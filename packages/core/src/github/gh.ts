import { execFile } from 'node:child_process'
import {
  PR_LIST_FIELDS,
  PR_LIST_LIMIT,
  PR_THREAD_COMMENTS_QUERY,
  PR_THREADS_QUERY,
  PR_VIEW_FIELDS,
  parseGhAuth,
  parseGhVersion,
  parsePullDetail,
  parseReviewThreadPage,
  parseThreadCommentPage,
  parsePullList
} from './parse'
import type { GhAuthReading } from './parse'
import type { PullDetail, PullPatch, PullReviewThread, PullSummary } from './types'

/**
 * Running the user's own `gh`.
 *
 * Helm makes no GitHub request of its own and holds no GitHub credential. Every
 * fetch on this surface is `gh` doing what `gh` does, on the token the user
 * gave it - which is the same arrangement Helm has with the `claude` CLI, and
 * it is deliberate rather than convenient: a token Helm never receives is a
 * token Helm cannot leak.
 *
 * The binary is **passed in**, not looked up here. `core` is headless and knows
 * nothing about install locations or a settings override; resolving those is
 * the host's job (`desktop/src/main/gh-cli.ts`), and this module is handed the
 * answer. Same shape as `readGitState` shelling out to `git`.
 */

/** Long enough for a cold API call, short enough that a pass cannot hang. */
const TIMEOUT_MS = 30_000

/** A repository's PR list is a few hundred kilobytes at most. */
const MAX_BUFFER = 8 * 1024 * 1024

/**
 * How to spawn `gh`, resolved by the host.
 *
 * `prefixArgs` carries the `cmd.exe /c` dance a `.cmd` shim needs on Windows -
 * the same reason `ClaudeCommand` has one. A scoop or npm installation of gh is
 * a batch file, and `CreateProcess` cannot execute one.
 */
export interface GhCommand {
  file: string
  prefixArgs: string[]
  /** The gh entry point itself, for diagnostics. */
  resolved: string
  /**
   * Where the *host* process is started, when that is not the directory the
   * command is about.
   *
   * Only `checkoutPull` is about a directory at all - everything else here
   * names its repository with `--repo` - and for a checkout inside a WSL
   * distribution the two come apart: the program is `wsl.exe`, the repository
   * is carried on its argv as `--cd`, and the working directory this process
   * may spawn with is neither. A `\\wsl$\...` cwd cannot be used: `execFile`
   * does not even fail honestly there, it spawns with the directory silently
   * defaulted (measured 2026-09-03 - `cmd.exe` reports "UNC paths are not
   * supported. Defaulting to Windows directory."), so the checkout would land
   * somewhere nobody chose.
   *
   * Unset by every ordinary caller, which leaves the Windows path unchanged.
   * The same field, for the same reason, as `ClaudeCommand.hostCwd`.
   */
  hostCwd?: string | undefined
}

export interface GhRun {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  /** Set when the process could not be run or was killed; null otherwise. */
  error: string | null
  durationMs: number
}

/**
 * The environment `gh` is given.
 *
 * Three of these keep the output parseable and one keeps the process from
 * waiting for a person: gh will otherwise print an update banner, colour its
 * diagnostics, page its output, and - on a repository it cannot resolve -
 * prompt. None of that is answerable from inside a fetch pass.
 *
 * Nothing is *removed*: `GH_TOKEN`, `GH_HOST` and the rest are the user's own
 * configuration, and a Helm that quietly unset them would be a Helm that
 * fetches as somebody else.
 */
function ghEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PROMPT_DISABLED: '1',
    GH_PAGER: 'cat',
    NO_COLOR: '1'
  }
}

export async function runGh(
  command: GhCommand,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {}
): Promise<GhRun> {
  const started = Date.now()
  return new Promise<GhRun>((resolve) => {
    execFile(
      command.file,
      [...command.prefixArgs, ...args],
      {
        // `hostCwd` wins: a routed command carries the real directory on its
        // own argv, and the one it would be spawned with is unusable.
        ...(command.hostCwd !== undefined
          ? { cwd: command.hostCwd }
          : options.cwd !== undefined
            ? { cwd: options.cwd }
            : {}),
        timeout: options.timeoutMs ?? TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: options.maxBuffer ?? MAX_BUFFER,
        env: ghEnv()
      },
      (err, stdout, stderr) => {
        // Resolved rather than rejected in every case, including the ones where
        // gh never started: a failed fetch is a fact this surface reports on a
        // repository row, not an exception the poller has to survive.
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : null
        resolve({
          ok: err === null,
          exitCode: code,
          stdout,
          stderr,
          error: err === null ? null : firstLine(err.message),
          durationMs: Date.now() - started
        })
      }
    )
  })
}

export async function readGhVersion(command: GhCommand): Promise<string | null> {
  const run = await runGh(command, ['--version'], { timeoutMs: 15_000 })
  return run.ok ? parseGhVersion(run.stdout) : null
}

/** Whether gh is signed in, from its exit code alone. See `parseGhAuth`. */
export async function readGhAuth(command: GhCommand): Promise<GhAuthReading> {
  const run = await runGh(command, ['auth', 'status'], { timeoutMs: 20_000 })
  return parseGhAuth(run)
}

/**
 * Open pull requests for one repository.
 *
 * `--repo <slug>` rather than a working directory, which is what makes this
 * independent of where the process happens to be: the same call answers for a
 * repository whose checkout has been renamed, moved or is mid-rebase, and it
 * cannot accidentally answer for whatever repository the cwd is inside.
 *
 * Rejects with gh's own first line of complaint. The caller records that
 * against the repository and keeps the rows it already had.
 */
export async function fetchOpenPulls(
  command: GhCommand,
  slug: string,
  options: { limit?: number; timeoutMs?: number } = {}
): Promise<PullSummary[]> {
  const run = await runGh(
    command,
    [
      'pr',
      'list',
      '--repo',
      slug,
      '--state',
      'open',
      '--limit',
      String(options.limit ?? PR_LIST_LIMIT),
      '--json',
      PR_LIST_FIELDS
    ],
    options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}
  )

  if (!run.ok) {
    const said = firstMeaningfulLine(run.stderr) ?? run.error ?? 'gh failed with no output'
    throw new Error(said)
  }
  return parsePullList(run.stdout)
}

/**
 * Everything behind one pull request.
 *
 * A second call and a second cache column rather than more fields on the list
 * fetch, because the two cost very different things: a list is one request per
 * repository on a five-minute timer, and this is the conversation, the commits
 * and the file list of a single pull request, asked for once when somebody
 * opens it. Folding them together would make the poll pay for detail nobody has
 * looked at.
 *
 * `--repo <slug>` again, so the answer does not depend on the working
 * directory - see `fetchOpenPulls`.
 */
export async function fetchPullDetail(
  command: GhCommand,
  slug: string,
  number: number,
  options: { timeoutMs?: number } = {}
): Promise<PullDetail> {
  const run = await runGh(
    command,
    ['pr', 'view', String(number), '--repo', slug, '--json', PR_VIEW_FIELDS],
    options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}
  )

  if (!run.ok) {
    const said = firstMeaningfulLine(run.stderr) ?? run.error ?? 'gh failed with no output'
    throw new Error(said)
  }
  return parsePullDetail(run.stdout)
}

/**
 * How many pages of each connection the thread fetch will walk.
 *
 * A ceiling and not a page size - the page sizes are in the queries. Twenty
 * pages of fifty is a thousand threads and a thousand replies to any one of
 * them, which is far past any pull request a person reads and far short of an
 * unbounded loop against somebody's rate limit. A pull request that goes over
 * it keeps what was read; the alternative is a fetch that never returns.
 */
const MAX_THREAD_PAGES = 20

/**
 * Every comment left on a line of the diff, threads and all.
 *
 * A **second call** beside `fetchPullDetail` rather than more fields on it, and
 * not by choice: `gh pr view --json` cannot see these at all. Its `comments`
 * are the issue-level ones from the conversation tab and its `reviews` are each
 * review's summary body; the notes people leave on individual lines are review
 * threads and are absent from that surface entirely. So this asks GitHub's
 * GraphQL API - through `gh api graphql`, which means it is still the user's
 * own `gh` on the user's own token, and nothing here handles a credential any
 * more than the rest of this file does.
 *
 * Not the REST `pulls/{n}/comments` endpoint, which `gh api` could equally have
 * called. REST hands over `in_reply_to_id`, which is enough to rebuild the
 * threading, and it carries **neither `isResolved` nor `isOutdated`** - and a
 * resolved thread painted identically to a live one reads as an objection
 * nobody ever answered, which is a worse answer than no threads at all.
 *
 * **Both connections page**, and both are walked. `reviewThreads` pages, and so
 * do the comments *inside* each thread - a pull request with a long review is
 * exactly the case where the first matters and a thread somebody argued in is
 * where the second does. The inner walk is per thread and by node id, so
 * reaching reply 51 of one thread does not re-fetch the fifty threads beside
 * it.
 *
 * Rejects with gh's own first line of complaint, like every other fetch here.
 * The caller keeps whatever threads it had and says the age of them.
 */
export async function fetchReviewThreads(
  command: GhCommand,
  slug: string,
  number: number,
  options: { timeoutMs?: number } = {}
): Promise<PullReviewThread[]> {
  const [owner, name] = slug.split('/')
  if (owner === undefined || name === undefined || owner === '' || name === '') {
    throw new Error(`${slug} is not an owner/name repository`)
  }

  const threads: PullReviewThread[] = []
  let cursor: string | null = null

  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const stdout = await graphql(
      command,
      PR_THREADS_QUERY,
      [
        // `-f` for the two strings and `-F` for the one Int, which is what the
        // query declares them as. `-F` on the owner would type-convert a
        // repository whose name is a number into a JSON number and the query
        // would be refused.
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${String(number)}`,
        // Omitted rather than sent as null on the first page: a nullable
        // variable nobody supplies is an argument that is not there, which is
        // exactly "start at the beginning", and it needs no agreement with gh
        // about how it spells a JSON null on a command line.
        ...(cursor === null ? [] : ['-f', `cursor=${cursor}`])
      ],
      options
    )

    const answer = parseReviewThreadPage(stdout)
    for (const parsed of answer.threads) {
      threads.push({
        ...parsed.thread,
        comments: parsed.comments.hasNextPage
          ? [
              ...parsed.thread.comments,
              ...(await restOfThread(command, parsed.thread.id, parsed.comments.endCursor, options))
            ]
          : parsed.thread.comments
      })
    }

    if (!answer.page.hasNextPage || answer.page.endCursor === null) break
    cursor = answer.page.endCursor
  }

  return threads
}

/** Replies 51 and on of one thread, by node id. */
async function restOfThread(
  command: GhCommand,
  id: string,
  from: string | null,
  options: { timeoutMs?: number }
): Promise<PullReviewThread['comments']> {
  const rest: PullReviewThread['comments'] = []
  let cursor = from
  for (let page = 0; page < MAX_THREAD_PAGES && cursor !== null; page++) {
    const stdout = await graphql(
      command,
      PR_THREAD_COMMENTS_QUERY,
      ['-f', `id=${id}`, '-f', `cursor=${cursor}`],
      options
    )
    const answer = parseThreadCommentPage(stdout)
    rest.push(...answer.comments)
    cursor = answer.page.hasNextPage ? answer.page.endCursor : null
  }
  return rest
}

/** One `gh api graphql`, with the query passed as a raw string field. */
async function graphql(
  command: GhCommand,
  query: string,
  fields: string[],
  options: { timeoutMs?: number }
): Promise<string> {
  const run = await runGh(
    command,
    ['api', 'graphql', '-f', `query=${query}`, ...fields],
    options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}
  )
  if (!run.ok) {
    const said = firstMeaningfulLine(run.stderr) ?? run.error ?? 'gh failed with no output'
    throw new Error(said)
  }
  return run.stdout
}

/**
 * How much of one pull request's patch is kept.
 *
 * A ceiling rather than a page size, because `gh pr diff` has no paging: the
 * whole patch arrives on stdout or none of it does. Two megabytes is far past
 * any diff a person reads and far short of what a generated-file pull request
 * can be, and what goes over it is cut at a line boundary and **said so** - the
 * view carries a sentence and the Files footer prints it. Silently keeping the
 * first two megabytes would be a diff that reads as complete.
 */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024

/**
 * The patch behind one pull request.
 *
 * A third call, kept apart from `fetchPullDetail` for the reason that one is
 * kept apart from the list: they cost different amounts and go stale at
 * different rates. This is also the only fetch on the surface with no useful
 * degraded form - half a patch is a patch that lies about what changed - so the
 * caller gets a rejection and the pane says the Files view has nothing rather
 * than painting a diff missing its last file.
 *
 * `--repo <slug>` again, so nothing depends on the working directory.
 */
export async function fetchPullDiff(
  command: GhCommand,
  slug: string,
  number: number,
  options: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<PullPatch> {
  const limit = options.maxBytes ?? MAX_DIFF_BYTES
  const run = await runGh(command, ['pr', 'diff', String(number), '--repo', slug], {
    // Room to notice the ceiling has been passed without holding a great deal
    // more than it: the process is killed the moment stdout goes over this, and
    // a buffer exactly at the limit could not tell "just fits" from "way over".
    maxBuffer: limit + 1024 * 1024,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
  })

  if (!run.ok) {
    // Node kills the child and reports this when the buffer fills, which on
    // this call means one thing worth saying plainly rather than passing on.
    if ((run.error ?? '').includes('maxBuffer')) {
      throw new Error(
        `The patch for #${String(number)} is larger than the ${String(Math.round(limit / (1024 * 1024)))}MB Helm fetches.`
      )
    }
    const said = firstMeaningfulLine(run.stderr) ?? run.error ?? 'gh failed with no output'
    throw new Error(said)
  }

  if (run.stdout.length <= limit) return { text: run.stdout, truncated: false }

  // Cut back to the last complete line: half a line of somebody's source
  // rendered as a diff row is a row that says something the file does not.
  const cut = run.stdout.slice(0, limit)
  const lastBreak = cut.lastIndexOf('\n')
  return { text: lastBreak < 0 ? '' : cut.slice(0, lastBreak + 1), truncated: true }
}

/**
 * `gh pr checkout`, the one call on this surface that changes something.
 *
 * Everything else here reads. This fetches the pull request's head into the
 * checkout at `cwd` and moves it there, which is why `cwd` is required rather
 * than optional: `--repo` names which repository the number belongs to, but the
 * tree being moved is whichever one the process is standing in, and defaulting
 * that to `process.cwd()` would be a working directory nobody chose.
 *
 * The dirty-tree guard is the **caller's**, deliberately: this is `core`, it
 * has one job, and the guard needs `readGitState` plus a sentence to show. See
 * `desktop/src/main/pulls.ts`.
 *
 * Rejects with gh's own first line of complaint - a fork whose head has been
 * deleted, a branch name that collides with a local one, a repository mid-merge.
 */
export async function checkoutPull(
  command: GhCommand,
  slug: string,
  number: number,
  cwd: string,
  options: { timeoutMs?: number } = {}
): Promise<GhRun> {
  const run = await runGh(command, ['pr', 'checkout', String(number), '--repo', slug], {
    cwd,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
  })

  if (!run.ok) {
    const said = firstMeaningfulLine(run.stderr) ?? run.error ?? 'gh failed with no output'
    throw new Error(said)
  }
  return run
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? text
}

function firstMeaningfulLine(text: string): string | null {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? null
  )
}

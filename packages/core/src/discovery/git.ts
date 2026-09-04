import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { GitState } from '../types'
import { toWslPath, wslDistroOf } from '../wsl/path'

const run = promisify(execFile)

/**
 * How to run `git` for a given working directory.
 *
 * For a path on this machine it is `git` with a `cwd`, which is what this file
 * has always done. For a path inside a distro it is the **distro's** git,
 * reached through `wsl.exe --cd`.
 *
 * That is not a preference, it is the only thing that works. Windows git
 * refuses a WSL-resident repository outright:
 *
 * ```
 * fatal: detected dubious ownership in repository at
 *   '//wsl$/Ubuntu/home/me/harness/repos/lams'
 * ```
 *
 * because the files carry the distro's uid rather than this user's. The
 * documented remedy is a `safe.directory` entry per repository in the user's
 * global config, which is Helm editing a file it does not own, once per
 * repository somebody clones, to work around running the wrong git. The
 * distro's own git has none of that to say, and its `--porcelain=v2` output is
 * byte-identical - measured, which is why `parseGitStatus` needed no change.
 *
 * The cwd is passed to `--cd` as a **distro** path rather than the UNC one:
 * that is the spelling the distro's git will report paths in, and it keeps the
 * relay from translating on Helm's behalf.
 */
/**
 * How to reach *any* repository-local tool from a path, not just git.
 *
 * Exported because the pull-request surface needs the identical decision and
 * getting it wrong there was a measured bug rather than a hypothetical one. On
 * 2026-09-03, `git remote get-url origin` run from Windows with a
 * `\\wsl$\Ubuntu\...` working directory answered:
 *
 *     fatal, exit 128: warning: safe.directory 'undefined' not absolute
 *
 * and `gh repo view` failed the same way one level up ("failed to run git").
 * The consequence was a distro-resident repository whose branch and dirty state
 * the launcher showed correctly - because `readGitState` already routes - while
 * the PR pane reported it as having nothing. Two surfaces answering the same
 * question differently is exactly what one shared decision prevents.
 *
 * `file` is the program, `prefix` goes before the caller's own argv, and `cwd`
 * is set **only** when the host may use it: `CreateProcess` cannot take a UNC
 * working directory, and `execFile` does not even fail honestly there - it
 * spawns with the directory silently defaulted (measured: `cmd.exe` reports
 * "UNC paths are not supported. Defaulting to Windows directory."), so a
 * command would run somewhere nobody chose.
 */
export function repoCommand(
  cwd: string,
  program: string
): { file: string; prefix: string[]; cwd?: string } {
  // Only a `\\wsl$\` UNC selects `wsl.exe`, so on a Linux host - where every
  // cwd is a posix path - this is always the program itself.
  const distro = wslDistroOf(cwd)
  if (distro === null) return { file: program, prefix: [], cwd }
  const inside = toWslPath(cwd, { distro })
  // A UNC path that will not translate cannot be reached from either side.
  // Falling back to the Windows program would produce the ownership error
  // above, so the caller gets the honest failure instead.
  if (inside === null) return { file: program, prefix: [], cwd }
  return { file: 'wsl.exe', prefix: ['-d', distro, '--cd', inside, '--', program] }
}

const gitCommand = (cwd: string): ReturnType<typeof repoCommand> => repoCommand(cwd, 'git')

/** `execFile`, routed to whichever git owns this path. */
async function runGit(
  cwd: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number }
): Promise<{ stdout: string }> {
  const command = gitCommand(cwd)
  const { stdout } = await run(command.file, [...command.prefix, ...args], {
    ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    timeout: options.timeout,
    windowsHide: true,
    ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer })
  })
  return { stdout }
}

/**
 * Working-tree state, read by shelling out to `git`.
 *
 * No libgit binding: this is one call per project on a background refresh, the
 * numbers do not need to be exact to the millisecond, and a native git binding
 * is a second native module to package (Spike B's whole subject) for something
 * the CLI already answers in a single command.
 */

const TIMEOUT_MS = 10_000

/** `.git` is a directory in a normal clone and a file in a worktree or submodule. */
export async function isGitRepo(projectPath: string): Promise<boolean> {
  try {
    await stat(join(projectPath, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * `git status --porcelain=v2 --branch` in one call: the header lines carry the
 * branch and the ahead/behind pair, the rest are changed paths. Asking for
 * `rev-list --count` separately would be a second process and could disagree
 * with the first if an index write landed between them.
 */
export async function readGitState(projectPath: string): Promise<GitState | null> {
  if (!(await isGitRepo(projectPath))) return null

  let stdout: string
  try {
    const result = await runGit(
      projectPath,
      [
        '--no-optional-locks',
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=all',
        '--ignore-submodules=dirty'
      ],
      { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }
    )
    stdout = result.stdout
  } catch (err) {
    // git writes multi-line diagnostics; the first line is the one worth
    // showing in a chip.
    const message = err instanceof Error ? err.message : String(err)
    return {
      branch: null,
      detached: false,
      dirty: 0,
      ahead: 0,
      behind: 0,
      error: message.split('\n')[0] ?? message
    }
  }

  return parseGitStatus(stdout)
}

/** Exported for tests: the parse is where the bugs would be, not the spawn. */
export function parseGitStatus(stdout: string): GitState {
  const state: GitState = { branch: null, detached: false, dirty: 0, ahead: 0, behind: 0 }

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue

    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      // porcelain=v2 reports a detached HEAD with the literal string
      // "(detached)", which is not a branch name a repo could otherwise have.
      if (head === '(detached)') state.detached = true
      else state.branch = head
      continue
    }

    if (line.startsWith('# branch.ab ')) {
      // Format: "# branch.ab +2 -1". Absent entirely when there is no upstream.
      const parts = line.slice('# branch.ab '.length).trim().split(/\s+/)
      for (const part of parts) {
        const n = Number(part.slice(1))
        if (!Number.isFinite(n)) continue
        if (part.startsWith('+')) state.ahead = n
        else if (part.startsWith('-')) state.behind = Math.abs(n)
      }
      continue
    }

    if (line.startsWith('#')) continue

    // Every remaining line is one path: '1' changed, '2' renamed/copied,
    // 'u' unmerged, '?' untracked, '!' ignored (not requested here).
    const kind = line[0]
    if (kind === '1' || kind === '2' || kind === 'u' || kind === '?') state.dirty += 1
  }

  return state
}

/**
 * The branch name alone, for a caller that has somebody waiting on it.
 *
 * `readGitState` above answers this too, and is deliberately not what a session
 * launch uses. That one is `git status --untracked-files=all`, whose cost is the
 * size of the working tree - fine on a background refresh, and unbounded work in
 * front of a person who has just clicked "Start session here". `symbolic-ref`
 * reads one file and answers in single-digit milliseconds however large the repo
 * is.
 *
 * `symbolic-ref` rather than `rev-parse --abbrev-ref HEAD` because it is honest
 * about both edge cases at once: it exits 1 on a detached HEAD instead of
 * printing the literal string `HEAD` as a branch name, and it still answers on
 * an unborn branch, where `rev-parse` fails because there is no commit for HEAD
 * to resolve to. Every failure - no git, not a repository, detached, unreadable
 * - is the same answer here: null, which the caller paints as nothing.
 */
export async function readGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      timeout: TIMEOUT_MS
    })
    const branch = stdout.trim()
    return branch === '' ? null : branch
  } catch {
    return null
  }
}

/** Reads many repos at once. Bounded so a root holding fifty repos does not
 * spawn fifty git processes into the same disk at the same moment. */
export async function readGitStates(
  paths: string[],
  concurrency = 8
): Promise<Map<string, GitState | null>> {
  const result = new Map<string, GitState | null>()
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (cursor < paths.length) {
      const path = paths[cursor++]
      if (path === undefined) return
      result.set(path, await readGitState(path))
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker))
  return result
}

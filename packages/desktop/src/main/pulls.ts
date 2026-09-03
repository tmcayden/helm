import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import {
  checkoutPull,
  classifyGhFailure,
  fetchOpenPulls,
  fetchPullDetail,
  fetchPullDiff,
  fetchReviewThreads,
  forgetPrRepos,
  heldReviewThreads,
  indexDiffByPath,
  isRepoIgnored,
  parseGitHubRemote,
  parseUnifiedDiff,
  pullConversation,
  readGhAuth,
  readGhVersion,
  readGitState,
  readPrRepos,
  readPull,
  readPullsBySlug,
  recordPrFetch,
  renderMarkdown,
  renderPullPrompt,
  replaceRepoPulls,
  repoCommand,
  upsertPrRepo,
  writePullDetail,
  wslDistroOf,
  MAX_DIFF_BYTES,
  type AppSettings,
  type GhCommand,
  type GhFailureKind,
  type GhProblem,
  type GhStatus,
  type IgnoredRepo,
  type LaunchedReviewPlan,
  type PrRepoRow,
  type PullDetail,
  type PullDetailView,
  type PullFileView,
  type PullPatch,
  type PullRepo,
  type PullReviewThread,
  type PullsSnapshot,
  type PullSummary,
  type RenderedPullItem,
  type RenderedThreadComment,
  type Store
} from '@helm/core'
import {
  findGhExecutable,
  GH_MISSING_SENTENCE,
  GH_OFFLINE_SENTENCE,
  GH_UNAUTHENTICATED_SENTENCE,
  resolveGhCommand
} from './gh-cli'

const run = promisify(execFile)

/** gh's own complaint, trimmed to the line worth showing. */
function firstLineOf(text: string): string | null {
  const line = text.trim().split(/\r?\n/)[0]?.trim()
  return line === undefined || line === '' ? null : line
}

/**
 * Keeping the Pulls pane level with what GitHub says.
 *
 * Modelled on `usage.ts`, and different from it in the two ways that matter.
 * There is no `fs.watch` here and there cannot be: nothing on this machine
 * changes when somebody opens a pull request, so the triggers are a timer, the
 * window regaining focus, and the refresh button - and the timer is the reason
 * this service exists at all.
 *
 * The other difference is what a stale answer is worth. Usage degrades to
 * nothing, because a plan percentage from two hours ago is a wrong number. A
 * pull request from two hours ago is a true fact about two hours ago, so this
 * degrades to *stale with its age on it*: cached rows stay, the error goes on
 * the repository that failed, and the snapshot always carries the moment the
 * oldest of them was fetched.
 *
 * Three things it inherits from `usage.ts` unchanged: a pass that throws is
 * caught so it cannot take the interval with it, a snapshot is pushed only when
 * its signature differs, and the fixture hooks (`pointGh`, `pointRemotes`,
 * `pointPollMs`) are methods on the service rather than channels on the IPC
 * contract - the renderer has no business choosing which binary the pull
 * requests come from.
 */

/** `git remote get-url origin` is local and instant, or it is broken. */
const GIT_TIMEOUT_MS = 10_000

/** One `git` per repository; a root holding fifty must not spawn fifty at once. */
const REMOTE_CONCURRENCY = 8

/** One `gh` per distinct remote, held down harder - these are network calls. */
const FETCH_CONCURRENCY = 4

/**
 * How long `gh pr checkout` is given.
 *
 * Four times the budget a fetch gets, because this one is not an API call: it
 * pulls the pull request's head into the repository, and on a large history
 * over a slow link that is a real transfer. Still bounded - a checkout that has
 * hung is a button that never comes back.
 */
const CHECKOUT_TIMEOUT_MS = 120_000

/**
 * How long a mapped remote is believed.
 *
 * Remotes are changed by hand, once in a while, and re-reading every one of
 * them on every five-minute tick would spawn a `git` per repository for an
 * answer that has not moved since the app started. New directories are mapped
 * immediately regardless - this only governs re-reading a directory already
 * known.
 */
const REMOTE_TTL_MS = 10 * 60_000

/**
 * The floor under the focus refresh.
 *
 * Alt-tabbing between an editor and Helm is not a request for a network call.
 * The same guard the git refresh uses, at the interval this surface can afford.
 */
const FOCUS_MIN_INTERVAL_MS = 5 * 60_000

/** A discovered project, as this service needs it. */
export interface PullsProject {
  path: string
  name: string
}

export interface PullsService {
  /** The cache, without touching gh. What `pr:snapshot` answers with. */
  snapshot: () => PullsSnapshot
  /** Fetches now - one repository, or all of them. */
  refresh: (request?: { repoPath?: string }) => Promise<PullsSnapshot>
  /**
   * One pull request, with its markdown rendered. Cached unless `refresh`.
   *
   * Rejects with a whole sentence - the tab shows it as it is.
   */
  detail: (request: {
    repoPath: string
    number: number
    refresh?: boolean
  }) => Promise<PullDetailView>
  /**
   * Everything a review launch needs, decided here rather than in the window.
   *
   * Does the side effect too when `prCheckout` is on - `gh pr checkout` runs
   * before this resolves - because a plan that promised a checkout and left it
   * to the caller would be a plan that can be half-applied. The session host
   * takes what comes back and spawns it.
   *
   * Rejects with a whole sentence, like `detail`.
   */
  prepareReview: (request: { repoPath: string; number: number }) => Promise<LaunchedReviewPlan>
  /**
   * The window came forward. Guarded rather than debounced, and additionally
   * rate-limited: returns false when it decided not to.
   */
  refreshOnFocus: () => boolean
  /**
   * Rebuilds the snapshot from the cache and pushes it if it moved.
   *
   * For a setting that changes what the snapshot *says* without changing
   * anything GitHub knows - the ignore list is the only one so far. `refresh`
   * would do this too, but only on the path where no pass is already in
   * flight, so a toggle during a sweep would not reach the pane until the
   * sweep ended.
   */
  republish: () => PullsSnapshot
  /** Re-reads the interval and the gh override out of settings. */
  rearm: () => void
  start: () => void
  stop: () => void

  /**
   * Fixture hooks. Deliberately not on the IPC contract - see the file comment.
   */
  pointGh: (path: string | null) => void
  pointRemotes: (remotes: Record<string, string> | null) => void
  pointPollMs: (ms: number | null) => void
  /** Passes attempted and passes that threw. The poller's own vital signs. */
  passes: () => { started: number; failed: number; lastError: string | null }
}

export interface PullsServiceDeps {
  store: Store
  /** Read through a function: the interval has to be able to change at runtime. */
  settings: () => AppSettings
  /** The directories to consider, from the last scan or the project cache. */
  projects: () => PullsProject[]
  /** Called after any pass whose snapshot differs from the one before it. */
  onChange: (snapshot: PullsSnapshot) => void
}

function msOf(iso: string | null): number | null {
  if (iso === null) return null
  const at = Date.parse(iso)
  return Number.isNaN(at) ? null : at
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function mapLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor++]
      if (item === undefined) return
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/**
 * What makes one snapshot different from another.
 *
 * A string rather than a field-by-field comparison, for the reason `usage.ts`
 * gives: a repository appearing, a pull request closing or a review landing all
 * count as a change without this function having to know which fields exist.
 * `fetchedAtMs` is *in* it, unlike the usage signature - a refresh that found
 * exactly the same pull requests still moved the age caption, and the caption is
 * the honesty this surface degrades through.
 */
function signature(snapshot: PullsSnapshot): string {
  return JSON.stringify([
    snapshot.gh.path,
    snapshot.gh.authenticated,
    snapshot.gh.problem?.kind ?? null,
    snapshot.open,
    snapshot.checked,
    // The mapping finishing moves no other field on a machine with no GitHub
    // remotes on it, and it is precisely the transition from "still looking" to
    // an answer - so without this the pane would keep saying it was checking.
    snapshot.unmapped,
    snapshot.fetchedAtMs,
    // Ignoring a repository that had nothing open moves no other field in here
    // - the same reason `pull.checks` is in the row tuple below - so without
    // this the pane would keep painting the list from before the toggle.
    snapshot.ignored.map((repo) => [repo.slug, repo.name, repo.present, repo.paths]),
    snapshot.repos.map((repo) => [
      repo.path,
      repo.slug,
      repo.fetchedAtMs,
      repo.error,
      repo.pulls.map((pull) => [
        pull.number,
        pull.updatedAt,
        pull.title,
        pull.isDraft,
        pull.reviewDecision,
        pull.additions,
        pull.deletions,
        // A run going green moves nothing else on the row, so without this the
        // list would keep painting the tally from the pass before it.
        pull.checks
      ])
    ])
  ])
}

export function createPullsService({
  store,
  settings,
  projects,
  onChange
}: PullsServiceDeps): PullsService {
  /** Set by `pointGh`; overrides both the setting and discovery. */
  let ghFixture: string | null = null
  /** Set by `pointRemotes`; stands in for `git remote get-url origin`. */
  let remoteFixture: Record<string, string> | null = null
  /** Set by `pointPollMs`; a driver cannot wait five minutes for a tick. */
  let pollFixtureMs: number | null = null

  let ghStatus: GhStatus | null = null
  /**
   * Whether `ghStatus` was concluded from fetches rather than from `gh auth
   * status`.
   *
   * A fetch outranks that command and this flag is what stops the ranking being
   * undone: `ensureGh` runs at the top of every pass for the executable's
   * identity, and without this it would re-derive the problem from an exit code
   * that cannot tell an unreachable GitHub from a rejected token - overwriting
   * the offline verdict the previous sweep worked out properly.
   */
  let verdictFromFetch = false
  let poll: NodeJS.Timeout | null = null
  let inFlight: Promise<PullsSnapshot> | null = null
  let lastPassAtMs = 0
  let everFetched = false
  let lastSignature = ''
  let started = 0
  let failed = 0
  let lastError: string | null = null

  // ---------------------------------------------------------------------
  // gh
  // ---------------------------------------------------------------------

  /**
   * What `gh` is on this machine, cached until something could have changed it.
   *
   * `gh auth status` is a real request against GitHub - it validates the token
   * rather than merely finding one - which is what makes its answer worth
   * asking for once and also what makes it untrustworthy as a **verdict**: with
   * no route to github.com it exits 1 and reports the token as invalid. So this
   * establishes the executable's identity and offers an opinion, and the pass
   * corrects the opinion from what the fetches actually did.
   *
   * A cached answer is kept when it is good news, or when a fetch has already
   * overruled it. Bad news of this command's own is re-asked every pass: it
   * costs one process per interval, and it is the difference between a machine
   * that recovers when its network comes back and one that has to be restarted.
   */
  async function ensureGh(force = false): Promise<GhStatus> {
    if (ghStatus !== null && !force && (verdictFromFetch || ghStatus.problem === null)) {
      return ghStatus
    }
    verdictFromFetch = false

    const override = ghFixture ?? settings().ghPath
    const command = resolveGhCommand(override ?? undefined)
    if (command === null) {
      // An override that does not resolve is worth saying so: falling back to
      // discovery silently would make a wrong setting invisible.
      const discovered = override !== null ? findGhExecutable() : null
      ghStatus = {
        path: discovered,
        source: null,
        version: null,
        authenticated: false,
        problem: { kind: 'missing', message: GH_MISSING_SENTENCE }
      }
      return ghStatus
    }

    const version = await readGhVersion(command)
    const auth = await readGhAuth(command)
    ghStatus = {
      path: command.resolved,
      source: override !== null ? 'setting' : 'discovered',
      version,
      authenticated: auth.authenticated,
      problem: auth.authenticated
        ? null
        : { kind: 'unauthenticated', message: GH_UNAUTHENTICATED_SENTENCE }
    }
    return ghStatus
  }

  function ghCommand(): GhCommand | null {
    return resolveGhCommand((ghFixture ?? settings().ghPath) ?? undefined)
  }

  // ---------------------------------------------------------------------
  // Remotes
  // ---------------------------------------------------------------------

  /**
   * A project's `origin`, read where the project is.
   *
   * Here rather than in `discovery/`, deliberately. The focus git refresh is one
   * `execFile` per project and is on the path between alt-tabbing and seeing a
   * branch chip; adding a second spawn to it would double that cost for every
   * project on the machine, GitHub or not. This runs on the PR surface's own
   * schedule instead, and caches its answer in `pr_repos`.
   */
  async function readOrigin(path: string): Promise<string | null> {
    if (remoteFixture !== null) return remoteFixture[path] ?? null
    /*
     * Routed through whichever git owns the path, which for a repository inside
     * a WSL distribution is that distribution's.
     *
     * This one line is what the whole surface hung on. Measured 2026-09-03: run
     * from Windows with a `\\wsl$\Ubuntu\...` working directory, `git remote
     * get-url origin` exits 128 with `safe.directory 'undefined' not absolute`
     * - so `readOrigin` returned null, the repository never got a slug, and the
     * pane reported a distro-resident repo as having no pull requests. Not an
     * error the user could act on: "nothing to fetch" is the same answer this
     * gives for a folder that genuinely is not a repository.
     *
     * `repoCommand` is the same decision `readGitState` makes, shared rather
     * than copied - the launcher showing a branch for a repo the PR pane called
     * empty was two answers to one question.
     */
    const command = repoCommand(path, 'git')
    try {
      const { stdout } = await run(
        command.file,
        [...command.prefix, '--no-optional-locks', 'remote', 'get-url', 'origin'],
        {
          ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true
        }
      )
      const url = stdout.trim()
      return url === '' ? null : url
    } catch {
      // Not a repository, no `origin`, or git is not installed. All three mean
      // the same thing here: nothing to fetch pull requests for.
      return null
    }
  }

  /** Maps the remotes of every project that has not been looked at recently. */
  async function mapRemotes(only: string | null): Promise<void> {
    const rows = new Map(readPrRepos(store).map((row) => [row.path.toLowerCase(), row]))
    const now = Date.now()
    const due = projects().filter((project) => {
      if (only !== null && project.path.toLowerCase() !== only.toLowerCase()) return false
      const row = rows.get(project.path.toLowerCase())
      if (row === undefined) return true
      const checked = msOf(row.checkedAt)
      // A manual refresh of one repository re-reads its remote unconditionally:
      // the button exists for the case where something changed.
      return only !== null || checked === null || now - checked > REMOTE_TTL_MS
    })

    await mapLimit(due, REMOTE_CONCURRENCY, async (project) => {
      const url = await readOrigin(project.path)
      const remote = url === null ? null : parseGitHubRemote(url)
      // `remote.url` rather than the raw one: a remote carrying an embedded
      // token is a credential, and the parse is what strips it.
      upsertPrRepo(store, {
        path: project.path,
        url: remote?.url ?? url,
        slug: remote?.slug ?? null
      })
    })
  }

  // ---------------------------------------------------------------------
  // The pass
  // ---------------------------------------------------------------------

  async function pass(only: string | null): Promise<void> {
    const known = projects()
    forgetPrRepos(
      store,
      known.map((project) => project.path)
    )

    await mapRemotes(only)

    // Asked for the executable's identity - its path, its version, and a first
    // opinion on the sign-in for the case where there is nothing to fetch.
    const status = await ensureGh()
    const command = ghCommand()
    // The **only** thing that stops a pass, and deliberately: "there is no gh on
    // this machine" is a local fact that cannot go stale between two ticks.
    // Everything else - not signed in, no route to github.com - is a claim about
    // a server, and a claim about a server may never gate the very request that
    // would correct it. Gating on `status.authenticated` here is what used to
    // latch this surface off for the rest of the session after one dropped
    // connection: the cached "not signed in" suppressed every fetch, and the
    // forced re-check that could have cleared it only ran when a fetch failed.
    if (command === null) return

    // One fetch per distinct remote, not per directory: two checkouts of the
    // same repository are two rows in the pane and one call to GitHub.
    //
    // The ignore list is applied *here*, before any of it, which is the whole
    // point of the setting: an ignored repository is a `gh` process that never
    // starts, not a row filtered out of an answer already paid for. It is
    // checked even when `only` names one repository - a manual refresh of an
    // ignored repository is a refresh of something the pane is not showing.
    const ignoredRepos = settings().prIgnoredRepos
    const wanted = readPrRepos(store).filter((row) => {
      if (row.slug === null) return false
      if (isRepoIgnored(ignoredRepos, row.slug)) return false
      return only === null || row.path.toLowerCase() === only.toLowerCase()
    })
    const bySlug = new Map<string, string[]>()
    for (const row of wanted) {
      const slug = row.slug as string
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), row.path])
    }

    let attempted = 0
    let failures = 0
    let firstFailure: string | null = null
    /** What each failure turned out to be about, for the verdict below. */
    const kinds = new Set<GhFailureKind>()

    await mapLimit([...bySlug.entries()], FETCH_CONCURRENCY, async ([slug, paths]) => {
      attempted += 1
      const at = new Date().toISOString()
      let pulls: PullSummary[]
      try {
        pulls = await fetchOpenPulls(command, slug)
      } catch (err) {
        failures += 1
        const message = err instanceof Error ? err.message : String(err)
        firstFailure ??= `${slug}: ${message}`
        kinds.add(classifyGhFailure(message))
        // The rows already cached stay exactly where they are; only the reason
        // is recorded. That is the whole of stale-with-age.
        recordPrFetch(store, paths, { error: message })
        return
      }
      replaceRepoPulls(store, slug, pulls, at)
      recordPrFetch(store, paths, { error: null, fetchedAt: at })
    })

    if (attempted === 0) {
      // Nothing was asked of GitHub, so nothing was learned about it. A verdict
      // an earlier sweep drew from fetches has no fetches supporting it any
      // more - every repository may since have been ignored or removed - so it
      // is released, and `ensureGh` goes back to being the only opinion there
      // is. It re-derives on the next pass rather than here, because asking
      // again inside a sweep that fetched nothing is a process spent to
      // re-confirm what it just said.
      verdictFromFetch = false
      return
    }
    if (failures < attempted) {
      // Something came back, which settles both questions at once and is the
      // only evidence on this surface that can: GitHub was reachable and it
      // accepted the token. Clearing unconditionally is the point - a problem
      // raised by an earlier sweep has just been disproved, and the version of
      // this that only refreshed the status when something *failed* left the
      // banner up through a completely healthy pass.
      everFetched = true
      clearProblem()
      return
    }

    // Everything failed. A verdict about the machine may only be drawn from a
    // full sweep: `only` is one repository, and one repository failing is a fact
    // about that repository however total its own failure was. Retrying a broken
    // row used to escalate it to "GitHub could not be reached" for this reason.
    if (only !== null) return
    ghStatus = { ...status, ...verdict(kinds, status, firstFailure) }
    verdictFromFetch = true
  }

  /**
   * What a sweep in which nothing succeeded means, from what the failures said.
   *
   * The classification comes from the **fetches**, never from `gh auth status`:
   * with no route to github.com that command exits 1 and reports the token as
   * invalid, so believing it would answer "you are signed out" to a question
   * that was really about the network - which is exactly the sentence that costs
   * a user their working login. A `pr list` failure carries the difference in
   * its own text, and `classifyGhFailure` reads it.
   *
   * Mixed kinds fall through to `failed` with the first reason quoted. Two
   * different explanations for one sweep is not something this can summarise, so
   * it shows one rather than picking a side.
   */
  function verdict(
    kinds: Set<GhFailureKind>,
    status: GhStatus,
    detail: string | null
  ): Pick<GhStatus, 'authenticated' | 'problem'> {
    if (kinds.size === 1 && kinds.has('offline')) {
      // Not a statement about the sign-in either way - the token was never
      // presented to anybody - so what is known about it is left as it was.
      return { authenticated: status.authenticated, problem: offlineProblem() }
    }
    if (kinds.size === 1 && kinds.has('auth')) {
      // GitHub answered and refused it. This is the one path that has actually
      // established a signed-out machine, and the only one allowed to say so.
      return {
        authenticated: false,
        problem: { kind: 'unauthenticated', message: GH_UNAUTHENTICATED_SENTENCE }
      }
    }
    // Reached GitHub well enough to be told something else - a 404, a 403, a
    // payload that would not parse. The sign-in is not what is wrong.
    return { authenticated: true, problem: failedProblem(detail) }
  }

  /**
   * Drops a global problem raised by an earlier sweep.
   *
   * Called whenever any repository came back, which is the only evidence this
   * surface has that settles both questions at once, and it settles them
   * affirmatively: GitHub answered, and it answered on this token.
   */
  function clearProblem(): void {
    if (ghStatus === null) return
    verdictFromFetch = true
    if (ghStatus.problem === null && ghStatus.authenticated) return
    ghStatus = { ...ghStatus, authenticated: true, problem: null }
  }

  function offlineProblem(): GhProblem {
    return { kind: 'offline', message: GH_OFFLINE_SENTENCE }
  }

  function failedProblem(detail: string | null): GhProblem {
    return {
      kind: 'failed',
      message:
        detail === null
          ? 'GitHub CLI could not list pull requests.'
          : `GitHub CLI could not list pull requests - ${detail}`
    }
  }

  // ---------------------------------------------------------------------
  // One pull request
  // ---------------------------------------------------------------------

  function repoRow(path: string): PrRepoRow | null {
    const wanted = path.toLowerCase()
    return readPrRepos(store).find((row) => row.path.toLowerCase() === wanted) ?? null
  }

  /**
   * The `gh` to fetch a detail with, or the sentence explaining why there
   * is not one.
   *
   * Thrown rather than returned as a degraded view, which is the opposite of
   * what the list does and deliberately so: a stale *list* is a true statement
   * about a moment in the past, but a tab opened on a pull request nobody can
   * fetch has nothing to show at all, and an empty conversation would read as a
   * pull request with no comments.
   */
  async function ghForDetail(): Promise<GhCommand> {
    const command = ghCommand()
    // Only the local fact stops it, for the reason `pass` gives at more length:
    // a problem the *list* concluded a while ago describes a sweep, not this
    // request, and refusing to run on the strength of one would leave a tab
    // reporting a stale diagnosis instead of trying. If it is still true, this
    // fetch is about to find that out first-hand and say so.
    if (command === null) {
      const status = await ensureGh()
      throw new Error(status.problem?.message ?? GH_MISSING_SENTENCE)
    }
    return command
  }

  /**
   * Markdown to HTML, in the main process.
   *
   * Here and not in the window for the reason the content viewer gives: the
   * pipeline is remark plus rehype plus shiki's grammars, which are megabytes
   * the renderer bundle must not carry, and the sanitiser is the only thing
   * standing between a stranger's pull-request comment and `innerHTML`. Running
   * it here means the window receives HTML that has already been through
   * GitHub's own sanitize schema and never evaluates any of it.
   *
   * Rendered per request rather than cached beside the JSON: HTML belongs to
   * the version of the pipeline that produced it, and a cache holding it would
   * keep painting an old renderer's output for as long as the pull request
   * stayed open.
   */
  async function render(markdown: string): Promise<string> {
    if (markdown.trim() === '') return ''
    // `frontmatter: false` because none of this is a note. A description that
    // opens with `---` opens with a horizontal rule, and reading it as a
    // metadata block would swallow everything down to the next one.
    const rendered = await renderMarkdown(markdown, { frontmatter: false })
    return rendered.html
  }

  async function detail(request: {
    repoPath: string
    number: number
    refresh?: boolean
  }): Promise<PullDetailView> {
    const row = repoRow(request.repoPath)
    if (row === null || row.slug === null) {
      throw new Error(`${request.repoPath} has no github.com origin remote.`)
    }
    const slug = row.slug

    const cached = readPull(store, slug, request.number)
    if (cached === null) {
      // The summary is what the header is painted from, so a pull request the
      // list has never seen is not one this can open. It happens when a tab is
      // restored for a pull request that has since been merged or closed.
      throw new Error(
        `Pull request #${String(request.number)} is no longer in ${slug}'s open list.`
      )
    }

    let held: PullDetail | null = cached.detail
    let patch: PullPatch | null = cached.diff
    /** Why there is no patch, when the fetch is the reason. */
    let patchProblem: string | null = null
    /** Why the threads are missing or old, when the fetch is the reason. */
    let threadProblem: string | null = null
    let fetchedAt = cached.detailFetchedAt
    let fromCache = true

    if (held === null || request.refresh === true) {
      const command = await ghForDetail()

      // All three at once. They are one act to whoever opened the tab, they are
      // independent calls to gh, and running them in series would make the
      // conversation wait on a patch it does not need - or the other way round.
      const [detailAttempt, diffAttempt, threadAttempt] = await Promise.allSettled([
        fetchPullDetail(command, slug, request.number),
        fetchPullDiff(command, slug, request.number),
        fetchReviewThreads(command, slug, request.number)
      ])

      if (detailAttempt.status === 'rejected') {
        const err: unknown = detailAttempt.reason
        const said = err instanceof Error ? err.message : String(err)
        // Classified from what this fetch said, not from a fresh `gh auth
        // status`. The version that re-asked that command turned every dropped
        // connection into "run gh auth login" - and worse, wrote the answer into
        // the shared status, so opening one tab while offline took the whole
        // list down with it. A 401 still earns the sign-in sentence, because a
        // 401 is GitHub itself refusing the token.
        const kind = classifyGhFailure(said)
        if (kind === 'auth') throw new Error(GH_UNAUTHENTICATED_SENTENCE, { cause: err })
        if (kind === 'offline') throw new Error(GH_OFFLINE_SENTENCE, { cause: err })
        throw new Error(said, { cause: err })
      }

      // A patch that would not fetch is **not** fatal and is not survivable
      // either: the conversation, the commits and the file list are all still
      // worth the tab, so the view is built without hunks and says why. What it
      // must not do is keep the patch it had - that one describes the file list
      // from the last fetch, and this one has a new file list.
      patch = diffAttempt.status === 'fulfilled' ? diffAttempt.value : null
      if (diffAttempt.status === 'rejected') {
        const err: unknown = diffAttempt.reason
        patchProblem = err instanceof Error ? err.message : String(err)
      }

      // The threads go the **other** way to the patch, and the difference is
      // what each one is anchored to. A patch describes a file list that has
      // just been replaced, so keeping the old one would paint hunks under
      // paths that no longer have them. A thread is anchored to a path and a
      // line and carries its own record of the diff it was written against, so
      // one fetched ten minutes ago is still a true fact about that
      // conversation - and this surface degrades stale-with-age rather than to
      // nothing. So a failed thread query keeps what was cached, and the view
      // says both that it failed and how old what is on screen is.
      const previous = heldReviewThreads(cached.detail)
      let threads = previous
      let threadsAt = cached.detail?.reviewThreadsFetchedAt ?? null
      if (threadAttempt.status === 'fulfilled') {
        threads = threadAttempt.value
        threadsAt = Date.now()
      } else {
        const err: unknown = threadAttempt.reason
        threadProblem = err instanceof Error ? err.message : String(err)
      }

      const at = new Date().toISOString()
      // Spread onto the fetched detail rather than written beside it: threads
      // ride inside `PullDetail`, so this is the object the cache holds and the
      // one the view is built from, and `undefined` here is a key that
      // `JSON.stringify` drops - which is exactly how "never fetched" survives
      // a round trip through the database.
      const fetched: PullDetail = {
        ...detailAttempt.value,
        ...(threads === undefined ? {} : { reviewThreads: threads }),
        ...(threadsAt === null ? {} : { reviewThreadsFetchedAt: threadsAt })
      }
      writePullDetail(store, slug, request.number, fetched, {
        diff: patch,
        detailFetchedAt: at
      })
      held = fetched
      fetchedAt = at
      fromCache = false
    }

    const conversation: RenderedPullItem[] = await Promise.all(
      pullConversation(held).map(async (entry) =>
        entry.kind === 'thread'
          ? { ...entry, comments: await renderThread(entry.comments) }
          : { ...entry, html: await render(entry.body) }
      )
    )

    return {
      slug,
      repoPath: row.path,
      summary: cached.summary,
      detail: held,
      bodyHtml: await render(held.body),
      conversation,
      threadsNote: threadsNote(held, threadProblem),
      threadsFetchedAtMs: held.reviewThreadsFetchedAt ?? null,
      ...filesOf(held, patch, patchProblem),
      fetchedAtMs: msOf(fetchedAt),
      cached: fromCache
    }
  }

  /** Every comment of one thread, each through the same pipeline as a body. */
  async function renderThread(
    comments: PullReviewThread['comments']
  ): Promise<RenderedThreadComment[]> {
    return Promise.all(
      comments.map(async (comment) => ({ ...comment, html: await render(comment.body) }))
    )
  }

  /**
   * What the Conversation view has to admit about its diff-line threads.
   *
   * Three states and they are genuinely different facts, which is why this is a
   * sentence rather than a flag. **Never fetched** is a pull request cached by a
   * Helm that had no thread query - it must not read as "nobody annotated this",
   * which is the bug the query was added to fix. **Failed with something to fall
   * back on** keeps the old threads and captions them, which is this surface's
   * whole degradation rule. **Failed with nothing** says so plainly. And an
   * empty array that actually came back from GitHub says nothing at all, because
   * a pull request with no inline comments is not a pull request with a problem.
   */
  function threadsNote(detail: PullDetail, problem: string | null): string | null {
    const held = heldReviewThreads(detail)
    if (problem !== null) {
      // Terminated before anything is appended to it. What gh prints is a
      // fragment - `HTTP 502: the fixture is unwell` - with no full stop on the
      // end, and a sentence continued straight off one reads as a single run-on
      // that nobody can find the seam in.
      const said = /[.!?]$/.test(problem) ? problem : `${problem}.`
      if (held === undefined || held.length === 0) {
        return `Comments left on lines of the diff could not be read - ${said}`
      }
      // "Shown" rather than "below": this sentence sits at the foot of the
      // conversation and the threads it is about are above it, interleaved with
      // everything else by time rather than gathered into a block.
      //
      // No age in it either, and the age is not missing: it is painted beside
      // it from `threadsFetchedAtMs`, by the pane, off the same live clock every
      // other caption on this surface runs on. A moment turned into "4m ago" in
      // main is a moment that stops being true the second after it is sent.
      return `Comments left on lines of the diff could not be re-read - ${said} The ${String(held.length)} shown ${held.length === 1 ? 'is the one' : 'are the ones'} Helm already had.`
    }
    if (held === undefined) {
      return 'Comments left on lines of the diff have not been fetched for this pull request - it was cached before Helm could read them. Refresh to fetch them.'
    }
    return null
  }

  /**
   * GitHub's file list, with the patch laid over it.
   *
   * The list is the spine and the patch is what hangs off it, never the other
   * way round: `pr view --json files` is the same fetch the header's file count
   * and diff size come from, so a Files view built from the patch instead would
   * disagree with the header on exactly the pull requests whose patch was capped.
   * A file the patch does not describe still gets its row, its counts and its
   * badge - it simply has nothing to expand.
   */
  function filesOf(
    detail: PullDetail,
    patch: PullPatch | null,
    problem: string | null
  ): Pick<PullDetailView, 'files' | 'diffNote'> {
    const parsed = patch === null ? null : parseUnifiedDiff(patch.text, { truncated: patch.truncated })
    const byPath = parsed === null ? null : indexDiffByPath(parsed)

    const files: PullFileView[] = detail.files.map((file) => {
      const found = byPath?.get(file.path) ?? null
      return {
        ...file,
        status: found?.status ?? 'modified',
        oldPath: found?.oldPath ?? null,
        hunks: found?.hunks ?? [],
        binary: found?.binary ?? false,
        droppedLines: found?.droppedLines ?? 0
      }
    })

    return { files, diffNote: diffNote(patch, parsed?.truncated ?? false, problem, files) }
  }

  function diffNote(
    patch: PullPatch | null,
    truncated: boolean,
    problem: string | null,
    files: PullFileView[]
  ): string | null {
    if (problem !== null) return `The patch could not be fetched - ${problem}`
    if (patch === null) {
      // Not an error: a pull request cached by a Helm that never fetched
      // patches, opened again before anything refreshed it.
      return files.length === 0 ? null : 'No patch has been fetched for this pull request yet.'
    }
    if (truncated) {
      return `The patch is larger than the ${String(Math.round(MAX_DIFF_BYTES / (1024 * 1024)))}MB Helm fetches, so the files below it are listed without one.`
    }
    return null
  }

  // ---------------------------------------------------------------------
  // Reviewing one
  // ---------------------------------------------------------------------

  /**
   * The prompt, the working directory, and the checkout if one was asked for.
   *
   * Everything decided in this function is decided from the **cache and the
   * settings**, never from anything the window sent - which is the whole of the
   * "the renderer does not compose argv" rule (`LaunchProfileRequest` has the
   * same shape and the same reason). The window sends a repository path and a
   * number; a prompt that arrived over the wire would be a prompt no setting
   * governs.
   *
   * The order matters and is not an accident. The checkout happens **before**
   * the session is spawned, because a session started in a tree that is about
   * to move underneath it would read one revision and be told about another.
   */
  async function prepareReview(request: {
    repoPath: string
    number: number
  }): Promise<LaunchedReviewPlan> {
    const row = repoRow(request.repoPath)
    if (row === null || row.slug === null) {
      throw new Error(`${request.repoPath} has no github.com origin remote.`)
    }
    const slug = row.slug

    // The summary rather than the detail: a review needs the number, the branch
    // and the title, all of which the list fetch already has - so reviewing a
    // pull request never has to wait for a `pr view`.
    const cached = readPull(store, slug, request.number)
    if (cached === null) {
      throw new Error(
        `Pull request #${String(request.number)} is no longer in ${slug}'s open list.`
      )
    }

    const settled = settings()
    const warnings: string[] = []
    let checkedOut: string | null = null

    if (settled.prCheckout === 'checkout') {
      const command = await ghForDetail()

      // The guard, before anything is fetched. `readGitState` is the launcher's
      // own reader, so the count in this sentence is the count the project row
      // is showing - and Helm does not stash: moving somebody's uncommitted
      // work is the kind of help nobody asks for twice.
      const before = await readGitState(request.repoPath)
      if (before === null) {
        throw new Error(
          `${request.repoPath} is not a git repository, so there is nothing to check out into. Set "Check out the branch" back to off in Settings to review from the pull request's refs instead.`
        )
      }
      if (before.dirty > 0) {
        throw new Error(
          `${request.repoPath} has ${String(before.dirty)} uncommitted ${before.dirty === 1 ? 'change' : 'changes'}. Commit or stash them, or turn the checkout off in Settings to review without touching the tree.`
        )
      }

      /*
       * The one gh call that is about a directory, so the one that has to be
       * the gh that can reach it.
       *
       * Every other call here names its repository with `--repo` and is
       * therefore cwd-independent, which is why they stay on this machine's gh
       * and this machine's `gh auth`. A checkout moves a working tree, and a
       * tree inside a distribution can only be moved from inside it - Windows
       * gh against a `\\wsl$\...` path fails at the git underneath it (measured:
       * `failed to run git: warning: safe.directory 'undefined' not absolute`).
       *
       * That means the distro's own gh, with its own authentication, and it may
       * have neither. Both failures are reported rather than guessed at: the
       * run's own first line says which, and the sentence below names the
       * distribution so "gh: command not found" is not a mystery.
       */
      const routed = repoCommand(request.repoPath, 'gh')
      const inDistro = routed.file !== 'gh'
      const checkoutCommand: GhCommand = inDistro
        ? { file: routed.file, prefixArgs: routed.prefix, resolved: 'gh', hostCwd: homedir() }
        : command

      const run = await checkoutPull(checkoutCommand, slug, request.number, request.repoPath, {
        timeoutMs: CHECKOUT_TIMEOUT_MS
      })
      /*
       * Reported, not thrown, and git is still the source of truth below.
       *
       * The exit code used to be dropped entirely: the design reads the branch
       * back from git rather than trusting gh's output, which is right, but it
       * left a checkout that did not happen showing up only as a confusing
       * "the local branch is not what was expected" a few lines further down.
       * The reason belongs beside the outcome.
       */
      if (!run.ok) {
        warnings.push(
          inDistro
            ? `gh could not check the pull request out inside ${wslDistroOf(request.repoPath) ?? 'the distribution'}: ${run.error ?? firstLineOf(run.stderr) ?? 'it failed with no output'}. That distribution needs its own gh, signed in.`
            : `gh could not check the pull request out: ${run.error ?? firstLineOf(run.stderr) ?? 'it failed with no output'}.`
        )
      }

      // Asked of git rather than assumed from `headRefName`, and the difference
      // is real: `gh pr checkout` renames a fork's branch when the name is
      // already taken locally, so the branch the tree is actually on is the
      // only honest thing to report.
      const after = await readGitState(request.repoPath)
      checkedOut = after?.branch ?? null
      if (checkedOut === null) {
        warnings.push('gh checked the pull request out, but git did not report a branch name.')
      } else if (checkedOut !== cached.summary.headRefName) {
        warnings.push(
          `The local branch is ${checkedOut}, not ${cached.summary.headRefName} - gh renamed it to avoid a collision.`
        )
      }
    }

    // Rendered here, in main, from the template as stored. The pane renders the
    // same template for its disclosure sentence; that copy is a preview and
    // never travels.
    const prompt = renderPullPrompt(settled.prReviewPrompt, {
      number: cached.summary.number,
      url: cached.summary.url,
      // The branch as GitHub names it, which is what the setting's help text
      // says `{branch}` means - including the fork case where the tree does not
      // have it unless the checkout above just fetched it.
      branch: cached.summary.headRefName,
      title: cached.summary.title,
      slug
    })

    return {
      repoPath: row.path,
      slug,
      number: cached.summary.number,
      prompt,
      // Read here with everything else the launch is composed from, so the
      // window cannot send a model any more than it can send a prompt.
      model: settled.prReviewModel,
      effort: settled.prReviewEffort,
      checkedOut,
      warnings
    }
  }

  // ---------------------------------------------------------------------
  // The snapshot
  // ---------------------------------------------------------------------

  function build(): PullsSnapshot {
    const rows = new Map(readPrRepos(store).map((row) => [row.path.toLowerCase(), row]))
    const pullsBySlug = readPullsBySlug(store)
    const known = projects()
    const ignoredRepos = settings().prIgnoredRepos

    /** Ignored slugs a scanned project maps to: what to call them, and where. */
    const ignoredPresent = new Map<string, { name: string; paths: string[] }>()

    /**
     * Projects whose origin remote has not been read yet.
     *
     * Counted rather than inferred, because the two states are the same absence
     * otherwise: a project Helm has never run `git remote get-url` in has no row
     * here, and so does one whose remote turned out to be GitLab. Without this
     * the pane told a fresh install that none of its folders was on GitHub while
     * the very first sweep was still finding out.
     */
    let unmapped = 0

    const repos: PullRepo[] = []
    for (const project of known) {
      const row = rows.get(project.path.toLowerCase())
      if (row === undefined) unmapped += 1
      // Only repositories with a github.com origin are listed. The rest are
      // counted - `checked` is what lets the pane say "nothing here is on
      // GitHub" rather than showing an empty list with no explanation.
      if (row === undefined || row.slug === null) continue
      if (isRepoIgnored(ignoredRepos, row.slug)) {
        // First checkout wins the name. Two directories for one slug are one
        // entry, because the setting is one entry - and a list that named the
        // same repository twice would offer two ticks for one fact. Every
        // directory is still collected: the entry is one tick, but each of
        // those checkouts has a project pane that has to know it is covered.
        const held = ignoredPresent.get(row.slug.toLowerCase())
        if (held === undefined) {
          ignoredPresent.set(row.slug.toLowerCase(), { name: project.name, paths: [project.path] })
        } else {
          held.paths.push(project.path)
        }
        continue
      }
      repos.push({
        path: project.path,
        name: project.name,
        url: row.url,
        slug: row.slug,
        fetchedAtMs: msOf(row.fetchedAt),
        error: row.error,
        pulls: pullsBySlug.get(row.slug) ?? []
      })
    }

    // Busiest first, then alphabetical, so the order is stable between passes
    // for the repositories that have nothing.
    repos.sort((a, b) => {
      const activity = (repo: PullRepo): number => repo.pulls[0]?.updatedAt ?? 0
      return activity(b) - activity(a) || a.name.localeCompare(b.name)
    })

    // Distinct (slug, number): two checkouts of one repository are two rows and
    // one set of pull requests, and counting them twice would overstate the
    // sidebar.
    const distinct = new Set<string>()
    for (const repo of repos) {
      for (const pull of repo.pulls) distinct.add(`${repo.slug ?? ''}#${String(pull.number)}`)
    }

    const ages = repos
      .map((repo) => repo.fetchedAtMs)
      .filter((at): at is number => at !== null)

    // Every entry of the setting, not only the ones a project maps to: a slug
    // whose checkout has been deleted or renamed still occupies the list and
    // still has to be removable, and a settings row that vanished with the
    // directory would leave a repository ignored for ever with nothing on
    // screen saying so.
    const ignored: IgnoredRepo[] = ignoredRepos
      .map((slug) => {
        const mapped = ignoredPresent.get(slug.toLowerCase())
        return {
          slug,
          name: mapped?.name ?? (slug.split('/')[1] ?? slug),
          present: mapped !== undefined,
          paths: mapped?.paths ?? []
        }
      })
      .sort((a, b) => a.slug.toLowerCase().localeCompare(b.slug.toLowerCase()))

    return {
      repos,
      ignored,
      open: distinct.size,
      checked: known.length,
      unmapped,
      gh: ghStatus ?? {
        path: null,
        source: null,
        version: null,
        authenticated: false,
        problem: null
      },
      // The oldest, not the newest: see `PullsSnapshot`.
      fetchedAtMs: ages.length === 0 ? null : Math.min(...ages),
      fetching: inFlight !== null
    }
  }

  function publish(): PullsSnapshot {
    const next = build()
    const nextSignature = signature(next)
    if (nextSignature !== lastSignature) {
      lastSignature = nextSignature
      onChange(next)
    }
    return next
  }

  // ---------------------------------------------------------------------
  // Driving it
  // ---------------------------------------------------------------------

  function refresh(request?: { repoPath?: string }): Promise<PullsSnapshot> {
    if (inFlight !== null) return inFlight
    started += 1
    const only = request?.repoPath ?? null
    const attempt = pass(only)
      .catch((err: unknown) => {
        // A pass that threw - a database that would not take a write, a bug in
        // here - is recorded and swallowed. The next tick is the next chance,
        // and an interval that dies on the first bad pass is an interval that
        // stops silently.
        failed += 1
        lastError = err instanceof Error ? err.message : String(err)
        console.warn(`pull request refresh failed: ${lastError}`)
      })
      .then(() => {
        lastPassAtMs = Date.now()
        inFlight = null
        return publish()
      })
    inFlight = attempt
    // Painted immediately as "fetching" so the refresh control can spin without
    // waiting for the network.
    onChange(build())
    return attempt
  }

  function pollMs(): number {
    if (pollFixtureMs !== null) return pollFixtureMs
    const minutes = settings().prPollMinutes
    return minutes <= 0 ? 0 : minutes * 60_000
  }

  function arm(): void {
    if (poll !== null) {
      clearInterval(poll)
      poll = null
    }
    const ms = pollMs()
    if (ms <= 0) return
    poll = setInterval(() => {
      void refresh()
    }, ms)
    poll.unref()
  }

  return {
    snapshot: () => build(),
    refresh,
    republish: publish,
    detail,
    prepareReview,

    refreshOnFocus() {
      if (inFlight !== null) return false
      // Never the *first* fetch: a window coming forward before anything has
      // been fetched at all is a cold start, and that pass is started
      // deliberately from `rendererReady` rather than by whoever clicked.
      if (!everFetched) return false
      if (Date.now() - lastPassAtMs < FOCUS_MIN_INTERVAL_MS) return false
      void refresh()
      return true
    },

    rearm() {
      // The gh status too: `ghPath` and the interval are written through the
      // same channel, and a cached status would keep naming the old executable.
      ghStatus = null
      verdictFromFetch = false
      arm()
    },

    start: arm,

    stop() {
      if (poll !== null) clearInterval(poll)
      poll = null
    },

    pointGh(path) {
      ghFixture = path
      ghStatus = null
      verdictFromFetch = false
    },

    pointRemotes(remotes) {
      remoteFixture = remotes
    },

    pointPollMs(ms) {
      pollFixtureMs = ms
      arm()
    },

    passes: () => ({ started, failed, lastError })
  }
}

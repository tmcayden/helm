/**
 * The vocabulary every surface shares. Nothing here may reference Electron,
 * the DOM, or a database driver - these are the shapes that cross the IPC wire
 * and get persisted, and both sides have to agree on them.
 *
 * It is also the one module the renderer may import *values* from, so the two
 * config parsers the editor needs before it is allowed to save are re-exported
 * through here. Both files they come from are pure by construction; adding a
 * `node:` import to either would break the renderer bundle at rollup rather
 * than at typecheck (CLAUDE.md, hard rules).
 */

// Imported as well as re-exported: `AppSettings` below names it, and a
// re-export alone does not bring a name into this file's scope.
import type { UsageDisplayMode } from './usage/shape'
// The same, for `CreateConfigRequest` below.
import type { CreatableKind } from './config/names'
// The same, for a value: `DEFAULT_SETTINGS` reads the polling default off it.
import { PR_POLL_MINUTES, PR_STALE_DAYS, type PrCheckoutMode } from './github/types'
// And for the review template's default, which is the prompt module's to state.
import { DEFAULT_PR_REVIEW_PROMPT } from './github/prompt'
// The same again: `AppSettings.browserReach` names it.
import type { BrowserReach } from './browser/reach'

/**
 * The browser pane's URL rules, re-exported here rather than from the package
 * root for the reason `PR_CHECKOUT_MODES` and `USAGE_DISPLAY_MODES` are: the
 * address bar and the settings pane are *renderer* code, and a value import
 * from `@helm/core` reaches the filesystem through `launch/` and `store/`,
 * which fails at rollup rather than at typecheck. These are pure by
 * construction - they decide about a string and touch nothing.
 */
export {
  agentReach,
  BROWSER_REACH_MODES,
  browserReachAllows,
  isLoopbackUrl,
  resolveBrowserAddress,
  type BrowserReach,
  type ReachDecision
} from './browser/reach'

export {
  frontmatterField,
  parseFrontmatter,
  validateJson,
  type Frontmatter,
  type JsonProblem
} from './config/validate'
/**
 * The naming rules, for the same reason and by the same argument: the New and
 * Rename dialogs have to refuse a name the CLI could not address *as it is
 * typed*, which means the check runs in the renderer. `create-rename-delete.ts`
 * runs it again on the main side, where it is the guarantee rather than the
 * courtesy.
 */
export {
  checkConfigName,
  configUnit,
  isRenamable,
  planConfigFile,
  renameRefusal,
  CREATABLE_KINDS,
  RENAMABLE_KINDS,
  type ConfigFilePlan,
  type CreatableKind,
  type CreatableKindSpec,
  type NameCheck,
  type PlanInput,
  type PlanResult
} from './config/names'
export {
  settingHint,
  topLevelKey,
  SETTING_HINTS,
  type SettingHint
} from './config/settings-schema'
/**
 * And the join between a `.claude` tree and what a session would do with it.
 * Pure by the same rule: it reads no file, only an `EffectiveView` that has
 * already been computed, so the window can ask it about a row without a
 * round trip and without a second answer to the question the Effective tab
 * already answers.
 */
export {
  computeConfigLive,
  configFileNote,
  hookBindings,
  isRedactedConfigFile,
  samePath,
  settingReferences,
  settingsDeclaredBy
} from './config/live'
/**
 * The usage reader's pure half, re-exported for the same reason: the status bar
 * re-derives what it may paint on a timer, from the same functions the main
 * process parsed with. Two implementations of "is this reading still good" is
 * exactly the bug this file exists to prevent.
 */
export {
  describeAge,
  nextUsageMode,
  offerableUsageModes,
  parseUsage,
  usageProblem,
  usageView,
  COST_MODE_UNAVAILABLE,
  USAGE_DISPLAY_MODES,
  USAGE_STALE_AFTER_MS,
  type UsageBucket,
  type UsageDisplayMode,
  type UsageGroup,
  type UsageLimit,
  type UsageProblem,
  type UsageProblemKind,
  type UsageSeverity,
  type UsageSnapshot,
  type UsageSpend,
  type UsageTokens,
  type UsageView,
  type UsageWindowCost
} from './usage/shape'
export {
  costOfTokens,
  priceFor,
  priceTableAgeDays,
  PRICES,
  PRICE_TABLE_DATE,
  PRICE_TABLE_FRESH_FOR_DAYS,
  type ModelPrice,
  type TokenPrice
} from './usage/prices'
/**
 * The pull-request vocabulary, re-exported for the same reason: the Pulls pane
 * and the sidebar are renderer code, and `github/types.ts` is pure by
 * construction while the rest of `github/` spawns a subprocess.
 */
export {
  isRepoIgnored,
  isRepoSlug,
  withRepoIgnored,
  PR_CHECKOUT_MODES,
  PR_IGNORED_REPOS_MAX,
  PR_POLL_MINUTES,
  PR_STALE_DAYS,
  type GhProblem,
  type GhProblemKind,
  type GhStatus,
  type IgnoredRepo,
  type LaunchedReviewPlan,
  type PrCheckoutMode,
  type PullChecks,
  type PullComment,
  type PullCommit,
  type PullConversationEntry,
  type PullConversationItem,
  type PullDetail,
  type PullDetailView,
  type PullDiff,
  type PullDiffHunk,
  type PullDiffLine,
  type PullFile,
  type PullFileDiff,
  type PullFileStatus,
  type PullFileView,
  type PullPatch,
  type PullRepo,
  type PullReview,
  type PullReviewDecision,
  type PullReviewThread,
  type PullSummary,
  type PullsSnapshot,
  type PullThreadComment,
  type PullThreadEntry,
  type RenderedPullEntry,
  type RenderedPullItem,
  type RenderedPullThread,
  type RenderedThreadComment,
  type RepoRemote
} from './github/types'
/**
 * The per-file line ceiling, re-exported because the pane that stops painting
 * at it is the pane that has to name it: the sentence under a cut-short file
 * says how many lines it kept, and a renderer holding its own copy of the
 * number would eventually say a number the parser does not use. Pure - `diff.ts`
 * imports nothing but types.
 */
export { MAX_FILE_LINES } from './github/diff'
/**
 * The thread-to-diff-row join, re-exported for the same reason and under the
 * same guarantee: `diff.ts` is pure and imports nothing but types, so this
 * reaches the browser bundle without dragging `launch/` or `store/` into it.
 *
 * In core rather than in the pane because it is the one part of the Files
 * view's thread markers that is a *decision* rather than a rendering - what to
 * do when the patch and the threads, fetched separately, disagree about where a
 * line is - and a decision belongs where it can be unit-tested.
 */
export { anchorThreadsToFile } from './github/diff'
export type { AnchoredThreads, ThreadLooseReason, ThreadPosition } from './github/diff'
/**
 * The review prompt's template renderer, re-exported for the same reason again:
 * the detail pane's disclosure sentence names the exact prompt the button will
 * run, so it renders the template itself. The prompt that is actually launched
 * is composed in the main process - see `desktop/src/main/pulls.ts` - and this
 * side never sends one.
 */
export {
  renderPullPrompt,
  DEFAULT_PR_REVIEW_PROMPT,
  PR_PROMPT_PLACEHOLDERS,
  PR_REVIEW_PROMPT_MAX_LENGTH,
  type PullPromptFacts,
  type PullPromptPlaceholder
} from './github/prompt'

/**
 * What the editors do when you press a key.
 *
 * Re-exported here rather than reached for through the package root, because
 * the component that calls them runs in the browser bundle and this file is the
 * one entry point with no `node:` behind it. `content/editing.ts` imports
 * nothing at all, which is what makes that safe - and is why the editing rules
 * live away from both the DOM and shiki.
 */
export {
  backspaceAction,
  caretAt,
  editorExtension,
  editorKeyAction,
  enterAction,
  findMatchesIn,
  indentAction,
  lineStarts,
  pairAction,
  syntaxFor,
  wrapsByDefault,
  type EditAction,
  type EditorSyntax
} from './content/editing'

/** What a discovered directory turned out to be. */
export type ProjectKind =
  /** Has a `harness.yaml`. Its `repos/*` children are projects in their own right. */
  | 'harness'
  /** A repo inside a harness's `repos/` directory. */
  | 'repo'
  /** A directory that is neither, scanned because a root path pointed at it. */
  | 'folder'

/**
 * Counts of what a project's `.claude/` directory actually contains.
 *
 * Counted the way Claude Code resolves them, not the way a file listing would:
 * a skill is a directory holding a `SKILL.md`, and commands and agents are
 * markdown files at any depth (`commands/spec/plan.md` is the `/spec:plan`
 * command, so a top-level count of that tree would report 1 instead of 20).
 */
export interface ClaudeInventory {
  skills: number
  commands: number
  agents: number
  hooks: boolean
  settings: boolean
  claudeMd: boolean
  mcp: boolean
}

export const EMPTY_INVENTORY: ClaudeInventory = {
  skills: 0,
  commands: 0,
  agents: 0,
  hooks: false,
  settings: false,
  claudeMd: false,
  mcp: false
}

/** Working-tree summary for the launcher's per-project chips. */
export interface GitState {
  branch: string | null
  /** Detached HEAD, mid-rebase, or otherwise not on a named branch. */
  detached: boolean
  /** Files with any staged, unstaged, or untracked change. */
  dirty: number
  ahead: number
  behind: number
  /** Set when the directory is a repo but git could not answer. */
  error?: string
}

export interface Project {
  /** Absolute, normalised path. Stable across scans; the identity of a project. */
  path: string
  name: string
  kind: ProjectKind
  /** Path of the harness this project belongs to, if any. */
  harnessPath: string | null
  hasClaudeDir: boolean
  inventory: ClaudeInventory
  git: GitState | null
}

export interface Harness {
  path: string
  name: string
  /** Parsed from `harness.yaml` when present. */
  template: string | null
  version: string | null
  /** Absolute paths of the projects found under `repos/`. */
  repoPaths: string[]
}

export interface DiscoveryResult {
  /** The root paths that were scanned. */
  roots: string[]
  harnesses: Harness[]
  projects: Project[]
  /** Roots that could not be read, with the reason. */
  errors: Array<{ path: string; message: string }>
  scannedAt: string
  durationMs: number
}

/**
 * How a hosted session ended, or that it has not.
 *
 * `lost` is the honest answer for a row that was still `running` when the
 * process that owned it went away - a crash, a kill from Task Manager, a power
 * cut. The alternative, stamping an end time at the next launch, would invent a
 * duration nobody measured.
 */
export type SessionStatus = 'running' | 'exited' | 'lost'

/** One hosted `claude` process, from spawn to exit. */
export interface SessionRecord {
  id: number
  /** The `-n` name handed to the CLI, so the session is identifiable in
   * `/resume` later (SPEC 4.1, and the session index reads these rows). Never
   * rewritten - a rename writes `label`. See the column comment in `schema.ts`. */
  name: string
  /** What Helm calls it on screen, or null for "use `name`". `sessionLabel`. */
  label: string | null
  cwd: string
  /** The branch `cwd` was on when this was spawned. Null for a non-repo cwd, a
   * detached HEAD, or a read that failed. Captured, never followed. */
  branch: string | null
  /** The discovered project it was launched against, if it was one. */
  projectPath: string | null
  /** The profile it was launched from, if it was one. Not a foreign key: the
   * session is a record of what happened and outlives a deleted profile. */
  profileId: number | null
  /** Argv after the executable, as spawned. */
  argv: string[]
  /**
   * The Claude Code conversation id this session is having, or null.
   *
   * **Assigned, not discovered.** Helm mints a uuid and hands it over in argv
   * (`--session-id`), so the row and the conversation agree from the first
   * instant rather than from whenever something managed to read one out of the
   * other. A resumed session carries the id it resumed, because that is the
   * conversation it is.
   *
   * Null for a session launched before this column existed, and for one
   * launched against a CLI with no `--session-id` flag. Both are read as "no
   * durable join", never as an error.
   *
   * Three measured facts shape what it may be used for, all against 2.1.238:
   *
   *   - **A `/clear` re-registers under a new id, same process.** So this is
   *     the id the conversation *started* as, and a live join may not depend on
   *     it staying current - see `joinSessionRegistry`, which uses it once to
   *     learn the process and then follows the process.
   *   - **`/compact` keeps it.** A compaction is the same conversation.
   *   - **A uuid that already exists is refused**: `Error: Session ID <uuid> is
   *     already in use.` and exit 1. So an id is minted per launch and never
   *     reused, and this column is a record rather than something to launch
   *     from.
   */
  claudeSessionId: string | null
  status: SessionStatus
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  /** Null while running, and for a session whose exit code was never observed. */
  exitCode: number | null
}

/**
 * What a live Claude Code session says it is doing.
 *
 * These four are the CLI's own vocabulary, not Helm's: they are the enum its
 * registry validator accepts, and Helm neither adds to it nor collapses it.
 * Confirmed against **2.1.238** by driving a real session through every one of
 * them and keeping the records - see `packages/core/src/registry/registry.ts`
 * for what each one was provoked with.
 *
 * A const array because a component maps it to a tone, which makes it a
 * *value* in the browser bundle - so it lives in `types.ts`, the one entry
 * point safe to import values from (CLAUDE.md "Boundaries").
 */
export const SESSION_ACTIVITIES = ['busy', 'shell', 'idle', 'waiting'] as const
export type SessionActivity = (typeof SESSION_ACTIVITIES)[number]

/**
 * One record out of `~/.claude/sessions/<pid>.json`, parsed tolerantly.
 *
 * Every field but `pid` and `file` is optional, because every field but those
 * two has been observed absent: a record is written the instant a session
 * registers and gains its `status` only when the interactive loop publishes
 * one, so the very first record of every session has no status at all.
 *
 * This is undocumented CLI internals. The parse is deliberately shaped so that
 * a field going missing, changing type or gaining a sibling costs a value and
 * never an exception.
 */
export interface SessionRegistryEntry {
  /** The file this came out of, for diagnostics. `<pid>.json`. */
  file: string
  /**
   * The pid Claude Code registered under - **its own**, which is not always the
   * one Helm holds. Through a `.cmd` shim the pty is `cmd.exe` and `claude.exe`
   * is its child, so the two differ; measured, pty 23496 against registry 4068.
   */
  pid: number
  /**
   * Windows FILETIME of the process's creation, as a decimal string, or null.
   *
   * The one thing that makes a pid safe to join on. Claude Code's own registry
   * sweep does not compare it and is therefore blind to pid reuse; a reader
   * joining on pid should not be.
   */
  procStart: string | null
  /** The conversation id. Changes under a `/clear` without the pid changing. */
  sessionId: string | null
  cwd: string | null
  /** The `-n` name. */
  name: string | null
  /** The CLI version that wrote the record. */
  version: string | null
  /** `cli` for an interactive run, `sdk-cli` for a `-p` one. */
  entrypoint: string | null
  /** Epoch ms the process registered at. */
  startedAt: number | null
  /**
   * The published status, or null where the record carried none **or carried
   * one this build does not recognise**.
   *
   * Those two are deliberately the same value here and are told apart by
   * `rawStatus`: both mean "Helm has nothing to say", which is the only honest
   * answer to a status it cannot interpret. A CLI that renames one of the four
   * therefore degrades to painting what the tab painted before this existed,
   * never to a guess.
   */
  activity: SessionActivity | null
  /** Exactly what the `status` field held, whatever it was. Null when absent. */
  rawStatus: string | null
  /**
   * Why the session is blocked, when it is - the CLI's own sentence.
   *
   * Two were measured on 2.1.238: `"dialog open"` for a slash command that
   * renders a UI, and `"permission prompt"` for a tool call awaiting approval.
   * Carried verbatim and never matched against, because it comes from whatever
   * dialog is on top rather than from a fixed list.
   */
  waitingFor: string | null
  /**
   * When the status last changed, epoch ms, or null.
   *
   * **Its age says nothing about staleness.** The file is written on
   * transition and never on a timer - a `busy` record carrying an 18-minute-old
   * stamp is an ordinary long tool call. Liveness is the only test, and it is
   * `probeProcess`. Present for diagnostics; nothing in Helm may infer from it.
   */
  statusUpdatedAt: number | null
}

/**
 * What one of Helm's own sessions is doing, ready for the tab.
 *
 * Null activity is the ordinary state, not an error: a session whose registry
 * record has not appeared yet, whose process cannot be proved alive, or that is
 * publishing a status this build does not know. All three paint what the tab
 * painted before any of this existed.
 */
export interface SessionActivityState {
  /** Helm's own session row id. */
  id: number
  activity: SessionActivity | null
  /** The CLI's sentence for a `waiting` session. Null otherwise. */
  waitingFor: string | null
  /**
   * The conversation id the registry is currently reporting under.
   *
   * Not necessarily `SessionRecord.claudeSessionId`: a `/clear` gives the same
   * process a new one, and this is the live value.
   */
  claudeSessionId: string | null
}

/**
 * One live Claude Code session on this machine, whoever started it.
 *
 * **Listing is machine-wide; detail is Helm's own.** The registry Claude Code
 * keeps is not Helm's - a `claude` in Windows Terminal writes a record beside
 * anything Helm hosts - and a listing that only showed Helm's own would answer
 * "is anybody working in this tree" wrongly in exactly the case somebody gets
 * hurt by it. So every record is listed, and the fields below are the whole of
 * what a record carries. Everything richer - branch, profile, overlays, argv,
 * the process tree, the ports - hangs off `helmSessionId`, because Helm has
 * none of it for a session it did not spawn. That degradation needs no special
 * case: it is simply what is knowable.
 *
 * This is the same rule `browser_tabs` established, arrived at from the other
 * side: listing is not driving.
 */
export interface LiveSession {
  /**
   * Helm's own session row id, or null for a session Helm does not host.
   *
   * The whole of the hosted/not distinction, and it is a join key rather than a
   * flag: everything Helm knows beyond the record is reached through it.
   */
  helmSessionId: number | null
  /**
   * The pid the session is registered under, or the pty's pid for a hosted
   * session that has no record yet.
   *
   * Not necessarily the same process in the two cases: through a `.cmd` shim
   * the pty is `cmd.exe` and `claude.exe` registers under its own pid. Which
   * one this is, is what `registered` says.
   */
  pid: number
  /**
   * Whether a registry record was found for it.
   *
   * False is an ordinary state rather than an error, and there are two measured
   * ways into it: the second between spawn and registration, and a session
   * sitting on the workspace-trust prompt, which registers only after the
   * startup gates. A Helm session in that state is listed anyway - Helm knows
   * its own processes are running - carrying what its row says and nothing the
   * record would have added.
   */
  registered: boolean
  /** The working directory. From the record, or from Helm's row. */
  cwd: string | null
  /** What it is called: the `-n` name, or Helm's own label for a hosted one. */
  name: string | null
  activity: SessionActivity | null
  /** The CLI's own sentence for a `waiting` session, verbatim. */
  waitingFor: string | null
  /**
   * When the status above was last published, epoch ms, or null.
   *
   * Carried so a surface can say **how long** a session has been busy, or
   * waiting, which is the difference between "it is working" and "it has been
   * working for forty minutes". That is a different claim from the one
   * `SessionRegistryEntry.statusUpdatedAt` forbids, and the two are worth
   * keeping apart: the record is written on transition and never on a timer, so
   * its age says exactly how long this status has held, and says **nothing**
   * about whether the session is still alive. Liveness is `probeProcess` and
   * only `probeProcess` - by the time a value reaches this field the record has
   * already been through that filter.
   */
  statusSinceMs: number | null
  /** The CLI version that wrote the record. Null for an unregistered one. */
  version: string | null
  /** `cli` for an interactive run, `sdk-cli` for a `-p` one. */
  entrypoint: string | null
  /** Epoch ms the session registered at, or Helm's own start time. */
  startedAtMs: number | null
  /** The conversation id the registry is reporting under. */
  claudeSessionId: string | null
}

/** Every live session on the machine, as one pass saw them. */
export interface SessionsOverview {
  /** Hosted first, then the rest; each group by start time, newest last. */
  sessions: LiveSession[]
  /** When the registry was read, epoch ms. */
  readAtMs: number
}

/**
 * One process in a session's tree.
 *
 * **Helm spawned the pty, so the tree under it is Helm's own process tree**,
 * not a reading of anybody's conversation. That is the whole argument for this
 * being in scope: nothing here parses session output or infers anything from
 * what a model said - it asks the operating system what the children of a
 * process Helm started are, which is a question Helm is entitled to ask about
 * its own children and about nothing else.
 */
export interface SessionProcess {
  pid: number
  parentPid: number
  /** The image name, e.g. `docker.exe`. Machine data, so it renders in mono. */
  name: string
  /**
   * The full command line, or null where the host would not give it up.
   *
   * Null is routine rather than exceptional and it is **not** an error: on this
   * machine 159 of 277 processes refused one to an unelevated query. Helm makes
   * no elevation assumption anywhere, so a process it may not open is a process
   * reported as unknown - never one that fails the pass.
   */
  commandLine: string | null
  /** How far below the session's own process this sits. The root is 0. */
  depth: number
  /**
   * The ports this process is listening on, ascending - or null where the
   * socket query could not run at all.
   *
   * Nullable on its own rather than folded into the tree's own nullability,
   * because the two queries fail independently: a tree read with no socket
   * answer must say "not known" here and not the empty list, which would be a
   * claim that this process is listening on nothing.
   */
  ports: number[] | null
}

/** A listening socket held somewhere in a session's process tree. */
export interface SessionPort {
  port: number
  pid: number
  /** The image name of the process holding it. */
  process: string
  /**
   * Every local address it is bound to, sorted - `127.0.0.1`, `0.0.0.0`, `::`.
   *
   * A list rather than one string because a server routinely binds the same
   * port twice, once per address family, and "which interfaces is this reachable
   * on" is a different question from "which port". Collapsing them would lose
   * the difference between a loopback-only dev server and one on every
   * interface, which is the difference that matters when two machines share a
   * network.
   */
  addresses: string[]
}

/**
 * What one session Helm hosts is currently holding.
 *
 * Every field that can be unknown is nullable, and the rule the whole shape is
 * built on is that **"could not look" and "nothing there" are different
 * claims**. A pass that could not enumerate processes leaves `processes` null,
 * and the pane says so; a pass that enumerated and found the session childless
 * leaves it `[]`. A surface that merged them would tell somebody a session is
 * holding nothing at the exact moment Helm had failed to ask.
 */
export interface SessionResources {
  /** Helm's own session row id. */
  id: number
  /**
   * The pty's pid: the root of the tree, and provably Helm's own child.
   *
   * Deliberately the pty's rather than the registry record's. Through a `.cmd`
   * shim those differ - the pty is `cmd.exe` and `claude.exe` is beneath it -
   * and the pty's is the one that roots *everything the session started*,
   * including the shim itself. It is also the one Helm holds without asking
   * anybody.
   */
  rootPid: number
  /**
   * The tree under `rootPid`, root first and then breadth-first, or null where
   * the host could not be asked at all.
   */
  processes: SessionProcess[] | null
  /**
   * Whether `rootPid` was in the enumeration.
   *
   * Distinguishes the third state from the other two: the pass ran, and the
   * session's own process was not in it. That is a session that exited between
   * the pass being scheduled and it running, which is ordinary - and it is not
   * the same claim as "it has no children".
   */
  rootSeen: boolean
  /** Listening sockets anywhere in the tree, or null where none was asked for. */
  ports: SessionPort[] | null
  /**
   * How many processes in the tree would not give up a command line.
   *
   * Reported rather than hidden: it is the size of what this pass could not
   * see, and a pane that showed twelve rows without saying four of them are
   * opaque would be implying a completeness it does not have.
   */
  opaque: number
  /** When the pass that produced this ran, epoch ms. */
  atMs: number
}

/**
 * What to call a session on screen: its label if it has one, its `-n` name if
 * not.
 *
 * One function rather than `label ?? name` at each call site, and that is the
 * whole reason it exists. A session is named in four places - the tab, the tab's
 * hover hint, the sidebar's live-session tooltip, and the confirmation before it
 * is ended - and the failure a shared helper prevents is the one where the tab
 * says "PR review", the dialog asking to end it says "dev 2", and the user has
 * to work out that those are the same session before answering a question whose
 * cost is whatever the session had not finished saying.
 *
 * In `types.ts` because the renderer imports it, and a value import into the
 * browser bundle comes from `@helm/core/types` and not the package root
 * (CLAUDE.md "Boundaries").
 */
export function sessionLabel(session: Pick<SessionRecord, 'name' | 'label'>): string {
  return session.label ?? session.name
}

/**
 * One prompt a person submitted, as `~/.claude/history.jsonl` recorded it.
 *
 * This file is Claude Code's own, shared by every session on the machine and
 * appended to whether or not Helm is running. Helm reads it and never writes
 * to it.
 */
export interface HistoryPrompt {
  sessionId: string
  /** Submission order across the whole file. Monotonic, not necessarily dense. */
  seq: number
  /** The prompt as typed, verbatim. */
  text: string
  /** Epoch milliseconds, as recorded. */
  at: number
}

/**
 * A session `history.jsonl` knows about, and whether it can still be resumed.
 *
 * The two facts come from different places and only one of them is durable.
 * The prompts persist indefinitely; the transcript that `--resume` actually
 * needs is reaped on Claude Code's own schedule - 105 of 799 survive on the
 * machine this was built against - so resumability is a property of the disk
 * right now, re-read on every index pass rather than remembered.
 */
export interface HistorySession {
  sessionId: string
  /** Working directory the session ran in, exactly as history recorded it. */
  project: string
  /** Last path segment of `project`, for a list that has no room for the rest. */
  projectName: string
  promptCount: number
  firstAt: number
  lastAt: number
  /** The opening prompt, verbatim. What was said first, not what this is called. */
  firstPrompt: string
  /**
   * What to call this session, derived from its prompts.
   *
   * Never empty, and not the same thing as `firstPrompt`: the opening prompt is
   * a slash command in 291 of this machine's 1,011 sessions and an image
   * placeholder in others, which is a row that says nothing. See
   * `discovery/title.ts` for what is read instead, and `historyTitle` for the
   * name a surface should actually paint.
   */
  title: string
  /**
   * True when no prompt survived cleaning and `title` is Helm's own words for
   * an empty record - "Image only", "No prompt recorded". A stand-in is not
   * something to draw in the same weight as a sentence somebody wrote.
   */
  titleFallback: boolean
  /**
   * The name somebody gave this session by hand, or null.
   *
   * Kept apart from `title` for the reason `SessionRecord` keeps `label` apart
   * from `name`: clearing it has to return the row to its derived title, and a
   * single field that had been overwritten could not.
   */
  label: string | null
  /** The transcript on disk, or null once it has been reaped. */
  transcriptFile: string | null
  transcriptBytes: number | null
  /** False when the recorded working directory is no longer there. */
  projectExists: boolean
  /**
   * What Helm's own archive holds for this session, or null when it has never
   * held anything.
   *
   * The third fact about a session, alongside the transcript and the folder,
   * and it does not follow from either: a conversation Claude Code reaped can
   * still be readable here, and one that is still on disk may never have been
   * captured. `'evicted'` is deliberately not folded into null - see
   * `ArchiveSessionState`.
   */
  archive: ArchiveSessionState | null
  /** Messages in the archive for it. Zero once the ceiling has dropped them. */
  archivedMessages: number | null
  /**
   * The first prompt that matched the search, when the query had one. Absent
   * for an unfiltered listing rather than set to the opening prompt, so the UI
   * can tell "matched here" from "this is just the start of it".
   */
  match?: string | undefined
}

/**
 * The cap on a hand-given session name.
 *
 * Long enough for a sentence about what a session was, short enough that the
 * list stays a list. `sanitizeSessionName`'s 60 is a tab's width; this is a
 * row's, and the row is wider. Here rather than beside the write because the
 * field enforcing it is in the renderer and the write enforcing it is in main -
 * one number, imported by both, or the field lets you type what the write will
 * silently cut.
 */
export const HISTORY_NAME_MAX = 120

/**
 * What to call a history session on screen: the name it was given, or the one
 * derived from its prompts.
 *
 * `sessionLabel`'s twin, and it exists for the same reason - the list row, the
 * detail heading and the tab a resume opens all name the same session, and a
 * `label ?? title` written out three times is three places for them to
 * disagree. In `types.ts` because the renderer imports it (CLAUDE.md
 * "Boundaries").
 */
export function historyTitle(session: Pick<HistorySession, 'title' | 'label'>): string {
  return session.label ?? session.title
}

// ---------------------------------------------------------------------------
// Transcript archive
// ---------------------------------------------------------------------------

/**
 * What Helm's archive holds for a session.
 *
 * Two values and no third for "never captured", which is the absence of a row.
 * The distinction that has to survive every refactor is `'evicted'` against
 * null: "we had this conversation and dropped it to stay under your limit" and
 * "this was reaped before Helm ever saw it" are different facts about the same
 * missing text, and only one of them is something the user chose.
 */
export type ArchiveSessionState = 'archived' | 'evicted'

/** One message of an archived conversation, as the viewer renders it. */
export interface ArchiveMessage {
  uuid: string
  role: 'user' | 'assistant'
  /** Epoch ms. */
  at: number
  text: string
}

/**
 * One archived conversation.
 *
 * `messages` is empty for an evicted one, and the row is still returned: the
 * pane has something to say about a conversation Helm dropped, and nothing to
 * say about one it never had.
 */
export interface ArchivedConversation {
  sessionId: string
  /** The transcript it was read from. Usually gone by the time this is read. */
  sourceFile: string
  state: ArchiveSessionState
  firstAt: number | null
  lastAt: number | null
  messageCount: number
  /** Message text as read, before compression. */
  rawBytes: number
  /** What it costs in the database now. Zero once evicted. */
  storedBytes: number
  capturedAt: string
  evictedAt: string | null
  messages: ArchiveMessage[]
}

/** What the archive holds, for the settings pane to state rather than imply. */
export interface ArchiveStats {
  sessions: number
  /** Sessions the ceiling dropped. Counted separately; they are not gone-gone. */
  evictedSessions: number
  messages: number
  rawBytes: number
  /** Compressed message bodies. The figure the ceiling is enforced against. */
  storedBytes: number
  /** The ceiling in force, from `transcriptArchiveMaxBytes`. */
  maxBytes: number
  /** Last-message time of the oldest and newest archived conversation. */
  oldestAt: number | null
  newestAt: number | null
}

/**
 * Resuming needs both halves: the conversation to restore and the directory to
 * restore it in. `--resume <id>` is resolved against the working directory - a
 * session resumed from anywhere else reports "No conversation found", measured
 * on 2.1.225 - so a project that has been deleted is as fatal as a reaped
 * transcript, and the launcher says which one it is.
 */
export function canResume(session: HistorySession): boolean {
  return session.transcriptFile !== null && session.projectExists
}

/** One recorded working directory, with how much history it holds. */
export interface HistoryProject {
  project: string
  name: string
  sessions: number
  prompts: number
  lastAt: number
  resumable: number
  exists: boolean
}

/** What the index currently holds. Cheap enough to recompute on every change. */
export interface HistorySummary {
  sessions: number
  prompts: number
  projects: number
  /** Sessions that could be resumed right now. */
  resumable: number
  /** Newest prompt in the index, or null when it is empty. */
  latestAt: number | null
  /**
   * The primary history file - this machine's - so the UI can say where the
   * index came from and offer to re-read it.
   */
  historyFile: string
  /**
   * Every file being indexed, primary first.
   *
   * More than one whenever a WSL distribution is installed: a session hosted in
   * a distro appends to *that* distro's `~/.claude/history.jsonl` and never to
   * this machine's, so an index over one file would show the launcher a user's
   * Windows sessions and silently omit their Linux ones. They are read together
   * and counted together - a session is a session - and this is the list that
   * lets the UI say so instead of naming one file as if it were the whole
   * story.
   */
  historyFiles: string[]
  /**
   * Bytes consumed so far, summed across every file.
   *
   * Also what the renderer keys its caches on, which works for the same reason
   * it worked as a single cursor: it only ever grows while the sources are
   * stable, and a source resetting rebuilds everything anyway.
   */
  indexedBytes: number
  /** Set when the file could not be read at all. */
  error?: string | undefined
}

/**
 * What a search is over.
 *
 * `prompts` is the historic behaviour and the default: a substring of a prompt
 * or a project path, matched with `LIKE`. `messages` is the archive - every
 * word of every conversation Helm captured, through FTS5.
 *
 * Two scopes rather than one box that searches both, and that is a decision.
 * They answer different questions and return wildly different counts, and the
 * counts are the point: "sessions where I typed this" and "conversations where
 * this was said" are not the same list, and a box that quietly returned the
 * union would make the smaller of the two unreachable.
 */
export const HISTORY_SEARCH_SCOPES = ['prompts', 'messages'] as const
export type HistorySearchScope = (typeof HISTORY_SEARCH_SCOPES)[number]

export interface HistoryQuery {
  /** Case-insensitive substring of a prompt. Empty means no filter. */
  search?: string | undefined
  /** What `search` is matched against. Defaults to `prompts`. */
  scope?: HistorySearchScope | undefined
  /** One recorded working directory, compared case-insensitively. */
  project?: string | undefined
  /** Drop sessions that could not be resumed. */
  resumableOnly?: boolean | undefined
  limit?: number | undefined
}

export interface HistoryPage {
  /** Most recently active first. */
  sessions: HistorySession[]
  /** Sessions the query matched, before `limit` was applied. */
  total: number
  /** How long the query itself took, in milliseconds. */
  tookMs: number
}

/**
 * The launch knobs a profile carries, named as the CLI names them.
 *
 * Both lists are the CLI's own, copied rather than derived: they are the
 * choices `claude --help` prints for `--effort` and `--permission-mode` on the
 * pinned version, and a value outside them is rejected by the CLI after the
 * session has already been spawned. Keeping them here lets a profile be
 * validated at the point it is saved instead.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export const PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan'
] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/**
 * Where a session's `claude` process runs.
 *
 * Windows is the default and the only thing that existed before: `claude` is
 * the executable, the pty is its own, and every path on the argv is already
 * spelled the way the process will read it.
 *
 * A WSL target puts the CLI inside a distro, which changes three things and
 * nothing else. The program becomes `wsl.exe` with the real entry point behind
 * `--`; every path on the argv is translated (`core/wsl/path.ts`); and the
 * session's `~/.claude` is the distro's, not this user's - which is why the
 * history, transcript and usage readers take a root rather than asking
 * `homedir()`.
 *
 * Measured 2026-09-02, and the reason the overlay mechanism needed no second
 * implementation: a Windows directory junction surfaces inside the distro as a
 * symlink whose target is *already* translated to `/mnt/c/...`, and reads
 * through it work. So `--plugin-dir` composition (SPEC 2) crosses the boundary
 * unchanged for any project on a Windows drive.
 */
export type LaunchTarget = { kind: 'windows' } | { kind: 'wsl'; distro: string }

/**
 * Re-exported here, and only here, so the profile editor can ask the question.
 *
 * A target is not really a preference: a project under `\\wsl$\Ubuntu\...`
 * *cannot* run on Windows - `CreateProcess` refuses a UNC working directory -
 * so the launcher derives the target from the path and overrides whatever the
 * profile said. The editor showing a free choice that the launch then ignores
 * would be a control that lies, so it asks the same function and says the
 * answer instead.
 *
 * `wsl/path.ts` is pure - no `node:` imports anywhere behind it - which is what
 * makes this legal to pull into the renderer bundle through `@helm/core/types`
 * (CLAUDE.md, Boundaries). The rest of `wsl/` is not, and stays out.
 */
export { wslDistroOf } from './wsl/path'

/** The default, and what every profile authored before targets existed means. */
export const WINDOWS_TARGET: LaunchTarget = { kind: 'windows' }

/**
 * A launch target as one string: `windows`, or `wsl:<distro>`.
 *
 * One codec for both places a target is written down - the `target` column on
 * `profiles`, and the `target:` key in an exported profile. They are the same
 * fact, and two parsers would be two places for `wsl:Ubuntu` and `WSL:ubuntu`
 * to start disagreeing.
 *
 * It lives here rather than in `wsl/` because the profile editor needs it, and
 * a value import into the renderer bundle may only come from `@helm/core/types`
 * (CLAUDE.md, Boundaries) - the package root reaches the filesystem.
 *
 * Null is not a failure: it is the answer for `windows`, for an absent value,
 * and for a row written before targets existed, all of which mean the same
 * launch. An unreadable value lands there too, because reads stay tolerant -
 * a value from another build is a fact about the past.
 */
export function parseLaunchTarget(value: string | null | undefined): LaunchTarget | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || text.toLowerCase() === 'windows') return null
  const match = /^wsl:(.+)$/i.exec(text)
  if (match === null) return null
  const distro = (match[1] ?? '').trim()
  return distro === '' ? null : { kind: 'wsl', distro }
}

/** Writes a target. Windows is written out rather than left absent, so the
 * exported file shows what can be set where a missing key shows nothing. */
export function formatLaunchTarget(target: LaunchTarget | null | undefined): string {
  return target != null && target.kind === 'wsl' ? `wsl:${target.distro}` : 'windows'
}

/** What to call a target in a sentence a user reads. */
export function launchTargetLabel(target: LaunchTarget | null | undefined): string {
  return target != null && target.kind === 'wsl' ? target.distro : 'Windows'
}

/**
 * One WSL distribution, as `wsl.exe -l -v` reports it.
 *
 * `state` is recorded and deliberately not used to gate anything: launching
 * into a stopped distro starts it, so refusing one would be Helm inventing a
 * failure the platform does not have.
 */
export interface WslDistro {
  name: string
  state: 'Running' | 'Stopped' | string
  version: number
  /** Whether `wsl.exe` marks this one with `*`. */
  isDefault: boolean
}

/**
 * What Helm found when it looked inside a distro.
 *
 * The same warn-do-not-block posture SPEC 7 pins for the Windows CLI: a distro
 * with no `claude` is a row that says so, not a launch that fails later with no
 * explanation.
 */
export interface WslProbe {
  distro: string
  /** Absolute path to `claude` inside the distro, or null. */
  claudePath: string | null
  /** What `claude --version` printed there, or null. */
  claudeVersion: string | null
  /** The distro's `$HOME`, which is where its `~/.claude` lives. */
  home: string | null
  /**
   * Whether the distro can reach Helm's loopback endpoint.
   *
   * Measured 2026-09-02 on default NAT networking: it cannot. Neither
   * `127.0.0.1` (which only mirrors under `networkingMode=mirrored`) nor the
   * gateway address (the server binds loopback only, by the rule stated in
   * `browser-mcp.ts` and SPEC 5) is reachable. So a WSL session gets no
   * `--mcp-config` at all unless this is true, and the launch says why.
   */
  endpointReachable: boolean
  /** Why the probe answered as it did, for the sentence the UI shows. */
  problem: string | null
}

/**
 * A distribution's `~/.claude`, in both spellings.
 *
 * The pair is what callers need, not one or the other. `claudeHome` is how this
 * Windows process opens the directory - `\\wsl$\Ubuntu\home\me\.claude`, which
 * every reader in `discovery/`, `usage/` and `config/` treats as an ordinary
 * path - while `home` is what the distro itself calls it, which is what belongs
 * in a sentence shown to somebody who works in that distro.
 *
 * Produced by `wslHomeOf` from a probe, and absent for a distro whose probe did
 * not answer: a home Helm had to guess at would be a config console browsing
 * nothing and an effective view composed from a directory that is not there.
 */
export interface WslHome {
  distro: string
  /** The distro's `$HOME`, Linux-spelled, as `bash -lc 'echo $HOME'` printed it. */
  home: string
  /** Its `~/.claude`, spelled as this Windows process must open it. */
  claudeHome: string
}

/**
 * The one networking mode Helm has anything to say about.
 *
 * `mirrored` is the fix for the fact SPEC 4.8 measured - loopback is shared
 * with a distro only under it - and `nat` is the platform default and therefore
 * the way back from having set it. Every other value WSL accepts is left to the
 * file: Helm reads whatever is there verbatim and offers these two, rather than
 * becoming a settings editor for a file it does not own.
 */
export type WslNetworkingMode = 'mirrored' | 'nat'

/**
 * What `%USERPROFILE%\.wslconfig` says about networking, as its text reads.
 *
 * Deliberately three separate facts rather than one verdict. Whether the file
 * exists, what it sets, and whether Helm may rewrite it are answered
 * independently, and none of them says whether a distro can reach the endpoint
 * *now* - that is `WslProbe.endpointReachable`, measured by a connect, and a
 * file saying `mirrored` before WSL has restarted is exactly the state a user
 * has to be able to see.
 */
export interface WslConfigFacts {
  /**
   * The value under `[wsl2]`, verbatim, or null for a file that does not set
   * one. Null is never rendered as `nat`: the default is a fact about the WSL
   * build rather than about this file.
   */
  networkingMode: string | null
  /** Whether the file has a `[wsl2]` section at all. */
  hasWsl2Section: boolean
  /**
   * Why Helm will not rewrite this file, or null. A file it cannot read with
   * confidence is reported and left alone - the user edits it by hand.
   */
  refusal: string | null
}

/** The same facts, plus the file they were read out of. */
export interface WslNetworkingState extends WslConfigFacts {
  /** `%USERPROFILE%\.wslconfig`, whether or not it is there. */
  path: string
  exists: boolean
}

/**
 * A rewrite of the file's text, or the reason there is not one.
 *
 * `changed: false` is a success: the file already says what was asked for, and
 * the caller has something to say about that rather than nothing.
 */
export type WslConfigEdit =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; problem: string }

/**
 * The outcome of setting the mode, as the pane needs it.
 *
 * `backupPath` is the whole of "there is a way back": every change Helm makes
 * to a file it does not own leaves a copy of what was there beside it, the same
 * rule the config console's snapshot follows (`writeConfigFile`). Null with
 * `ok: true` means nothing was written, so there was nothing to back up.
 */
export interface WslNetworkingWriteResult {
  ok: boolean
  /** The file as it reads after the attempt, written or not. */
  state: WslNetworkingState
  /** The copy taken immediately before the write, or null. */
  backupPath: string | null
  /** The file already said this, so nothing was written. */
  unchanged: boolean
  error: string | null
}

/**
 * A saved launch composition - the core object everything in Helm is organised
 * around (SPEC 3).
 *
 * `overlays` are composed into the session as plugins, so their skills, agents
 * and commands resolve from a cwd that is not theirs. `access` is the separate
 * question of which directories the session may touch. They overlap in practice
 * and are still not the same thing: composing a repo's skills does not grant
 * its files, and granting its files does not compose its skills.
 */
export interface Profile {
  id: number
  name: string
  /** Working directory. Claude Code resolves `.claude/` config from it. */
  root: string
  /** Project paths composed via `--plugin-dir`. */
  overlays: string[]
  /** Project paths passed to `--add-dir`. */
  access: string[]
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode | null
  agent: string | null
  /**
   * MCP server names. Persisted and exported, but not yet placed on the argv:
   * no CLI flag selects already-configured servers by name, and resolving them
   * into a `--mcp-config` document is the config console's job (SPEC 4.2).
   */
  mcp: string[]
  /** Submitted as the session's first message. */
  openingPrompt: string | null
  /** Launcher ordering; null means unpinned. */
  pinnedOrder: number | null
  /**
   * Where this profile's sessions run. Null means Windows.
   *
   * Nullable rather than defaulted in the type, because every profile saved
   * before targets existed has no column value and "not recorded" and "chose
   * Windows" are the same launch. The resolver is `launchTarget` below, so
   * nothing else has to know that.
   */
  target: LaunchTarget | null
  createdAt: string
  updatedAt: string
}

/** A profile's target, with the pre-target default applied. */
export function launchTarget(target: LaunchTarget | null | undefined): LaunchTarget {
  return target ?? WINDOWS_TARGET
}

/** A profile before the store has given it an identity. */
export type ProfileDraft = Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>

/**
 * One synthesised overlay plugin: the directory handed to `--plugin-dir`, and
 * what went into it.
 */
export interface OverlayShim {
  /** The plugin manifest name, and therefore the prefix its skills appear
   * under - `acme:think`, not `acme-overlay:think`. */
  name: string
  /** The project this overlay was synthesised from. */
  projectPath: string
  /** The shim directory itself. */
  dir: string
  /** Convention directories that were linked in, e.g. `['skills', 'agents']`. */
  linked: string[]
  /** Junctions need no elevation; `copy` is the fallback when one fails. */
  mode: 'junction' | 'copy'
  /** Whether the source project had a CLAUDE.md to carry. */
  hasClaudeMd: boolean
  /** True when this launch rebuilt the shim rather than reusing it. */
  rebuilt: boolean
}

/** Everything a host needs to spawn a composed session. */
export interface LaunchPlan {
  cwd: string
  name: string
  /** Argv after the executable. */
  argv: string[]
  overlays: OverlayShim[]
  /**
   * The composed project-instructions file passed to
   * `--append-system-prompt-file`, or null when no overlay had a CLAUDE.md.
   */
  memoryFile: string | null
  /**
   * The ephemeral `--mcp-config` document written for this session, or null.
   *
   * Returned so the host can delete it when the session ends: it carries a
   * bearer token for Helm's own loopback endpoint, and a token file that
   * outlives the run that minted it is a file nothing collects.
   */
  mcpConfigFile: string | null
  /**
   * The conversation id this launch assigned with `--session-id`, or null when
   * it assigned none.
   *
   * Returned so the host can put it on the session row: the flag is in `argv`
   * either way, but a row that had to re-parse its own argv to find out what it
   * launched would be a second parser of a string this file wrote.
   */
  claudeSessionId: string | null
  /**
   * Where this launch runs, with the pre-target default already applied.
   *
   * On the plan rather than left for the host to remember, because the host
   * has to make two decisions from it - which program to spawn, and which
   * `~/.claude` this session's rows belong to - and a host deriving that from
   * the profile again is a second place for the answer to drift.
   */
  target: LaunchTarget
  /** Things the user should know that did not stop the launch. */
  warnings: string[]
}

export type ThemePreference = 'system' | 'light' | 'dark'

/** The three, as a value, so a validator and a control can share one list. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

/** xterm's three cursor shapes, restated here so a validator and a control can
 * share one list without either of them importing xterm. */
export const TERMINAL_CURSOR_STYLES = ['block', 'underline', 'bar'] as const
export type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number]

/**
 * The bounds on the two numeric terminal settings.
 *
 * The font size ceiling is not taste. A pane is a few hundred pixels wide, and
 * a grid narrow enough stops being a terminal: Claude Code's composer and
 * status line assume they have columns to lay out in, and every check that
 * asserts a pane came back with a usable grid is only loose because this is
 * tight. The floor is the point below which the glyphs stop being legible on a
 * 100% display.
 */
export const TERMINAL_FONT_SIZE = { min: 8, max: 32, default: 14 } as const

/** Lines of history a terminal keeps. The ceiling is memory: a line is roughly
 * a kilobyte of cell data, so a million of them per pane is not a setting. */
export const TERMINAL_SCROLLBACK = { min: 500, max: 200_000, default: 10_000 } as const

/**
 * How much of the project page's column the shell may take, as a percentage.
 *
 * The default is where the shell used to be pinned, and the argument that put
 * it there is still the argument for the default: about a third of the page
 * gives a tall display 15+ rows - PSReadLine's ListView threshold - while a
 * small window keeps most of its height for the project pane. What that
 * argument never justified was being the *only* value, which is what a fixed
 * class made it.
 *
 * The ceiling is half, and it is the user's own ask: past half the project
 * pane would be the smaller part of the page it names. The floor here is
 * proportional and is deliberately not the whole floor - the pane carries a
 * pixel floor too (`PROJECT_SHELL_MIN_PX`), which is the binding one on any
 * window this app opens. This bound is what stops a percentage chosen on a
 * short window describing a four-row terminal on a tall one.
 */
export const PROJECT_SHELL_HEIGHT_PCT = { min: 10, max: 50, default: 30 } as const

/**
 * The hanging indent a wrapped source line's continuation carries, in columns.
 *
 * Its job is to say "this row is the last row continued" rather than "this row
 * is the next line", and that is a distinction the eye makes by *size*: at the
 * `tab-size: 2` this viewer sets, a two-column hang is the same distance as one
 * nesting step, so a continuation would read as a child of the line above it.
 * Four is the smallest value that cannot be mistaken for a level of nesting.
 *
 * Zero is allowed and is a real choice - it is what a plain editor does. The
 * ceiling is where the hang starts eating the measure it was meant to make
 * readable.
 */
export const CONTENT_WRAP_INDENT = { min: 0, max: 16, default: 4 } as const

/**
 * How much of the window's width the sessions column takes, as a percentage.
 *
 * The other axis of the same idea as `PROJECT_SHELL_HEIGHT_PCT`, and the same
 * bounds the divider has always enforced in its handler - 20% to 80% - now said
 * once here rather than as two literals inside a `mousemove`.
 *
 * The default is 45 because that is the number the split has silently opened at
 * since it was written, and this key is only being introduced to stop it
 * forgetting: somebody who never touches the divider must not have the app move
 * on them the first time they upgrade.
 */
export const SESSION_SPLIT_PCT = { min: 20, max: 80, default: 45 } as const

/**
 * How much of `helm.db` the transcript archive may take, in bytes.
 *
 * A gigabyte by default, and both halves of that are deliberate. Unbounded is
 * not an option: `helm.db` is the user's file, and a feature that grows it
 * without limit is one they find out about from their disk rather than from
 * Helm. A gigabyte is enormous for what this actually stores - the conversation
 * text out of one 3.9 MB transcript on this machine is 54 KB before
 * compression, a 71x difference, because tool traffic is not archived - so on
 * any ordinary machine the ceiling is a guard rail rather than a budget.
 *
 * The floor is a kilobyte rather than something respectable, because a bound
 * that no check can drive past is a bound nothing has ever tested: the eviction
 * rule is the interesting part of this feature, and `pnpm transcript-check`
 * makes it fire by setting a ceiling smaller than what it just archived. The
 * settings pane offers sensible sizes; the validator only enforces the shape.
 */
export const TRANSCRIPT_ARCHIVE_BYTES = {
  min: 1024,
  max: 64 * 1024 ** 3,
  default: 1024 ** 3
} as const

/**
 * A shell Helm found on this machine, offered in the shell pickers.
 *
 * `path` is what gets launched and what gets stored, and it is absolute for the
 * same reason `claudePath` is: a bare `pwsh.exe` means whatever the process's
 * PATH happened to resolve it to, which is not necessarily what the user saw in
 * the picker.
 */
export interface DetectedShell {
  /** Absolute path to the executable. */
  path: string
  /** The file name - `pwsh.exe`. What the picker shows as machine data. */
  name: string
  /** A human label - "PowerShell 7". */
  label: string
  /** The arguments Helm would launch it with, from the per-shell table. */
  args: string[]
}

/**
 * One pane on the workspace tab strip, in the form it is written down in.
 *
 * A record and not the strip's `project:C:\...` id string, deliberately: a
 * Windows path can contain a `#` and a `:`, so a tab id is an identity to
 * compare and never a thing to take apart again. Restoring the strip needs the
 * path and the number back, so what is persisted is the fields rather than the
 * id built from them.
 *
 * The renderer's `PaneRef` is this type - one definition, because the shape a
 * pane has and the shape it is stored in must not be free to drift apart.
 */
export type WorkspaceTab =
  | { kind: 'project'; path: string }
  | { kind: 'history' }
  | { kind: 'sessions' }
  | { kind: 'pulls' }
  | { kind: 'pr'; repoPath: string; number: number }
  | { kind: 'config' }
  | { kind: 'content' }
  | { kind: 'settings' }

/** How many tabs are worth writing down. Past this the list is a bug, not a
 * workspace, and a settings row nobody can shrink is worse than a truncation. */
export const WORKSPACE_TABS_MAX = 100

/**
 * How many projects the pinned list may name.
 *
 * A ceiling on a value that is JSON in one row and is rewritten whole on every
 * toggle, exactly as `PR_IGNORED_REPOS_MAX` is - not a statement about how many
 * anybody pins. A list past a screenful has stopped being a shortlist and the
 * tree is what it wanted, but that is the user's call and not a validator's.
 */
export const PINNED_PROJECTS_MAX = 200

/**
 * How two project paths are compared, everywhere this list is read or written.
 *
 * Case folding and nothing else. The sidebar's own grouping already keys its
 * harness map with a bare `path.toLowerCase()`, and a second normalisation here
 * - trailing separators, `resolve`, short-name expansion - would be a way for
 * the pinned section and the group it lifts a project out of to disagree about
 * whether they are looking at the same project, which is how the same row ends
 * up printed twice.
 */
function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Whether this project has been lifted into the sidebar's Pinned section. */
export function isProjectPinned(pinned: readonly string[], path: string): boolean {
  return pinned.some((entry) => samePath(entry, path))
}

/**
 * The live sessions whose working directory is this folder.
 *
 * The whole of the launch-time warning's arithmetic, and it lives here beside
 * `samePath` for the reason that function's comment gives: one normalisation.
 * A warning that compared paths differently from the way the sidebar groups
 * them would be a warning that appears for one surface and not for the other,
 * on the same two directories.
 *
 * Case folding and nothing else, for the same reason. Trailing separators,
 * `resolve` and short-name expansion are all ways for two readings of one path
 * to disagree, and this comparison is between a path Helm holds and a path
 * Claude Code wrote into its own record - two writers, so the risk of a second
 * normalisation is a warning that silently stops appearing.
 *
 * `null` cwds are excluded rather than matched: a record with no working
 * directory is a session whose directory is unknown, and "unknown" is not
 * "here".
 */
export function liveSessionsIn(
  sessions: readonly LiveSession[],
  path: string
): LiveSession[] {
  return sessions.filter((session) => session.cwd !== null && samePath(session.cwd, path))
}

/**
 * The pinned list with one project switched on or off.
 *
 * The whole list every time, because that is how the setting is written, and
 * the comparison is the case-insensitive one above - so pinning `C:\Repos\Api`
 * when the list already holds `c:\repos\api` replaces that entry rather than
 * adding a second spelling of one project. Sorted by path so the stored value
 * does not depend on the order somebody clicked; what the sidebar *shows* is
 * sorted by name instead, which is a different question and answered there.
 */
export function withProjectPinned(
  pinned: readonly string[],
  path: string,
  on: boolean
): string[] {
  const without = pinned.filter((entry) => !samePath(entry, path))
  const next = on ? [...without, path] : without
  return next.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
}

/**
 * Persisted application settings. Keys are the column names in `app_settings`;
 * every value is JSON-encoded on the way in, so adding a key here is the only
 * step needed to persist it.
 */
export interface AppSettings {
  theme: ThemePreference
  /** Directories the launcher scans. Empty means "not set up yet". */
  scanRoots: string[]
  /**
   * Projects lifted out of their harness group into the sidebar's Pinned
   * section, as absolute paths.
   *
   * Keyed by **path**, and that is a decision rather than the only option that
   * occurred to anybody - see the validator in `store/settings.ts`, which is
   * where the consequence is written down. Matching is case-insensitive, the
   * same comparison the sidebar's own grouping already makes on these paths.
   *
   * Projects only. A harness is not pinnable: the tree already gives every
   * harness a collapse state, which is most of what pinning one would be, and
   * one pin kind means there is no rule to invent for a pinned project inside a
   * pinned harness.
   *
   * A path that no longer resolves keeps its entry. Discovery will not return
   * it, so the sidebar paints it as gone rather than dropping it - pinning is a
   * deliberate act, and an unplugged drive is not a decision to un-pin.
   * Bounded by `PINNED_PROJECTS_MAX`.
   */
  pinnedProjects: string[]
  /** Window geometry, restored on next launch. */
  windowBounds: { width: number; height: number; x?: number; y?: number } | null
  /**
   * The workspace tab strip, restored on next launch: which panes are open, in
   * the order they were arranged, and which one was in front.
   *
   * State rather than a preference, so it sits beside `windowBounds` and not in
   * the settings pane - it is something Helm remembers, not something anyone
   * chose. Null means nothing has been written yet, which is not the same as an
   * empty strip: a user who closed every tab gets an empty strip back.
   *
   * The **session** strip is deliberately not here. `before-quit` calls
   * `sessions.shutdown()`, so no session survives a restart, and a strip of
   * tabs pointing at processes that no longer exist is not a workspace
   * restored - it is a strip of dead tabs to close.
   *
   * `activeId` is a tab id, which is only ever compared: a saved id that no
   * longer matches an open pane falls back to the last tab, the same rule that
   * governs `requestedId` while the app is running.
   */
  workspaceTabs: { panes: WorkspaceTab[]; activeId: string | null } | null
  /**
   * When the first-run flow was finished. Null means it has not been, which is
   * what puts the setup pane on screen instead of the launcher.
   */
  firstRunCompletedAt: string | null
  /**
   * A `claude` executable the user picked by hand, for the machine where it is
   * not on PATH and not in the usual install directory. Null means "find it".
   *
   * A path, never a credential: Helm locates the CLI and hands it a pty, and
   * signing in stays entirely between the user and `claude`.
   */
  claudePath: string | null
  /**
   * What the status bar's usage segment shows. Set in the settings pane's
   * Appearance group; clicking the segment itself still cycles it, because a
   * quick accessor beside the thing it changes is worth keeping.
   */
  usageDisplay: UsageDisplayMode

  /**
   * A font family for the terminal panes, or null for the built-in stack.
   *
   * Whatever is named here is **prepended** to the default stack, never
   * substituted for it. A monospace font chosen for its letterforms is rarely
   * chosen for its box-drawing, CJK or emoji coverage, and Claude Code's TUI is
   * made of box-drawing characters - so a font with holes in it has to degrade
   * one glyph at a time rather than take the whole interface down with it.
   */
  terminalFontFamily: string | null
  /** Point size for the terminal panes. Bounded by `TERMINAL_FONT_SIZE`. */
  terminalFontSize: number
  /** Cursor shape in the terminal panes. */
  terminalCursorStyle: TerminalCursorStyle
  terminalCursorBlink: boolean
  /** Lines of history a terminal pane keeps. Bounded by `TERMINAL_SCROLLBACK`. */
  terminalScrollback: number
  /**
   * The executable new project shells are opened with, or null to let Helm
   * detect one. An absolute path, for the reason `DetectedShell.path` gives.
   *
   * Project shells only. A Claude session is not a shell - Helm hands the
   * `claude` executable its own pty and this setting never reaches it.
   */
  terminalShell: string | null
  /**
   * How tall a project page's shell is, as a percentage of that page's column.
   * Bounded by `PROJECT_SHELL_HEIGHT_PCT`, dragged by the handle above the
   * shell, and settable in the Terminal group for when a drag lands somewhere
   * silly.
   *
   * **One value for every project rather than one per project.** The question
   * being answered is "how much terminal do I want", and that is about the
   * person and the monitor in front of them, not about the repository: someone
   * who wants a tall shell to read a `pnpm dev` in wants it in every checkout
   * they read one in. Per-project heights would also mean the page's
   * proportions moved as you moved between projects, which is furniture
   * rearranging itself.
   *
   * Not a terminal preference, whatever the settings group it is shown in says:
   * it never reaches `applyPrefs` and no session pane has one. It is the
   * project page's layout.
   */
  projectShellHeightPct: number
  /**
   * How wide the sessions column is, as a percentage of the window, when a
   * workspace pane and a session are both on screen. Bounded by
   * `SESSION_SPLIT_PCT` and dragged by the divider between them.
   *
   * **One value for every project**, the same answer `projectShellHeightPct`
   * gives and for the same reason: this is "how much terminal do I want beside
   * my work", which is a fact about the person and the monitor rather than
   * about a repository. It is also the stronger case of the two - this divider
   * does not move when you switch tabs, so a per-project value would make the
   * boundary jump every time somebody changed pane.
   *
   * A percentage, not the fraction the renderer holds. The pane's other
   * remembered size is a percentage, the settings row wants a number a person
   * can retype, and `0.45` in a database column that its neighbour writes `30`
   * into is the kind of difference nobody remembers on the day it matters.
   */
  sessionSplitPct: number

  /**
   * Whether the content viewer wraps long lines when it shows a file as source.
   *
   * **Default off, and that is a position this repository already took.** The
   * content editor's textarea soft-wraps and says why in a comment beside it:
   * it edits prose, where a paragraph is one very long line. The config editor
   * next to it deliberately does not, because it edits JSON, "where a wrapped
   * line hides the structure". A source file is structure, so the default
   * follows the config editor rather than the prose one.
   *
   * This is the *default*, not the state. The document header carries a toggle
   * that overrides it for the file on screen, because whether a given file
   * reads better wrapped is a question about that file - a minified payload and
   * a hand-written YAML want opposite answers, and neither is a preference
   * about Helm.
   */
  contentWrap: boolean
  /**
   * The hanging indent on a wrapped line's continuation rows, in columns.
   * Bounded by `CONTENT_WRAP_INDENT`; zero is a real choice. Has no effect
   * while nothing is wrapped, which is why it is one setting rather than a
   * pair that have to be kept consistent.
   */
  contentWrapIndent: number

  /**
   * How many bytes of `helm.db` the transcript archive may occupy.
   *
   * The archive itself has no on/off switch, and that is the decision rather
   * than an omission. 91% of the conversations behind `history.jsonl` were
   * already gone when this was measured, and a default-off setting would go on
   * losing them while it sat off - the cost of capturing is a few kilobytes per
   * conversation and the cost of not capturing is the conversation. What *is*
   * a setting is the ceiling, because that is the part with a real trade-off in
   * it: bounded by `TRANSCRIPT_ARCHIVE_BYTES`, enforced after every pass by
   * dropping the oldest archived session whole. See `evictToCeiling` - the
   * ceiling is adjustable and the eviction rule is not.
   */
  transcriptArchiveMaxBytes: number
  /**
   * A `gh` executable the user picked by hand, for the machine where it is not
   * on PATH and not in the usual install directory. Null means "find it".
   *
   * A path, never a credential - the exact parity with `claudePath`, and the
   * same hard rule behind it: Helm locates the CLI and runs it, and the GitHub
   * sign-in stays entirely between the user and `gh auth login`.
   */
  ghPath: string | null
  /**
   * How often Helm sweeps the discovered repositories for open pull requests,
   * in minutes. `0` is off - manual and focus refreshes still work.
   *
   * On by default, which is a deliberate change to Helm's network posture and
   * not an oversight: periodic scanning is what the surface is for. Helm itself
   * still makes no direct request; `gh` does, on the user's own token, on this
   * schedule. Bounded by `PR_POLL_MINUTES`.
   */
  prPollMinutes: number
  /**
   * How long a pull request may go untouched before the Pulls pane files it
   * under STALE rather than ACTIVE, in days. `0` is off - one flat Open list,
   * exactly as that section rendered before the split existed.
   *
   * A **preference** rather than a constant, and it is the only piece of that
   * pane's triage controls that is one: where a pull request stops being work
   * in flight is a judgement about the user's own working rhythm, and a week's
   * silence on a repository with one contributor means something different from
   * a week's silence on a busy one. The filter and the grouping beside it are
   * the opposite - reactions to a list that changes hourly - so they live in
   * the pane's own state and deliberately not here. Bounded by `PR_STALE_DAYS`,
   * whose comment argues the default.
   */
  prStaleDays: number
  /**
   * Repositories whose pull requests Helm does not fetch or show, as
   * `owner/name` slugs.
   *
   * A denylist rather than an allowlist, because a repository appearing on this
   * surface is what discovery already means - a new clone should show up
   * without anybody enrolling it, and going quiet should take a deliberate act.
   *
   * Keyed by **slug**, not by directory. The slug is what the surface fetches
   * by (one `gh` per distinct remote, however many checkouts of it are on the
   * machine), it is what the user is actually choosing about, and it survives a
   * repository being re-cloned somewhere else. Matching is case-insensitive -
   * see `isRepoIgnored`.
   *
   * An ignored repository is skipped **before the fetch**, so this is a smaller
   * network posture rather than a filter over the same calls. Its cached rows
   * are left in the database untouched: they are true facts about the last time
   * anybody looked, and deleting them would make un-ignoring a repository show
   * an empty list rather than a stale one with its age on it - which is the
   * opposite of how the rest of this surface degrades.
   */
  prIgnoredRepos: string[]
  /**
   * The opening prompt a "Review with Claude" launch starts its session with.
   *
   * A template - `{number} {url} {branch} {title} {slug}` are substituted and
   * anything else in braces is left as written. Rendered in the **main
   * process** from the cached pull request; the window renders the same
   * template only to show what the button will run.
   *
   * `{branch}` names `headRefName`, which on a pull request opened from a fork
   * does not exist in the local checkout unless `prCheckout` is `'checkout'`.
   * The default uses `{number}` alone for exactly that reason.
   */
  prReviewPrompt: string
  /**
   * Whether a review launch checks the pull request out first.
   *
   * `'none'` reviews from the pull request's refs and never touches the working
   * tree. `'checkout'` runs `gh pr checkout <n>` in the repository before
   * spawning, and is refused with a count of the changed files when the tree is
   * dirty - Helm does not stash. See `PR_CHECKOUT_MODES`.
   */
  prCheckout: PrCheckoutMode
  /**
   * The model a review launch runs on; null is the CLI's own default.
   *
   * A setting rather than a fixed choice because a review is the one launch
   * Helm composes on the user's behalf, and reading a diff is not the task they
   * necessarily want their default model spent on - in either direction. Null
   * passes **no** `--model` at all rather than passing a name Helm decided,
   * which keeps a Helm nobody has configured launching exactly what `claude`
   * would have launched.
   *
   * Not validated against a list of names. The CLI's aliases and its full model
   * ids both move faster than a desktop app's release does, and a setting that
   * refused `claude-opus-5` on the day it shipped would be a setting the user
   * cannot use for exactly as long as it takes Helm to catch up. What is
   * enforced is the shape - one bare token, no spaces or dashes to lead with -
   * because this becomes an argv word.
   */
  prReviewModel: string | null
  /**
   * The reasoning effort a review launch runs at; null is the CLI's default.
   *
   * Bounded by `EFFORT_LEVELS`, unlike the model: these five are the CLI's own
   * flag values rather than a naming scheme that moves, and a select is a better
   * control than a text field for a closed set of five.
   */
  prReviewEffort: EffortLevel | null

  /**
   * Whether Helm asks GitHub, once per launch, if there is a newer release.
   *
   * A deliberate amendment to the network posture and the reason README, SPEC
   * 5, PACKAGING and the `update:check` comment all moved together: until this,
   * Helm's own process opened no connection at all unless somebody invoked the
   * channel by hand. It now opens one, at most once a day, on a launch.
   *
   * The reasoning that made "only when asked" right is untouched, because it
   * was never about the request - it was about the *download*. Helm still
   * fetches nothing, replaces nothing and restarts nothing; the whole outcome
   * is a version number, and a line in the status bar when it is higher. What
   * "only when asked" actually cost was the person who would have to think to
   * ask, which is nobody: an update you have to remember to look for is an
   * update you run without for months.
   *
   * On by default and off in one tick, because a machine that must not talk to
   * anything is a real requirement and not an exotic one.
   */
  updateCheck: boolean
  /**
   * When the last check actually reached GitHub, ISO 8601, or null.
   *
   * Internal state and deliberately not in the settings pane, the same as
   * `windowBounds` and `firstRunCompletedAt`: it is something Helm remembers,
   * not something anyone chose. It exists to throttle - `UPDATE_CHECK_EVERY_MS`
   * - so that restarting the app twenty times in an afternoon, which is what
   * developing it looks like, is still one request.
   */
  lastUpdateCheckAt: string | null

  /**
   * How far the browser pane may reach: anywhere, or this machine only.
   *
   * A **posture**, and the widest of the two reach controls: it governs the
   * pane itself, whoever is driving. It is enforced in exactly one function
   * (`browserReachAllows`), which `browserMcpLocalOnly` composes with rather
   * than copying - see `agentReach`.
   */
  browserReach: BrowserReach
  /**
   * Whether Helm serves its browser tools to the sessions it hosts.
   *
   * On by default, because the stated purpose is that Claude can open things in
   * Helm: a session that cannot reach the pane beside it is a pane the user has
   * to drive twice. Off is a real off - `main/browser-mcp.ts` never binds a
   * port, no token exists, and no `--mcp-config` reaches any argv - so the app
   * has no inbound listener at all, which is the state it was in before M17.
   */
  browserMcp: boolean
  /**
   * Whether the tools are confined to this machine even when the pane is not.
   *
   * The **narrower** of the two reach controls, and off by default because the
   * pane's default is `web` and a tool that could not follow the page the user
   * is looking at would be a tool nobody used. On, an agent navigation is
   * allowed only where `browserReach` **and** this both allow it - the
   * intersection, taken by passing both to `browserReachAllows` rather than by
   * writing a second rule (`agentReach`). An agent can therefore never exceed
   * the reach of the pane it is driving, in either setting's direction.
   */
  browserMcpLocalOnly: boolean
  /**
   * The last URLs a browser pane visited, newest first.
   *
   * The address bar's dropdown and nothing more elaborate - no history page, no
   * manager, no search over it (see the milestone's "explicitly out"). State
   * rather than a preference, so it sits beside `workspaceTabs` and is
   * deliberately absent from the settings pane. Bounded by
   * `BROWSER_RECENT_URLS_MAX`.
   */
  browserRecentUrls: string[]
  /**
   * The last URL a browser pane was on, per project directory.
   *
   * Also state. It is what makes opening a browser beside a project cheap: the
   * dev server's port is a property of the project, and typing it again every
   * session is the papercut this pane exists to remove. Keyed by the project's
   * path, lower-cased, the same comparison every other path list here makes.
   * Bounded by `BROWSER_PROJECT_URLS_MAX`.
   *
   * The browser *tabs* themselves are not persisted, and that is the same rule
   * the session strip follows for the same reason: a `WebContentsView` is
   * main-owned state with a process behind it, it does not outlive the app, and
   * a strip of tabs pointing at views that no longer exist is not a workspace
   * restored. This is the part worth remembering, so this is the part remembered.
   */
  browserProjectUrls: Record<string, string>

  /**
   * Whether Helm tells a session it hosts what the other sessions are doing.
   *
   * **A second setting rather than `browserMcp`'s, and the reasoning is the
   * decision.** The two are served by one listener, on one port, under one
   * token - so a single tick would have been less to hold and would read as one
   * capability. They are not one capability. Driving a browser acts on the
   * world; this only looks at it, and the thing it looks at is *other people's
   * work*. Somebody may reasonably want either without the other, and the two
   * refusals have nothing in common: "do not let an agent click things" and "do
   * not tell an agent about my other sessions".
   *
   * The second reason is that it makes off assertable at the wire. With two
   * named servers, this off means the route answers 404, the name is absent
   * from the `--mcp-config` document, and the tools are in no list - three
   * independent facts. Folded into `browserMcp`, "nothing in argv" could not be
   * asserted at all, because the browser's `--mcp-config` is in the argv either
   * way.
   *
   * **On by default, and the argument is not that its neighbour is.** The two
   * differ in exactly the way that would decide this: `browserMcp` on gives an
   * agent *reach* over a pane the user is looking at, where this only tells an
   * agent about work in other windows. That is a smaller grant, over the user's
   * own machine, of facts the operating system will hand any process that asks
   * - and against it stands the failure it exists to prevent, which is two
   * agents editing one checkout, and which happens to somebody who never went
   * looking for a setting. A capability that has to be discovered is one that
   * prevents nothing.
   *
   * What makes on defensible is what is *not* served: no conversation, no argv,
   * no conversation id, no child command lines, and no way to send another
   * session anything. If any of that were in it, this would default off.
   *
   * Off is one tick away and is a real off - `main/session-tools.ts` is then
   * not mounted, no route exists, and the app is exactly what it was without it.
   */
  sessionMcp: boolean
}

/** How many addresses the dropdown offers. Ten, and no manager behind it. */
export const BROWSER_RECENT_URLS_MAX = 10

/**
 * How many projects keep a remembered URL.
 *
 * A ceiling on a value rewritten whole on every navigation, exactly as
 * `PINNED_PROJECTS_MAX` is - not a statement about how many projects anybody
 * has. Past this the oldest entries are dropped.
 */
export const BROWSER_PROJECT_URLS_MAX = 200

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  scanRoots: [],
  pinnedProjects: [],
  windowBounds: null,
  workspaceTabs: null,
  firstRunCompletedAt: null,
  claudePath: null,
  usageDisplay: 'percent',
  // The four defaults below are the values Spike C measured and `terminal.ts`
  // was built around. They are the documented baseline, not a starting point
  // someone picked: a setting left alone must produce the configuration the
  // fidelity checks measure.
  terminalFontFamily: null,
  terminalFontSize: TERMINAL_FONT_SIZE.default,
  terminalCursorStyle: 'block',
  terminalCursorBlink: true,
  terminalScrollback: TERMINAL_SCROLLBACK.default,
  terminalShell: null,
  projectShellHeightPct: PROJECT_SHELL_HEIGHT_PCT.default,
  sessionSplitPct: SESSION_SPLIT_PCT.default,
  // Off, following the config editor rather than the prose one - see the field.
  contentWrap: false,
  contentWrapIndent: CONTENT_WRAP_INDENT.default,
  transcriptArchiveMaxBytes: TRANSCRIPT_ARCHIVE_BYTES.default,
  ghPath: null,
  prPollMinutes: PR_POLL_MINUTES.default,
  prStaleDays: PR_STALE_DAYS.default,
  prIgnoredRepos: [],
  prReviewPrompt: DEFAULT_PR_REVIEW_PROMPT,
  prCheckout: 'none',
  prReviewModel: null,
  prReviewEffort: null,
  updateCheck: true,
  lastUpdateCheckAt: null,
  // `web` rather than `local`, and it is a decision. The pane is framed as a
  // dev-server viewport, but a dev server that pulls an API, a font or a docs
  // page is the ordinary case, and a viewport that could not follow it is one
  // people would turn off on the first afternoon. `local` is one click away for
  // the run where nothing should leave the machine.
  browserReach: 'web',
  // On, because the whole point of the endpoint is that a session can open a
  // page in the app that is hosting it; off is one tick away and removes the
  // listener entirely.
  browserMcp: true,
  // Off, because the pane defaults to `web`: an agent confined to loopback
  // beside a pane that is not would be a surprise rather than a posture.
  browserMcpLocalOnly: false,
  browserRecentUrls: [],
  browserProjectUrls: {},
  // On, because the collision this exists to prevent - two agents in one
  // working tree - happens to somebody who never went looking for a setting,
  // and because what it serves is a strictly smaller grant than the tick above
  // it. See the field for what is not in it, which is what makes that true.
  sessionMcp: true
}

/**
 * How long a launch waits before asking about releases again.
 *
 * A day. The question changes about as often as a release happens, and the
 * throttle is what keeps "once per launch" from meaning "once per restart" on
 * the machine Helm is being written on.
 */
export const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Config console
// ---------------------------------------------------------------------------

/**
 * One `.claude/` tree, and where it sits in the precedence chain.
 *
 * `user` is `~/.claude` itself; the other two are directories that *contain* a
 * `.claude`, which is why `path` is the base rather than the config directory -
 * `CLAUDE.md` and `.mcp.json` live beside `.claude/`, not inside it.
 */
export type ConfigScopeKind = 'user' | 'harness' | 'project'

export interface ConfigScope {
  kind: ConfigScopeKind
  /** The directory config resolves from. For `user`, the home directory. */
  path: string
  /** The `.claude` directory. Equal to `path` for the user scope. */
  claudeDir: string
  label: string
  /** Present so the switcher can say so rather than showing an empty tree. */
  exists: boolean
}

/**
 * What a file in a `.claude` tree is, as Claude Code resolves it.
 *
 * `skill` is the `SKILL.md` inside a skill directory, not the directory: the
 * directory name is the skill's name and the file is what gets edited.
 */
export type ConfigFileKind =
  | 'skill'
  | 'command'
  | 'agent'
  | 'hook'
  | 'settings'
  | 'settings-local'
  | 'claude-md'
  | 'mcp'
  | 'rule'
  | 'other'

export interface ConfigFile {
  path: string
  /** Relative to the scope's base directory, with forward slashes. */
  relPath: string
  kind: ConfigFileKind
  /**
   * How it is addressed: a skill's directory name, a command's `spec:plan`
   * namespace path, or the file name for everything else.
   */
  name: string
  size: number
  mtimeMs: number
  /** `description:` from the frontmatter, when there is one. */
  description: string | null
  /** True for a file Helm will not offer to edit as text. */
  binary: boolean
}

export interface ConfigTree {
  scope: ConfigScope
  files: ConfigFile[]
  /** Directories that could not be read. Not fatal; the rest of the tree stands. */
  errors: string[]
  scannedAt: string
}

/** A file's bytes, with the hash every write is checked against. */
export interface ConfigFileContent {
  path: string
  exists: boolean
  content: string
  /** sha256 of the bytes on disk, hex. The editor's basis for its next write. */
  hash: string
  size: number
  mtimeMs: number
  /** Set when the bytes are not decodable text; the editor refuses these. */
  binary: boolean
}

/**
 * Why a snapshot was taken. Stored on the row and shown in the file's history.
 *
 * `rename` and `delete` are ordinary rows and are deliberately not a second
 * mechanism: a `delete` row holds the bytes that were there, so restoring it
 * puts the file back the same way restoring an `edit` row does. That is what
 * makes "undo this delete" and "restore this version" the same button.
 */
export type ConfigWriteReason =
  | 'edit'
  | 'create'
  | 'restore'
  | 'mcp'
  | 'approve'
  | 'rename'
  | 'delete'

export interface ConfigSnapshotMeta {
  id: number
  scopePath: string
  /** Relative to `scopePath`, forward-slashed - the same key the index uses. */
  filePath: string
  contentHash: string
  bytes: number
  reason: ConfigWriteReason
  createdAt: string
}

export interface ConfigSnapshot extends ConfigSnapshotMeta {
  content: string
}

export interface WriteConfigRequest {
  /** The scope's base directory. Recorded on the snapshot. */
  scopePath: string
  path: string
  content: string
  /**
   * The hash the editor's content was derived from, or null for a file it knows
   * does not exist yet. A mismatch is an external edit and stops the write.
   */
  expectedHash: string | null
  reason: ConfigWriteReason
}

export interface WriteConfigResult {
  ok: boolean
  /** The file after the write, or as it stands now when the write was refused. */
  file: ConfigFileContent
  /** Null when nothing was written; otherwise the row taken first. */
  snapshotId: number | null
  /** The bytes were already what was asked for, so nothing was written. */
  unchanged: boolean
  /**
   * Set when the file on disk is not what the editor was based on. Carries the
   * current bytes so the editor can show what it would have overwritten.
   */
  conflict?: {
    onDiskHash: string
    onDiskContent: string
    mtimeMs: number
  }
  /** Set when the write was refused for a reason other than a conflict. */
  error?: string
}

// --- Create, rename, delete -------------------------------------------------

/**
 * The three things a directory supports that replacing one file's bytes does
 * not. All three take the scope by path and the entry by absolute path, the
 * same way `config:write` does, and all three are answered with a structured
 * result rather than a throw: every one of them has failure modes the *user*
 * caused - a name the CLI could not address, a collision, a bundled file Helm
 * cannot record - and those have to be shown in the dialog that asked.
 */
export interface CreateConfigRequest {
  scopePath: string
  kind: CreatableKind
  /** Ignored for the fixed-name kinds; see `CREATABLE_KINDS`. */
  name: string
}

export interface CreateConfigResult {
  ok: boolean
  /** Absolute path of the file that now exists, so the console can open it. */
  path: string | null
  /** Relative to the scope base, forward-slashed - the tree's own key. */
  relPath: string | null
  /** The `create` row taken before the file was touched. */
  snapshotId: number | null
  error: string | null
}

export interface RenameConfigRequest {
  scopePath: string
  /** The addressed file - a skill's `SKILL.md`, not its directory. */
  path: string
  name: string
}

export interface RenameConfigResult {
  ok: boolean
  /** The addressed file at its new location. Null when nothing moved. */
  path: string | null
  relPath: string | null
  /** Every file that moved. A skill's whole directory, one file for the rest. */
  moved: Array<{ from: string; to: string }>
  /** Every row taken - the destinations' `create`s and the sources' `rename`s. */
  snapshotIds: number[]
  /**
   * The moved file's frontmatter `name:` was updated to match.
   *
   * Only ever true when it named the *old* address exactly - a file declaring
   * anything else is not claiming to be the thing being renamed, and Helm does
   * not edit a field somebody set on purpose.
   */
  frontmatterRenamed: boolean
  error: string | null
}

export interface DeleteConfigRequest {
  scopePath: string
  path: string
}

export interface DeletedConfigFile {
  path: string
  /** Relative to the scope base - the key this file's history is listed under. */
  relPath: string
  snapshotId: number
}

export interface DeleteConfigResult {
  ok: boolean
  /** What came off the disk, each with the row that can put it back. */
  removed: DeletedConfigFile[]
  error: string | null
}

// --- Effective view --------------------------------------------------------

/** Where a resolved capability came from. */
export type EffectiveSource = 'user' | 'cwd' | 'overlay'

/**
 * One skill, command or agent as a session would actually address it.
 *
 * The namespace is *predicted*, not observed: the platform prefixes everything
 * an overlay contributes with the plugin's manifest name (Spike A), and Helm
 * chooses that name when it synthesises the shim - so `<overlay>:<skill>` is
 * decidable before anything is launched. Cross-overlay collisions are therefore
 * impossible, and two overlays defining the same skill both appear, each under
 * its own prefix.
 */
export interface EffectiveEntry {
  /** What you type: `acme:think`, or `think` for an unnamespaced one. */
  invocation: string
  name: string
  source: EffectiveSource
  /** The overlay's plugin name, or null when the entry resolves unprefixed. */
  namespace: string | null
  /** The directory it came from. */
  origin: string
  path: string
  description: string | null
}

export type SettingsLayerKind = 'user' | 'project' | 'local'

export interface SettingsLayer {
  kind: SettingsLayerKind
  file: string
  exists: boolean
  /** Leaf paths the layer defines. */
  keys: number
  /** Set when the file is there but could not be parsed. */
  error: string | null
}

/**
 * One setting, and which layer's value a session would see.
 *
 * Keyed by leaf path (`env.FOO`, `permissions.defaultMode`) rather than by
 * top-level key, because the layers merge per leaf: measured on 2.1.225, a
 * project `settings.json` that sets `env.A` and a `settings.local.json` that
 * sets `env.B` yield a session with both, and where they set the same name the
 * local one wins. A top-level view would have reported `env` as wholly replaced.
 */
export interface EffectiveSetting {
  key: string
  /** JSON encoding of the winning value. */
  value: string
  winner: SettingsLayerKind
  winnerFile: string
  /** Every layer defining this key, highest precedence first. */
  candidates: Array<{ layer: SettingsLayerKind; file: string; value: string }>
  /** True when a lower layer's value is being shadowed. */
  overridden: boolean
}

/** An MCP server as configured, and whether a session would actually load it. */
export interface EffectiveMcpServer {
  name: string
  /** `project` is `.mcp.json`; `local` and `user` live in `~/.claude.json`. */
  scope: 'project' | 'local' | 'user'
  /** The file that defines it. */
  file: string
  /** The server's JSON, pretty-printed. */
  config: string
  transport: string
  /**
   * `.mcp.json` servers gate on first launch unless a settings layer has
   * approved them. Null for scopes where the question does not arise.
   */
  approved: boolean | null
  /** Why `approved` is what it is. */
  approvedBy: string | null
  /** Set when a higher-precedence scope defines the same name. */
  shadowedBy: string | null
}

export interface EffectiveView {
  cwd: string
  /** The profile this was computed for, or null for a plain directory. */
  profileId: number | null
  profileName: string | null
  overlays: Array<{
    /** The plugin manifest name, which is the namespace. */
    name: string
    projectPath: string
    exists: boolean
    skills: number
    commands: number
    agents: number
  }>
  skills: EffectiveEntry[]
  commands: EffectiveEntry[]
  agents: EffectiveEntry[]
  /**
   * Names carried by more than one source, each under its own invocation. Not
   * a collision report - it cannot be one - but the thing a person wants to see
   * when two repos both define `think`.
   */
  sharedNames: Array<{ name: string; invocations: string[] }>
  settingsLayers: SettingsLayer[]
  settings: EffectiveSetting[]
  /** Instruction files the session would be given, in the order they arrive. */
  instructions: Array<{ path: string; source: EffectiveSource; bytes: number; origin: string }>
  mcpServers: EffectiveMcpServer[]
  warnings: string[]
  computedAt: string
}

// --- Live state, per file --------------------------------------------------

/**
 * What a resolution has to say about one file in a `.claude` tree.
 *
 * Six states rather than live/dead, because "not live" is three different
 * situations wearing one word: outranked by another layer, empty, or simply
 * not part of the resolution being looked at. They call for three different
 * reactions, so they are three different states.
 *
 *   - `live` - everything in it reaches a session
 *   - `partial` - it contributes, and something in it is outranked
 *   - `shadowed` - it contributes nothing that survives
 *   - `inert` - it is read, and has nothing to say
 *   - `absent` - this resolution never looks at it
 *   - `none` - Helm has no claim to make about it, and makes none
 */
export type ConfigLiveState = 'live' | 'partial' | 'shadowed' | 'inert' | 'absent' | 'none'

/** One settings leaf as one file declares it, and what outranked it. */
export interface ConfigSettingLive {
  key: string
  /** JSON encoding of *this file's* value, which may not be the winning one. */
  value: string
  layer: SettingsLayerKind
  wins: boolean
  outrankedBy: { layer: SettingsLayerKind; file: string; value: string } | null
}

/** One reason a hook file runs: the event, the matcher, and the layer saying so. */
export interface HookBinding {
  /** `PreToolUse`, `Stop`, ... - the key under `hooks`. */
  event: string
  /** The tool pattern the block matches, or null for a block with none. */
  matcher: string | null
  command: string
  layer: SettingsLayerKind
  /** The settings file the block is written in. */
  file: string
}

export interface ConfigLive {
  state: ConfigLiveState
  /** One line for a row. Null when there is nothing to say. */
  note: string | null
  /** The whole sentence, for the pill's title. Empty when the state is `none`. */
  reason: string
  /** What a session types to reach it: `dev:think`, `/spec:plan`. */
  invocation: string | null
  /** Other files resolving under the same name, each with its own invocation. */
  alsoDefinedBy: Array<{
    invocation: string
    source: EffectiveSource
    origin: string
    path: string
  }>
  /** Two unprefixed sources landed on one name, so which one wins is unpredicted. */
  contested: boolean
  settings: ConfigSettingLive[]
  hooks: HookBinding[]
  /** Settings leaves naming this file - a status line's command, and so on. */
  references: Array<{ key: string; layer: SettingsLayerKind; file: string; value: string }>
}

/**
 * A config file rendered as what it is, rather than as its bytes.
 *
 * Exactly one half is ever set: markdown for the kinds a session reads as
 * prose, highlighted source for the ones it runs. Both are null when the file
 * is neither, which is the case the pane draws as plain mono - and `code` is
 * null too when shiki has no grammar for the extension, so "not highlighted"
 * and "highlighted as plain text" stay different answers.
 */
export interface ConfigRendered {
  markdown: RenderedMarkdown | null
  code: { html: string; language: string; highlighted: boolean } | null
}

// --- MCP management --------------------------------------------------------

export type McpScope = 'local' | 'user' | 'project'

export interface McpAddRequest {
  scope: McpScope
  name: string
  /** The server object, as `claude mcp add-json` takes it. */
  json: string
  /** Working directory the CLI resolves `project` and `local` against. */
  cwd: string
}

/**
 * What the file would look like afterwards, computed before anything is run.
 *
 * The write itself is `claude mcp add-json` rather than a JSON edit (SPEC 4.2),
 * so the result cannot be known for certain in advance - this is Helm merging
 * the same object into the same document and showing the diff. The applied
 * result is re-read afterwards and shown too, so a prediction that was wrong is
 * visible rather than assumed.
 */
export interface McpPreview {
  file: string
  before: string
  after: string
  /** Unified-ish diff lines, each tagged. */
  diff: Array<{ sign: ' ' | '+' | '-'; text: string }>
  /** Set when the name is already configured in this scope. */
  replaces: string | null
  /** Set when the JSON the user typed is not usable. */
  error: string | null
}

export interface McpResult {
  ok: boolean
  /** What the CLI printed, trimmed. */
  output: string
  exitCode: number | null
  /** The file after the CLI ran, so the pane can show what actually changed. */
  after: string
  /** The snapshot taken before the subprocess ran. */
  snapshotId: number | null
}

// ---------------------------------------------------------------------------
// Content viewer
// ---------------------------------------------------------------------------

/**
 * A directory of things worth reading, inside a scope.
 *
 * The four the spec names - `notes/`, `context/`, `.claude/skills/`, `docs/` -
 * are always offered when they exist, in that order, because they are the ones
 * a person goes looking for by name. Everything else is *found*: a top-level
 * directory holding anything readable is content whatever it is called, which is
 * how `lessons/` and `reference/` - full of artifacts Claude produced - end up
 * reachable without this file knowing they exist.
 */
export type ContentRootKind = 'notes' | 'context' | 'skills' | 'docs' | 'root' | 'found'

/**
 * *Why* a root is on screen, which is the thing the curated model was hiding.
 *
 * `named` is "offered by rule" - the four the spec names, plus the scope
 * directory itself, all of which are listed whether or not they turned out to
 * hold anything. `discovered` is "offered because walking it found content".
 * The badge is data rather than a UI inference from `kind` so that the pane and
 * a check are reading the same answer.
 */
export type ContentRootOffer = 'named' | 'discovered'

export interface ContentRoot {
  kind: ContentRootKind
  offer: ContentRootOffer
  /** Relative to the scope, forward-slashed. `''` is the scope directory itself. */
  relPath: string
  path: string
  label: string
  files: number
}

/**
 * What Helm will do with a file.
 *
 * `markdown` is rendered, `html` goes to the sandboxed frame, `data`, `text`
 * and `source` are shown as source, and `binary` is listed but not opened. The
 * distinction is by extension rather than by content because it decides which
 * *surface* opens, and a surface that changed after the read would flash the
 * wrong one first.
 *
 * A kind decides how a file **opens**, never whether it is **shown**. The
 * config tree already draws that line with `TEXT_EXT`, and the curated view
 * used to draw it in the wrong place: `contentFileKind` returned null for a
 * script and the walk then dropped it, so an agent's own `tools/` was invisible
 * in the pane meant for reading what the agent wrote.
 */
export type ContentFileKind = 'markdown' | 'html' | 'data' | 'text' | 'source' | 'binary'

export interface ContentFile {
  path: string
  /** Relative to the scope, forward-slashed. */
  relPath: string
  /** The `relPath` of the root it was found under. */
  root: string
  rootKind: ContentRootKind
  kind: ContentFileKind
  /** Basename without extension: what `[[a wikilink]]` names. */
  slug: string
  /** Lower-cased extension without the dot, `''` for a file that has none. */
  ext: string
  /** Frontmatter `title`, else the first heading, else the slug. */
  title: string
  size: number
  mtimeMs: number
  /** Frontmatter `type`, `date` and `tags` - the vault's own convention. */
  noteType: string | null
  date: string | null
  tags: string[]
}

export interface ContentScope {
  kind: ConfigScopeKind
  path: string
  label: string
}

export interface ContentTree {
  scope: ContentScope
  roots: ContentRoot[]
  files: ContentFile[]
  /** Directories that could not be read. Not fatal; the rest of the tree stands. */
  errors: string[]
  scannedAt: string
  /** How long the walk took, for the pane's own honesty about a cold scope. */
  tookMs: number
}

/**
 * How the content pane is listing a scope.
 *
 * `curated` is the vault reading: the named roots, the discovered ones, newest
 * first inside each. `tree` is an ordinary file tree - every file, read one
 * directory at a time, with the repository's own ignore rules drawn rather than
 * applied silently.
 *
 * A scope's *kind* picks which one a scope opens on and nothing more. Both work
 * from either kind, because "a harness with a big `tools/` directory should
 * still be walkable" and "a project's `docs/` is still a vault" are both true,
 * and a mode locked to a kind cannot say so.
 */
export type ContentViewMode = 'curated' | 'tree'

/** Why a tree entry is greyed. `null` for one that is not. */
export type ContentIgnoreReason = 'gitignore' | 'default'

/**
 * One line of a directory listing in the tree view.
 *
 * Ignored entries are carried rather than dropped: the complaint this whole
 * surface answers is "nothing on screen says what was left out", and a tree
 * that hid `node_modules/` would be making exactly that omission at the top
 * level of every repository.
 */
export interface ContentDirEntry {
  name: string
  /** Relative to the scope, forward-slashed. */
  relPath: string
  path: string
  directory: boolean
  /**
   * A symlink or junction. Listed, never descended - an overlay shim's junction
   * points back into a real repository, and a tree that walked one would list
   * another project's files as this scope's.
   */
  link: boolean
  /** How the file would open. `null` for a directory. */
  kind: ContentFileKind | null
  /** Lower-cased extension without the dot. `''` for a directory or no extension. */
  ext: string
  size: number
  mtimeMs: number
  ignored: boolean
  ignoredBy: ContentIgnoreReason | null
}

/** One directory, read on demand. */
export interface ContentDirListing {
  scopePath: string
  /** Relative to the scope, forward-slashed. `''` is the scope directory. */
  relPath: string
  entries: ContentDirEntry[]
  /** How many of `entries` are ignored, so a header can count them. */
  ignored: number
  /**
   * What decided the ignores: the repository's own rules, or Helm's built-in
   * list where there is no git to ask.
   */
  ignoreSource: ContentIgnoreReason
  /** Set when this directory could not be read at all. */
  error: string | null
  tookMs: number
}

/** One `key: value` from the frontmatter, as the header chip row shows it. */
export interface ContentChip {
  key: string
  value: string
  /** A list-valued key (`tags`) renders as several chips rather than one. */
  values: string[]
}

export interface ContentHeading {
  depth: number
  text: string
  slug: string
}

/**
 * One `[[wikilink]]`, and whether the vault has anything to point it at.
 *
 * A broken link is not an error here. The vault's own convention is that a link
 * to a note nobody has written yet is a note worth writing, so the renderer
 * marks it and moves on - which is why `resolved` is nullable rather than the
 * link being dropped.
 */
export interface ContentWikilink {
  /** Exactly what was between the brackets, before `|` and `#` were split off. */
  target: string
  label: string
  heading: string | null
  /** Absolute path, or null when nothing in the scope matches. */
  resolved: string | null
}

/** What the source turned out to contain. Counted while rendering, so a check
 * can compare them against its own read of the same file. */
export interface ContentCounts {
  tables: number
  taskItems: number
  taskItemsChecked: number
  codeBlocks: number
  /** Code blocks that got a real grammar rather than plain text. */
  highlightedBlocks: number
  callouts: number
  wikilinks: number
  brokenWikilinks: number
  tags: number
  headings: number
}

export interface RenderedMarkdown {
  /** Sanitised HTML. The renderer injects it; it never evaluates it. */
  html: string
  frontmatter: {
    /** Present at all - a file with no `---` block has none. */
    present: boolean
    fields: ContentChip[]
    raw: string
    /** Set when the block is there and is not parseable YAML. */
    error: string | null
    /** Line the closing fence sits on, 1-based, for the source view. */
    endLine: number
  }
  headings: ContentHeading[]
  links: ContentWikilink[]
  tags: string[]
  words: number
  counts: ContentCounts
  /** Languages a code fence asked for that no grammar was loaded for. */
  unknownLanguages: string[]
  tookMs: number
}

/**
 * A file shown as source, highlighted.
 *
 * The source view is what every kind that is not markdown or HTML opens in, and
 * once source files are listed at all - which is the point of the split - that
 * view is where an agent's `tools/` scripts are read. A `<pre>` of undifferen-
 * tiated grey is a worse answer than the one the markdown renderer already
 * gives a fenced block, and it is the same machinery: one `highlightCode` call,
 * both themes in the output as custom properties.
 */
export interface ContentSource {
  /** Shiki's HTML, or `''` when there is none and the plain text should show. */
  html: string
  /** The grammar used. `plaintext` when nothing matched the extension. */
  language: string
  highlighted: boolean
  /** True when the file was past the ceiling; `html` is empty and that is why. */
  tooLarge: boolean
}

/**
 * A draft, tokenised, for the editor's underlay.
 *
 * Per line rather than as one block of HTML, because the underlay builds DOM
 * for a window of the file rather than all of it - see `CodeEditor`. The whole
 * file is tokenised even so: a string opened two hundred lines up changes the
 * colour of everything below it, so a window tokenised on its own would be
 * confidently wrong rather than merely late.
 *
 * `tooLarge` is the same ceiling the read views use, and it degrades the same
 * way: the text still edits, in one colour, and the pane says why.
 */
export interface EditorHighlight {
  /** The inner HTML of each line. Empty when `tooLarge`. */
  lines: string[]
  language: string
  highlighted: boolean
  tooLarge: boolean
  /** How long the tokenise took in main, for the latency group to report. */
  tookMs: number
}

/** A file, its bytes, and - for markdown - what they render to. */
export interface ContentDocument {
  file: ContentFile
  content: ConfigFileContent
  rendered: RenderedMarkdown | null
  /** Set for anything shown as source: data, text, and an agent's own scripts. */
  source: ContentSource | null
  /** Set when the file could not be rendered at all; the source still shows. */
  error: string | null
}

export interface ContentSearchLine {
  line: number
  /** The line, trimmed, with the match still inside it. */
  text: string
  /** Offsets of the match within `text`. */
  from: number
  to: number
}

export interface ContentSearchHit {
  path: string
  relPath: string
  root: string
  title: string
  matches: number
  /**
   * The file's own name or title matched, whether or not its text did. Kept
   * separate from `matches` so a search for `journal-2026-08` finds the note
   * whose *filename* says so and the result can say that is why.
   */
  nameMatch: boolean
  /** The first few matching lines. Bounded, so one file cannot fill the pane. */
  lines: ContentSearchLine[]
}

export interface ContentSearchResult {
  query: string
  hits: ContentSearchHit[]
  filesSearched: number
  /**
   * The kinds whose bytes were read, so the status row can say what was
   * searched rather than leaving the reader to infer it. Every file is matched
   * on its *name* whatever its kind, which is why this is about bodies only.
   */
  bodyKinds: ContentFileKind[]
  /** How many of `filesSearched` had their text read. The rest matched by name. */
  filesWithText: number
  bytesSearched: number
  totalMatches: number
  /** Measured around the search itself, not around the read. */
  tookMs: number
  /** True when the corpus had to be read from disk rather than served warm. */
  cold: boolean
  truncated: boolean
}

// --- Health ----------------------------------------------------------------

export interface DoctorReport {
  /** `claude doctor` stdout, verbatim. */
  output: string
  /** Parsed `Label: value` lines, in order. */
  rows: Array<{ label: string; value: string }>
  exitCode: number | null
  ranAt: string
  durationMs: number
  /** Set when the CLI could not be run at all. */
  error: string | null
}

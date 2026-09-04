import type {
  AppSettings,
  ArchiveStats,
  ArchivedConversation,
  CachedProject,
  ConfigFileContent,
  ConfigRendered,
  ConfigScope,
  ConfigSnapshotMeta,
  ConfigTree,
  ContentDirListing,
  ContentDocument,
  ContentScope,
  ContentSearchResult,
  ContentTree,
  CreateConfigRequest,
  CreateConfigResult,
  DeleteConfigRequest,
  DeleteConfigResult,
  DetectedShell,
  DiscoveryResult,
  DoctorReport,
  EditorHighlight,
  EffectiveView,
  GitState,
  HistoryPage,
  HistoryProject,
  HistoryPrompt,
  HistoryQuery,
  HistorySession,
  HistorySummary,
  McpAddRequest,
  McpPreview,
  McpResult,
  McpScope,
  Profile,
  ProfileDraft,
  PullDetailView,
  PullsSnapshot,
  FolderTemplateKind,
  FolderTemplatePreview,
  RenameConfigRequest,
  RenameConfigResult,
  RenderedMarkdown,
  SaveFolderAsTemplateResult,
  SessionActivityState,
  SessionRecord,
  SessionResources,
  SessionsOverview,
  TemplateDeleteResult,
  TemplateDetail,
  TemplateImportResult,
  TemplateListing,
  TemplatePreview,
  TemplateWriteResult,
  ThemePreference,
  UsageSnapshot,
  WriteConfigRequest,
  WriteConfigResult,
  WslDistro,
  WslHome,
  WslNetworkingMode,
  WslNetworkingState,
  WslNetworkingWriteResult,
  WslProbe
} from '@helm/core'
import type { ProbeOp, TermCreateOptions } from './protocol'

/**
 * The whole renderer <-> main surface, in one place.
 *
 * Every channel is declared here and nowhere else. The preload builds its API
 * from these maps and the main process registers against them, so a channel
 * that is not in this file cannot be sent, and a handler whose payload has
 * drifted from its caller is a type error rather than an `undefined` at
 * runtime. This is what "all communication goes through the typed contract"
 * means in practice - not a convention, a shape the compiler checks.
 *
 * Three categories, because they have genuinely different semantics:
 *   Requests - renderer asks, main answers  (ipcRenderer.invoke)
 *   Sends    - renderer tells, no answer    (ipcRenderer.send)
 *   Events   - main pushes to the renderer  (webContents.send)
 */

/**
 * `dev-live` is the unpackaged run with **no data directory of its own**, which
 * shares `%APPDATA%\Helm` with the installed app. It is a mode rather than the
 * absence of one because the status bar has to be able to name it: everything
 * that makes it dangerous is invisible from inside the window.
 */
export type AppMode = 'dev' | 'dev-live' | 'portable' | 'installed'

export interface AppInfo {
  version: string
  mode: AppMode
  dataDir: string
  dbFile: string
  /** Migration tags this build applied or found already applied. */
  migrations: string[]
  versions: {
    electron: string
    chrome: string
    node: string
  }
  /**
   * `claude --version`, or null if the CLI was not found. Helm warns and keeps
   * going: the CLI is required to launch a session, not to browse config.
   */
  claudeVersion: string | null
  /** Windows build number; xterm uses it to pick ConPTY quirk handling. */
  windowsBuild: number | null
  /**
   * The releases page, so a window can offer it without having asked GitHub
   * anything.
   *
   * `UpdateCheck.url` carries the same address but only arrives with an answer,
   * and the three states where somebody most wants this link - up to date, the
   * setting off, no network - are exactly the three that produce no answer.
   * Read once at startup with the rest of the app's identity; opened through
   * `shell:openExternal`, never fetched.
   */
  releasesUrl: string
}

/**
 * Whether this machine has signed in to Claude Code. `unknown` is a real
 * answer, not a placeholder: on macOS and Linux the credential legitimately
 * lives in a store Helm has no business opening.
 */
export type ClaudeAuth = 'authenticated' | 'unauthenticated' | 'unknown'

/**
 * What Helm found out about the CLI, for the setup pane and the version banner.
 *
 * Carries no credential and never will. `auth` is decided from the *existence*
 * of a login artefact, and the remedy for `unauthenticated` is a sentence
 * telling the user to run `claude` themselves.
 */
export interface ClaudeStatus {
  /** The executable, or null when there is not one. */
  path: string | null
  /** `setting` when the user picked it, `discovered` when Helm found it. */
  source: 'setting' | 'discovered' | null
  /** Raw `claude --version` output. */
  version: string | null
  /** The `x.y.z` parsed out of it, or null if it did not carry one. */
  semver: string | null
  /** Whether that version is inside the range this build was tested against. */
  tested: boolean
  testedRange: { min: string; max: string }
  /** `~/.claude`, or wherever `CLAUDE_CONFIG_DIR` points. */
  configDir: string
  configDirExists: boolean
  auth: ClaudeAuth
  /** Which signal decided `auth`, so the pane can be specific about why. */
  authSignal: string
  /** What went wrong locating or running the CLI, if anything. */
  error: string | null
}

/** Creating a harness, or turning a folder that holds repos into one. */
export interface CreateHarnessOutcome {
  /** The harness directory, or null when nothing was written. */
  path: string | null
  /** Paths written, relative to `path`. */
  created: string[]
  /**
   * What went wrong, as sentences. With `path` null it is why nothing was
   * written; with `path` set it is a template that was applied *partly* -
   * `created` is what landed, these are the entries that did not, and no
   * rollback is claimed.
   */
  problems: string[]
  /**
   * The harness that was already there, when that is why nothing was written.
   *
   * `path` stays null - nothing was created - but this is **not** a refusal to
   * report and stop at: the root has been added, so the folder is now in the
   * launcher, and the dialog says that rather than showing an error over a
   * harness the user cannot find. See `CreateHarnessResult.existing`.
   */
  existing: string | null
  /** The scan roots after the new harness was added to them. */
  roots: string[]
}

/**
 * The result of an explicit "is there a newer Helm" check.
 *
 * User-initiated only - see `docs/PACKAGING.md`. Helm makes no network request
 * unless this channel is invoked, which is why `checkedAt` is here: a pane that
 * says "up to date" has to be able to say when it last actually asked.
 */
export interface UpdateCheck {
  /** The version running now. */
  current: string
  /** The newest published release, or null if the check could not complete. */
  latest: string | null
  /** True only when `latest` is a strictly higher version than `current`. */
  newer: boolean
  /** Where to go to get it. Opened through `shell:openExternal`, not fetched. */
  url: string | null
  /** Why the check could not complete. */
  error: string | null
  checkedAt: string
}

export interface ScanRequest {
  /** Read git state during the scan. A first paint skips it and refreshes after. */
  includeGit?: boolean
}

export interface ScanStatus {
  running: boolean
  /** Set when the last scan failed outright rather than returning errors. */
  error?: string
}

export interface TermCreatedInfo {
  rendererKind: 'webgl' | 'dom'
  cols: number
  rows: number
  unicodeVersion: string
}

export interface StartSessionRequest {
  /** Working directory for the session. Claude Code resolves `.claude/` from it. */
  cwd: string
  /** The discovered project this is, when it is one. Recorded, not used to launch. */
  projectPath?: string | null
  /** Basis for the `-n` name. Made unique against the running sessions. */
  name?: string
  /** Initial grid, from the pane that will host it. */
  cols: number
  rows: number
}

/**
 * Launching a profile is a different request from launching a project: the
 * profile supplies the cwd, the overlays and every flag, so the renderer sends
 * an id and a grid and nothing else. Sending the composition from the renderer
 * would put the argv in the window, where it can drift from what was saved.
 */
export interface LaunchProfileRequest {
  profileId: number
  cols: number
  rows: number
}

/** What a launch composed, for the pane to report before the TUI paints. */
export interface LaunchedProfile {
  session: SessionRecord
  profile: Profile
  /** Plugin namespaces the session was given, e.g. `['api', 'web']`. */
  overlays: string[]
  /** Whether composed project instructions were passed. */
  composedInstructions: boolean
  /** Non-fatal problems: a missing overlay directory, an empty `.claude/`. */
  warnings: string[]
}

export interface SaveProfileRequest {
  /** Absent to create; present to update in place. */
  id?: number | null
  draft: ProfileDraft
}

export interface SaveProfileResult {
  profile: Profile | null
  /** Field-level problems. Non-empty means nothing was written. */
  problems: string[]
}

export interface ImportProfileResult {
  profile: Profile | null
  /** Set when the user cancelled the file picker. */
  cancelled: boolean
  /** Set when the file was not a profile. */
  error?: string
  /** The name it had to be given because one was taken. */
  renamedTo?: string
}

export interface ExportProfileResult {
  /** Where it was written, or null if the user cancelled. */
  file: string | null
}

/**
 * Reopening a conversation from the session index.
 *
 * Only an id and a grid: the working directory, the argv and whether it is
 * even possible are all decided in the main process from the indexed row.
 * Sending the cwd from the renderer would let a stale list resume a session
 * into the wrong directory, where `--resume` silently finds nothing.
 */
export interface ResumeSessionRequest {
  sessionId: string
  cols: number
  rows: number
}

export interface ResumedSession {
  session: SessionRecord
  /** The indexed row it came from, for the pane to caption before the TUI paints. */
  history: HistorySession
  /**
   * What the resume could not do but did anyway, in the same shape and for the
   * same reason `LaunchedProfile` carries them: an unreachable endpoint in a
   * distro, or a `--mcp-config` path with no spelling inside it. A resume can
   * lose Helm's own tools for either, and silently losing them is what the
   * launch path already refuses to do.
   */
  warnings: string[]
}

/**
 * Reviewing a pull request: which one, and how big the pane is.
 *
 * The same shape and the same reasoning as `LaunchProfileRequest` and
 * `ResumeSessionRequest`. Everything else about the launch - the working
 * directory, the session's name, whether the tree gets checked out, and the
 * opening prompt itself - is decided in the main process from the cached pull
 * request and the stored settings.
 */
export interface ReviewPullRequest {
  /** The project directory whose origin remote the pull request belongs to. */
  repoPath: string
  number: number
  /** Initial grid, from the pane that will host the session. */
  cols: number
  rows: number
}

/** What a review launch composed, for the pane to report before the TUI paints. */
export interface LaunchedReview {
  session: SessionRecord
  /**
   * The opening prompt the session was actually started with - the trailing
   * positional argument in `session.argv`. Sent back so the pane reports what
   * happened rather than re-rendering the template and reporting its own
   * arithmetic.
   */
  prompt: string
  /** The branch `gh pr checkout` moved the tree to, or null when it did not run. */
  checkedOut: string | null
  /** Non-fatal notes from the launch: a missing overlay, what the checkout said. */
  warnings: string[]
}

export interface CloseSessionRequest {
  id: number
  /**
   * Skip the "this session is still running" confirmation. Set when the caller
   * has already asked - closing the window, for one, where the user answered
   * about all of them at once.
   */
  force?: boolean
}

export interface CloseSessionResult {
  /** False when the user declined the confirmation. */
  closed: boolean
}

/**
 * Renaming a session's tab.
 *
 * The label goes to main rather than being held in the window because it has to
 * outlive the window: a renderer reload adopts the sessions back from main
 * (`session:list`), and a rename that lived in React state would be forgotten by
 * the reload while the session it named carried on running. It is written to
 * `sessions.label` and nothing touches `sessions.name` - see that column's
 * comment in `schema.ts` for why the divergence from `/resume` is on purpose.
 *
 * Null, or a string that is only whitespace, clears the label and the tab goes
 * back to reading the name the CLI was given.
 */
export interface RenameSessionRequest {
  id: number
  label: string | null
}

/**
 * Naming a session in the history pane.
 *
 * Deliberately a second request type rather than a widened `RenameSessionRequest`:
 * that one names a **running** session by its row id in `sessions`, this one
 * names a record of one that has already ended, keyed by the id Claude Code
 * gave it. The two tables have nothing to do with each other, and one shape
 * covering both would be a shape that has to be read twice to know which.
 */
export interface RenameHistorySessionRequest {
  sessionId: string
  /** Null, or whitespace, restores the title derived from the prompts. */
  name: string | null
}

/**
 * Which file the config editor currently has open.
 *
 * The main process watches it so that a change made in another editor reaches
 * the window *before* the user saves over it. Null means nothing is open, which
 * releases the watch - an app that keeps a handle on every file it has ever
 * shown is an app that stops other tools from renaming them on Windows.
 */
export interface WatchConfigRequest {
  path: string | null
}

/** A file the editor has open was changed by something that is not Helm. */
export interface ConfigExternalChange {
  path: string
  /** sha256 of the bytes now on disk, or '' if it has been removed. */
  hash: string
  exists: boolean
  mtimeMs: number
}

export interface EffectiveViewRequest {
  /** Computed for a saved profile - its root and its overlays. */
  profileId?: number | null
  /** Or for a plain directory, with whatever overlays are passed alongside. */
  cwd?: string | null
  overlays?: string[]
}

/**
 * Approving a `.mcp.json` server for a project.
 *
 * A server declared in `.mcp.json` gates on first launch until a settings layer
 * lists it, so this writes `enabledMcpjsonServers` into the scope's
 * `settings.local.json` - through the same snapshotted write path as any other
 * edit, because it is one.
 */
export interface McpApproveRequest {
  cwd: string
  name: string
  approved: boolean
}

/**
 * A live session is about to be ended, and the user has to agree first.
 *
 * Main asks and the *renderer* answers, so the question is a Helm island
 * rather than a Win32 message box - see `IpcEvents['session:confirm']` for why
 * the direction is what it is.
 */
export interface SessionConfirmRequest {
  /** Correlates the answer with the question; see `session:confirmed`. */
  id: number
  kind: 'close-session' | 'quit'
  message: string
  detail: string
  /** What the agreeing button says. Plural when quitting ends several. */
  confirmLabel: string
  /** Names of the sessions this ends, for the dialog to list. */
  sessionNames: string[]
}

// ---------------------------------------------------------------------------
// The browser pane
// ---------------------------------------------------------------------------

/**
 * One browser view, as the window sees it.
 *
 * The view itself is a `WebContentsView` living in the main process, like a
 * pty: React paints a placeholder rectangle and this is everything it knows
 * about what is inside it. That split is the whole design - a native view
 * cannot be a React child, its page state must survive the workspace strip's
 * unmount-on-tab-switch, and the renderer must never be the authority on what a
 * page is doing.
 */
export interface BrowserState {
  id: number
  /** Where it actually is, which is not always where it was asked to go. */
  url: string
  /** The page's own title, or the host until it has one. Names the tab. */
  title: string
  /** The tab's subtitle, and what an address that failed to load still says. */
  host: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /**
   * Why the page is not there, as a whole sentence: a reach refusal, a
   * certificate the pane will not click through, a dev server that is not up.
   * Null when the page loaded.
   */
  problem: string | null
  /**
   * When a connection-refused retry gives up, as an epoch millisecond, or null.
   *
   * You open the pane before `pnpm dev` is up. Rather than an error, the view
   * reconnects quietly for about half a minute - and the pane says so, because
   * a viewport that is retrying and one that has given up look identical.
   */
  retryingUntil: number | null
  /** `webContents.getZoomLevel()`, so the pane's zoom control reads the truth. */
  zoomLevel: number
  /** Entries in the ring buffer at level `error` or `warning`. The chip. */
  errors: number
  /** Whether this view's detached DevTools window is up. */
  devtoolsOpen: boolean
  /** The last `findInPage` and what it found, or null when nothing is being found. */
  find: { query: string; matches: number; active: number } | null
  /** The project this tab was opened beside, for the per-project URL memory. */
  project: string | null
  /**
   * The name of the session that opened this tab, or null when the user did.
   *
   * The **name**, never the token it is looked up by: attribution is something
   * the strip paints, and the bearer token that decides which tabs a session
   * may drive stays in the main process. A tab with a name here is one an agent
   * opened, it says so in the strip, and it is the only kind `browser_close`
   * will close.
   */
  openedBy: string | null
}

/**
 * A line a page wrote to its console, or a load that failed.
 *
 * The same shape the artifact console already produced, plus the two fields a
 * *panel* needs that a count did not: which view it came from and when. One
 * shape, because the panel is one component used in two places.
 */
export interface BrowserConsoleEntry {
  level: string
  message: string
  source: string
  line: number
  /** Epoch milliseconds. The panel prints a wall clock beside each entry. */
  at: number
}

/**
 * Where the placeholder is, in CSS pixels, and whether the view should show.
 *
 * Fire-and-forget for the reason `pty:input` is: a `ResizeObserver` on the
 * placeholder fires per frame during a split drag, and a promise per frame
 * would put an IPC round trip inside the gesture. Main converts to DIPs itself
 * - the zoom factor is the window's, and the window is the side that knows it.
 *
 * `visible` is the *renderer's* answer to "should this be on screen", and it
 * folds together every reason there is: the tab is not in front, an overlay is
 * up, the workspace column is collapsed, a tab is being dragged. Main does not
 * reason about any of them; it calls `setVisible`.
 */
export interface BrowserBounds {
  id: number
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

/** How many browser tabs may be open at once. `window.open` is capped by it. */
export const BROWSER_TABS_MAX = 10

// ---------------------------------------------------------------------------
// Renderer -> main, with a response
// ---------------------------------------------------------------------------

export interface IpcRequests {
  'app:info': { request: void; response: AppInfo }

  'settings:read': { request: void; response: AppSettings }
  'settings:write': { request: Partial<AppSettings>; response: AppSettings }

  /** Rows from the last scan, for painting before a fresh one finishes. */
  'discovery:cached': { request: void; response: CachedProject[] }
  'discovery:scan': { request: ScanRequest; response: DiscoveryResult }

  /** Best guesses for a first-run scan root; may be empty. */
  'roots:suggest': { request: void; response: string[] }
  /** Native directory picker. Returns the roots after the addition. */
  /**
   * Adds folders the user picks. `startIn` opens the dialog somewhere specific -
   * see `path:chooseDirectory`, which has the measurement behind it.
   */
  'roots:add': { request: { startIn?: string } | void; response: string[] }
  /** Adds a path already in hand - a suggestion accepted, a harness created. */
  'roots:accept': { request: { path: string }; response: string[] }
  'roots:remove': { request: { path: string }; response: string[] }

  /**
   * First run. Setup is a *state*, not a wizard the app remembers having
   * shown: the pane is on screen whenever there is nothing to scan and no
   * completion stamp, so quitting halfway through leaves it exactly where it
   * was rather than dropping the user into an empty launcher.
   */
  'setup:status': { request: void; response: ClaudeStatus }
  /**
   * Pick the `claude` executable by hand, for the machine where it is neither
   * on PATH nor in the usual place. The picked file is run with `--version`
   * before it is saved, so a mis-click is a sentence rather than a pty that
   * opens and closes.
   */
  'setup:locateClaude': { request: void; response: ClaudeStatus }
  /** Stamps `firstRunCompletedAt`. The pane closing is a consequence of this. */
  'setup:complete': { request: void; response: AppSettings }

  /**
   * The WSL distributions on this machine, for the profile editor's target
   * picker and the settings pane's WSL group.
   *
   * The listing alone, with no probe: enumerating is `wsl.exe -l -v` and costs
   * one process, where asking each distro what `claude` it has starts every one
   * of them. A form opening must not boot two distributions.
   */
  'wsl:distros': { request: void; response: WslDistro[] }
  /**
   * Each distribution's `~/.claude` and the home it sits in, as paths this
   * machine can open.
   *
   * Free to ask: the answer is the memoised one the history, usage, activity
   * and archive readers already made Helm find at start-up, so this awaits a
   * promise rather than starting anything. Empty on a machine with no WSL, and
   * empty when `CLAUDE_CONFIG_DIR` points Helm at one tree - see `wslHomes`.
   *
   * The folder pickers use it to open *inside* a distribution, which is the
   * only route Helm has into one: Explorer's "Linux" entry is a shell namespace
   * extension that no Electron dialog API can add, and the share root is not
   * listable by the file APIs at all.
   */
  'wsl:homes': { request: void; response: WslHome[] }
  /**
   * What one distro has - its `claude`, that CLI's version, and whether it can
   * reach Helm's endpoint. One distro at a time because it is a question asked
   * about the row somebody is looking at, and because the answer starts the
   * distro if it is not running.
   */
  'wsl:probe': { request: { distro: string; refresh?: boolean }; response: WslProbe }

  /**
   * What `%USERPROFILE%\.wslconfig` says about `networkingMode`.
   *
   * A read of one small file, so it is asked whenever the settings pane opens -
   * unlike `wsl:probe`, which starts a distribution. It answers only what the
   * file says: whether a distro can reach the endpoint *now* is `wsl:probe`'s
   * `endpointReachable`, and the two are deliberately separate channels because
   * they are separate facts. A file that has been set to `mirrored` while WSL
   * has not restarted yet is the state a user most needs to see.
   */
  'wsl:networking': { request: void; response: WslNetworkingState }
  /**
   * Sets `networkingMode` under `[wsl2]`, in the user's own file.
   *
   * The one write Helm makes outside its own data directory and a `.claude`
   * tree, and it carries the same guarantee the config console's does: a copy
   * of the previous bytes goes down first and a failure to take it aborts the
   * write. A file too odd to parse with confidence is refused rather than
   * rewritten, and comes back in `error` for the pane to print.
   *
   * **It never restarts WSL.** The setting takes effect at the next WSL start,
   * and `wsl:shutdown` is a separate channel for that reason.
   */
  'wsl:setNetworking': {
    request: { mode: WslNetworkingMode }
    response: WslNetworkingWriteResult
  }
  /**
   * `wsl --shutdown`, which ends **every** WSL process on this machine.
   *
   * Its own channel, invoked from nothing but a confirmation that names what it
   * terminates - other people's editors, servers and builds inside any
   * distribution, and any Claude Code session running in one, this Helm's own
   * WSL-target sessions included. Nothing in the main process calls it as a
   * side effect of anything, which is the rule the separate channel exists to
   * make structural rather than remembered.
   */
  'wsl:shutdown': { request: void; response: { ok: boolean; error: string | null } }

  /**
   * A directory chosen by the user, without doing anything with it yet.
   *
   * `startIn` is where the dialog opens. It exists for one reason: **Windows'
   * file dialog has no route into a WSL distribution that Helm can add.** The
   * "Linux" entry beside "This PC" in Explorer is a shell namespace extension,
   * not a listable share - measured 2026-09-03, `readdirSync('\\\\wsl$\\')` and
   * `readdirSync('\\\\wsl.localhost\\')` both answer ENOENT while
   * `\\wsl.localhost\Ubuntu\home` is an ordinary directory - and Electron
   * exposes no way to add a place to the dialog's sidebar. So the way to put a
   * user inside a distribution is to open the dialog *there*, which Helm can do
   * because it already knows every distro's home.
   */
  'path:chooseDirectory': {
    request: { title?: string; startIn?: string }
    response: { path: string | null }
  }
  /**
   * The same for a program. Used by the terminal settings' "Choose…" row, for
   * a shell that is installed somewhere `where.exe` does not look.
   */
  'path:chooseFile': { request: { title?: string }; response: { path: string | null } }

  /**
   * Scaffold a harness, or turn a folder that already holds repositories into
   * one. The new harness becomes a scan root in the same call, because a
   * harness the user cannot see is not one they created.
   *
   * `template` applies in `'new'` mode only. Absent or `minimal` writes the
   * built-in scaffold - `harness.yaml`, `repos/`, an empty `.claude/` - and
   * anything else names a directory in the templates directory, whose tree is
   * written into the new harness. Converting is deliberately template-free: it
   * writes a manifest and a `.claude/` into a folder somebody already has, and
   * a layout written into their work is not a scaffold.
   */
  'harness:create': {
    request: { mode: 'new' | 'convert'; dir: string; name?: string; template?: string }
    response: CreateHarnessOutcome
  }

  /**
   * The picker's rows: `minimal` first and always, then whatever is in the
   * templates directory. A template whose `template.yaml` cannot be read is
   * left out with a sentence in `problems` rather than breaking the list.
   */
  'template:list': { request: void; response: TemplateListing }
  /**
   * What "What gets written" shows. Answered from the same walk that does the
   * writing, so the dialog cannot describe a layout the writer would not
   * produce - which is what the hardcoded three-line list could do.
   */
  'template:preview': {
    request: { template: string; mode?: 'new' | 'convert' }
    response: TemplatePreview
  }

  /**
   * Authoring, which is the half of templates a file explorer cannot do.
   *
   * A template is a plain directory the user can open in any editor, so there
   * is deliberately **no in-app file editor** on this family and no channel
   * that reads or writes an arbitrary file inside one - `shell:showItem` opens
   * the folder and their own editor takes it from there. What is here is what
   * Explorer has no idea about: the metadata the picker reads, the `.tpl`
   * convention, copying in a skill the user already wrote, and freezing a
   * whole harness into a layout.
   *
   * Every write behind these lands **inside the templates directory and
   * nowhere else** (`assertTemplateWritable`), and `template:import` reads its
   * sources - `~/.claude` among them - without writing a byte back. That is
   * the CLAUDE.md rule about `~/.claude` unchanged, not a second exception to
   * it.
   */

  /** One template's files, with what a harness would receive each one as. */
  'template:detail': { request: { template: string }; response: TemplateDetail }
  /** Scaffolds a `template.yaml` and an empty tree. No starter files. */
  'template:create': {
    request: { name: string; label?: string; description?: string }
    response: TemplateWriteResult
  }
  /** Moves the directory. The id *is* the folder name, so this is the rename. */
  'template:rename': { request: { template: string; name: string }; response: TemplateWriteResult }
  /**
   * Removes the directory, unlinking any reparse point rather than walking it.
   * Final: a template holds whatever its author put there, including bytes the
   * snapshot table cannot hold, so there is no undo behind this one.
   */
  'template:delete': { request: { template: string }; response: TemplateDeleteResult }
  /** The metadata form: `label` and `description`, not raw YAML. */
  'template:metadata': {
    request: { template: string; label: string; description: string }
    response: TemplateWriteResult
  }
  /** Renames one file to `x.tpl`, which is how it opts in to substitution. */
  'template:substitute': {
    request: { template: string; path: string }
    response: TemplateWriteResult
  }
  /**
   * Copies chosen entries of a `.claude` tree into a template, as plain files.
   *
   * The sources are named by the paths `config:tree` reports for `scopePath`,
   * which is the one seam that can name them - `ClaudeInventory` is counts and
   * carries no names at all. The scope is resolved and the tree re-read in the
   * main process, so what a skill *is* - a directory, not one file - is decided
   * from the disk rather than from a list the renderer sent.
   */
  'template:import': {
    request: { template: string; scopePath: string; paths: string[] }
    response: TemplateImportResult
  }
  /**
   * What "Save as template" would copy, before anything is copied.
   *
   * Top-level entries with the recursive file count and byte size of each, so
   * the dialog states the total before writing - a harness with repositories in
   * it is gigabytes, and the number is what stops that being a surprise.
   */
  'template:folderPreview': {
    request: { dir: string; kind: FolderTemplateKind }
    response: FolderTemplatePreview
  }
  /** Copies the ticked entries in and writes a `template.yaml` over them. */
  'template:fromFolder': {
    request: {
      dir: string
      kind: FolderTemplateKind
      name: string
      label: string
      description: string
      include: string[]
    }
    response: SaveFolderAsTemplateResult
  }

  /**
   * Ask GitHub whether there is a newer release.
   *
   * **Helm contacts nothing on its own initiative except the update check.
   * Everything else on the network happens because you asked for it: the
   * pull-request surface goes through your own `gh`, and the browser pane
   * fetches the page you navigate to.**
   *
   * That is the whole network posture, and it is written identically here, in
   * the README, in docs/PACKAGING.md and in SPEC 5. If it moves again, all four
   * move together - CLAUDE.md says so, and the reason is that four copies of a
   * claim about what an app does to the network is four chances to ship a lie.
   * It replaced "the only outbound connection Helm's own process opens" when
   * the browser pane landed, because a browser makes that false.
   *
   * The endpoint Helm serves to its own sessions did **not** move it, and the
   * reasoning is worth keeping: that sentence is about what Helm *contacts*,
   * and an MCP endpoint bound to `127.0.0.1` for the sessions Helm hosts
   * contacts nothing. What it does do is **listen**, which the app had never
   * done before, so that fact is stated separately - in the same four places,
   * and in `main/browser-mcp.ts` where the rules are.
   *
   * That separate statement has moved once since, and the outbound sentence
   * still did not: the listener now serves **two** named servers rather than
   * one - the browser tools and the session-awareness tools - on one port,
   * behind one token, with a tick each. Two families of tools is not two
   * sockets and is not an outbound connection, so what changed is the listening
   * paragraph in those four places and nothing here.
   *
   * The app asks on its own too: once per launch, at most once a day, when
   * `updateCheck` is on - see `maybeCheckForUpdate`. Neither path downloads
   * anything. No artefact is fetched, nothing is replaced, nothing restarts.
   *
   * This channel keeps no throttle of its own. It is a person pressing
   * something - Check now, in Settings under Updates - and a deliberate act
   * that silently did nothing would be worse than no button. It is also the
   * only route to an answer when `updateCheck` is off: the setting governs
   * whether Helm asks by itself, not whether the user may.
   *
   * The pull-request surface reaches GitHub as well, but through the user's own
   * `gh` CLI on a schedule the user sets (default every 5 minutes, `0` turns it
   * off), so bytes can leave the machine without this channel being invoked.
   * Helm opens no socket of its own for that either, and stores no GitHub
   * credential. See `pr:snapshot` and docs/PACKAGING.md.
   */
  'update:check': { request: void; response: UpdateCheck }

  /** What `theme: 'system'` currently resolves to on this machine. */
  'theme:resolved': { request: void; response: ResolvedTheme }

  /** Open a path in the OS file manager. */
  'shell:showItem': { request: { path: string }; response: void }

  /**
   * Spawn a hosted `claude`. Rejects with a readable message when the CLI
   * cannot be found or the pty will not open - the renderer has nowhere else to
   * learn that, and a tab holding a terminal that never started is worse than
   * no tab.
   */
  'session:start': { request: StartSessionRequest; response: SessionRecord }
  /** Terminate and forget. Confirms first if the process is still alive. */
  'session:close': { request: CloseSessionRequest; response: CloseSessionResult }
  /** Sessions this main process is currently hosting, for a renderer reload. */
  'session:list': { request: void; response: SessionRecord[] }
  /**
   * What every hosted session is doing, out of Claude Code's own registry.
   *
   * A request as well as an event, for the reason `session:list` is one: a
   * renderer reload adopts main's sessions back, and a strip that adopted the
   * tabs without their dots would sit blank until the next transition - which
   * for an idle session is however long until somebody types.
   */
  'session:activity': { request: void; response: SessionActivityState[] }
  /**
   * Every live Claude Code session on this machine, Helm's own marked.
   *
   * **Machine-wide on purpose**, and the reason is the one the whole surface
   * exists for: a `claude` started in Windows Terminal collides with a working
   * tree exactly as hard as a tab does. It is read out of the registry the CLI
   * keeps for its own purposes and joined to Helm's rows here in main, where
   * the pty pids live.
   *
   * A request as well as an event, for the reason `session:list` is one: a
   * renderer that has just mounted needs the answer without waiting out a poll.
   */
  'sessions:overview': { request: void; response: SessionsOverview }
  /**
   * What each hosted session is holding: its process tree and its ports.
   *
   * Hosted only, and that is not a limitation to be fixed. Helm spawned the
   * pty, so the tree under it is Helm's own process tree; for a session it did
   * not spawn there is no such claim to make, and asking the machine about
   * somebody else's process tree would be a different thing entirely.
   *
   * Answers with whatever the last pass produced. The pass runs only while
   * something is watching (`sessions:watch`), so this is empty rather than
   * stale before the first one.
   */
  'sessions:resources': { request: void; response: SessionResources[] }
  /**
   * Rename a session's tab. Answers with the row as main now holds it, which is
   * what the window adopts - the same shape `settings:write` uses, so a label a
   * validator normalised cannot drift from what was stored.
   */
  'session:rename': { request: RenameSessionRequest; response: SessionRecord }

  /**
   * The project shell - a plain terminal under the project pane, opened in
   * that project's directory. Not a session: no row, no history, no
   * notification (see main/pterm.ts). Opening an already-open path reattaches
   * to the shell it has.
   */
  'pterm:open': {
    request: {
      path: string
      cols: number
      rows: number
      /**
       * Open this pane under a specific executable. Absent means the
       * `terminalShell` setting, and failing that whatever Helm detects.
       */
      shell?: string
    }
    response: {
      id: number
      /** The executable actually running, which the pane header shows. */
      shell: string
      /** What was asked for when that is not what runs; null when they agree. */
      requested: string | null
      problem: string | null
    }
  }
  /** Kill the shell. Called when the project's tab closes, not when it hides. */
  'pterm:close': { request: { id: number }; response: void }
  /**
   * Shells this machine has, for the settings pane's default picker and the
   * per-pane one in a project shell's header. Probed once per process - the
   * answer is a property of the installation, not of Helm's state.
   */
  'pterm:shells': { request: void; response: DetectedShell[] }

  'profile:list': { request: void; response: Profile[] }
  /** Create or update. Returns the problems instead of throwing for a draft
   * the form should show errors against rather than a dialog. */
  'profile:save': { request: SaveProfileRequest; response: SaveProfileResult }
  'profile:delete': { request: { id: number }; response: { deleted: boolean } }
  /** Rewrites the pin order from the given ids; anything omitted is unpinned. */
  'profile:pin': { request: { ids: number[] }; response: Profile[] }
  /** Native save dialog, then the YAML. */
  'profile:export': { request: { id: number }; response: ExportProfileResult }
  'profile:import': { request: void; response: ImportProfileResult }
  /**
   * Synthesise the overlays and spawn. Rejects with a readable message for the
   * same reason `session:start` does.
   */
  'profile:launch': { request: LaunchProfileRequest; response: LaunchedProfile }

  /**
   * The session index over `~/.claude/history.jsonl`. Read-only: Helm
   * mirrors that file and never writes to it.
   */
  'history:summary': { request: void; response: HistorySummary }
  'history:sessions': { request: HistoryQuery; response: HistoryPage }
  'history:prompts': { request: { sessionId: string }; response: HistoryPrompt[] }
  'history:projects': { request: void; response: HistoryProject[] }
  /** Forces a pass now. The index also keeps itself current; this is the button. */
  'history:refresh': { request: void; response: HistorySummary }
  /**
   * Names one session by hand, or clears the name it was given.
   *
   * The one write on this family of channels, and it goes nowhere near
   * `history.jsonl` - it lands in `history_names`, a table of Helm's own that
   * the index never rebuilds. Null, or whitespace, clears it and the row goes
   * back to the title derived from its prompts. Resolves null for a session id
   * the index does not have, rather than writing a name nothing joins to.
   */
  'history:rename': {
    request: RenameHistorySessionRequest
    response: HistorySession | null
  }
  /**
   * Spawns `claude --resume <id>` in the directory history recorded. Rejects
   * with a readable sentence when the transcript or the directory has gone,
   * rather than opening a tab that prints "No conversation found" and exits.
   */
  'history:resume': { request: ResumeSessionRequest; response: ResumedSession }

  /**
   * The transcript archive: the conversations Helm kept after Claude Code
   * deleted them.
   *
   * Read-only in both directions, and in two senses. Helm never writes to
   * `~/.claude` to build this - `main/archive.ts` only ever reads - and the
   * window can only read it back: there is no channel here that captures,
   * deletes or re-runs anything, because none of those is the window's to
   * decide. What the window may change is the ceiling, and that is an ordinary
   * `settings:write`.
   *
   * This is what CLAUDE.md's Scope paragraph was amended for. Helm still
   * renders nothing for a **live** session; an archived transcript is a record
   * on disk that Claude Code is about to remove, and nothing on this channel is
   * ever in the path of a running session.
   */
  'archive:conversation': {
    request: { sessionId: string }
    response: ArchivedConversation | null
  }
  /** Sessions, messages and bytes against the ceiling. What Settings states. */
  'archive:stats': { request: void; response: ArchiveStats }

  /**
   * The config console. This is the one surface that *writes* to a
   * `.claude` tree, which is why every write goes through `config:write` and
   * nothing else - the snapshot is taken there, and a second path into the
   * filesystem would be a path with no undo behind it.
   */
  /**
   * A draft, tokenised for an editor's underlay.
   *
   * One channel for both editors, because there is one editor component and one
   * highlighter. It takes the source rather than a path to read, for the reason
   * `config:render` does: what is being coloured is what is in the box, which is
   * not on disk and may never be.
   *
   * Read-only in the strongest sense - it opens no file and writes none - so it
   * is not a second route into a `.claude` tree. Every byte Helm writes still
   * goes through `config:write`.
   *
   * The window debounces this and drops stale answers against a revision
   * counter; nothing here is on the path between a keystroke and a glyph.
   */
  'editor:highlight': {
    request: { path: string; source: string }
    response: EditorHighlight
  }

  'config:scopes': { request: void; response: ConfigScope[] }
  'config:tree': { request: { scopePath: string }; response: ConfigTree }
  'config:read': { request: { path: string }; response: ConfigFileContent }
  /**
   * The same bytes as something other than a textarea: markdown rendered, a
   * hook highlighted. Takes the source rather than reading the file again, so
   * one channel serves both the file on disk and a draft being edited - and so
   * the render can never be of a version the pane is not showing.
   */
  'config:render': {
    request: { path: string; source: string }
    response: ConfigRendered
  }
  'config:write': { request: WriteConfigRequest; response: WriteConfigResult }
  /** Versions of one file, newest first, without their contents. */
  'config:snapshots': {
    request: { scopePath: string; path: string }
    response: ConfigSnapshotMeta[]
  }
  /** The bytes of one version, for a preview before restoring it. */
  'config:snapshot': { request: { id: number }; response: { content: string } | null }
  'config:restore': { request: { id: number; path: string }; response: WriteConfigResult }
  /** Tells main which file to watch for changes made outside the app. */
  'config:watch': { request: WatchConfigRequest; response: void }

  /**
   * The three things a directory supports that replacing one file's bytes does
   * not. They are separate channels rather than modes of `config:write` because
   * each takes a different question - a kind and a name, a new name, or nothing
   * at all - and because a delete that arrived as a write of zero bytes would
   * be a delete with no way to tell it from an emptied file.
   *
   * All three go through the same snapshot-first path `config:write` does, and
   * through the same `assertWritable`: a new channel here is a new *question*,
   * never a second route into the filesystem.
   */
  'config:create': { request: CreateConfigRequest; response: CreateConfigResult }
  /** Moves a skill's whole directory, or a command across its namespace path. */
  'config:rename': { request: RenameConfigRequest; response: RenameConfigResult }
  /** Snapshots first, then removes. Each row is restorable through `config:restore`. */
  'config:delete': { request: DeleteConfigRequest; response: DeleteConfigResult }

  'config:effective': { request: EffectiveViewRequest; response: EffectiveView }

  'config:mcpPreview': { request: McpAddRequest; response: McpPreview }
  /** Runs `claude mcp add-json`, having snapshotted the file it will rewrite. */
  'config:mcpAdd': { request: McpAddRequest; response: McpResult }
  'config:mcpRemove': {
    request: { name: string; scope: McpScope; cwd: string }
    response: McpResult
  }
  'config:mcpApprove': { request: McpApproveRequest; response: WriteConfigResult }
  /** `claude mcp list`, which health-checks every server, so it is slow. */
  'config:mcpList': { request: { cwd: string }; response: McpResult }

  /**
   * `claude doctor` for the scope on screen.
   *
   * Carries a `cwd` because which Claude Code is being asked about is a
   * property of the path: a scope inside a WSL distribution is served by that
   * distribution's CLI, and a health report about this machine's would be a
   * report about an installation those sessions never run.
   */
  'config:doctor': { request: { cwd: string }; response: DoctorReport }

  /**
   * Claude Code's cached answer about plan limits, read out of
   * `~/.claude.json`. Read-only, like the session index: these are the
   * server's figures and Helm mirrors them.
   *
   * The reading is shipped raw - what may be *painted* from it is decided in
   * the window, on a timer, because a reading goes stale and a usage window
   * rolls over without any file having changed.
   */
  'usage:read': { request: void; response: UsageSnapshot }

  /**
   * Open pull requests across the discovered repositories.
   *
   * `pr:snapshot` is the cache and nothing else - it runs no subprocess, so the
   * pane paints from SQLite on the first frame and the fetch that follows
   * arrives as `pr:changed`. `pr:refresh` is the button: it fetches now, for one
   * repository or all of them, and resolves with what it found.
   *
   * Helm holds no GitHub credential on either path. Every fetch behind these two
   * channels is the user's own `gh` CLI, run on the user's own token.
   */
  'pr:snapshot': { request: void; response: PullsSnapshot }
  'pr:refresh': { request: { repoPath?: string }; response: PullsSnapshot }
  /**
   * One pull request, for its own tab.
   *
   * Answers from the cached detail when there is one, running no `gh` at all in
   * that case - which is what makes reopening a tab instant. `refresh` is the
   * button: it fetches again and rewrites the cache.
   *
   * The markdown - the description, every comment, every review body - is
   * rendered **here**, in main, through the same sanitising pipeline the
   * content viewer uses. The window receives HTML it never evaluates, and
   * shiki's grammars stay out of the browser bundle.
   */
  'pr:detail': {
    request: { repoPath: string; number: number; refresh?: boolean }
    response: PullDetailView
  }
  /**
   * Start a Claude Code session that reviews this pull request.
   *
   * Four fields, and the absence of a fifth is the point: **the prompt is not
   * one of them**. Main looks the pull request up in its own cache, reads the
   * template out of settings and renders it there, exactly as `profile:launch`
   * sends an id rather than an argv. A window that composed the prompt would be
   * a window whose idea of the template could drift from the stored one, and
   * argv assembled in a renderer is argv nothing in the main process checked.
   *
   * Rejects with a whole sentence: no `gh`, not signed in, a pull request the
   * list no longer has, a dirty tree in `checkout` mode, or no `claude` CLI.
   * The pane shows it as it is.
   *
   * What comes back is a session like any other - it lands in the strip through
   * the same adopt flow a resume uses, and Helm reads nothing it prints.
   */
  'pr:review': { request: ReviewPullRequest; response: LaunchedReview }

  /**
   * The content viewer. Rendering happens here rather than in the window:
   * shiki's grammars are megabytes the browser bundle must not carry, and a
   * live preview that re-parsed a 21 KB note on the UI thread per keystroke
   * would be the one place in the app that stutters.
   */
  'content:scopes': { request: void; response: ContentScope[] }
  'content:tree': { request: { scopePath: string; refresh?: boolean }; response: ContentTree }
  /**
   * One directory of the tree view.
   *
   * A channel per directory rather than one walk, because the tree is lazy on
   * purpose: `content:tree` walks a whole scope to decide what to *curate*, and
   * a project has no ceiling that walk could be given which is not either a
   * silent truncation or a several-second pause. This one costs a `readdir` and
   * a `git check-ignore` against a directory somebody just clicked open.
   */
  'content:dir': {
    request: { scopePath: string; relPath: string }
    response: ContentDirListing
  }
  /** A file, its bytes, and - for markdown - the HTML it renders to. */
  'content:document': {
    request: { scopePath: string; path: string }
    response: ContentDocument
  }
  /** The same render for text that is not on disk yet: the split preview. */
  'content:render': {
    request: { scopePath: string; path: string; source: string }
    response: RenderedMarkdown
  }
  'content:search': {
    request: { scopePath: string; query: string }
    response: ContentSearchResult
  }
  /**
   * Saving a note. A different channel from `config:write` because it is a
   * different *permission* - notes here, configuration there - but the same
   * snapshot table and the same conflict check behind both.
   */
  'content:write': { request: WriteConfigRequest; response: WriteConfigResult }
  'content:snapshots': {
    request: { scopePath: string; path: string }
    response: ConfigSnapshotMeta[]
  }
  'content:restore': { request: { id: number; path: string }; response: WriteConfigResult }
  /**
   * Mints the URL a sandboxed frame may load an HTML artifact from. The
   * renderer never builds this URL itself: a frame can only reach a directory
   * the main process pinned to a token it issued for a file the user opened.
   */
  'content:artifact': {
    request: { scopePath: string; path: string }
    response: { url: string; token: string }
  }
  /**
   * Resolves a `[[wikilink]]` a *frame* clicked.
   *
   * The one caller that cannot resolve its own links. A rendered note has its
   * links resolved before the HTML reaches the window; an HTML artifact runs in
   * a sandbox with an opaque origin that is deliberately told no paths, so it
   * posts the target's name out and this answers with the file. `from` is the
   * artifact, which is how `[[index]]` prefers the one in its own directory.
   */
  'content:wikilink': {
    request: { scopePath: string; target: string; from: string }
    response: { path: string | null }
  }

  /**
   * Hands a link in a rendered note to the OS browser.
   *
   * Needed because the alternative is nothing: `will-navigate` is prevented and
   * `setWindowOpenHandler` denies, so an `https://` link in a note is inert
   * without this. Restricted to http, https and mailto in the handler - a note
   * is content, and `shell.openExternal` on an arbitrary scheme is a way to run
   * a program.
   */
  'shell:openExternal': { request: { url: string }; response: { opened: boolean } }

  /** The terminal pane's clipboard, routed through Electron rather than the
   * async DOM Clipboard API, which needs a permission prompt and a focused
   * document - neither of which a hosted TUI can rely on. */
  'clipboard:read': { request: void; response: string }
  'clipboard:write': { request: string; response: void }

  /**
   * The browser pane.
   *
   * Every one of these addresses a view by id, because the view is main's and
   * the window holds nothing but a rectangle and a number - the same shape the
   * session channels have, for the same reason. What is deliberately *not* here
   * is a channel that hands main a URL to fetch on its own: every navigation
   * behind these is a page the user asked for, in a view they opened.
   *
   * The whole family goes through `browserReachAllows`, in `@helm/core`, and
   * nothing here re-implements any part of it - see `main/browser.ts`.
   */

  /**
   * Make a view. `url` is optional: a new tab with no address is an empty pane
   * with the caret in the address bar, which is what a new-tab button should do.
   * `project` is the project the tab was opened beside, and it is what the
   * remembered per-project URL is keyed on.
   */
  'browser:open': {
    request: { url?: string; project?: string | null }
    response: { state: BrowserState | null; problem: string | null }
  }
  /**
   * Go somewhere. Takes what was **typed**, not a URL: turning `3000` into
   * `http://localhost:3000/` and refusing a word rather than searching for it
   * are decisions about the address bar, and they are made in one place
   * (`resolveBrowserAddress`) so the pane and an agent cannot disagree.
   */
  'browser:navigate': { request: { id: number; input: string }; response: BrowserState | null }
  'browser:back': { request: { id: number }; response: BrowserState | null }
  'browser:forward': { request: { id: number }; response: BrowserState | null }
  /** `hard` reloads ignoring the cache - what a stale dev server asset wants. */
  'browser:reload': { request: { id: number; hard?: boolean }; response: BrowserState | null }
  /** Destroys the view. The tab closing is what calls this, like `disposeShell`. */
  'browser:close': { request: { id: number }; response: void }
  /**
   * Every view, or one of them.
   *
   * With no id it is the adopt list, and it is here for the reason
   * `session:list` is: a renderer reload (dev HMR, a crashed render process)
   * leaves main holding views the new window has never heard of, and a strip
   * that forgot them would leave live pages painting over the app with no tab
   * to close.
   */
  'browser:state': { request: { id?: number }; response: BrowserState[] }
  /**
   * Run an expression in the page and answer with what it evaluated to.
   *
   * The console panel's input line, and the same plumbing M17's
   * `browser_evaluate` needs - built once here so that milestone exposes it
   * rather than writing a second one. The answer is a **string**: whatever a
   * page returns has to cross a process boundary, and "it did not serialise" is
   * a thing the panel should print rather than a rejected promise.
   */
  'browser:eval': {
    request: { id: number; source: string }
    response: { ok: boolean; value: string; error: string | null }
  }
  /**
   * The first DevTools in Helm, scoped to one view's own web contents and
   * opened detached - docked would put a second, Chromium-owned rectangle
   * inside the window and join the bounds problem this pane already has.
   */
  'browser:devtools': { request: { id: number }; response: BrowserState | null }
  /** `webContents.findInPage`. What it found arrives on `browser:changed`. */
  'browser:find': {
    request: { id: number; query: string; forward?: boolean }
    response: void
  }
  'browser:stopFind': { request: { id: number }; response: void }
  'browser:zoom': { request: { id: number; level: number }; response: BrowserState | null }
  /**
   * `session.clearStorageData()` for this view's partition, so an auth flow can
   * be tested twice. It clears the **shared** browser profile, because there is
   * one - see `main/browser.ts` - so the pane asks first.
   */
  'browser:clearStorage': { request: { id: number }; response: BrowserState | null }
  /** The ring buffer, for a panel that has just been opened on an old tab. */
  'browser:console': { request: { id: number }; response: BrowserConsoleEntry[] }
}

export type ResolvedTheme = 'light' | 'dark'

// ---------------------------------------------------------------------------
// Renderer -> main, fire and forget
// ---------------------------------------------------------------------------

export interface IpcSends {
  /** The renderer has mounted and can receive events. */
  'renderer:ready': void

  /** Terminal surface. High frequency, so one-way by design - a promise per
   * keystroke would put an IPC round trip in the echo path Spike C measured. */
  'pty:input': string
  'pty:resize': { cols: number; rows: number }
  'term:created': TermCreatedInfo
  'term:resized': void

  /** The app's equivalents, addressed to one session. Same reasoning. */
  'session:input': { id: number; data: string }
  'session:resize': { id: number; cols: number; rows: number }

  /** The project shell's wire, one-way for the same echo-path reason. */
  'pterm:input': { id: number; data: string }
  'pterm:resize': { id: number; cols: number; rows: number }
  /**
   * Which session the user is actually looking at, or null for a non-terminal
   * tab. Only the renderer knows this, and the main process needs it to decide
   * whether an exit is worth a notification.
   */
  'session:focus': { id: number | null }
  /**
   * Whether anything is looking at the resource pass. Renderer to main.
   *
   * A process enumeration costs 400ms of a child process where the registry
   * poll beside it costs 0.15ms, so it is **off unless somebody is watching** -
   * this is the switch, and `false` means no timer and no child process at all.
   * Reference-counted in `resources.ts`, so two watchers cannot switch each
   * other off.
   */
  'sessions:watch': { watching: boolean }

  /**
   * The answer to a `session:confirm`. One-way rather than a request, because
   * the question travelled the other way: main is the side waiting, and it
   * matches the reply to the question by `id`.
   */
  'session:confirmed': { id: number; agreed: boolean }

  /** Spike harness: the renderer's answer to a `probe:req`. */
  'probe:res': { id: number; value: unknown }

  /**
   * Where the browser view's placeholder is now, and whether it should paint.
   *
   * One-way and debounced by the sender, for the reason the terminal wires are:
   * a `ResizeObserver` and a split drag both fire per frame, and a round trip
   * per frame is a round trip inside a gesture. Nothing waits on the answer -
   * the next frame's bounds supersede this one's.
   */
  'browser:bounds': BrowserBounds
}

// ---------------------------------------------------------------------------
// Main -> renderer
// ---------------------------------------------------------------------------

export interface IpcEvents {
  'discovery:updated': DiscoveryResult
  /**
   * Git state only, keyed by project path. Pushed when the window regains
   * focus: the renderer cannot detect that reliably (a window raised behind the
   * app never fires a DOM `focus`, and `visibilitychange` does not fire for a
   * merely-obscured window), but the main process is told directly.
   */
  'git:updated': Record<string, GitState | null>
  'scan:status': ScanStatus
  'settings:changed': AppSettings
  /** The whole list after any write, so every surface showing profiles agrees
   * without each of them refetching. */
  'profiles:changed': Profile[]
  'theme:changed': { preference: ThemePreference; resolved: ResolvedTheme }
  /**
   * The session index moved. Pushed rather than polled: the file is shared
   * with every `claude` on the machine, so the change that matters most is the
   * one Helm did not cause.
   */
  'history:changed': HistorySummary

  /**
   * The transcript archive moved: a conversation was captured, or the ceiling
   * dropped one. Pushed for the reason `history:changed` is - the writes that
   * matter are the ones Helm did not cause, and a settings pane that reported a
   * figure only while somebody was looking at it would be reporting nothing.
   */
  'archive:changed': ArchiveStats

  /**
   * Claude Code refreshed its usage figures. Pushed for the same reason
   * `history:changed` is: the file belongs to every `claude` on the machine,
   * and the refresh that matters is the one Helm did not cause.
   */
  'usage:changed': UsageSnapshot

  /**
   * A launch check found a release, and it is newer than this build.
   *
   * Pushed only when the check reached GitHub. It runs once per launch and at
   * most once a day - `updateCheck` gates it, `UPDATE_CHECK_EVERY_MS` bounds
   * it - and a failure to reach GitHub sends nothing at all: offline is the
   * ordinary case here, and a status bar that reported it would be reporting
   * the network rather than anything about Helm.
   *
   * `newer` is the field the window acts on. The payload is sent either way so
   * a check that found nothing still updates "last checked", which is the one
   * thing that distinguishes "you are current" from "nobody has looked".
   */
  'update:checked': UpdateCheck

  /**
   * A fetch pass found something different, or one started.
   *
   * Pushed rather than polled for the reason every other event here is: the
   * timer that drives this lives in the main process, and the window would
   * otherwise have to poll a service that is itself polling. Sent only when the
   * snapshot's signature has changed - which includes the fetch age, because
   * that is what the pane's caption is made of.
   */
  'pr:changed': PullsSnapshot

  /**
   * The file the config editor has open changed on disk, and Helm was not the
   * one who changed it. Pushed rather than discovered at save time: by then the
   * user has typed a screen of text they are about to lose, and the point of
   * the warning is to arrive before that.
   */
  'config:externalChange': ConfigExternalChange

  /**
   * "This session is still running" - asked by main, answered by the renderer
   * on `session:confirmed`.
   *
   * The question belongs to main: it owns process lifetime, and `before-quit`
   * is raised there with no renderer involvement. But a `dialog.showMessageBox`
   * is a Win32 window with no styling surface at all - wrong typeface, wrong
   * ground, wrong everything - so the *asking* is delegated to the renderer and
   * main waits for the reply. `nativeConfirm` remains the fallback for when
   * there is no window to ask, which is the case this indirection has to keep
   * working: a Helm that cannot be quit because its renderer is wedged is worse
   * than an ugly dialog.
   */
  'session:confirm': SessionConfirmRequest

  /**
   * A line an HTML artifact wrote to its console. Pushed from main because the
   * frame's origin is opaque: the window hosting it cannot read its console,
   * and the process that owns both of them can.
   */
  'content:artifactConsole': {
    level: string
    message: string
    source: string
    line: number
  }

  'term:create': TermCreateOptions
  'term:write': string
  'term:resize': { cols: number; rows: number }

  /** Process output, addressed to the pane hosting that session. */
  'session:data': { id: number; data: string }
  /** Project-shell output and death, addressed to the pane hosting it. */
  'pterm:data': { id: number; data: string }
  'pterm:exit': { id: number; exitCode: number }
  /** The finished row, exit code and measured duration included. */
  'session:exit': SessionRecord
  /**
   * Every hosted session's activity, pushed when any of them moves.
   *
   * The whole set rather than the one that changed, and that is the cheap fix
   * for a class of bug rather than laziness: a renderer that missed one event -
   * mounted late, backgrounded, reloaded - corrects itself on the next push
   * instead of carrying a wrong dot until that session happens to transition
   * again. Four short fields per session, only sent when something actually
   * differs.
   */
  'session:activity': SessionActivityState[]
  /** Every live session on the machine, pushed when the listing changes. */
  'sessions:overview': SessionsOverview
  /** Each hosted session's tree and ports, pushed when one of them moves. */
  'sessions:resources': SessionResources[]
  /** Bring a session's tab forward - sent when its exit notification is clicked. */
  'session:activate': { id: number }

  /** Spike harness: main asks the renderer to inspect the live terminal. */
  'probe:req': { id: number; req: ProbeOp }

  /**
   * A browser view moved, loaded, failed or finished finding.
   *
   * Pushed rather than polled because a page is the one thing in the app that
   * changes without anybody in Helm having done something: a dev server
   * restarts, a redirect lands somewhere else, a retry finally connects. The
   * tab's title and the address bar are both made of this.
   */
  'browser:changed': BrowserState

  /**
   * A view Helm made that the window did not ask for: `window.open` inside a
   * page. The strip adopts it as a tab, and the cap is enforced in main - a
   * page that opens eleven windows gets ten tabs and a console line, not eleven.
   */
  'browser:opened': BrowserState

  /**
   * A view is gone. Sent when main destroyed it for a reason the window did not
   * cause - the cap, a render process that crashed, `before-quit` - so a tab
   * pointing at nothing closes itself instead of sitting there.
   */
  'browser:closed': { id: number }

  /** A line a page wrote, or a load that failed. Feeds the console panel. */
  'browser:logged': { id: number; entry: BrowserConsoleEntry }
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

export type RequestChannel = keyof IpcRequests
export type RequestPayload<K extends RequestChannel> = IpcRequests[K]['request']
export type RequestResult<K extends RequestChannel> = IpcRequests[K]['response']

export type SendChannel = keyof IpcSends
export type SendPayload<K extends SendChannel> = IpcSends[K]

export type EventChannel = keyof IpcEvents
export type EventPayload<K extends EventChannel> = IpcEvents[K]

/** The object the preload exposes. The renderer sees exactly this and nothing
 * else - no `ipcRenderer`, no `require`, no Node globals. */
export interface HelmBridge {
  invoke<K extends RequestChannel>(
    channel: K,
    ...args: RequestPayload<K> extends void ? [] : [payload: RequestPayload<K>]
  ): Promise<RequestResult<K>>

  send<K extends SendChannel>(
    channel: K,
    ...args: SendPayload<K> extends void ? [] : [payload: SendPayload<K>]
  ): void

  /** Returns an unsubscribe function. */
  on<K extends EventChannel>(channel: K, listener: (payload: EventPayload<K>) => void): () => void
}

/**
 * Channel name lists, used by the preload to build the bridge.
 *
 * Written as `Record<Channel, true>` rather than an array so the compiler
 * enforces both directions: a channel added to the types but not listed here is
 * a missing property, and a name listed here that is not a channel is an excess
 * property. An array with `satisfies` would only catch the second.
 */
export const REQUEST_CHANNELS = Object.keys({
  'app:info': true,
  'settings:read': true,
  'settings:write': true,
  'discovery:cached': true,
  'discovery:scan': true,
  'roots:suggest': true,
  'roots:add': true,
  'roots:accept': true,
  'roots:remove': true,
  'setup:status': true,
  'setup:locateClaude': true,
  'setup:complete': true,
  'wsl:distros': true,
  'wsl:homes': true,
  'wsl:probe': true,
  'wsl:networking': true,
  'wsl:setNetworking': true,
  'wsl:shutdown': true,
  'path:chooseDirectory': true,
  'path:chooseFile': true,
  'harness:create': true,
  'template:list': true,
  'template:preview': true,
  'template:detail': true,
  'template:create': true,
  'template:rename': true,
  'template:delete': true,
  'template:metadata': true,
  'template:substitute': true,
  'template:import': true,
  'template:folderPreview': true,
  'template:fromFolder': true,
  'update:check': true,
  'theme:resolved': true,
  'shell:showItem': true,
  'session:start': true,
  'session:close': true,
  'session:list': true,
  'session:activity': true,
  'sessions:overview': true,
  'sessions:resources': true,
  'session:rename': true,
  'pterm:open': true,
  'pterm:close': true,
  'pterm:shells': true,
  'profile:list': true,
  'profile:save': true,
  'profile:delete': true,
  'profile:pin': true,
  'profile:export': true,
  'profile:import': true,
  'profile:launch': true,
  'history:summary': true,
  'history:sessions': true,
  'history:prompts': true,
  'history:projects': true,
  'history:refresh': true,
  'history:rename': true,
  'history:resume': true,
  'archive:conversation': true,
  'archive:stats': true,
  'editor:highlight': true,
  'config:scopes': true,
  'config:tree': true,
  'config:read': true,
  'config:render': true,
  'config:write': true,
  'config:snapshots': true,
  'config:snapshot': true,
  'config:restore': true,
  'config:watch': true,
  'config:create': true,
  'config:rename': true,
  'config:delete': true,
  'config:effective': true,
  'config:mcpPreview': true,
  'config:mcpAdd': true,
  'config:mcpRemove': true,
  'config:mcpApprove': true,
  'config:mcpList': true,
  'config:doctor': true,
  'usage:read': true,
  'pr:snapshot': true,
  'pr:refresh': true,
  'pr:detail': true,
  'pr:review': true,
  'content:scopes': true,
  'content:tree': true,
  'content:dir': true,
  'content:document': true,
  'content:render': true,
  'content:search': true,
  'content:write': true,
  'content:snapshots': true,
  'content:restore': true,
  'content:artifact': true,
  'content:wikilink': true,
  'shell:openExternal': true,
  'clipboard:read': true,
  'clipboard:write': true,
  'browser:open': true,
  'browser:navigate': true,
  'browser:back': true,
  'browser:forward': true,
  'browser:reload': true,
  'browser:close': true,
  'browser:state': true,
  'browser:eval': true,
  'browser:devtools': true,
  'browser:find': true,
  'browser:stopFind': true,
  'browser:zoom': true,
  'browser:clearStorage': true,
  'browser:console': true
} satisfies Record<RequestChannel, true>) as RequestChannel[]

export const SEND_CHANNELS = Object.keys({
  'renderer:ready': true,
  'pty:input': true,
  'pty:resize': true,
  'term:created': true,
  'term:resized': true,
  'session:input': true,
  'session:resize': true,
  'session:focus': true,
  'sessions:watch': true,
  'pterm:input': true,
  'pterm:resize': true,
  'session:confirmed': true,
  'probe:res': true,
  'browser:bounds': true
} satisfies Record<SendChannel, true>) as SendChannel[]

export const EVENT_CHANNELS = Object.keys({
  'discovery:updated': true,
  'git:updated': true,
  'scan:status': true,
  'settings:changed': true,
  'profiles:changed': true,
  'theme:changed': true,
  'history:changed': true,
  'archive:changed': true,
  'usage:changed': true,
  'update:checked': true,
  'pr:changed': true,
  'config:externalChange': true,
  'content:artifactConsole': true,
  'term:create': true,
  'term:write': true,
  'term:resize': true,
  'session:data': true,
  'session:exit': true,
  'session:activity': true,
  'sessions:overview': true,
  'sessions:resources': true,
  'session:activate': true,
  'session:confirm': true,
  'pterm:data': true,
  'pterm:exit': true,
  'probe:req': true,
  'browser:changed': true,
  'browser:opened': true,
  'browser:closed': true,
  'browser:logged': true
} satisfies Record<EventChannel, true>) as EventChannel[]

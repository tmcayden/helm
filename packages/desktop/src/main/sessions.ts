import { type BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import {
  launchTarget,
  buildResumeArgs,
  finishSession,
  historyTitle,
  launchRequestFromProfile,
  newClaudeSessionId,
  prepareLaunch,
  readGitBranch,
  readHistorySession,
  readProfile,
  removeSessionMcpConfig,
  renameSession,
  runningSessionNames,
  sanitizeSessionName,
  sessionLabel,
  startSession,
  uniqueSessionName,
  writeSessionMcpConfig,
  type LaunchedReviewPlan,
  type LaunchPlan,
  type LaunchTarget,
  type SessionMcpServer,
  type SessionRecord,
  WINDOWS_TARGET,
  isLinuxPath,
  toWindowsPath,
  wslDistroOf
} from '@helm/core'
import type { BrowserMcpHost } from './browser-mcp'
import {
  claudePtyArgs,
  readClaudeSupportsSessionId,
  resolveClaudeCommand,
  type ClaudeCommand
} from './claude-cli'
import { emit } from './ipc'
import { shimRoot } from './paths'
import { killAllSessionsSync, killSession, spawnSession, type SessionHandle } from './pty'
import { describeWslDistro, unreachableEndpointNote, wslClaudeCommand } from './wsl'
import type { Services } from './services'
import type {
  CloseSessionRequest,
  CloseSessionResult,
  LaunchedProfile,
  LaunchProfileRequest,
  RenameSessionRequest,
  ResumedSession,
  ResumeSessionRequest,
  StartSessionRequest
} from '../shared/ipc'

/**
 * The lifecycle of a hosted `claude`, from argv to exit code.
 *
 * Helm supplies the argv, the cwd and the environment and then gets out of the
 * way (SPEC 4.4): nothing here reads the process's output. The only thing this
 * file does with the bytes is forward them to the pane that owns them.
 *
 * It owns two things the renderer cannot: what is actually alive - a tab is a
 * React value and a process is not - and the database row, so a session's exit
 * code and duration survive the window that was watching it.
 */

interface Hosted {
  record: SessionRecord
  handle: SessionHandle
  /**
   * Where this session is running, which the row does not record.
   *
   * Held in memory rather than added as a column because the one thing that
   * asks is the activity pass, which only ever asks about a session this
   * process is hosting: it decides which `~/.claude/sessions` the session's
   * record is in, and a session that is not running has no record anywhere.
   */
  target: LaunchTarget
  /**
   * The tab is gone but the process may not be yet. Kept rather than deleted so
   * that the exit still reaches the database: dropping the entry at close time
   * would leave the row claiming to be running until the next launch swept it
   * to `lost`, which is a lie about a session Helm ended on purpose.
   */
  closed: boolean
  /**
   * The bearer token this session was given for Helm's browser endpoint, and
   * the ephemeral file carrying it. Both null when `browserMcp` is off.
   *
   * Held here rather than in the endpoint's own bookkeeping because this map is
   * what knows a session has *ended*, and the token has to die with it: a token
   * that outlived its session would be a live credential for a listener,
   * belonging to a process that is gone.
   */
  mcpToken: string | null
  mcpConfigFile: string | null
}

/**
 * Optional taps for the `--sessions-check` driver.
 *
 * The app passes none. They exist because the two things this milestone has to
 * prove that leave no trace anywhere else - what a hosted session printed, and
 * whether an exit was judged worth a notification - are decided here and then
 * forgotten. A driver that asserted on screenshots instead would be asserting
 * on the wrong thing.
 */
export interface SessionObserver {
  onOutput?: (id: number, chunk: string) => void
  /** Called only when a notification was actually shown. */
  onNotified?: (record: SessionRecord) => void
}

/** A question that must be answered before a live session is ended. */
export interface ConfirmRequest {
  kind: 'close-session' | 'quit'
  message: string
  detail: string
  /**
   * What the agreeing button says. Carried on the request rather than derived
   * by each implementation, so the Helm dialog and the native fallback cannot
   * word the same decision two different ways.
   */
  confirmLabel: string
  /** The sessions the answer decides the fate of. */
  sessions: SessionRecord[]
}

/**
 * How the user is asked. Injected rather than called directly so the driver can
 * answer it: a native modal has no automation surface, and a check that leaves
 * one open on screen also leaves it in the way of the app's own shutdown.
 */
export type Confirm = (request: ConfirmRequest) => Promise<boolean>

/**
 * How long main will wait for the renderer to answer before asking the old way.
 *
 * This is not a "the user is taking too long" timer - it is set well past any
 * real reading time, because the only thing it exists to catch is a renderer
 * that will never answer at all. `before-quit` holds the window open on this
 * promise, so without a ceiling a wedged renderer makes Helm unquittable, and
 * an ugly dialog beats an app that cannot be closed. If it does fire while a
 * Helm dialog is still on screen, the native box is what decides; the stale
 * answer arrives later and finds nothing waiting for it.
 */
const CONFIRM_TIMEOUT_MS = 120_000

let nextConfirmId = 1
const pendingConfirms = new Map<number, (agreed: boolean) => void>()

// Module scope, not per host: a second `createSessionHost` in the same process
// would otherwise stack a listener per call. Registered alongside the no-op in
// `ipc.ts`, which keeps the send contract exhaustive without stealing the event.
ipcMain.on('session:confirmed', (_e, { id, agreed }: { id: number; agreed: boolean }) => {
  pendingConfirms.get(id)?.(agreed)
  pendingConfirms.delete(id)
})

/**
 * Ask the renderer, so the question is a Helm island rather than a Win32 box.
 *
 * Falls back to `native` whenever there is no live window to ask - during
 * shutdown, before the first window, or after a renderer has gone. That path is
 * the reason this indirection is allowed to exist at all: main owns process
 * lifetime, and it must never be unable to ask its question.
 */
function rendererConfirm(window: () => BrowserWindow | null, native: Confirm): Confirm {
  return async (request) => {
    const win = window()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return native(request)

    const id = nextConfirmId++
    const answered = await new Promise<boolean | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingConfirms.delete(id)
        resolve(null)
      }, CONFIRM_TIMEOUT_MS)
      pendingConfirms.set(id, (agreed) => {
        clearTimeout(timer)
        resolve(agreed)
      })
      emit(win, 'session:confirm', {
        id,
        kind: request.kind,
        message: request.message,
        detail: request.detail,
        confirmLabel: request.confirmLabel,
        // What the tab says, not the `-n` name: this dialog is asking about the
        // sessions on screen, and a list naming them something else is a list
        // the user has to translate before answering.
        sessionNames: request.sessions.map(sessionLabel)
      })
    })

    return answered ?? native(request)
  }
}

function nativeConfirm(window: () => BrowserWindow | null): Confirm {
  return async ({ message, detail, confirmLabel }) => {
    const win = window()
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: [confirmLabel, 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message,
      detail
    }
    const { response } =
      win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
    return response === 0
  }
}

export interface SessionHost {
  start: (req: StartSessionRequest) => Promise<SessionRecord>
  /** Synthesises the profile's overlays, then spawns against them. */
  launchProfile: (req: LaunchProfileRequest) => Promise<LaunchedProfile>
  /** Reopens a conversation from the history index in a new tab. */
  resume: (req: ResumeSessionRequest) => Promise<ResumedSession>
  /**
   * Starts a session on a pull request, with a prompt composed by the caller.
   *
   * Takes the whole plan rather than a pull request number, because deciding
   * what the prompt says needs the cache, the settings and possibly a `gh pr
   * checkout` - all of which belong to `pulls.ts`. What this file owns is what
   * it owns for every other launch: turning a plan into argv and a process.
   */
  review: (
    plan: LaunchedReviewPlan,
    grid: { cols: number; rows: number }
  ) => Promise<SessionRecord>
  close: (req: CloseSessionRequest) => Promise<CloseSessionResult>
  /** Helm's own label for a tab. Never rewrites the `-n` name. */
  rename: (req: RenameSessionRequest) => SessionRecord
  /** Sessions this process is hosting, running or exited-but-not-yet-closed. */
  list: () => SessionRecord[]
  input: (id: number, data: string) => void
  resize: (id: number, cols: number, rows: number) => void
  /** The grid the pane last reported, which is what the pty is actually at. */
  grid: (id: number) => { cols: number; rows: number } | null
  /** OS process id, for asserting a session is really gone. */
  pid: (id: number) => number | null
  /**
   * Where a hosted session is running, so the activity pass knows which
   * `~/.claude/sessions` its record is in. Null for a session this process is
   * not hosting, which has no record anywhere.
   */
  target: (id: number) => LaunchTarget | null
  /**
   * The session a bearer token was minted for, or null.
   *
   * **The whole of attribution at Helm's endpoint**, and it is answered from
   * this map rather than from bookkeeping of its own because this map is what
   * owns a token's lifetime: the same entry that hands the token out is the one
   * that revokes it when the session ends, so an answer here cannot outlive the
   * session it names. A caller never says which session it is; the token that
   * arrived does, and this is where that becomes a row.
   *
   * Null for an unknown token, for a session that has ended, and for a session
   * whose tools were never registered - all three are "Helm has no session for
   * this", which is the only honest answer to a token it does not know.
   */
  tokenHolder: (token: string) => SessionRecord | null
  /**
   * Called whenever the set of hosted sessions changes - a spawn, an exit, a
   * close - so the activity poller re-reads at once instead of on its next tick.
   *
   * A callback rather than a direct call because the poller is created *after*
   * this host (it needs the window), and because this file has no business
   * knowing what else cares that a session started.
   */
  onChanged: (listener: () => void) => void
  /** Which pane the user is looking at; decides whether an exit notifies. */
  setFocus: (id: number | null) => void
  runningCount: () => number
  /** Asks about every still-running session at once. True means go ahead. */
  confirmCloseAll: () => Promise<boolean>
  /** Synchronous teardown for app quit. */
  shutdown: () => void
}

export interface SessionHostDeps {
  services: Services
  window: () => BrowserWindow | null
  /**
   * Helm's browser endpoint, or null where there is none.
   *
   * A function for the reason `window` is one: it is created after this host,
   * because it drives the browser views and those need the window. Null - or a
   * `register` that answers null - is the ordinary state with `browserMcp` off,
   * and it produces a launch with no `--mcp-config` in it at all.
   */
  browserMcp?: (() => BrowserMcpHost | null) | undefined
  observer?: SessionObserver | undefined
  /** Defaults to asking the renderer, with the native box behind it. */
  confirm?: Confirm | undefined
}

export function createSessionHost({
  services,
  window,
  browserMcp,
  observer,
  confirm = rendererConfirm(window, nativeConfirm(window))
}: SessionHostDeps): SessionHost {
  const hosted = new Map<number, Hosted>()
  const grids = new Map<number, { cols: number; rows: number }>()
  let focused: number | null = null
  const changed = new Set<() => void>()
  const announce = (): void => {
    for (const listener of changed) listener()
  }

  const isRunning = (h: Hosted): boolean => h.record.status === 'running'
  /** Still alive *and* still in a tab. */
  const running = (): Hosted[] => [...hosted.values()].filter((h) => isRunning(h) && !h.closed)

  /**
   * The names a new launch must not collide with.
   *
   * Wider than "what is running", and that is a fix rather than caution. The
   * counter used to be computed against the running rows alone, so ending
   * `dev 2` and starting another session produced a second `dev 2` - a label
   * pointing at different work, sitting in the strip beside the dead tab still
   * wearing it. A tab survives its process (the scrollback is the record of what
   * happened), so the set that matters is the set of tabs, which is exactly the
   * entries this host has not been asked to forget.
   *
   * The running rows stay in the union because they are a fact about the
   * database rather than about this process, and two Helms sharing a data
   * directory is a state `paths.ts` allows.
   *
   * Labels are deliberately not in here. This produces the `-n` name, and `-n`
   * is what `/resume` lists; what someone has since renamed a *tab* to has no
   * bearing on which session names Claude Code will show side by side.
   */
  const takenNames = (): string[] => [
    ...runningSessionNames(services.store),
    ...[...hosted.values()].filter((h) => !h.closed).map((h) => h.record.name)
  ]

  function onExit(id: number, exitCode: number): void {
    // The row is the source of truth for the duration - it measures against the
    // clock that wrote `started_at`. `finishSession` returns null if this exit
    // was already recorded, in which case there is nothing to announce.
    const record = finishSession(services.store, id, { exitCode })
    const entry = hosted.get(id)
    // Before every branch below, because every one of them ends this session:
    // the process is gone, so its token is a credential nothing owns.
    if (entry) releaseBrowserTools(entry)
    if (!record || !entry || entry.closed) {
      // Already recorded, or nobody is watching: there is no pane to tell.
      hosted.delete(id)
      announce()
      return
    }

    entry.record = record
    emit(window(), 'session:exit', record)
    announce()
    notifyIfUnwatched(record)
  }

  /**
   * Helm notifies on an unwatched **exit**, and deliberately not on `waiting`.
   *
   * The question came up with the session-state indicator, since `waitingFor`
   * hands over a ready-made sentence. The answer is no, for now, and the
   * reasoning is worth keeping because it will be asked again.
   *
   * An exit is *terminal*: it happens once, it is the end of the thing, and a
   * notification is the only way to learn about it without watching. `waiting`
   * is neither - a session in a permission-asking mode enters and leaves it once
   * per tool call, and the probe that measured these states saw two `waiting`
   * transitions inside eighteen seconds. One of them was a `/help` dialog the
   * user had opened a moment earlier, and telling somebody about a dialog they
   * just opened is the definition of noise. A toast per permission prompt would
   * make the feature something people turn off.
   *
   * The tab's dot is continuous, costs nothing and is already the answer while
   * the window is in front of you. What would earn a notification is the case
   * the dot cannot reach: the window is **not focused**, the session has been
   * waiting for more than some seconds, and `waitingFor` is not `"dialog open"`
   * - a dialog is something the user did, a permission prompt is something the
   * agent needs. That is three thresholds and a string comparison against an
   * undocumented value, which is a design with its own measurements rather than
   * a line added here.
   */
  function notifyIfUnwatched(record: SessionRecord): void {
    const win = window()
    // "Non-focused" is two conditions, not one: a session in a background tab
    // of a focused window is just as unwatched as one in a minimised window.
    const watched = win !== null && !win.isDestroyed() && win.isFocused() && focused === record.id
    if (watched || !Notification.isSupported()) return

    const outcome =
      record.exitCode === 0 ? 'finished' : `exited with code ${String(record.exitCode ?? '?')}`
    const notification = new Notification({
      // The tab's label: this notification's job is to send someone back to a
      // tab, so it has to name the one they will be looking for.
      title: `${sessionLabel(record)} ${outcome}`,
      body: record.cwd
    })
    notification.on('click', () => {
      const target = window()
      if (!target || target.isDestroyed()) return
      if (target.isMinimized()) target.restore()
      target.show()
      target.focus()
      emit(target, 'session:activate', { id: record.id })
    })
    notification.show()
    observer?.onNotified?.(record)
  }

  /**
   * A conversation id for a launch, or null where this CLI has no flag for one.
   *
   * Minted per launch and never reused: a uuid that already exists is refused
   * outright - `Error: Session ID <uuid> is already in use.`, exit 1, measured
   * on 2.1.238 - so there is no "reconnect by id" to be had here, and treating
   * one as reusable would turn a launch into a failure.
   *
   * A CLI that does not take the flag gets no flag and launches exactly as it
   * did before, which is the whole of "warns and launches without it": the
   * warning is `setup.ts`'s, said once at startup about the binary, rather than
   * a sentence repeated at every launch about something the user cannot fix
   * from here.
   */
  const mintSessionId = async (): Promise<string | null> =>
    (await readClaudeSupportsSessionId()) ? newClaudeSessionId() : null

  /**
   * A token for the session about to start, or null.
   *
   * Minted before `prepareLaunch` because the argv is what carries it: the file
   * `prepareLaunch` writes *is* the registration, and a token that existed
   * without a file - or a file without a token - would be a session holding
   * half a credential.
   */
  const registerBrowserTools = (
    name: string
  ): { token: string; mcp: { dir: string; servers: SessionMcpServer[] } } | null => {
    const registration = browserMcp?.()?.register(name) ?? null
    return registration === null ? null : { token: registration.token, mcp: registration.launch }
  }

  /** Tell the endpoint where the file went, so `stop()` can take it away. */
  const attachBrowserTools = (token: string | null, file: string | null): void => {
    if (token !== null) browserMcp?.()?.attach(token, file)
  }

  /**
   * The token dies with the session, and this is the only place that decides
   * so.
   *
   * Called on exit, on close and on shutdown, and safe to call twice - a
   * session that ends while its tab is still open, and one whose tab is closed
   * while it runs, are two orders for the same two events.
   */
  const releaseBrowserTools = (entry: Hosted): void => {
    browserMcp?.()?.release(entry.mcpToken)
    removeSessionMcpConfig(entry.mcpConfigFile)
    entry.mcpToken = null
    entry.mcpConfigFile = null
  }

  /**
   * A working directory this process can actually start a program in.
   *
   * The session's own directory for anything on this machine. Two shapes fall
   * back to the user's home instead, and `--cd` is what puts the session where
   * it belongs in both:
   *
   *   `\\wsl$\Ubuntu\home\me\work`  a path inside a distro. Windows has no
   *                                 directory there that `CreateProcess` will
   *                                 accept - measured, it answers ENOENT.
   *   `/home/me/work`               a **resumed** distro session, whose working
   *                                 directory was recorded by the CLI that had
   *                                 the conversation and is therefore
   *                                 Linux-spelled. `path.win32` would resolve
   *                                 the leading slash against the current
   *                                 drive root and start the session in
   *                                 `C:\home\me\work`, which is not a failure
   *                                 anybody could read - it is a session in the
   *                                 wrong place, or one that will not start.
   *
   * Deliberately not silent about which is which: the session **row** keeps
   * `plan.cwd`, because the honest answer to "where is this session working" is
   * the project, not wherever the relay happened to be launched from.
   */
  const hostCwd = (cwd: string): string =>
    wslDistroOf(cwd) === null && !isLinuxPath(cwd) ? cwd : homedir()

  /**
   * Which CLI to hand a `--resume` to, from the transcript it will open.
   *
   * A transcript under `\\wsl$\<distro>\...\.claude\projects` was written by
   * that distro's CLI and can only be reopened by it. Everything else - a path
   * on this machine, and the null of a row whose transcript has been reaped
   * (which `resume` refuses before reaching here) - is Windows, which is what
   * this whole path did unconditionally before a distro's history was indexed.
   */
  const resumeTarget = (transcriptFile: string | null): LaunchTarget => {
    const distro = transcriptFile === null ? null : wslDistroOf(transcriptFile)
    return distro === null ? WINDOWS_TARGET : { kind: 'wsl', distro }
  }

  /**
   * The distro's own `claude`, as a command the pty can open.
   *
   * Throws rather than degrading, and that is the one place a WSL target is
   * stricter than a Windows one. A missing Windows CLI is a machine somebody
   * can fix from the settings pane and every other surface still works without
   * it; a WSL target with no CLI inside the distro is a launch that was asked
   * for explicitly and cannot happen, so it says which distro and what to
   * install rather than opening a pty that closes.
   */
  const wslCommandFor = async (distro: string, cwd: string): Promise<ClaudeCommand> => {
    const probe = await describeWslDistro(distro, browserMcp?.()?.address()?.port ?? null)
    if (probe.claudePath === null) {
      throw new Error(probe.problem ?? `No \`claude\` inside ${distro}.`)
    }
    return wslClaudeCommand(distro, probe.claudePath, cwd)
  }

  /**
   * Whether a target can have Helm's own tools, and what to say when it cannot.
   *
   * Asked **before** the token is minted, because minting one for a session
   * that can never reach the endpoint would leave a live credential nothing can
   * use - and the `--mcp-config` naming it would send the CLI looking for a
   * server that never answers. A Windows target is always allowed; this is
   * entirely about the measured fact that a distro on default NAT networking
   * cannot see this machine's loopback.
   */
  const toolsGate = async (
    target: LaunchTarget
  ): Promise<{ allowed: boolean; note: string | null }> => {
    if (target.kind !== 'wsl') return { allowed: true, note: null }
    const port = browserMcp?.()?.address()?.port ?? null
    // No endpoint at all - both tool settings off - is not a WSL problem and
    // must not produce a sentence blaming WSL for it.
    if (port === null) return { allowed: false, note: null }
    const probe = await describeWslDistro(target.distro, port)
    return probe.endpointReachable
      ? { allowed: true, note: null }
      : { allowed: false, note: unreachableEndpointNote(target.distro) }
  }

  /**
   * The one path a session is spawned by, whether it came from a project row or
   * from a profile. Both produce a `LaunchPlan` first - the only difference
   * between them is how many flags ended up in it.
   *
   * Async only because of the branch read below, which is why every caller of
   * this is async too.
   */
  async function spawn(
    plan: LaunchPlan,
    grid: { cols: number; rows: number },
    origin: { projectPath?: string | null | undefined; profileId?: number | null | undefined },
    mcpToken: string | null = null
  ): Promise<SessionRecord> {
    /*
     * Which `claude` this session runs, and therefore which program the pty
     * opens.
     *
     * A WSL target does not resolve on this machine at all: the CLI is the
     * distro's, discovered inside it, and the program is `wsl.exe` with that
     * path behind `--`. Everything after this line is unchanged for both -
     * which is the design, and why the branch is one `if` rather than a second
     * spawn path.
     */
    const command =
      plan.target.kind === 'wsl'
        ? await wslCommandFor(plan.target.distro, plan.cwd)
        : resolveClaudeCommand()
    if (!command) {
      throw new Error(
        'Claude Code CLI not found. Install it (or put `claude` on PATH) and restart Helm.'
      )
    }

    const argv = [...command.prefixArgs, ...plan.argv]

    /**
     * The branch the tab's subtitle carries, read once, here, and never again.
     *
     * **Captured, not followed**, and both halves of that are the decision.
     *
     * Following HEAD would defeat the subtitle it feeds. Two sessions in one
     * working tree share a HEAD by construction, so a live reading would put the
     * same branch on both of them - and the moment somebody checked out a second
     * branch to run the second session on, it would relabel the first tab to
     * match. Telling those two apart is the whole reason the subtitle exists.
     * Captured, they read `main` and `feat/x`, which is what happened.
     *
     * And a tab is a position you learn: a strip that quietly relabels itself
     * mid-work is one you have to re-read every time you look at it, which is
     * worse than one that is occasionally a checkout behind.
     *
     * Read from git here rather than taken from the `GitState` the sidebar
     * already holds - that cache is refreshed on window *focus*, and the way a
     * second session on a second branch actually gets started is a `git checkout`
     * inside a session Helm is already hosting, during which the window never
     * loses focus and the cache never moves. The one case this feature is for is
     * the one case the cache is stale for.
     *
     * Before the row rather than after: a session that dies in its first second
     * still gets a complete row, and a second UPDATE would be a second way for
     * this to be half-written.
     */
    const branch = await readGitBranch(plan.cwd)

    // The row goes in before the spawn so that a session which dies in its
    // first second is still a session that happened, with a reason.
    const record = startSession(services.store, {
      name: plan.name,
      cwd: plan.cwd,
      branch,
      projectPath: origin.projectPath ?? null,
      profileId: origin.profileId ?? null,
      argv,
      // Taken off the plan rather than re-read out of `argv`: the plan is what
      // put the flag there, so this is the value at its source.
      claudeSessionId: plan.claudeSessionId
    })

    let handle: SessionHandle
    try {
      handle = spawnSession({
        id: String(record.id),
        file: command.file,
        // The row above records the logical `argv`, which is what the launch
        // disclosure prints and what a person would type. What the pty is
        // handed is a different question for a `.cmd` shim, where cmd.exe
        // re-parses the line - see `claudePtyArgs`.
        args: claudePtyArgs(command, plan.argv),
        cols: Math.max(grid.cols, 1),
        rows: Math.max(grid.rows, 1),
        /*
         * The directory *this* process starts the program in, which is not
         * always the directory the session runs in.
         *
         * For a project inside a distro those are two different places, and the
         * distinction is load-bearing: `CreateProcess` cannot take a UNC
         * working directory at all - it answers ENOENT, measured 2026-09-02 -
         * so handing `\\wsl$\Ubuntu\...` to node-pty fails the spawn before
         * `wsl.exe` ever runs. The session's real working directory is carried
         * by `--cd` in `wslClaudeCommand`, which the relay honours; where the
         * pty itself starts is then irrelevant, so it starts somewhere this
         * process can certainly chdir to.
         */
        cwd: hostCwd(plan.cwd),
        onData: (data) => {
          emit(window(), 'session:data', { id: record.id, data })
          observer?.onOutput?.(record.id, data)
        },
        onExit: (exitCode) => onExit(record.id, exitCode)
      })
    } catch (err) {
      finishSession(services.store, record.id, { exitCode: null })
      // The token would otherwise outlive a session that never existed, and
      // the file with it.
      browserMcp?.()?.release(mcpToken)
      removeSessionMcpConfig(plan.mcpConfigFile)
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(`Could not start a session in ${plan.cwd}: ${detail}`, { cause: err })
    }

    hosted.set(record.id, {
      record,
      handle,
      closed: false,
      target: plan.target,
      mcpToken,
      mcpConfigFile: plan.mcpConfigFile
    })
    announce()
    return record
  }

  return {
    async start(req) {
      const base = req.name?.trim() || basename(req.cwd) || 'session'
      const name = uniqueSessionName(base, takenNames())
      const tools = registerBrowserTools(name)
      const plan = prepareLaunch({
        root: req.cwd,
        name,
        shimRoot,
        mcp: tools?.mcp ?? null,
        sessionId: await mintSessionId()
      })
      attachBrowserTools(tools?.token ?? null, plan.mcpConfigFile)
      return spawn(plan, req, { projectPath: req.projectPath }, tools?.token ?? null)
    },

    async launchProfile(req) {
      const profile = readProfile(services.store, req.profileId)
      if (!profile) throw new Error('That profile no longer exists.')

      // Named after the profile, uniqued against every tab in the strip: three
      // sessions from one profile is the normal case, and `/resume` shows only
      // the name.
      const name = uniqueSessionName(profile.name, takenNames())
      const gate = await toolsGate(launchTarget(profile.target))
      const tools = gate.allowed ? registerBrowserTools(name) : null
      const plan = prepareLaunch({
        ...launchRequestFromProfile(profile, shimRoot, name),
        mcp: tools?.mcp ?? null,
        sessionId: await mintSessionId()
      })
      // On the plan's own warnings rather than a channel of its own: the launch
      // already has a place for "something you should know that did not stop
      // this", and the pane already paints it.
      if (gate.note !== null) plan.warnings.push(gate.note)
      attachBrowserTools(tools?.token ?? null, plan.mcpConfigFile)

      // The overlay work happens before the row exists, so a profile pointing
      // at a repo that has been deleted fails here rather than as a session
      // that starts and quietly composes nothing.
      const session = await spawn(plan, req, { profileId: profile.id }, tools?.token ?? null)

      return {
        session,
        profile,
        overlays: plan.overlays.map((shim) => shim.name),
        composedInstructions: plan.memoryFile !== null,
        warnings: plan.warnings
      }
    },

    /**
     * Reopening a conversation `history.jsonl` remembers.
     *
     * Both preconditions are checked here rather than trusted from the
     * renderer. The launcher already refuses to offer a session it knows is
     * reaped, but "knows" is an index that was current a moment ago, and the
     * failure it is guarding against - `claude` printing "No conversation
     * found" into a fresh tab and exiting - is exactly the broken terminal the
     * milestone is about. A sentence the pane can show is better than a tab
     * that dies in front of the user.
     */
    async resume(req) {
      const history = readHistorySession(services.store, req.sessionId)
      if (!history) {
        throw new Error('That session is not in the history index any more.')
      }
      if (!history.projectExists) {
        throw new Error(
          `${history.project} is no longer on disk. Claude Code resolves a session id against the working directory, so this conversation cannot be reopened from anywhere else.`
        )
      }
      if (history.transcriptFile === null) {
        throw new Error(
          'Claude Code has removed this conversation’s transcript, so there is nothing left to resume. Its prompts are still in the history.'
        )
      }

      // Helm's own label for the tab, not the session's name - `-n` is not
      // passed, so nothing here reaches the CLI. The same name the history pane
      // shows, which is the point: a tab titled `/usage` is a tab nobody can
      // pick out of a strip, and that is what the opening prompt gave for 291
      // of this machine's sessions.
      const label = uniqueSessionName(
        sanitizeSessionName(historyTitle(history)) || history.projectName,
        takenNames()
      )

      /*
       * A resumed session gets the browser tools too, and it goes through the
       * same core writer rather than a second one - `writeSessionMcpConfig` is
       * what `prepareLaunch` calls, and this is the one launch path that does
       * not build its argv there. What it must **not** borrow from
       * `prepareLaunch` is everything else: `-n`, a model, an overlay set. The
       * conversation was had under whatever it was had under.
       */
      const tools = registerBrowserTools(label)
      const mcpConfigFile =
        tools === null ? null : writeSessionMcpConfig(tools.mcp.dir, tools.mcp.servers)
      attachBrowserTools(tools?.token ?? null, mcpConfigFile)

      /*
       * The recorded directory, in the spelling the rest of Helm uses.
       *
       * A distro's CLI wrote down `/home/me/harness`, because that is what it
       * saw. Everything downstream here is a Windows process reading a Windows
       * path - the git branch on the row, `hostCwd`, the sessions pane - and a
       * bare `/home/...` is not one: `path.win32` resolves the leading slash
       * against the current drive root. Translated once, at the only point that
       * knows which distro wrote it, a resumed distro session is then
       * indistinguishable from one launched into that distro, and needed no
       * special case anywhere below.
       *
       * `toWindowsPath` answers null for a path that is already this machine's,
       * which is what a `/mnt/c` session records - so that falls through to the
       * recorded path unchanged, which is already right.
       */
      const target = resumeTarget(history.transcriptFile)
      const cwd =
        target.kind === 'wsl'
          ? (toWindowsPath(history.project, { distro: target.distro }) ?? history.project)
          : history.project

      const session = await spawn(
        {
          cwd,
          name: label,
          argv: buildResumeArgs(history.sessionId, mcpConfigFile),
          overlays: [],
          memoryFile: null,
          mcpConfigFile,
          /*
           * The id it already has, recorded rather than re-minted.
           *
           * `--resume <id>` was measured registering under that same id on
           * 2.1.238, so this row and the registry agree without the flag - and
           * passing `--session-id` here would be asserting an id that already
           * exists, which the CLI refuses outright.
           */
          claudeSessionId: history.sessionId,
          /*
           * Whose CLI had this conversation, read off the transcript's path.
           *
           * `history.jsonl` records a project directory and a conversation id
           * and says nothing about where the CLI that wrote them was running -
           * which is why this used to be Windows unconditionally, and why
           * guessing from `history.project` would still be wrong: a session run
           * *inside* a distro against `/mnt/c/work` records a `C:\work`-shaped
           * project and belongs to the distro all the same.
           *
           * The transcript file is the evidence the project path is not. It is
           * the file `--resume` will open, it is under the `~/.claude/projects`
           * of the CLI that wrote it, and the index now reads a distro's
           * alongside this machine's - so a transcript at
           * `\\wsl$\Ubuntu\...\projects\...` is Ubuntu's conversation by
           * construction rather than by inference. Resuming it anywhere else
           * fails with "No conversation found" and no indication why, which is
           * exactly what this avoids.
           */
          target,
          warnings: []
        },
        req,
        { projectPath: history.project },
        tools?.token ?? null
      )

      return { session, history }
    },

    /**
     * A review is an ordinary session that happens to open with a prompt.
     *
     * Which is the whole design. There is no review mode, no second kind of
     * pty and nothing watching what comes back: `prepareLaunch` puts the prompt
     * where the CLI expects a bare positional (`core/launch/plan.ts` -
     * `buildLaunchArgs`, last), the shared `spawn` starts it, and from that
     * moment it is a tab like any other, which the user can talk to, interrupt
     * or close. Helm never parses a line of it - see SPEC 4.4 and the hard rule
     * in CLAUDE.md.
     *
     * `projectPath` is the repository, so the session appears against the
     * project it reviewed rather than as an orphan.
     */
    async review(plan, grid) {
      const repo = plan.slug.split('/')[1] ?? basename(plan.repoPath)
      // Named for what it is, and uniqued like every other launch: reviewing
      // two pull requests at once is the normal case.
      const name = uniqueSessionName(`PR #${String(plan.number)} review - ${repo}`, takenNames())
      const tools = registerBrowserTools(name)
      const launch = prepareLaunch({
        root: plan.repoPath,
        name,
        shimRoot,
        openingPrompt: plan.prompt,
        // Null for either of these passes no flag at all, which is what keeps a
        // Helm nobody has configured launching exactly what `claude` would.
        model: plan.model,
        effort: plan.effort,
        mcp: tools?.mcp ?? null,
        sessionId: await mintSessionId()
      })
      attachBrowserTools(tools?.token ?? null, launch.mcpConfigFile)
      return spawn(launch, grid, { projectPath: plan.repoPath }, tools?.token ?? null)
    },

    /**
     * Helm's label for the tab, written to `sessions.label`.
     *
     * The hosted copy is updated alongside the row because `list()` is what a
     * renderer reload adopts and what the confirmation dialog is composed from -
     * a rename that reached the database and not this map would come back at the
     * next reload and would name the session by its old label in the dialog
     * asking to end it.
     *
     * A session this process is not hosting is still renamed. The row is the
     * record, and refusing would make the answer depend on which tab happened to
     * be open.
     */
    rename(req) {
      const record = renameSession(services.store, req.id, req.label)
      if (!record) throw new Error('That session is not in this database.')
      const entry = hosted.get(req.id)
      if (entry) entry.record = record
      return record
    },

    async close(req) {
      const entry = hosted.get(req.id)
      if (!entry) return { closed: true }

      if (isRunning(entry) && req.force !== true) {
        const agreed = await confirm({
          kind: 'close-session',
          message: `“${sessionLabel(entry.record)}” is still running.`,
          detail: `Closing the tab ends the Claude Code session in ${entry.record.cwd}.`,
          confirmLabel: 'End session',
          sessions: [entry.record]
        })
        if (!agreed) return { closed: false }
        // Re-read: the answer took as long as a person took to give it, and the
        // session may have ended on its own in the meantime.
        if (!hosted.has(req.id)) return { closed: true }
      }

      entry.closed = true
      if (isRunning(entry)) killSession(String(req.id))
      else {
        // The exit already released it; this is the other order - a tab closed
        // on a session that had already ended, whose entry is going now.
        releaseBrowserTools(entry)
        hosted.delete(req.id)
      }
      if (focused === req.id) focused = null
      announce()
      return { closed: true }
    },

    list: () => [...hosted.values()].filter((h) => !h.closed).map((h) => h.record),

    input(id, data) {
      hosted.get(id)?.handle.write(data)
    },

    resize(id, cols, rows) {
      const entry = hosted.get(id)
      if (!entry) return
      grids.set(id, { cols, rows })
      entry.handle.resize(cols, rows)
    },

    grid: (id) => grids.get(id) ?? null,

    pid: (id) => hosted.get(id)?.handle.pid ?? null,

    target: (id) => hosted.get(id)?.target ?? null,

    tokenHolder(token) {
      // A running session only. A token is revoked when its session ends, so
      // reaching this with a live token for an exited session would be a bug
      // rather than a state - and answering with the row anyway would let a
      // dead session's identity go on being asserted.
      for (const entry of hosted.values()) {
        if (entry.mcpToken !== null && entry.mcpToken === token && isRunning(entry)) {
          return entry.record
        }
      }
      return null
    },

    onChanged(listener) {
      changed.add(listener)
    },

    setFocus(id) {
      focused = id
    },

    runningCount: () => running().length,

    async confirmCloseAll() {
      const live = running()
      if (live.length === 0) return true

      return confirm({
        kind: 'quit',
        message:
          live.length === 1
            ? `“${live[0] ? sessionLabel(live[0].record) : ''}” is still running.`
            : `${String(live.length)} Claude Code sessions are still running.`,
        detail: 'Quitting Helm ends them.',
        confirmLabel: live.length > 1 ? `End ${String(live.length)} sessions` : 'End session',
        sessions: live.map((entry) => entry.record)
      })
    },

    shutdown() {
      // Rows first: once the processes are gone their `onExit` handlers may not
      // get a turn on the event loop before the process image is replaced, and
      // a row left claiming to be running would be reconciled to `lost` at the
      // next launch - which is the wrong answer for a session Helm ended on
      // purpose.
      for (const entry of hosted.values()) {
        if (isRunning(entry)) {
          finishSession(services.store, entry.record.id, { exitCode: entry.handle.exitCode() })
        }
        // Belt and braces: `before-quit` has already stopped the endpoint,
        // which revoked everything. This is what makes the file go away when
        // this host is shut down without one - which is what the check does.
        releaseBrowserTools(entry)
      }
      killAllSessionsSync()
      hosted.clear()
    }
  }
}

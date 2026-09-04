import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  shell
} from 'electron'
import {
  claudeHome,
  projectsDirIn,
  readProfile,
  writeSetting,
  writeSettings,
  type AppSettings
} from '@helm/core'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { emit, registerIpc, resolvedTheme } from './ipc'
import { appMode, dataDir, initDataDir, mcpConfigDir, shimRoot, templatesDir } from './paths'
import { activePty, killAllSessionsSync, killPty, spawnPty, windowsBuildNumber } from './pty'
import {
  adoptExistingProfile,
  cachedProjects,
  createServices,
  refreshGit,
  runScan,
  updateSettings,
  type Services
} from './services'
import { createConfigService } from './config'
import { createTemplateService } from './templates'
import {
  attachArtifactConsole,
  CONTENT_SCHEME,
  createContentService,
  registerContentProtocol
} from './content'
import {
  browserWillNavigate,
  browserWindowOpen,
  createBrowserHost,
  type BrowserHost
} from './browser'
import { createBrowserMcp, type BrowserMcpHost } from './browser-mcp'
import type { SessionToolsWorld } from './session-tools'
import { runBrowserChecks } from './browsercheck'
import { createArchiveService } from './archive'
import { createHistoryService } from './history'
import { watchWslClaudeTree } from './wslwatch'
import { createPullsService } from './pulls'
import { createUsageService } from './usage'
import { wslHomes } from './wsl'
import { maybeCheckForUpdate } from './update'
import { createSessionHost, type Confirm, type SessionObserver } from './sessions'
import { createActivityService } from './activity'
import { createResourcesService } from './resources'
import {
  createCollector,
  runSessionsChecks,
  runSessionsRestartChecks,
  type CheckContext
} from './sessionscheck'
import { TITLEBAR_OVERLAY } from './chrome'
import { createPtermHost } from './pterm'
import { runDesignShot } from './designshot'
import { runAffordanceChecks } from './affordancecheck'
import { runHighlightChecks } from './highlightcheck'
import { runProfilesChecks } from './profilescheck'
import { HOLD_REPORT, runShimHold } from './shimhold'
import { runHistoryChecks } from './historycheck'
import { runConfigChecks } from './configcheck'
import { runContentChecks } from './contentcheck'
import { runUsageChecks } from './usagecheck'
import { runSettingsChecks } from './settingscheck'
import { runPrChecks } from './prcheck'
import { runTranscriptChecks, runTranscriptRestartChecks } from './transcriptcheck'
import { hashTemplatesDir, runTemplateChecks } from './templatecheck'
import { runSelftest } from './selftest'
import { runFidelity } from './fidelity'
import { runClaudeChecks } from './claudecheck'
import { findClaudeExecutable, setClaudeOverride } from './claude-cli'
import { setGhOverride } from './gh-cli'
import { pickerAnswer, runPackagingChecks } from './packagingcheck'
import { screenshot } from './bridge'

/**
 * Two products in one binary.
 *
 * The default mode is the app: a window with the launcher, backed by SQLite and
 * project discovery. The `--selftest` / `--fidelity` / `--claude-check` /
 * `--claude` modes are Spike B and C's harnesses, kept because they are the
 * regression tests for the terminal configuration those spikes proved
 * load-bearing (CLAUDE.md, "Hard rules"). They render a different page and open
 * no database.
 */

type Mode =
  | 'app'
  | 'shell'
  | 'selftest'
  | 'fidelity'
  | 'claude-check'
  | 'claude'
  | 'sessions-check'
  | 'sessions-restart'
  | 'profiles-check'
  | 'history-check'
  | 'config-check'
  | 'content-check'
  | 'packaging-check'
  | 'packaging-firstrun'
  | 'usage-check'
  | 'usage-settings'
  | 'settings-check'
  | 'settings-restart'
  | 'pr-check'
  | 'transcript-check'
  | 'transcript-restart'
  | 'template-check'
  | 'browser-check'
  | 'browser-restart'
  | 'template-seed'
  | 'shim-sweep'
  | 'shim-hold'
  | 'design-shot'
  | 'affordance-check'
  | 'highlight-check'

function modeFromArgv(): Mode {
  if (process.argv.includes('--design-shot')) return 'design-shot'
  if (process.argv.includes('--affordance-check')) return 'affordance-check'
  if (process.argv.includes('--highlight-check')) return 'highlight-check'
  if (process.argv.includes('--selftest')) return 'selftest'
  if (process.argv.includes('--fidelity')) return 'fidelity'
  if (process.argv.includes('--claude-check')) return 'claude-check'
  if (process.argv.includes('--sessions-check')) return 'sessions-check'
  if (process.argv.includes('--sessions-restart')) return 'sessions-restart'
  if (process.argv.includes('--profiles-check')) return 'profiles-check'
  if (process.argv.includes('--history-check')) return 'history-check'
  if (process.argv.includes('--config-check')) return 'config-check'
  if (process.argv.includes('--content-check')) return 'content-check'
  if (process.argv.includes('--packaging-check')) return 'packaging-check'
  if (process.argv.includes('--packaging-firstrun')) return 'packaging-firstrun'
  if (process.argv.includes('--usage-check')) return 'usage-check'
  if (process.argv.includes('--usage-settings')) return 'usage-settings'
  if (process.argv.includes('--settings-check')) return 'settings-check'
  if (process.argv.includes('--settings-restart')) return 'settings-restart'
  if (process.argv.includes('--pr-check')) return 'pr-check'
  if (process.argv.includes('--transcript-check')) return 'transcript-check'
  if (process.argv.includes('--transcript-restart')) return 'transcript-restart'
  if (process.argv.includes('--browser-check')) return 'browser-check'
  if (process.argv.includes('--browser-restart')) return 'browser-restart'
  if (process.argv.includes('--template-check')) return 'template-check'
  if (process.argv.includes('--template-seed')) return 'template-seed'
  if (process.argv.includes('--shim-sweep')) return 'shim-sweep'
  if (process.argv.includes('--shim-hold')) return 'shim-hold'
  if (process.argv.includes('--claude')) return 'claude'
  if (process.argv.includes('--shell')) return 'shell'
  return 'app'
}

const mode = modeFromArgv()
// The check modes are the app: they drive the real window, so they need the
// real startup path, the database included.
const isSpikeMode =
  mode !== 'app' &&
  mode !== 'sessions-check' &&
  mode !== 'sessions-restart' &&
  mode !== 'profiles-check' &&
  mode !== 'history-check' &&
  mode !== 'config-check' &&
  mode !== 'content-check' &&
  mode !== 'packaging-check' &&
  mode !== 'packaging-firstrun' &&
  mode !== 'usage-check' &&
  mode !== 'settings-check' &&
  mode !== 'pr-check' &&
  mode !== 'transcript-check' &&
  mode !== 'transcript-restart' &&
  mode !== 'template-check' &&
  mode !== 'browser-check' &&
  mode !== 'browser-restart' &&
  mode !== 'shim-hold' &&
  mode !== 'design-shot' &&
  mode !== 'affordance-check' &&
  mode !== 'highlight-check'

/**
 * A check's window keeps rendering when something else is in front of it.
 *
 * Chromium backgrounds an occluded window: `requestAnimationFrame` stops and
 * timers are throttled to once a second. Every check here drives the **real
 * window** and measures what came back within a few hundred milliseconds - a
 * synthesised pointer move and then `getComputedStyle`, a drag and then the
 * pane's width - so a throttled renderer answers "nothing changed" to all of
 * it, which is indistinguishable from the app being broken.
 *
 * Measured on a machine running six Helm windows at once: `affordance-check`
 * measured 162 controls with its window in front and 7 with somebody else's on
 * top, reporting most of the app as having no hover state at all. The
 * alternative - raising or focusing our own window - is worse than the
 * problem, because every other window on that machine belongs to a check that
 * would then be the one being measured through a throttled renderer.
 *
 * Check and spike modes only. `app` is somebody's actual Helm, and a Helm
 * minimised behind an editor should go quiet like any other window.
 */
if (mode !== 'app') {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
}

initDataDir()

/**
 * The scheme HTML artifacts are served on, declared before the app is ready
 * because that is the only moment Chromium accepts a privileged scheme.
 *
 * `standard` gives it a real origin so relative URLs inside an artifact resolve
 * against the file's own directory; `secure` keeps it out of Chromium's
 * mixed-content and "not a secure context" penalty boxes. It is *not*
 * `corsEnabled` and does not `supportFetchAPI`: the frame gets no network, and
 * the way to make sure of that is to not build the doors.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: CONTENT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false }
  }
])

/**
 * Every renderer is our own bundle; nothing else may be navigated to or opened.
 *
 * The browser pane's `WebContentsView`s are the one thing in Helm that is
 * *supposed* to navigate, and they are let through **here**, by id, rather than
 * by relaxing anything. `browserWillNavigate` answers false for every web
 * contents that is not a live browser view - the window, the spike page, an
 * artifact frame - so the app's own renderers keep exactly the lock they had
 * before this pane existed, and a view that has been destroyed loses the
 * exemption with it.
 *
 * The window-open side answers `deny` for everything that is not a browser
 * view, and that is still the whole of the app's own posture - the window, the
 * spike page and an artifact frame cannot open anything, ever. A browser view
 * gets its answer from `browserWindowOpen`, which turns `target="_blank"` into
 * a Helm tab and `window.open` with features into a real popup window on the
 * same partition, under the same reach rule, in the same registry.
 *
 * The popup is the one deliberate widening in this file and it was measured
 * into existence: denied, `window.open` returns `null` and every OAuth library
 * reports a blocked popup, and the tab Helm opened instead has no
 * `window.opener` for the sign-in to hand its code back through. See
 * `browserWindowOpen` for the terms it is held to.
 *
 * Both hooks are read at *navigation* time rather than at creation time, which
 * is what lets the registry be filled in the view's own constructor path.
 */
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler((details) => browserWindowOpen(contents.id, details))
  contents.on('will-navigate', (event, url) => {
    if (!browserWillNavigate(contents.id, url)) event.preventDefault()
  })
})

function createWindow(
  page: 'index' | 'spike',
  bounds?: AppSettings['windowBounds']
): BrowserWindow {
  const win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    // Position is restored only when both coordinates were saved; handing
    // Electron one of the two would place the window at the other's default.
    ...(bounds?.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 900,
    minHeight: 560,
    // Painted before the renderer's first frame, so a cold start does not flash
    // white on a dark desktop.
    // The canvas tokens from theme.css - a mismatch here flashes the old
    // colour for a frame on every cold start.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#12131f' : '#eceef4',
    show: true,
    autoHideMenuBar: true,
    // The app window replaces the OS-accent title bar with its own brand
    // strip plus the Window Controls Overlay (see chrome.ts). The spike pages
    // keep the native frame: their drivers predate the strip and measure a
    // page, not the chrome.
    ...(page === 'index' && process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: TITLEBAR_OVERLAY[nativeTheme.shouldUseDarkColors ? 'dark' : 'light']
        }
      : {}),
    // A packaged Electron window does NOT inherit the exe's icon: given no
    // `icon` it uses Electron's own, which is what the taskbar showed on
    // 2026-08-10 while the exe itself was correctly stamped.
    //
    // `.ico` on Windows, not the PNG. The taskbar and title bar want 16 and 32
    // pixel variants, and a lone 256px PNG leaves Windows to invent them - it
    // kept showing Electron's default instead. The .ico carries every size.
    // Packaged, the file arrives through `extraResources`; unpackaged it is
    // read out of `build/` directly.
    icon: join(
      app.isPackaged ? process.resourcesPath : join(__dirname, '../../build'),
      process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    ),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only touches `contextBridge` and `ipcRenderer`, both of
      // which are available to a sandboxed preload, so the renderer runs in the
      // OS sandbox like any other Chromium content process.
      sandbox: true,
      webviewTag: false
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(page === 'index' ? devUrl : `${devUrl}/spike.html`)
  } else {
    win.loadFile(join(__dirname, `../renderer/${page === 'index' ? 'index' : 'spike'}.html`))
  }
  return win
}

function writeReport(name: string, report: unknown): string {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, name)
  writeFileSync(file, JSON.stringify(report, null, 2))
  return file
}

// ---------------------------------------------------------------------------
// App mode
// ---------------------------------------------------------------------------

export interface AppOptions {
  /** Taps for `--sessions-check`; the app itself passes none. */
  observer?: SessionObserver | undefined
  /** Answers the "this session is still running" question. Defaults to a dialog. */
  confirm?: Confirm | undefined
  /** Called once the renderer has mounted and the first scan is under way. */
  onReady?: ((ctx: CheckContext) => void) | undefined
  /**
   * Index a different `.claude` tree. Only `--history-check` passes one, so that
   * the watch can be proved against a fixture it is allowed to append to as
   * well as against the real file.
   */
  claudeHome?: string | undefined
  /**
   * Fetch pull requests through this `gh` instead of the discovered one.
   *
   * `pnpm dev` passes the synthetic gh here, and it is a launch argument rather
   * than the `ghPath` setting for two reasons. A setting would be written into
   * the database, and the dev database is a copy somebody may one day copy back
   * - so dev's fake binary would end up pointed at by the real app, on a path
   * that no longer exists. And which binary the pull requests come from is not
   * the window's to choose, which is why there is no IPC channel for it either;
   * `pointGh` on the service is the same hook `pr-check` uses.
   */
  gh?: string | undefined
  /**
   * Stand-ins for the native pickers, so `--packaging-firstrun` can drive "add a
   * folder" and "locate claude" through the real handlers. Same shape and same
   * reasoning as `confirm`.
   */
  chooseDirectory?: ((title: string) => string | null) | undefined
  chooseFile?: ((title: string) => string | null) | undefined
}

/**
 * The one line `pnpm dev:live` owes anybody who runs it.
 *
 * Printed before the database is opened, because by the time the window is up
 * the damage this warns about is already possible: this process is about to
 * write to the `helm.db`, the `overlays/` and the Chromium profile of whichever
 * Helm the user has open. The status bar names the mode too, but a chip on a
 * window somebody is not looking at is not a warning.
 */
function announceLiveMode(): void {
  if (appMode !== 'dev-live') return
  const rule = '─'.repeat(72)
  console.warn(
    [
      '',
      rule,
      '  DEV, LIVE - this run shares the installed app\'s data directory.',
      `    ${dataDir}`,
      '  Its database, overlay shims and Chromium profile are the ones the',
      '  installed Helm uses. Running both at once will fight over the',
      '  Chromium profile, and anything written here is written there.',
      '',
      '  `pnpm dev` is the isolated one. This is `pnpm dev:live`.',
      rule,
      ''
    ].join('\n')
  )
}

function startApp(options: AppOptions = {}): void {
  announceLiveMode()
  const services: Services = createServices()
  // Before anything can spawn: a `claude` the user picked by hand has to win
  // over discovery in every caller, and the session host does not read
  // settings.
  setClaudeOverride(services.settings.claudePath)
  // Same reason, same shape: the pull-request surface resolves `gh` through a
  // module-level override, and it must be in place before the first pass.
  setGhOverride(services.settings.ghPath)
  // Before the window exists: an install from before the setup pane has roots
  // and no completion stamp, and stamping it after the first paint would flash
  // a setup pane over a working launcher.
  if (adoptExistingProfile(services)) {
    console.log('existing profile adopted; first run marked complete')
  }
  if (services.lostSessions > 0) {
    console.warn(`${services.lostSessions} session(s) did not outlive the last run; marked lost`)
  }
  if (services.staleShims > 0) {
    console.log(`removed ${String(services.staleShims)} overlay shim(s) left by the last run`)
  }
  if (services.templates.seeded) {
    console.log(`seeded ${String(services.templates.created.length)} template file(s) into ${templatesDir}`)
  }
  if (services.templates.problem !== null) console.warn(services.templates.problem)

  let win: BrowserWindow | null = createWindow('index', services.settings.windowBounds ?? null)

  /**
   * Helm's own MCP endpoint, reached through a getter.
   *
   * It cannot be created here: it drives the browser host, which is created
   * further down because it needs the window. And the session host cannot be
   * created after it, because the browser host's `writeSettings` and this
   * file's shutdown order both already depend on the order these three are in.
   * So the session host is handed a *function*, which is the shape it already
   * uses for the window for the same reason.
   */
  let browserMcp: BrowserMcpHost | null = null

  /**
   * And what the session-awareness tools read, reached the same way.
   *
   * Null until the activity poller and the resource service exist, which is
   * after the endpoint for the reason above. A tool called in that window says
   * "still starting up" rather than throwing - see `session-tools.ts`.
   */
  let sessionTools: SessionToolsWorld | null = null

  const sessions = createSessionHost({
    services,
    window: () => win,
    browserMcp: () => browserMcp,
    observer: options.observer,
    confirm: options.confirm
  })

  // The setting is read through a function rather than passed by value: the
  // default shell has to be able to change while the app is running, and a
  // captured value would make it a property of when Helm started.
  const pterm = createPtermHost({
    window: () => win,
    defaultShell: () => services.settings.terminalShell
  })

  /*
   * The archive, and the session index that feeds it.
   *
   * Declared in this order and wired in the other: the archive is a **second
   * consumer of the walk the session index already does** rather than a second
   * walk, so `createHistoryService` hands it the transcript map it has just
   * built. `archive.start` is given the index's own `refresh` for the same
   * reason - the watch over `projects/` wakes one pass that serves both.
   * `main/archive.ts` explains why it is this walk and not the usage index's.
   */
  const archive = createArchiveService({
    store: services.store,
    projectsDir: projectsDirIn(options.claudeHome ?? claudeHome()),
    maxBytes: () => services.settings.transcriptArchiveMaxBytes,
    onChange: (stats) => emit(win, 'archive:changed', stats)
  })

  const history = createHistoryService({
    store: services.store,
    home: options.claudeHome,
    onTranscripts: (transcripts) => archive.consume(transcripts),
    onChange: (summary) => emit(win, 'history:changed', summary),
    // Only ever reached through `useHomes`, which the `--claude-home` gate
    // below never calls - so a check pointed at a fixture spawns nothing.
    watchDistro: watchWslClaudeTree
  })

  const usage = createUsageService({
    store: services.store,
    ...(options.claudeHome !== undefined ? { home: options.claudeHome } : {}),
    onChange: (snapshot) => emit(win, 'usage:changed', snapshot)
  })


  /**
   * The projects the PR sweep considers, read through a function.
   *
   * The last scan when there has been one, the cache before that - so a cold
   * start sweeps the repositories the previous run knew about rather than
   * waiting for discovery, and a rescan that adds a repository is picked up on
   * the next pass without anything having to tell this service about it.
   */
  const pulls = createPullsService({
    store: services.store,
    settings: () => services.settings,
    projects: () =>
      (services.lastScan?.projects ?? cachedProjects(services)).map((project) => ({
        path: project.path,
        name: project.name
      })),
    onChange: (snapshot) => emit(win, 'pr:changed', snapshot)
  })
  // Before the first pass, and through the service's own hook rather than the
  // setting - see `AppOptions.gh`.
  if (options.gh !== undefined) {
    pulls.pointGh(options.gh)
    console.log(`pull requests are coming from ${options.gh}`)
  }

  const config = createConfigService({
    services,
    ...(options.claudeHome !== undefined ? { userHome: options.claudeHome } : {}),
    onExternalChange: (change) => emit(win, 'config:externalChange', change)
  })

  const content = createContentService({ services })
  attachArtifactConsole(win, (entry) => emit(win, 'content:artifactConsole', entry))

  /**
   * The browser pane's views.
   *
   * Settings are read through a function and written through one, for the two
   * different reasons both shapes exist elsewhere in this file. The reach
   * posture can change while a view is open, so a captured value would make it
   * a property of when the tab was made. And the addresses a view has been to
   * are written by *main*, because main is the side that knows a navigation
   * succeeded - a redirect, a retry that finally connected and a `window.open`
   * are all invisible to a window that only saw what it asked for.
   */
  const browsers: BrowserHost = createBrowserHost({
    window: () => win,
    settings: () => services.settings,
    writeSettings: (patch) => {
      const next = updateSettings(services, patch)
      emit(win, 'settings:changed', next)
    },
    onChanged: (state) => emit(win, 'browser:changed', state),
    onOpened: (state) => emit(win, 'browser:opened', state),
    onClosed: (id) => emit(win, 'browser:closed', { id }),
    onLogged: (id, entry) => emit(win, 'browser:logged', { id, entry })
  })

  /**
   * And the endpoint that lets a session drive those views.
   *
   * Started here rather than lazily at the first launch, because "there is no
   * listener when `browserMcp` is off" has to be true of the *app* rather than
   * of a code path nobody has taken yet - a port that appears the first time
   * somebody starts a session is a port whose absence proves nothing.
   *
   * `start()` answers rather than throws: a machine where the loopback bind
   * fails is a machine where Helm still works, with no browser tools and a line
   * on the console saying so.
   */
  browserMcp = createBrowserMcp({
    browsers,
    settings: () => services.settings,
    dir: mcpConfigDir,
    sessions: () => sessionTools
  })
  void browserMcp.start().then(({ started, problem }) => {
    if (started) {
      const bound = browserMcp?.address()
      console.log(
        `${(browserMcp?.servedNames() ?? []).join(' and ')} on http://${bound?.address ?? '?'}:${String(
          bound?.port ?? 0
        )} (loopback, token-gated)`
      )
    } else if (services.settings.browserMcp || services.settings.sessionMcp) {
      console.warn(`Helm's tools are not available: ${problem ?? 'unknown'}`)
    }
  })

  /*
   * What each hosted session is doing, out of Claude Code's own registry.
   *
   * After the session host because it reads from it, and pointed at the same
   * `.claude` tree everything else that reads one is - so a check that hands
   * over a fixture home gets a registry from that home rather than the user's.
   */
  const activity = createActivityService({
    sessions,
    window: () => win,
    ...(options.claudeHome !== undefined ? { claudeHome: options.claudeHome } : {})
  })
  sessions.onChanged(() => activity.refresh())

  /*
   * The WSL distributions' `~/.claude` directories, handed to the four things
   * that read one, once the probe that finds them lands.
   *
   * A distro keeps a `.claude` of its own and a session hosted there uses only
   * that one: its prompts go in that `history.jsonl`, its transcript under that
   * `projects/`, its live status in that `sessions/`. So all four widen
   * together or the app is inconsistent with itself - a session in the history
   * whose tokens are not in the spend, or a tab whose dot never lights.
   *
   * The archive is the fourth and the one with a deadline on it: a transcript
   * Claude Code reaps is gone, so a home the archive's own sweep cannot see is
   * not a stale figure but a conversation lost. Its incremental half already
   * rode `history`'s widened walk; `useHomes` is what widens the sweep.
   *
   * Off the startup path on purpose. It is a `wsl.exe` per distribution, ~200ms
   * each cold, and all four are useful before it answers: they hold this
   * machine's, which is what they held before any of this existed. When it
   * answers they widen, and the window gets the ordinary change events.
   *
   * Not done at all when `--claude-home` points somewhere: a check pointed at a
   * fixture tree must not reach into the developer's real distributions. The
   * other way of pointing - the real `CLAUDE_CONFIG_DIR`, which is how
   * `transcript-check` does it - is refused inside `wslHomes` itself, so it
   * holds for the three other callers too. See that function for what it cost
   * to learn that this gate covered only one of the two.
   */
  if (options.claudeHome === undefined) {
    void wslHomes()
      .then((found) => {
        if (found.length === 0) return
        history.useHomes(found)
        usage.useHomes(found)
        activity.useHomes(found)
        archive.useHomes(found)
        console.log(`reading ${found.map((home) => home.distro).join(', ')} alongside this machine`)
      })
      .catch((err: unknown) => {
        // No WSL here is the ordinary answer, not a failure.
        console.warn(`WSL homes could not be read: ${String(err)}`)
      })
  }

  /*
   * What each hosted session is *holding* - its process tree and its ports.
   *
   * A separate service from the one above because it is a separate budget. The
   * registry poll costs 0.15ms and runs always; a process enumeration costs
   * 400ms of a child process and runs only while somebody is looking at it.
   * Wiring one off the other's timer is the change `resources.ts` exists to
   * argue against.
   */
  const resources = createResourcesService({ sessions, window: () => win })
  // A session ending is a tree that has gone with it, so the pass is re-run at
  // once rather than leaving a dead session's children on screen for an
  // interval. A no-op when nothing is watching.
  sessions.onChanged(() => void resources.refresh())

  /*
   * What a session may be told about the other sessions.
   *
   * Assembled from the three things that already know: the activity poller's
   * machine-wide listing, the resource service's process pass, and the session
   * host's own rows. **Nothing here reads the registry or the process table a
   * second time** - a second reader would be a second answer to "what is
   * running", free to disagree with the pane about it.
   *
   * `factsFor` is where the boundary is enforced rather than described: it
   * builds the answer field by field out of the row, and `argv` is not one of
   * the fields. A review session's argv carries its opening prompt, and every
   * argv carries the path to that session's own bearer token.
   */
  sessionTools = {
    refreshOverview: () => activity.refresh(),
    overview: () => activity.overview(),
    callerOf: (token) => sessions.tokenHolder(token)?.id ?? null,
    factsFor: (helmSessionId) => {
      const record = sessions.list().find((row) => row.id === helmSessionId)
      if (record === undefined) return null
      const profile = record.profileId === null ? null : readProfile(services.store, record.profileId)
      return {
        helmSessionId: record.id,
        branch: record.branch,
        // The profile may have been deleted since - a session is a record of
        // what happened and outlives the profile it came from - so this is
        // "what it was launched from, if that still exists" rather than a join
        // anything depends on.
        profile: profile?.name ?? null,
        overlays: profile?.overlays ?? [],
        startedAtMs: Date.parse(record.startedAt) || null
      }
    },
    measure: async () => {
      // A tool call is somebody looking, for exactly one pass. `watch` is
      // reference-counted, so this neither switches the pane's own pass off
      // when it returns nor leaves a timer running when nobody else wants one.
      resources.watch(true)
      try {
        await resources.refresh()
      } finally {
        resources.watch(false)
      }
      return resources.snapshots()
    }
  }

  // Built on the config service rather than beside it: the import picker's
  // sources are the console's own scopes, and what a skill *is* is the
  // console's own answer.
  const templates = createTemplateService(services, config)

  registerIpc({
    services,
    sessions,
    activity,
    resources,
    pterm,
    browsers,
    browserMcp,
    history,
    archive,
    usage,
    pulls,
    config,
    content,
    templates,
    window: () => win,
    ...(options.claudeHome !== undefined ? { claudeHome: options.claudeHome } : {}),
    ...(options.chooseDirectory !== undefined ? { chooseDirectory: options.chooseDirectory } : {}),
    ...(options.chooseFile !== undefined ? { chooseFile: options.chooseFile } : {}),
    rendererReady: () => {
      emit(win, 'settings:changed', services.settings)
      emit(win, 'theme:changed', {
        preference: services.settings.theme,
        resolved: resolvedTheme()
      })
      // The first scan is kicked off by the main process rather than waited on
      // by the renderer: the launcher paints from the cache immediately and
      // this replaces it when it lands.
      void runScan(services, { includeGit: true })
        .then((result) => {
          emit(win, 'discovery:updated', result)
          // The first scan is also what adopts the default roots on a fresh
          // profile, so settings can be different now than they were a moment
          // ago when the renderer was handed them.
          emit(win, 'settings:changed', services.settings)
          emit(win, 'scan:status', { running: false })
        })
        .catch((err: unknown) => {
          emit(win, 'scan:status', {
            running: false,
            error: err instanceof Error ? err.message : String(err)
          })
        })
      emit(win, 'scan:status', { running: true })

      // Off the renderer's critical path: the first pass reads 875 KB and
      // writes 3,470 rows, which is ~30ms the launcher should not spend
      // before it paints. The window gets `history:changed` when it lands.
      setImmediate(() => {
        try {
          emit(win, 'history:changed', history.refresh())
        } catch (err) {
          console.warn(`history index could not be built: ${String(err)}`)
        }
        history.start()
        // The archive rides that same first pass - `onTranscripts` has already
        // run by the time `refresh()` returned - so this only arms the watch
        // over `projects/`, which is the trigger a session appending to its
        // transcript without submitting a prompt would otherwise not have.
        // A session that ended while Helm was closed was caught by the pass
        // above, which is what makes the start-up sweep a sweep.
        archive.start(() => {
          history.refresh()
        })

        // Cheap by comparison - one 134 KB file, parsed - but it is on the
        // same "after the first paint" footing: the status bar has everything
        // else it needs before this lands, and gets `usage:changed` when it
        // does.
        try {
          emit(win, 'usage:changed', usage.refresh())
        } catch (err) {
          console.warn(`usage figures could not be read: ${String(err)}`)
        }
        usage.start()

        // Last, and deliberately: this one spawns `git` per repository and
        // `gh` per remote, and the pane it feeds paints from SQLite in the
        // meantime. The timer is armed either way - a fetch that fails is not a
        // reason to stop trying every five minutes.
        void pulls.refresh().catch((err: unknown) => {
          console.warn(`pull requests could not be fetched: ${String(err)}`)
        })
        pulls.start()

        // And the one request Helm's own process makes. Here rather than at
        // startup for the reason everything else in this block is: it is worth
        // nothing before the window has painted, and it must not be in front of
        // anything that is.
        //
        // Failure is silent on purpose, unlike the two above. Offline is the
        // ordinary case for this one, the answer is a line in the status bar
        // that simply does not appear, and there is nothing a user would do
        // with a warning that Helm could not reach GitHub while they work.
        void maybeCheckForUpdate(services, win)
      })

      if (win) {
        options.onReady?.({
          win,
          services,
          sessions,
          activity,
          resources,
          pterm,
          browsers,
          browserMcp,
          history,
          archive,
          usage,
          pulls,
          config,
          content
        })
      }
    }
  })

  /**
   * Set once the database has been let go of. Every write below checks it,
   * because the order of Electron's shutdown events is not the order the app
   * was written in: `before-quit` fires before the window's own `close`, so a
   * teardown that closed the store first would leave the close handler writing
   * to a closed connection - which throws in the middle of quitting, where an
   * uncaught error stalls the whole shutdown rather than being reported.
   */
  let storeClosed = false

  const persistBounds = (): void => {
    if (storeClosed || !win || win.isDestroyed() || win.isMinimized()) return
    const { width, height, x, y } = win.getNormalBounds()
    services.settings = { ...services.settings, windowBounds: { width, height, x, y } }
    writeSetting(services.store, 'windowBounds', services.settings.windowBounds)
  }

  // `resize`/`move` rather than `resized`/`moved`: the past-tense pair only
  // fires for a user-driven drag, so a window placed by a tiling manager, a
  // display change, or anything else that moves it programmatically would never
  // be remembered. They do fire per frame, hence the debounce - one upsert per
  // gesture instead of sixty.
  let boundsTimer: NodeJS.Timeout | null = null
  const scheduleBoundsPersist = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      persistBounds()
    }, 400)
  }
  win.on('resize', scheduleBoundsPersist)
  win.on('move', scheduleBoundsPersist)

  /**
   * SPEC 4.1 wants git state "at a glance", which only holds if it is current.
   * Someone commits in a terminal and comes back to Helm - regaining focus is
   * exactly that moment, and re-reading git is far cheaper than rescanning
   * every `.claude` tree.
   *
   * Guarded rather than debounced: alt-tabbing quickly should not stack up
   * `git status` runs across every repo, and the answer from the one already in
   * flight is current enough.
   */
  let gitRefreshInFlight = false
  win.on('focus', () => {
    // The PR sweep takes the same moment for the same reason, and guards itself
    // harder: git is local and a fetch is not, so `refreshOnFocus` also refuses
    // to run more than once every few minutes (see `pulls.ts`).
    pulls.refreshOnFocus()

    if (gitRefreshInFlight || services.lastScan === null) return
    gitRefreshInFlight = true
    void refreshGit(services)
      .then((states) => emit(win, 'git:updated', states))
      .catch(() => undefined)
      .finally(() => {
        gitRefreshInFlight = false
      })
  })

  /**
   * Closing the window ends every hosted session, so it asks first - once, for
   * all of them, rather than a dialog per tab.
   *
   * `close` is also the last moment the window still exists, so this is where
   * the bounds are flushed: by `closed` the geometry is gone and whatever the
   * debounce was still holding would be lost.
   */
  let closeConfirmed = false
  win.on('close', (event) => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = null
    persistBounds()

    if (closeConfirmed || sessions.runningCount() === 0) return
    event.preventDefault()
    void sessions.confirmCloseAll().then((confirmed) => {
      if (!confirmed) return
      closeConfirmed = true
      win?.close()
    })
  })

  win.on('closed', () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = null
    win = null
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = createWindow('index', services.settings.windowBounds ?? null)
    }
  })

  app.on('before-quit', () => {
    // Flush whatever the debounce is still holding.
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = null
    persistBounds()
    // Before the store is let go of: a debounced index pass, or a config watch
    // firing after `will-quit`, would write to a closed connection.
    history.stop()
    usage.stop()
    pulls.stop()
    config.stop()
    /*
     * The endpoint goes **before** the sessions, and the order is the point.
     *
     * A session being torn down can still be mid-tool-call, and a tool that
     * ran after its session's process was gone would be an agent driving a
     * browser on behalf of nothing. Stopping first revokes every token, so
     * anything still in flight is answered with a 401 by a listener that is on
     * its way out - and the ephemeral config files go with it, which is the
     * only sweep that catches a session whose exit never got a turn.
     *
     * Not awaited: `before-quit` is synchronous, and the close is a formality
     * once the tokens are gone.
     */
    void browserMcp?.stop()
    // The poller stops with them. Nothing is left reading a registry on behalf
    // of sessions that are about to be gone.
    activity.stop()
    resources.stop()
    // Synchronously, because this is the last point the main process is
    // guaranteed a turn. Anything deferred here is a process left behind.
    sessions.shutdown()
    /*
     * The browser views die here too, and it is the same argument.
     *
     * A `WebContentsView` is a render process - the same kind of thing a pty
     * is, from this file's point of view - and it belongs to the main process
     * rather than to the window. Destroying it in the window's `closed`
     * handler would be too late in one direction (a quit that never closed the
     * window) and too early in the other (`before-quit` runs first, and a view
     * torn down after the store closed would be a `did-navigate` writing a
     * remembered URL into a shut database).
     *
     * A tab closed by hand goes through `browser:close`; this is the sweep for
     * whatever is still open when the app ends. Both end at the same
     * `destroy()`.
     */
    browsers.shutdown()
  })

  app.on('will-quit', () => {
    // Not in `before-quit`: the windows have not closed yet at that point, and
    // closing a window persists its bounds. Here every window is gone, so this
    // is the first moment nothing can still want the database. Letting go of it
    // checkpoints the WAL rather than leaving it for the next launch.
    if (storeClosed) return
    storeClosed = true
    services.store.close()
  })
}

// ---------------------------------------------------------------------------
// Spike modes - Spike B/C harnesses, unchanged in behaviour
// ---------------------------------------------------------------------------

function startSpike(): void {
  const win = createWindow('spike')

  ipcMain.once('renderer:ready', async () => {
    if (mode === 'selftest') {
      const report = await runSelftest(win, dataDir)
      const file = writeReport('spike-report.json', {
        startedAt: new Date().toISOString(),
        mode: appMode,
        dataDir,
        versions: process.versions,
        ...report
      })
      console.log(`selftest report: ${file}`)
      killPty()
      setTimeout(() => app.exit(report.pass ? 0 : 1), 200)
      return
    }

    if (mode === 'fidelity' || mode === 'claude-check') {
      const onlyArg = process.argv.find((a) => a.startsWith('--only='))
      const only = onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
      const checks =
        mode === 'fidelity'
          ? await runFidelity(win, dataDir, only)
          : await runClaudeChecks(win, dataDir, only)
      const pass = checks.every((c) => c.ok)
      const file = writeReport(mode === 'fidelity' ? 'fidelity-report.json' : 'claude-report.json', {
        startedAt: new Date().toISOString(),
        mode: appMode,
        dataDir,
        versions: process.versions,
        pass,
        checks
      })
      console.log(`${mode} report: ${file}`)
      for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)
      killPty()
      setTimeout(() => app.exit(pass ? 0 : 1), 200)
      return
    }

    // Interactive: a real terminal pane, sized to the window. This is the
    // surface the 30-minute soak test is driven in.
    const cwdArg = process.argv.find((a) => a.startsWith('--cwd='))
    const cwd = cwdArg ? cwdArg.slice('--cwd='.length) : homedir()
    win.webContents.send('term:create', {
      cols: 100,
      rows: 30,
      fit: true,
      windowsBuild: windowsBuildNumber()
    })
    // The pane fits itself to the window before reporting back, so the pty has
    // to be opened at the grid the renderer actually ended up with - opening it
    // at the requested size would start the session one SIGWINCH behind.
    ipcMain.once('term:created', async (_e, info: { cols?: number; rows?: number }) => {
      const useClaude = mode === 'claude'
      const claudeExe = findClaudeExecutable() ?? join(homedir(), '.local', 'bin', 'claude.exe')
      spawnPty(win, {
        file: useClaude ? claudeExe : 'pwsh.exe',
        args: useClaude ? [] : ['-NoLogo'],
        cols: info?.cols ?? 100,
        rows: info?.rows ?? 30,
        cwd
      })

      // Unattended smoke check for the interactive path itself.
      const shotArg = process.argv.find((a) => a.startsWith('--shot-after='))
      if (shotArg) {
        const delay = Number(shotArg.slice('--shot-after='.length))
        setTimeout(async () => {
          const shot = await screenshot(win, join(dataDir, 'screenshots'), 'interactive.png')
          console.log(`interactive grid ${info?.cols}x${info?.rows}, screenshot: ${shot.file}`)
          killPty()
          app.exit(0)
        }, delay)
      }
    })
  })

  // The spike harness drives the terminal directly; the app's IPC surface is
  // not registered in these modes, so the pty channels are wired here.
  ipcMain.on('pty:input', (_e, data: string) => activePty()?.pty.write(data))
  ipcMain.on('pty:resize', (_e, size: { cols: number; rows: number }) => {
    try {
      activePty()?.pty.resize(size.cols, size.rows)
    } catch {
      // pty may have exited
    }
  })
  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text))
}

/**
 * Gives the dev app id a Start Menu shortcut of Helm's own, so the dev window's
 * taskbar button carries the ship's wheel rather than Electron's atom.
 *
 * A taskbar button's icon comes from the shortcut that declares its app id, not
 * from the window. Electron writes that shortcut itself the first time a toast
 * fires - pointing at `node_modules/electron/dist/electron.exe`, whose icon is
 * the atom - and then skips the write because one already exists. Writing it
 * first is therefore the whole fix: same id, same target, Helm's `.ico`.
 *
 * Dev only, Windows only, and never fatal. `Electron.lnk` is removed only when
 * it points at *this* checkout's electron.exe, because that one is an artefact
 * of running this app and a second shortcut declaring the same id is what put
 * the atom on the packaged app's button on 2026-08-10.
 */
function claimDevShortcut(): void {
  if (process.platform !== 'win32' || app.isPackaged) return
  try {
    const programs = join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs')
    const icon = join(__dirname, '../../build', 'icon.ico')
    if (!existsSync(icon)) return

    const stale = join(programs, 'Electron.lnk')
    if (existsSync(stale)) {
      const target = shell.readShortcutLink(stale).target.toLowerCase()
      if (target === process.execPath.toLowerCase()) rmSync(stale, { force: true })
    }

    // `create`, not `update`: `update` only edits a shortcut that is already
    // there and fails on the first run, which is the only run that matters.
    shell.writeShortcutLink(join(programs, 'Helm (dev).lnk'), 'create', {
      target: process.execPath,
      args: `"${app.getAppPath()}"`,
      appUserModelId: 'dev.coletaylor.helm.dev',
      description: 'Helm, run from source',
      icon,
      iconIndex: 0
    })
  } catch {
    // A shortcut is cosmetic. Nothing here is worth failing a start over.
  }
}

app.whenReady().then(() => {
  // The default application menu binds Ctrl-C to the Edit>Copy role, which
  // swallows the interrupt before xterm ever sees the keydown. A terminal host
  // cannot ship that menu.
  Menu.setApplicationMenu(null)

  // Windows resolves a toast back to an installed application through this id.
  // Without it the exit notifications either carry electron.app.Electron's
  // identity in dev or do not appear at all.
  //
  // Dev gets its OWN id, and that is load-bearing rather than tidy. Windows
  // requires a Start Menu shortcut declaring an id before it will show a toast
  // for it, so Electron creates one pointing at whatever exe is running - in
  // dev that is `node_modules/electron/dist/electron.exe`, carrying Electron's
  // atom. Two shortcuts then declare the same id, Windows resolves the id to
  // one of them, and it picked the dev one: the packaged app showed the atom on
  // its taskbar button while its own title bar showed the right icon, because a
  // title bar uses the window icon and a taskbar button uses the id.
  //
  // Measured 2026-08-10. Neither rebuilding, reinstalling, running from an
  // uncached path, nor purging the icon cache touched it - the stale
  // `Electron.lnk` had to go. Keeping the ids apart is what stops it returning.
  app.setAppUserModelId(app.isPackaged ? 'dev.coletaylor.helm' : 'dev.coletaylor.helm.dev')
  claimDevShortcut()

  // The artifact scheme's handler. Registered for every mode that opens a
  // window, because the spike pages share this process and a scheme with no
  // handler fails a load rather than falling through to something worse.
  registerContentProtocol()

  /**
   * A real app start, and nothing else.
   *
   * The "stale shims are swept at startup" criterion is about what
   * `createServices` does on the way in, which the process that already started
   * cannot assert about itself. So `--profiles-check` plants what a crash would have
   * left and this runs afterwards: same startup path, no window, and a report
   * of what it removed.
   */
  if (mode === 'shim-sweep') {
    const services = createServices()
    // `--report=` because this mode runs twice in one `profiles-check`: once
    // after PROF-9 plants a crashed run's shim, and once *while* `--shim-hold`
    // is holding a live one. One filename would leave the second overwriting
    // the first's evidence.
    const reportArg = process.argv.find((a) => a.startsWith('--report='))
    const file = writeReport(reportArg?.slice('--report='.length) ?? 'shim-sweep.json', {
      startedAt: new Date().toISOString(),
      shimRoot,
      removed: services.staleShims
    })
    console.log(`shim sweep: removed ${String(services.staleShims)} shim(s); report: ${file}`)
    services.store.close()
    app.exit(0)
    return
  }

  /**
   * One real app start, so `pnpm template-check` can ask what a start does to
   * the templates directory.
   *
   * Three claims need this and none of them can be made by a process that has
   * already started: a first start seeds, a second overwrites nothing, and a
   * start with the directory deleted seeds again. So `run-template.mjs` runs
   * this three times, arranging the directory between them, and each run writes
   * down what `createServices` found and the sha256 of every file in there.
   * The verdicts are `templatecheck.ts`'s - TPL-7/8/9 - because the report is
   * where a multi-phase check keeps its verdict. Same shape as `--shim-sweep`.
   *
   * No window: the claim is about startup, and a window would only add a scan.
   */
  if (mode === 'template-seed') {
    const services = createServices()
    const reportArg = process.argv.find((a) => a.startsWith('--report='))
    const file = writeReport(reportArg?.slice('--report='.length) ?? 'template-seed.json', {
      startedAt: new Date().toISOString(),
      dir: templatesDir,
      seeded: services.templates.seeded,
      created: services.templates.created,
      problem: services.templates.problem,
      files: hashTemplatesDir(templatesDir)
    })
    console.log(
      `template seed: ${services.templates.seeded ? `wrote ${String(services.templates.created.length)} file(s)` : 'already there, nothing written'}; report: ${file}`
    )
    services.store.close()
    app.exit(0)
    return
  }

  /**
   * The second phase of `usage-check`, and the whole of it.
   *
   * "The mode survives a restart" is a claim about a process that has not
   * started yet, so the process that set the mode cannot make it. The driver
   * leaves the setting on something other than its default and this reads it
   * back through the ordinary startup path - same store, same `readSettings` -
   * and writes down what it found. Same shape as `--shim-sweep`.
   */
  if (mode === 'usage-settings') {
    const services = createServices()
    const found = services.settings.usageDisplay
    const file = writeReport('usage-settings.json', {
      startedAt: new Date().toISOString(),
      usageDisplay: found,
      dbFile: services.store.file
    })
    console.log(`usage settings after restart: ${found}; report: ${file}`)

    // `--set=` puts the user's own setting back afterwards, because the driver
    // parked it on a non-default value in the real database to have something
    // to read.
    const setArg = process.argv.find((a) => a.startsWith('--set='))
    if (setArg) {
      const value = setArg.slice('--set='.length)
      if (value === 'percent' || value === 'cost' || value === 'off') {
        writeSetting(services.store, 'usageDisplay', value)
        console.log(`usage display restored to ${value}`)
      }
    }

    services.store.close()
    app.exit(0)
    return
  }

  /**
   * The second phase of `settings-check`, and the whole of it.
   *
   * Same shape as `--usage-settings` and for the same reason: the process that
   * wrote a setting cannot prove a restart finds it. This one starts through
   * the ordinary path, reports every setting it read, and - given
   * `--restore=<file>` - puts back the settings the driver wrote down before it
   * borrowed the real database.
   */
  if (mode === 'settings-restart') {
    const services = createServices()
    const found = services.settings
    const file = writeReport('settings-restart.json', {
      startedAt: new Date().toISOString(),
      settings: found,
      dbFile: services.store.file
    })
    console.log(`settings after restart: ${JSON.stringify(found)}\nreport: ${file}`)

    const restoreArg = process.argv.find((a) => a.startsWith('--restore='))
    if (restoreArg) {
      const from = restoreArg.slice('--restore='.length)
      try {
        const saved = JSON.parse(readFileSync(from, 'utf8')) as Partial<AppSettings>
        // Through the ordinary write path, validators included: whatever is put
        // back has to be something the app would have accepted anyway.
        writeSettings(services.store, saved)
        console.log(`settings restored from ${from}`)
      } catch (err) {
        console.error(`could not restore settings from ${from}: ${String(err)}`)
      }
    }

    services.store.close()
    app.exit(0)
    return
  }

  if (isSpikeMode) {
    startSpike()
    return
  }

  if (mode === 'design-shot') {
    startApp({
      onReady: (ctx) => {
        void runDesignShot(ctx, join(dataDir, 'screenshots', 'design'))
          .then((files) => {
            for (const file of files) console.log(`design-shot: ${file}`)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`design-shot crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  if (mode === 'highlight-check') {
    startApp({
      onReady: (ctx) => {
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runHighlightChecks(
          ctx,
          join(dataDir, 'screenshots'),
          dataDir,
          onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
        )
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('highlight-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`highlight-check report: ${file}`)
            for (const c of checks) {
              console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)
              for (const n of c.notes) console.log(`      ${n}`)
            }
            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`highlight-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  if (mode === 'affordance-check') {
    startApp({
      onReady: (ctx) => {
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runAffordanceChecks(
          ctx,
          join(dataDir, 'screenshots'),
          onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
        )
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('affordance-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`affordance-check report: ${file}`)
            for (const c of checks) {
              console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)
              for (const n of c.notes) console.log(`      ${n}`)
            }
            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`affordance-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  /**
   * The second half of sessions-check: a real second app start, reading back
   * the label phase one gave a tab. "It survived a restart" is not a claim the
   * process that set it can make - see `runSessionsRestartChecks`.
   */
  if (mode === 'sessions-restart') {
    startApp({
      onReady: (ctx) => {
        void runSessionsRestartChecks(ctx, dataDir)
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('sessions-restart-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`sessions-restart report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 30_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`sessions-restart crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  if (mode === 'sessions-check') {
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runSessionsChecks(
          ctx,
          collector,
          join(dataDir, 'screenshots'),
          dataDir,
          onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
        )
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('sessions-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`sessions-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            // `quit`, not `exit`: SESS-9 left a session running on purpose, and
            // the whole point is to make the app's own teardown deal with it.
            // `exit` would skip `before-quit` and prove nothing.
            // Quitting is itself under test - SESS-9 left a session running for
            // the app's own teardown to reap - so the run ends with `quit`,
            // not `exit`, and forces the status once the teardown is done.
            app.once('quit', () => process.exit(pass ? 0 : 1))
            // Armed before the quit, not after: if `app.quit()` throws or a
            // handler blocks, a watchdog scheduled behind it never exists.
            setTimeout(() => app.exit(pass ? 0 : 1), 30_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`sessions-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  if (mode === 'profiles-check') {
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        // The driver closes the sessions it opened, so every confirmation it
        // provokes is one it asked for on purpose.
        collector.answerWith(true)
        void runProfilesChecks(ctx, collector, join(dataDir, 'screenshots'), dataDir)
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('profiles-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`profiles-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            // PROF-9 planted a stale shim for the `--shim-sweep` start that
            // follows, so this run must end the same way a real one does -
            // through `quit`, not `exit`, which would skip the teardown.
            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`profiles-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  /**
   * PROF-10's first process: a real app with a real session, held open while a
   * second one starts and sweeps.
   *
   * Its own mode rather than a phase of `--profiles-check` because the claim is
   * about two Helms overlapping, and the driver that plants PROF-9's shim has to
   * *end* before the sweep that collects it. One process cannot do both.
   * `run-profiles.mjs` orchestrates the handshake; see `shimhold.ts`.
   */
  if (mode === 'shim-hold') {
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        collector.answerWith(true)
        void runShimHold(ctx, dataDir)
          .then((check) => {
            const file = writeReport(HOLD_REPORT, {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              pass: check.ok,
              checks: [check]
            })
            console.log(`shim-hold report: ${file}`)
            console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.id}  ${check.title}`)

            app.once('quit', () => process.exit(check.ok ? 0 : 1))
            setTimeout(() => app.exit(check.ok ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`shim-hold crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  if (mode === 'history-check') {
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        // The driver closes the session it resumed, so every confirmation is
        // one it asked for on purpose.
        collector.answerWith(true)
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runHistoryChecks(
          ctx,
          collector,
          join(dataDir, 'screenshots'),
          onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
        )
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('history-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`history-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`history-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  if (mode === 'config-check') {
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        // The driver closes the session it launched, so every confirmation is
        // one it asked for on purpose.
        collector.answerWith(true)
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runConfigChecks(
          ctx,
          collector,
          join(dataDir, 'screenshots'),
          dataDir,
          onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
        )
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('config-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`config-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`config-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  if (mode === 'content-check') {
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        collector.answerWith(true)
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runContentChecks(
          ctx,
          join(dataDir, 'screenshots'),
          dataDir,
          onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
        )
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('content-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`content-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`content-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  /**
   * First run, in two starts.
   *
   * `--packaging-check` runs against this machine: the grep audit and what the real
   * `claude` here actually is.
   *
   * `--packaging-firstrun` is the other half, and it is a separate process because
   * "a machine with a fresh `~/.claude` and no harness at all" is not a state
   * this one can enter. The driver starts it with `PORTABLE_EXECUTABLE_DIR`
   * pointed at a temporary directory - the app's own portable-mode mechanism,
   * used as the isolation - so it opens an empty database beside that directory
   * and touches neither `%APPDATA%\Helm` nor the user's `~/.claude`, which it is
   * pointed away from with `--claude-home=`.
   */
  if (mode === 'packaging-check' || mode === 'packaging-firstrun') {
    const collector = createCollector()
    const arg = (name: string): string | undefined => {
      const found = process.argv.find((a) => a.startsWith(`--${name}=`))
      return found?.slice(name.length + 3)
    }
    const fixtures = arg('fixtures')
    const claudeHome = arg('claude-home')
    const onlyArg = arg('only')

    startApp({
      observer: collector,
      confirm: collector.confirm,
      ...(claudeHome !== undefined ? { claudeHome } : {}),
      // Answered by the driver, and rewritten by it before each step that
      // opens one. A native dialog has no automation surface.
      ...(mode === 'packaging-firstrun'
        ? {
            chooseDirectory: (title: string) => pickerAnswer('directory', title),
            chooseFile: (title: string) => pickerAnswer('file', title)
          }
        : {}),
      onReady: (ctx) => {
        collector.answerWith(true)
        void runPackagingChecks(ctx, collector, join(dataDir, 'screenshots'), dataDir, {
          phase: mode === 'packaging-check' ? 'machine' : 'firstrun',
          ...(fixtures !== undefined ? { fixtures } : {}),
          ...(claudeHome !== undefined ? { claudeHome } : {}),
          ...(onlyArg !== undefined ? { only: onlyArg.split(',') } : {})
        })
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport(
              mode === 'packaging-check' ? 'packaging-report.json' : 'packaging-firstrun-report.json',
              {
                startedAt: new Date().toISOString(),
                mode: appMode,
                dataDir,
                versions: process.versions,
                pass,
                checks
              }
            )
            console.log(`${mode} report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`${mode} crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  if (mode === 'usage-check') {
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        // The driver closes the session it started, so every confirmation is
        // one it asked for on purpose.
        collector.answerWith(true)
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runUsageChecks(
          ctx,
          collector,
          join(dataDir, 'screenshots'),
          dataDir,
          onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
        )
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('usage-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`usage-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`usage-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  /**
   * The settings pane, driven through the real window.
   *
   * The pickers are answered by the driver for the same reason `--packaging-firstrun`
   * answers them: "add a folder" and "locate the CLI" both open a native dialog
   * that has no automation surface, and everything either one does afterwards -
   * the handler, the settings write, the rescan - is the real thing.
   *
   * It borrows the user's own database, because the claim is about the real
   * one. `scripts/run-settings.mjs` restarts the app to read what this left and
   * then puts the originals back.
   */
  if (mode === 'settings-check') {
    startApp({
      chooseDirectory: (title: string) => pickerAnswer('directory', title),
      chooseFile: (title: string) => pickerAnswer('file', title),
      onReady: (ctx) => {
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runSettingsChecks(
          ctx,
          join(dataDir, 'screenshots'),
          dataDir,
          onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
        )
          .then(({ checks, parked }) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('settings-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              parked,
              checks
            })
            console.log(`settings-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`settings-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  /**
   * The pull-request surface, driven through the real window.
   *
   * Borrows the user's database and settings the way `--settings-check` does,
   * and for the same reason - the claim is about the real ones. It adds a scan
   * root of fixture repositories, aims the pulls service at a `gh` of its own
   * making, spawns real `claude` sessions for the review phase and closes them,
   * and puts everything back; `scripts/run-prcheck.mjs` restores the settings
   * as well, for the run that dies before its own restore.
   */
  if (mode === 'pr-check') {
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        // Every session this driver started is one it closes on purpose.
        collector.answerWith(true)
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runPrChecks(
          ctx,
          collector,
          join(dataDir, 'screenshots'),
          dataDir,
          onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
        )
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('pr-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`pr-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`pr-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  /**
   * The transcript archive, driven through the real window in two phases.
   *
   * Both phases run against a `.claude` tree of the runner's own, pointed at
   * with the real `CLAUDE_CONFIG_DIR` rather than a flag - which is what makes
   * T-0 an assertion about the criterion instead of a statement about a hook.
   * The second phase exists because "the archive survives the transcript being
   * deleted and the app restarting" is not a claim the process that wrote the
   * rows can make: `scripts/run-transcript.mjs` deletes the transcript between
   * them.
   */
  if (mode === 'transcript-check' || mode === 'transcript-restart') {
    const restart = mode === 'transcript-restart'
    startApp({
      onReady: (ctx) => {
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        const options = {
          dataDir,
          shotDir: join(dataDir, 'screenshots'),
          ...(onlyArg ? { only: onlyArg.slice('--only='.length).split(',') } : {})
        }
        void (restart ? runTranscriptRestartChecks(ctx, options) : runTranscriptChecks(ctx, options))
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport(
              restart ? 'transcript-restart-report.json' : 'transcript-report.json',
              {
                startedAt: new Date().toISOString(),
                mode: appMode,
                dataDir,
                claudeConfigDir: process.env['CLAUDE_CONFIG_DIR'] ?? null,
                versions: process.versions,
                pass,
                checks
              }
            )
            console.log(`${mode} report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`${mode} crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  /**
   * Harness templates, driven through the real window.
   *
   * The directory picker is answered by the driver for the reason
   * `--settings-check` answers it: "Choose…" opens a native dialog with no
   * automation surface, and everything after it - the handler, the write, the
   * rescan - is the real thing. The seed phases that precede this one are
   * `--template-seed` above.
   */
  if (mode === 'template-check') {
    startApp({
      chooseDirectory: (title: string) => pickerAnswer('directory', title),
      onReady: (ctx) => {
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runTemplateChecks(ctx, {
          dataDir,
          shotDir: join(dataDir, 'screenshots'),
          ...(onlyArg ? { only: onlyArg.slice('--only='.length).split(',') } : {})
        })
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('template-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              templatesDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`template-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`template-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  /**
   * The browser pane, driven through the real window in two phases.
   *
   * The second exists for the reason every second phase in this file does:
   * "a cookie the fixture set is still there after a restart" is not a claim
   * the process that set it can make. `run-browser.mjs` starts this again with
   * `--browser-restart`, against the same isolated data directory and therefore
   * the same `persist:helm-browser` partition, and the fixture server is
   * started fresh on the port the first phase wrote down.
   */
  if (mode === 'browser-check' || mode === 'browser-restart') {
    const restart = mode === 'browser-restart'
    // A collector, because M17's `live` group spawns a real `claude` and the
    // only witness for what a session said is its output. Every other group in
    // this driver spawns nothing and never reads it.
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        collector.answerWith(true)
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runBrowserChecks(ctx, collector, {
          dataDir,
          shotDir: join(dataDir, 'screenshots'),
          phase: restart ? 'restart' : 'main',
          ...(onlyArg ? { only: onlyArg.slice('--only='.length).split(',') } : {})
        })
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport(
              restart ? 'browser-restart-report.json' : 'browser-report.json',
              {
                startedAt: new Date().toISOString(),
                mode: appMode,
                dataDir,
                versions: process.versions,
                pass,
                checks
              }
            )
            console.log(`${mode} report: ${file}`)
            for (const c of checks) {
              console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)
              for (const n of c.notes) console.log(`      ${n}`)
            }

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`${mode} crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  // The ordinary app. `--gh=` is the only flag it takes, threaded the way
  // `--claude-home=` is; `pnpm dev` is what passes one.
  const ghArg = process.argv.find((a) => a.startsWith('--gh='))
  startApp(ghArg ? { gh: ghArg.slice('--gh='.length) } : {})
})

app.on('window-all-closed', () => {
  killPty()
  app.quit()
})

/**
 * The backstop. `before-quit` does the orderly teardown - rows first, then the
 * processes - but it does not run for every way a process can end, and a
 * hosted `claude` outliving the app it was launched from is the one failure
 * this milestone is not allowed to have.
 */
app.on('will-quit', () => killAllSessionsSync())



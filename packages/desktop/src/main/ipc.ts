import { app, type BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'
import {
  createHarness,
  forgetProjects,
  isWithin,
  listTemplates,
  orphanedProjectPaths,
  previewTemplate,
  readArchivedConversation,
  readHistoryProjects,
  readHistoryPrompts,
  readHistorySessions,
  renameHistorySession,
  suggestRoots
} from '@helm/core'
import type { BrowserHost } from './browser'
import type { BrowserMcpHost } from './browser-mcp'
import type { ConfigService } from './config'
import { highlightForEditor, type ContentService } from './content'
import type { TemplateService } from './templates'
import type { ArchiveService } from './archive'
import type { HistoryService } from './history'
import type { PullsService } from './pulls'
import type { UsageService } from './usage'
import { applyTitleBarOverlay } from './chrome'
import type { PtermHost } from './pterm'
import { readClaudeVersion, setClaudeOverride } from './claude-cli'
import { setGhOverride } from './gh-cli'
import { describeWslDistro, forgetWslProbes, listWslDistros, wslHomes } from './wsl'
import { readWslNetworking, setWslNetworking, shutdownWsl } from './wslconfig'
import { readClaudeStatus, verifyClaudeAt } from './setup'
import { checkForUpdate, RELEASES_PAGE } from './update'
import { appMode, dataDir, dbFile, templatesDir } from './paths'
import { activePty, windowsBuildNumber } from './pty'
import {
  exportProfile,
  importProfile,
  pinProfiles,
  profiles,
  removeProfile,
  saveProfile
} from './profiles'
import { cachedProjects, runScan, updateSettings, type Services } from './services'
import type { SessionHost } from './sessions'
import type { ActivityService } from './activity'
import type { ResourcesService } from './resources'
import type {
  EventChannel,
  EventPayload,
  IpcRequests,
  RequestChannel,
  ResolvedTheme,
  SendChannel,
  SendPayload
} from '../shared/ipc'

/**
 * The main-process half of the contract.
 *
 * `RequestHandlers` is `Record<RequestChannel, ...>`, so leaving a channel
 * unhandled does not compile. Nothing in this process may call `ipcMain.handle`
 * outside `registerIpc` - that is what keeps the surface enumerable.
 */

type RequestHandlers = {
  [K in RequestChannel]: (
    payload: IpcRequests[K]['request'],
    event: Electron.IpcMainInvokeEvent
  ) => IpcRequests[K]['response'] | Promise<IpcRequests[K]['response']>
}

type SendHandlers = {
  [K in SendChannel]: (payload: SendPayload<K>, event: Electron.IpcMainEvent) => void
}

export function resolvedTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** Typed `webContents.send`. The only way the main process pushes to a window. */
export function emit<K extends EventChannel>(
  win: BrowserWindow | null,
  channel: K,
  payload: EventPayload<K>
): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, payload)
}

export interface IpcContext {
  services: Services
  window: () => BrowserWindow | null
  /** Owns the hosted `claude` processes; see `sessions.ts`. */
  sessions: SessionHost
  /** What each of those is doing, from Claude Code's registry. */
  activity: ActivityService
  /** What each of those is holding: process tree and ports. */
  resources: ResourcesService
  /** Owns the project shells; see `pterm.ts`. */
  pterm: PtermHost
  /** Owns the browser pane's `WebContentsView`s; see `browser.ts`. */
  browsers: BrowserHost
  /**
   * Serves those views to the sessions Helm hosts; see `browser-mcp.ts`.
   *
   * Here only so `browserMcp` can take effect at once rather than at the next
   * restart. Nothing on any channel reaches it, and nothing ever should: a
   * renderer that could ask the endpoint for anything would be a page away from
   * a token.
   */
  browserMcp: BrowserMcpHost | null
  /** Keeps the index over `~/.claude/history.jsonl` current; see `history.ts`. */
  history: HistoryService
  /** Keeps the conversations Claude Code deletes; see `archive.ts`. */
  archive: ArchiveService
  /** Mirrors Claude Code's cached plan-limit figures; see `usage.ts`. */
  usage: UsageService
  /** Sweeps the discovered repositories for open pull requests; see `pulls.ts`. */
  pulls: PullsService
  /** The one surface that writes to a `.claude` tree; see `config.ts`. */
  config: ConfigService
  /** Reads, renders and searches what Claude writes; see `content.ts`. */
  content: ContentService
  /** Authors what `template:list` reads back; see `templates.ts`. */
  templates: TemplateService
  /** Called when the renderer reports it has mounted. */
  rendererReady: () => void
  /**
   * Stands in for the native file and directory pickers.
   *
   * A native dialog has no automation surface, so the first-run driver - which
   * has to prove that "add a folder" and "locate claude" work end to end -
   * cannot click one. Same reasoning as the session host's `Confirm`: the
   * question is answered by the driver, and every other step still goes through
   * the real handler, the real settings write and the real rescan.
   *
   * Only `--packaging-firstrun` passes these. The app itself passes none and gets the
   * dialogs.
   */
  chooseDirectory?: ((title: string) => string | null) | undefined
  chooseFile?: ((title: string) => string | null) | undefined
  /**
   * A different `.claude` tree for the setup pane to report on. Only
   * `--packaging-firstrun` passes one - it is how "a machine with a fresh `~/.claude`"
   * is simulated without going anywhere near the user's real one.
   */
  claudeHome?: string | undefined
}

export function registerIpc(ctx: IpcContext): void {
  const { services } = ctx

  /** The CLI status, always read against the same config directory. */
  const claudeStatus = (picked?: string): ReturnType<typeof readClaudeStatus> =>
    readClaudeStatus({
      claudePath: picked ?? services.settings.claudePath,
      ...(ctx.claudeHome !== undefined ? { configDir: ctx.claudeHome } : {})
    })

  /** Adds paths that are not already roots, and tells the window. */
  const addRoots = (paths: string[]): string[] => {
    const merged = [...services.settings.scanRoots]
    for (const path of paths) {
      if (!merged.some((existing) => existing.toLowerCase() === path.toLowerCase())) {
        merged.push(path)
      }
    }
    if (merged.length === services.settings.scanRoots.length) return services.settings.scanRoots
    const next = updateSettings(services, { scanRoots: merged })
    emit(ctx.window(), 'settings:changed', next)
    return next.scanRoots
  }

  const requests: RequestHandlers = {
    'app:info': async () => ({
      version: app.getVersion(),
      mode: appMode,
      dataDir,
      dbFile,
      migrations: [...services.store.migrations.applied, ...services.store.migrations.alreadyApplied],
      versions: {
        electron: process.versions['electron'] ?? 'unknown',
        chrome: process.versions['chrome'] ?? 'unknown',
        node: process.versions['node'] ?? 'unknown'
      },
      claudeVersion: await readClaudeVersion(),
      windowsBuild: windowsBuildNumber() ?? null,
      releasesUrl: RELEASES_PAGE
    }),

    'settings:read': () => services.settings,

    'settings:write': (patch) => {
      const next = updateSettings(services, patch)
      emit(ctx.window(), 'settings:changed', next)
      // The session host reads the override, not the settings, so a picked CLI
      // written through this channel has to reach it too - otherwise sessions
      // launch from one path and `claude mcp add` from another.
      if (patch.claudePath !== undefined) setClaudeOverride(next.claudePath)
      // The pulls service resolves `gh` through the same module-level override,
      // and holds its own cached answer about which one it is - so a new path
      // has to reach both, and the poller has to be re-armed when the interval
      // moves or a change to it would not take effect until the next restart.
      if (patch.ghPath !== undefined) {
        setGhOverride(next.ghPath)
        ctx.pulls.rearm()
        void ctx.pulls.refresh()
      }
      if (patch.prPollMinutes !== undefined) ctx.pulls.rearm()
      // The snapshot is built in main, so the pane cannot hide or reveal a
      // repository on its own: `republish` repaints from the cache at once, and
      // the fetch behind it is for whatever was just un-ignored - a repository
      // Helm has been skipping has no rows, or has rows from before it was
      // ignored, and either way the sweep is what makes it current.
      if (patch.prIgnoredRepos !== undefined) {
        ctx.pulls.republish()
        void ctx.pulls.refresh()
      }
      /*
       * The endpoint follows its own tick, immediately.
       *
       * `browserMcpLocalOnly` is deliberately **not** here: it is read through
       * a function at every tool call, so it takes effect on the next one
       * without anything being told. This one is different because it owns a
       * socket - and an off switch for a listener that only takes effect at the
       * next restart is an off switch somebody would reasonably believe had
       * already worked.
       *
       * Sessions already running keep their tokens until it stops, and stopping
       * revokes them: a session that had the tools loses them mid-task, which
       * is the honest consequence of turning them off and is what the sentence
       * in the pane says.
       *
       * **Two ticks, one socket**, so the question is whether *anything* is
       * still on rather than whether this one is. Unticking one family with the
       * other still on takes that family's route away - the endpoint reads both
       * settings per request - and leaves the listener up for the other, which
       * is what makes them independent capabilities rather than one with two
       * switches.
       */
      if (
        (patch.browserMcp !== undefined || patch.sessionMcp !== undefined) &&
        ctx.browserMcp !== null
      ) {
        if (next.browserMcp || next.sessionMcp) void ctx.browserMcp.start()
        else void ctx.browserMcp.stop()
      }
      if (patch.theme !== undefined) {
        nativeTheme.themeSource = patch.theme
        applyTitleBarOverlay(ctx.window(), resolvedTheme())
        emit(ctx.window(), 'theme:changed', {
          preference: next.theme,
          resolved: resolvedTheme()
        })
      }
      return next
    },

    'discovery:cached': () => cachedProjects(services),

    'discovery:scan': async (payload) => {
      emit(ctx.window(), 'scan:status', { running: true })
      try {
        const result = await runScan(services, { includeGit: payload?.includeGit ?? true })
        emit(ctx.window(), 'discovery:updated', result)
        return result
      } finally {
        emit(ctx.window(), 'scan:status', { running: false })
      }
    },

    // The distro homes come from the host's memoised probe: `core/` never
    // spawns, so a suggestion inside a distro exists only if it is handed one.
    'roots:suggest': async () => suggestRoots(process.cwd(), await wslHomes()),

    'roots:add': async (request) => {
      const startIn = request?.startIn
      const title = 'Add a folder to scan'
      if (ctx.chooseDirectory) {
        const picked = ctx.chooseDirectory(title)
        return picked === null ? services.settings.scanRoots : addRoots([picked])
      }
      const win = ctx.window()
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ['openDirectory', 'multiSelections'],
        ...(startIn !== undefined && startIn !== '' ? { defaultPath: startIn } : {})
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return services.settings.scanRoots
      return addRoots(result.filePaths)
    },

    'roots:accept': ({ path }) => addRoots([path]),

    'roots:remove': ({ path }) => {
      const merged = services.settings.scanRoots.filter(
        (existing) => existing.toLowerCase() !== path.toLowerCase()
      )
      const next = updateSettings(services, { scanRoots: merged })
      // The rows this root put in the discovery cache go with it. Nothing else
      // can take them: the next scan does not walk a root that is no longer a
      // root, so a row left here would go on painting at every start, in a tree
      // that no longer holds it once the scan lands - the flicker being the
      // small half of it, and "Helm still lists a folder I removed" the rest.
      // Rows a *remaining* root still covers are kept; see `orphanedProjectPaths`.
      forgetProjects(
        services.store,
        orphanedProjectPaths(
          cachedProjects(services).map((project) => project.path),
          path,
          next.scanRoots
        )
      )
      emit(ctx.window(), 'settings:changed', next)
      return next.scanRoots
    },

    'setup:status': () => claudeStatus(),

    'setup:locateClaude': async () => {
      const title = 'Locate the claude executable'
      let picked: string | undefined
      if (ctx.chooseFile) {
        picked = ctx.chooseFile(title) ?? undefined
      } else {
        const win = ctx.window()
        const options: Electron.OpenDialogOptions = {
          title,
          properties: ['openFile'],
          filters:
            process.platform === 'win32'
              ? [
                  { name: 'Programs', extensions: ['exe', 'cmd', 'bat'] },
                  { name: 'All files', extensions: ['*'] }
                ]
              : [{ name: 'All files', extensions: ['*'] }]
        }
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options)
        picked = result.canceled ? undefined : result.filePaths[0]
      }
      if (picked === undefined) {
        return claudeStatus()
      }

      // Verified before it is saved. A setting that points at the wrong program
      // is a launch failure two screens later with nothing to connect it to.
      const check = await verifyClaudeAt(picked)
      if (!check.ok) {
        const status = await claudeStatus()
        return { ...status, error: check.problem }
      }
      const next = updateSettings(services, { claudePath: picked })
      setClaudeOverride(picked)
      emit(ctx.window(), 'settings:changed', next)
      return claudeStatus(picked)
    },

    'setup:complete': () => {
      const next = updateSettings(services, { firstRunCompletedAt: new Date().toISOString() })
      emit(ctx.window(), 'settings:changed', next)
      return next
    },

    /*
     * The listing is cheap and the probe is not, which is why they are two
     * channels rather than one.
     *
     * `wsl.exe -l -v` is one process and touches no distribution. Asking a
     * distro about its `claude` **starts** it if it is stopped, so a form that
     * probed everything on open would boot every distribution on the machine
     * to populate a dropdown.
     */
    'wsl:distros': () => listWslDistros(),

    'wsl:homes': async () => [...(await wslHomes())],

    'wsl:probe': async ({ distro, refresh }) => {
      // `refresh` is for the one case the memo is wrong about: the user has
      // just been told to change `.wslconfig` and wants to be asked again
      // without restarting Helm.
      if (refresh === true) forgetWslProbes()
      return describeWslDistro(distro, ctx.browserMcp?.address()?.port ?? null)
    },

    'wsl:networking': () => readWslNetworking(),

    'wsl:setNetworking': async ({ mode }) => {
      const result = setWslNetworking(mode)
      if (result.ok && !result.unchanged) {
        // The probes memoise "can this distro reach the endpoint", which is
        // exactly the answer this write is about - so a user who has just fixed
        // their configuration is asked again rather than having to restart Helm
        // to see it take. Both caches, because `wslHomes` is memoised behind
        // the same probes and a distro whose home was unreadable is one this
        // may have just made reachable.
        forgetWslProbes()
        await ctx.config.refreshWslHomes()
      }
      return result
    },

    /*
     * Ends every WSL process on this machine, and is called from exactly one
     * place: a confirmation in the settings pane that says so.
     *
     * Deliberately not folded into `wsl:setNetworking`. The write is safe and
     * this is not - it takes down other people's editors, servers and builds
     * inside any distribution, and any Claude Code session running in one,
     * including sessions this Helm is hosting on a WSL target. A setting that
     * quietly did this would be the one irreversible thing on the pane.
     */
    'wsl:shutdown': () => shutdownWsl(),

    'path:chooseDirectory': async ({ title, startIn }) => {
      if (ctx.chooseDirectory) return { path: ctx.chooseDirectory(title ?? 'Choose a folder') }
      const win = ctx.window()
      const options: Electron.OpenDialogOptions = {
        title: title ?? 'Choose a folder',
        properties: ['openDirectory', 'createDirectory'],
        // Only when asked for. An unset `defaultPath` leaves the dialog wherever
        // Windows last left it, which is what somebody choosing a Windows folder
        // wants; overriding that for everyone to serve the WSL case would be
        // taking one user's shortcut out of another's pocket.
        ...(startIn !== undefined && startIn !== '' ? { defaultPath: startIn } : {})
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
    },

    'path:chooseFile': async ({ title }) => {
      const heading = title ?? 'Choose a program'
      if (ctx.chooseFile) return { path: ctx.chooseFile(heading) }
      const win = ctx.window()
      const options: Electron.OpenDialogOptions = {
        title: heading,
        properties: ['openFile'],
        filters:
          process.platform === 'win32'
            ? [
                { name: 'Programs', extensions: ['exe', 'cmd', 'bat'] },
                { name: 'All files', extensions: ['*'] }
              ]
            : [{ name: 'All files', extensions: ['*'] }]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
    },

    'harness:create': async (request) => {
      const result = await createHarness({
        mode: request.mode,
        dir: request.dir,
        templatesDir,
        ...(request.name !== undefined ? { name: request.name } : {}),
        // 'new' only. The contract says so and `createHarness` enforces it, but
        // dropping it here as well means a renderer that sent one by mistake
        // cannot even reach the code that would have to ignore it.
        ...(request.template !== undefined && request.mode === 'new'
          ? { template: request.template }
          : {})
      })
      /*
       * A folder that is already a harness is not a failure to report and walk
       * away from - the thing the user asked for exists, and what they actually
       * want is to see it. So the root goes in exactly as it would have on a
       * successful conversion, and the reply carries the path so the dialog can
       * say "it is already one, and it is listed now" instead of refusing.
       *
       * Found in use on 2026-09-03, and WSL is why it was found: a harness
       * inside a distribution is never covered by a scan root, because every
       * root is a Windows path and nothing adds a `\\wsl$\` one. The user
       * converted `\\wsl$\Ubuntu\home\<user>\harness`, was told it was already a
       * harness, and then could not find it anywhere in the launcher - which
       * reads as the app contradicting itself, and is the same dead end for any
       * existing harness outside the roots.
       */
      if (result.path === null && result.existing !== null) {
        const covered = services.settings.scanRoots.some((root) =>
          isWithin(root, result.existing as string)
        )
        const roots = covered ? services.settings.scanRoots : addRoots([result.existing])
        return { ...result, roots }
      }
      if (result.path === null) {
        return { ...result, roots: services.settings.scanRoots }
      }
      // A harness the launcher cannot see is not one the user created, so the
      // root goes in with it - unless a root already covers it, in which case
      // adding the harness itself would list it twice.
      const covered = services.settings.scanRoots.some((root) =>
        isWithin(root, result.path as string)
      )
      const roots = covered ? services.settings.scanRoots : addRoots([result.path])
      return { ...result, roots }
    },

    'template:list': () => listTemplates(templatesDir),

    'template:preview': ({ template, mode }) =>
      previewTemplate({
        templatesDir,
        template,
        ...(mode !== undefined ? { mode } : {})
      }),

    // Authoring. Every one of these writes inside the templates directory and
    // nowhere else; `template:import` is the only one that reads outside it,
    // and reading is all it does - see `assertTemplateWritable`.
    'template:detail': ({ template }) => ctx.templates.detail(template),
    'template:create': (request) => ctx.templates.create(request),
    'template:rename': (request) => ctx.templates.rename(request),
    'template:delete': ({ template }) => ctx.templates.remove(template),
    'template:metadata': (request) => ctx.templates.metadata(request),
    'template:substitute': (request) => ctx.templates.substitute(request),
    'template:import': (request) => ctx.templates.importFiles(request),
    'template:folderPreview': (request) => ctx.templates.folderPreview(request),
    'template:fromFolder': (request) => ctx.templates.fromFolder(request),

    'update:check': () => checkForUpdate(),

    'theme:resolved': () => resolvedTheme(),

    'shell:showItem': ({ path }) => {
      shell.showItemInFolder(path)
    },

    // The renderer awaits this one, so a failure to spawn arrives as a rejected
    // promise with a sentence in it rather than a tab that never fills in.
    'session:start': (request) => ctx.sessions.start(request),
    'session:close': (request) => ctx.sessions.close(request),
    'session:list': () => ctx.sessions.list(),
    // A read of what main already holds, not a fresh pass: the poller is what
    // decides when the registry is re-read, and a channel that forced a read
    // would let a renderer set the poll rate.
    'session:activity': () => ctx.activity.states(),
    'sessions:overview': () => ctx.activity.overview(),
    // Whatever the last pass produced. Never a fresh enumeration: the pass runs
    // only while something is watching, and a channel that forced one would let
    // a renderer spawn a powershell.exe per invoke.
    'sessions:resources': () => ctx.resources.snapshots(),
    'session:rename': (request) => ctx.sessions.rename(request),

    'pterm:open': (request) => ctx.pterm.open(request),
    'pterm:close': ({ id }) => {
      ctx.pterm.close(id)
    },
    'pterm:shells': () => ctx.pterm.detected(),

    'profile:list': () => profiles(services),

    'profile:save': (request) => {
      const result = saveProfile(services, request)
      if (result.profile) emit(ctx.window(), 'profiles:changed', profiles(services))
      return result
    },

    'profile:delete': async ({ id }) => {
      const deleted = await removeProfile(services, ctx.window(), id)
      if (deleted) emit(ctx.window(), 'profiles:changed', profiles(services))
      return { deleted }
    },

    'profile:pin': ({ ids }) => {
      const next = pinProfiles(services, ids)
      emit(ctx.window(), 'profiles:changed', next)
      return next
    },

    'profile:export': ({ id }) => exportProfile(services, ctx.window(), id),

    'profile:import': async () => {
      const result = await importProfile(services, ctx.window())
      if (result.profile) emit(ctx.window(), 'profiles:changed', profiles(services))
      return result
    },

    'profile:launch': (request) => ctx.sessions.launchProfile(request),

    'history:summary': () => ctx.history.summary(),
    'history:sessions': (query) => readHistorySessions(services.store, query ?? {}),
    'history:prompts': ({ sessionId }) => readHistoryPrompts(services.store, sessionId),
    'history:projects': () => readHistoryProjects(services.store),
    'history:refresh': () => ctx.history.refresh(),
    // The one write in this family. It touches `history_names` and nothing the
    // index owns, so no pass is forced and no other window has to be told: the
    // renderer adopts the row it gets back.
    'history:rename': ({ sessionId, name }) =>
      renameHistorySession(services.store, sessionId, name),
    // Awaited by the renderer for the same reason `session:start` is: the
    // reasons a resume cannot happen are sentences, and a tab is the wrong
    // place to learn them.
    'history:resume': (request) => ctx.sessions.resume(request),

    // Read-only, both of them, and there is deliberately no third channel here
    // that captures or deletes anything: what the archive holds is decided by a
    // pass in the main process, and the ceiling is an ordinary setting.
    'archive:conversation': ({ sessionId }) => readArchivedConversation(services.store, sessionId),
    'archive:stats': () => ctx.archive.stats(),

    // A free function rather than a method on either service: one editor, one
    // highlighter, and nothing about a draft in a box belongs to a scope.
    'editor:highlight': ({ path, source }) => highlightForEditor(path, source),

    'config:scopes': () => ctx.config.scopes(),
    'config:tree': ({ scopePath }) => ctx.config.tree(scopePath),
    'config:read': ({ path }) => ctx.config.read(path),
    'config:render': ({ path, source }) => ctx.config.render(path, source),
    // Every byte Helm writes into a `.claude` tree goes through this one
    // handler, which is what makes "no write without a snapshot" a property of
    // the app rather than of whoever remembered to take one.
    'config:write': (request) => ctx.config.write(request),
    'config:snapshots': ({ scopePath, path }) => ctx.config.snapshots(scopePath, path),
    'config:snapshot': ({ id }) => ctx.config.snapshot(id),
    'config:restore': ({ id, path }) => ctx.config.restore(id, path),
    'config:watch': ({ path }) => {
      ctx.config.watch(path)
    },

    // The other three things a directory supports. They reach the same
    // snapshot-first path `config:write` does; what is new here is the
    // question, not a second route to the disk.
    'config:create': (request) => ctx.config.create(request),
    'config:rename': (request) => ctx.config.rename(request),
    'config:delete': (request) => ctx.config.remove(request),

    'config:effective': (request) => ctx.config.effective(request),

    'config:mcpPreview': (request) => ctx.config.mcpPreview(request),
    'config:mcpAdd': (request) => ctx.config.mcpAdd(request),
    'config:mcpRemove': (request) => ctx.config.mcpRemove(request),
    'config:mcpApprove': (request) => ctx.config.mcpApprove(request),
    'config:mcpList': ({ cwd }) => ctx.config.mcpList(cwd),

    'config:doctor': ({ cwd }) => ctx.config.doctor(cwd),

    // The last reading rather than a fresh read: the service keeps itself
    // current, and a status bar that hit the disk every time it repainted
    // would be the one surface in the app that does.
    'usage:read': () => ctx.usage.snapshot(),

    // The cache, deliberately: this runs no `gh`, so the pane paints on the
    // first frame and whatever the fetch finds arrives as `pr:changed`.
    'pr:snapshot': () => ctx.pulls.snapshot(),
    'pr:refresh': (request) =>
      ctx.pulls.refresh(request?.repoPath !== undefined ? { repoPath: request.repoPath } : {}),
    // Cached unless asked otherwise, and the markdown comes back rendered - the
    // window has no pipeline of its own to run it through.
    'pr:detail': ({ repoPath, number, refresh }) =>
      ctx.pulls.detail({ repoPath, number, ...(refresh === true ? { refresh: true } : {}) }),

    /**
     * The two halves of a review launch, in the order they have to happen.
     *
     * `prepareReview` is where the decisions are: it reads the pull request out
     * of the cache, reads the template and the checkout mode out of settings,
     * runs `gh pr checkout` if that is what was asked for, and renders the
     * prompt. Only then does the session host spawn - so a checkout that was
     * refused is a rejection with a sentence in it rather than a tab that
     * opened onto the wrong revision.
     *
     * Awaited by the renderer for the same reason `session:start` is: the pane
     * has nowhere else to learn that there is no `gh`, or that the tree is
     * dirty, and a tab holding a terminal that never started is worse than no
     * tab.
     */
    'pr:review': async ({ repoPath, number, cols, rows }) => {
      const plan = await ctx.pulls.prepareReview({ repoPath, number })
      const session = await ctx.sessions.review(plan, { cols, rows })
      return {
        session,
        prompt: plan.prompt,
        checkedOut: plan.checkedOut,
        warnings: plan.warnings
      }
    },

    'content:scopes': () => ctx.content.scopes(),
    'content:tree': ({ scopePath, refresh }) => ctx.content.tree(scopePath, refresh ?? false),
    'content:dir': ({ scopePath, relPath }) => ctx.content.dir(scopePath, relPath),
    'content:document': ({ scopePath, path }) => ctx.content.document(scopePath, path),
    'content:render': ({ scopePath, path, source }) => ctx.content.render(scopePath, path, source),
    'content:search': ({ scopePath, query }) => ctx.content.search(scopePath, query),
    'content:write': (request) => ctx.content.write(request),
    'content:snapshots': ({ scopePath, path }) => ctx.content.snapshots(scopePath, path),
    'content:restore': ({ id, path }) => ctx.content.restore(id, path),
    'content:artifact': ({ scopePath, path }) => ctx.content.artifact(scopePath, path),
    'content:wikilink': ({ scopePath, target, from }) => ({
      path: ctx.content.wikilink(scopePath, target, from)
    }),

    // A link in a note is the user's, not Helm's, so it opens where they expect
    // links to open. The scheme check is the whole security of this handler:
    // `shell.openExternal` will happily hand a `file:` URL to the shell, which
    // on Windows is a way to run whatever it points at.
    'shell:openExternal': async ({ url }) => {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { opened: false }
      }
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return { opened: false }
      await shell.openExternal(parsed.toString())
      return { opened: true }
    },

    'clipboard:read': () => clipboard.readText(),
    'clipboard:write': (text) => {
      clipboard.writeText(text)
    },

    /*
     * The browser pane. Every handler is a one-line delegation on purpose:
     * every decision behind them - what a typed address means, whether the
     * reach posture allows it, what hiding is - lives in `main/browser.ts` and
     * `@helm/core`, so there is exactly one place either could be got wrong.
     */
    'browser:open': (request) => ctx.browsers.open(request),
    'browser:navigate': ({ id, input }) => ctx.browsers.navigate(id, input),
    'browser:back': ({ id }) => ctx.browsers.back(id),
    'browser:forward': ({ id }) => ctx.browsers.forward(id),
    'browser:reload': ({ id, hard }) => ctx.browsers.reload(id, hard === true),
    'browser:close': ({ id }) => ctx.browsers.close(id),
    'browser:state': ({ id }) => ctx.browsers.states(id),
    'browser:eval': ({ id, source }) => ctx.browsers.evaluate(id, source),
    'browser:devtools': ({ id }) => ctx.browsers.devtools(id),
    'browser:find': ({ id, query, forward }) => ctx.browsers.find(id, query, forward !== false),
    'browser:stopFind': ({ id }) => ctx.browsers.stopFind(id),
    'browser:zoom': ({ id, level }) => ctx.browsers.zoom(id, level),
    'browser:clearStorage': ({ id }) => ctx.browsers.clearStorage(id),
    'browser:console': ({ id }) => ctx.browsers.entries(id)
  }

  const sends: SendHandlers = {
    'renderer:ready': () => ctx.rendererReady(),

    'pty:input': (data) => {
      activePty()?.pty.write(data)
    },

    'pty:resize': ({ cols, rows }) => {
      try {
        activePty()?.pty.resize(cols, rows)
      } catch {
        // The pty may have exited between the resize event and this call.
      }
    },

    'session:input': ({ id, data }) => ctx.sessions.input(id, data),
    'session:resize': ({ id, cols, rows }) => ctx.sessions.resize(id, cols, rows),
    'session:focus': ({ id }) => ctx.sessions.setFocus(id),
    'sessions:watch': ({ watching }) => ctx.resources.watch(watching),

    'pterm:input': ({ id, data }) => ctx.pterm.input(id, data),
    'pterm:resize': ({ id, cols, rows }) => ctx.pterm.resize(id, cols, rows),

    'browser:bounds': (payload) => ctx.browsers.bounds(payload),

    // Consumed by one-shot `ipcMain.once` listeners in the spike drivers, which
    // register alongside these. A no-op here keeps the contract exhaustive
    // without stealing the event.
    'term:created': () => undefined,
    'term:resized': () => undefined,
    'probe:res': () => undefined,
    // Same shape: the real listener is the one `sessions.ts` registers at
    // module scope, which is the side holding the promise this answers.
    'session:confirmed': () => undefined
  }

  // The maps above are where the types are checked. Registration itself is
  // uniform, so the payload is `unknown` here by construction - Electron cannot
  // know which channel it is dispatching.
  for (const [channel, handler] of Object.entries(requests) as Array<
    [string, (payload: unknown, event: Electron.IpcMainInvokeEvent) => unknown]
  >) {
    ipcMain.handle(channel, (event, payload: unknown) => handler(payload, event))
  }

  /*
   * A send that throws must not take the process with it.
   *
   * The asymmetry with `handle` above is the whole reason this exists: a
   * request that throws rejects its own promise and reaches the renderer as a
   * failed invoke, while a send has no reply to fail into - so an exception out
   * of one of these handlers is an **uncaught exception in the main process**,
   * and Electron answers that with its own error dialog over the app.
   *
   * That is not hypothetical. `browser:bounds` is sent on every
   * `ResizeObserver` tick of an open browser pane, and a view whose page had
   * closed itself made it throw every time: the dialog came back as fast as it
   * could be dismissed, which is what the bug report described. The fault
   * itself is fixed where it was, in `browser.ts`; this is here because the
   * next one should degrade rather than pop a dialog, and because a fire-and-
   * forget channel is exactly where a fault is least likely to be noticed
   * otherwise. Logged rather than swallowed, so it is still findable.
   */
  for (const [channel, handler] of Object.entries(sends) as Array<
    [string, (payload: unknown, event: Electron.IpcMainEvent) => void]
  >) {
    ipcMain.on(channel, (event, payload: unknown) => {
      try {
        handler(payload, event)
      } catch (err) {
        console.error(`ipc send ${channel} threw:`, err)
      }
    })
  }

  nativeTheme.themeSource = services.settings.theme
  nativeTheme.on('updated', () => {
    // The overlay buttons are native chrome, so the theme swap has to be told
    // to them separately - they do not follow the renderer's class.
    applyTitleBarOverlay(ctx.window(), resolvedTheme())
    emit(ctx.window(), 'theme:changed', {
      preference: services.settings.theme,
      resolved: resolvedTheme()
    })
  })
}

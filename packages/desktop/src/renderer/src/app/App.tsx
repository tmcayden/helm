import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_SETTINGS,
  isLoopbackUrl,
  isProjectPinned,
  liveSessionsIn,
  PROJECT_SHELL_HEIGHT_PCT,
  SESSION_SPLIT_PCT,
  sessionLabel,
  withProjectPinned,
  withRepoIgnored,
  type EditorHighlight,
  type HistorySession,
  type LiveSession,
  type Profile,
  type ProfileDraft,
  wslDistroOf,
  type WslDistro,
  type Project,
  type SessionRecord,
  type WorkspaceTab
} from '@helm/core/types'
import {
  AppShell,
  BookIcon,
  BrowserPane,
  cn,
  ConfigConsole,
  ConfigDeleteDialog,
  ConfigDeletedNotice,
  ConfigEditor,
  ConfigNewDialog,
  ConfigNothingSelected,
  ConfigRenameDialog,
  ConfirmSessionDialog,
  ContentDocumentPane,
  type ConsoleEntry,
  ContentNothingSelected,
  ContentViewer,
  EffectiveViewPane,
  FolderIcon,
  GearIcon,
  GlobeIcon,
  HarnessIcon,
  HealthPanel,
  HistoryIcon,
  McpPanel,
  NewHarnessDialog,
  ProfileEditor,
  ProfileList,
  ProjectPane,
  PullRequestIcon,
  PullsPane,
  pullRepoChoices,
  pullsSummaryLine,
  RepoIcon,
  SaveAsTemplateDialog,
  SessionHistory,
  SessionsPane,
  SetupPane,
  Sidebar,
  SlidersIcon,
  StatusBar,
  TabBar,
  TemplateManager,
  TerminalIcon,
  ThemeToggle,
  TitleBar,
  VersionBanner,
  WelcomePane,
  type ProfilePrediction,
  type Tab,
  type TabIndicator
} from '@helm/ui'
import type { AppMode, SessionConfirmRequest } from '../../../shared/ipc'
import { helm } from './bridge'
import { PROJECT_SHELL_MIN_PX, ProjectShellPane } from './ProjectShellPane'
import { PullRequestTab } from './PullRequestTab'
import { disposeShell, getShell } from './pterms'
import { estimateGrid } from './terminals'
import { TerminalPane } from './TerminalPane'
import { terminalFontStack } from '../terminal'
import { useConfig } from './useConfig'
import { useContent } from './useContent'
import { useHistory } from './useHistory'
import { useLauncher } from './useLauncher'
import { useProfiles } from './useProfiles'
import { forgetPullDetail } from './usePullDetail'
import { usePulls } from './usePulls'
import { useLiveSessions } from './useLiveSessions'
import { useSessions } from './useSessions'
import { useSetup } from './useSetup'
import { useTemplates } from './useTemplates'
import { useBrowsers } from './useBrowsers'
import { useShells } from './useShells'
import { useUpdate } from './useUpdate'
import { useUsage } from './useUsage'
import { SettingsWithWsl } from './SettingsWithWsl'

const KIND_ICON = {
  harness: HarnessIcon,
  repo: RepoIcon,
  folder: FolderIcon
} as const

/**
 * Two surfaces, two strips (DESIGN.md, mockup direction 2a).
 *
 * The workspace holds panes that are views of data - projects, history,
 * config, content - and can be thrown away and rebuilt at will; every piece
 * of state they carry lives in a hook rather than in the component. Sessions
 * are different in kind: each has a process behind it, so they dock as a
 * resizable split on the right with their own tab row, are closed by asking
 * the main process, and their panes stay mounted even while another session
 * is in front - unmounting one would drop the scrollback of a live session.
 * The split is what lets a session keep running in view while the workspace
 * is browsed.
 *
 * `WorkspaceTab` is `@helm/core`'s, because the strip is persisted across
 * launches (`AppSettings.workspaceTabs`) and a pane shape that drifted from
 * the shape it is stored in would restore a strip nobody arranged. A `pr` pane
 * is identified by the project it was opened from and not by the repository
 * slug: two checkouts of one repository are two projects, and closing one must
 * not close the other's tabs.
 *
 * **A browser pane is the one kind that is not persisted**, which is why this
 * is a union rather than an alias any more. It is not a view of data: it is a
 * `WebContentsView` in the main process, with a render process behind it, and
 * `before-quit` destroys it exactly as it ends every session. A strip that
 * wrote down browser tabs would restore tabs pointing at views that do not
 * exist - the reasoning `AppSettings.workspaceTabs` already gives for leaving
 * the *session* strip out. What is worth remembering is remembered instead:
 * `browserProjectUrls` puts a new tab back on the address the project was last
 * looked at, which is the part somebody would have had to type again.
 */
type PaneRef = WorkspaceTab | { kind: 'browser'; id: number }

/**
 * A link in a rendered note, handed to the OS browser.
 *
 * Not a hook, because it holds nothing. The renderer's navigation posture is
 * unchanged by the browser pane and is the reason this exists at all:
 * `will-navigate` is still prevented on this window and its window-open handler
 * still denies, so the only thing an `https://` link in a document can do is
 * ask main to open it somewhere else. What the browser pane added is a set of
 * `WebContentsView`s that are exempt **by id**, in `main/index.ts`; this window
 * is not one of them and never will be.
 */
const helmOpenExternal = (url: string): Promise<{ opened: boolean }> =>
  helm.invoke('shell:openExternal', { url })

/** A stable empty list, so a view with no console entries does not hand
 * `BrowserPane` a fresh array to re-render against on every render. */
const EMPTY_CONSOLE: ConsoleEntry[] = []

/** The same, for a project with nothing running in it - which is most of them. */
const EMPTY_LIVE: LiveSession[] = []

/**
 * The editors' tokeniser, on the far side of an IPC boundary.
 *
 * A module-level constant rather than a `useCallback`, and that is load-bearing
 * rather than tidy: the editor debounces on this identity, so a new function
 * per render of `App` would cancel and restart the debounce on every render the
 * app happens to do - which is the shape of a highlighter that never fires
 * while anything else on screen is animating. Nothing here closes over state,
 * so there is nothing for a hook to hold.
 */
const helmHighlight = (path: string, source: string): Promise<EditorHighlight> =>
  helm.invoke('editor:highlight', { path, source })

/**
 * What each build mode is called on the status bar.
 *
 * A map rather than the mode string itself because one of them does not read
 * as English: `dev-live` is the dev build with **no data directory of its own**,
 * sharing `%APPDATA%\Helm` with the installed app, and the segment that says so
 * is the only thing on screen that distinguishes it from an ordinary `pnpm dev`.
 */
const MODE_LABEL: Record<AppMode, string> = {
  installed: 'installed',
  portable: 'portable',
  dev: 'dev',
  'dev-live': 'dev · live'
}

const HISTORY_TAB = 'history'
const SESSIONS_TAB = 'sessions'
const PULLS_TAB = 'pulls'
const CONFIG_TAB = 'config'
const CONTENT_TAB = 'content'
const SETTINGS_TAB = 'settings'

const tabId = (ref: PaneRef): string => {
  if (ref.kind === 'project') return `project:${ref.path}`
  if (ref.kind === 'browser') return `browser:${String(ref.id)}`
  if (ref.kind === 'sessions') return SESSIONS_TAB
  if (ref.kind === 'pulls') return PULLS_TAB
  // Compared, never taken apart again: a Windows path can contain a `#` and a
  // `:`, so this string is an identity and not a record. Whatever needs the
  // path or the number reads them off the `PaneRef`.
  if (ref.kind === 'pr') return `pr:${ref.repoPath}#${String(ref.number)}`
  if (ref.kind === 'config') return CONFIG_TAB
  if (ref.kind === 'content') return CONTENT_TAB
  if (ref.kind === 'settings') return SETTINGS_TAB
  return HISTORY_TAB
}

/**
 * A tab label, cut to what a 240px folder tab can hold.
 *
 * Cut here rather than left to `text-overflow`, because the label is a number
 * and a title glued together and the number is the half that identifies it: CSS
 * would ellipsise the whole string and a long title would be indistinguishable
 * from the next long title.
 */
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`

/** A stable identity for "no strip at all", so the fallback in `placedOrder`
 * does not hand `openPanes` a fresh array to memoise against on every render. */
const EMPTY_STRIP: PaneRef[] = []

/** The session strip's tab ids - `session:12` - kept in the exact shape the
 * single-strip era used, because `sessions-check` locates tabs by them. */
const sessionTabId = (id: number): string => `session:${String(id)}`
const sessionIdFromTab = (tab: string): number => Number(tab.slice('session:'.length))

/**
 * The shell's height as a percentage of `column`, for a drag that has put the
 * shell's top edge at `top`.
 *
 * Clamped in pixels first and in percent second, and that order is the whole
 * of it. The pixel floor is the bound with a measurement behind it
 * (`PROJECT_SHELL_MIN_PX`), and converting an already-clamped pixel height
 * into a percentage is what keeps the stored number a description of the
 * height on screen. Clamping the percentage alone would let the setting read
 * 10 while CSS drew 180px - a handle that has stopped moving under a number
 * that has not, and a settings row reporting a height the app is not at.
 */
function shellHeightFor(column: DOMRect, top: number): number {
  const ceiling = (column.height * PROJECT_SHELL_HEIGHT_PCT.max) / 100
  const px = Math.min(ceiling, Math.max(PROJECT_SHELL_MIN_PX, column.bottom - top))
  const pct = Math.round((px / column.height) * 100)
  return Math.min(PROJECT_SHELL_HEIGHT_PCT.max, Math.max(PROJECT_SHELL_HEIGHT_PCT.min, pct))
}

export function App(): JSX.Element {
  const launcher = useLauncher()
  const { discovery, settings, info } = launcher

  /**
   * Placement of the workspace strip, or null while it is still the saved one.
   *
   * Null and not `[]` because the two are different states: nothing has been
   * arranged this run, versus every tab has been closed. Only the first of them
   * should fall back to what the last launch left behind, and an empty strip a
   * user made has to survive being looked at.
   *
   * Restoring is therefore a *derivation* (`placedOrder`) rather than an effect
   * that copies the setting into state once it lands. The settings arrive over
   * IPC a moment after the first paint, so a sync would render the empty strip
   * first and the real one after - and `settings:changed` fires on every write,
   * including this strip's own, so a one-shot latch would be load-bearing.
   * Derived, none of that arises. It is the same rule `openPanes` follows
   * below, and for the same reason.
   */
  const [order, setOrder] = useState<PaneRef[] | null>(null)
  /** What the user last asked for. The tab that is actually active is derived
   * from it, because the requested one can stop existing. */
  const [requestedId, setRequestedId] = useState<string | null>(null)
  /** Placement of the session strip; membership is derived from `sessions`. */
  const [sessionOrder, setSessionOrder] = useState<number[]>([])
  const [requestedSession, setRequestedSession] = useState<number | null>(null)
  /** null = split; one side can take the whole row. */
  const [maximize, setMaximize] = useState<'workspace' | 'sessions' | null>(null)
  /**
   * The split's boundary is a CSS custom property on the row, not state.
   *
   * There is no `split` here on purpose. `--split` is written by the drag and
   * by the effect below and by nothing else - React never mentions it in any
   * render - so a `mousemove` moves a boundary without reconciling anything,
   * and an unrelated re-render cannot contradict where the pointer put it. The
   * argument in full, and the two attempts this replaces, are in `theme.css`
   * beside `.split-row`.
   */
  const splitRowRef = useRef<HTMLDivElement>(null)
  const draggingSplit = useRef(false)
  /** Where the current drag has got to, for the one write on release. */
  const splitDragged = useRef<number | null>(null)
  const [launching, setLaunching] = useState(false)
  /**
   * The row the sessions pane has open, by pid.
   *
   * The pid rather than an index or a name: pids are unique among live
   * processes, which is the whole set this pane draws from, and it is the one
   * key a session Helm does not host also has. An index would move whenever
   * anything on the machine started or stopped.
   *
   * Held here rather than in the pane for the reason every workspace pane's
   * state is held here: a workspace pane can be thrown away and rebuilt at
   * will, and a selection that unmounted with it would drop whenever somebody
   * looked at another tab.
   */
  const [selectedLivePid, setSelectedLivePid] = useState<number | null>(null)
  /** The pane box, measured to open a pty at roughly the right grid. */
  const paneRef = useRef<HTMLDivElement>(null)
  /** The project page's column, measured by its shell's drag handle. */
  const projectColumnRef = useRef<HTMLDivElement>(null)
  /**
   * The project the workspace is looking at, as a ref.
   *
   * A ref because the thing that reads it - "open a browser tab beside whatever
   * project is in front" - is a callback declared long before `selectedPath` is
   * derived, and threading the value through would mean re-creating that
   * callback on every tab change for a value it only reads at the moment it is
   * pressed.
   */
  const activePaneProjectRef = useRef<string | null>(null)

  const activateSession = useCallback((id: number) => {
    setRequestedSession(id)
    // A notification click must actually reveal the session, so a maximized
    // workspace gives the split back.
    setMaximize((current) => (current === 'workspace' ? null : current))
  }, [])

  const sessionState = useSessions(activateSession)
  const { sessions, activity: sessionActivity } = sessionState
  /*
   * Every live session on the machine, and what Helm's own are holding.
   *
   * Held here rather than inside the pane because the *warning* needs it and
   * the pane does not exist while somebody is looking at a project. A folder
   * that already has a session in it has to say so on the launch row whether or
   * not the sessions pane has ever been opened.
   */
  const machineSessions = useLiveSessions()
  const profileState = useProfiles()
  const historyState = useHistory()
  const pullsState = usePulls()
  const configState = useConfig()
  const contentState = useContent()
  const usage = useUsage()
  const check = useUpdate()
  /**
   * Narrowed here rather than in the status bar.
   *
   * `UpdateCheck` allows a null version and URL because a check that could not
   * complete has neither, and `newer` is only ever true when both are there.
   * Doing it at the seam means the bar takes a shape whose fields arrive
   * together, instead of taking three nullable ones and restating the rule that
   * connects them.
   *
   * From `answered` and not `attempted`, which is the whole reason the hook
   * keeps two. The bar's line is a standing fact - a newer release exists - and
   * a manual check that could not reach GitHub is not evidence against it. The
   * settings pane takes `attempted` instead, because there the question is what
   * happened when you pressed the button, and "could not ask" is the answer.
   */
  const answered = check.answered
  const update =
    answered !== null && answered.newer && answered.latest !== null && answered.url !== null
      ? { latest: answered.latest, newer: true, url: answered.url }
      : null
  const setup = useSetup(settings, launcher.rescan)
  /**
   * Template authoring, held at app level because both of its entry points are.
   *
   * The manager is reached from the New Harness dialog and from Settings, and
   * "Save as template" from a harness's pane - three surfaces, one directory,
   * so one piece of state rather than a copy each that goes stale the moment
   * another one writes.
   */
  const templates = useTemplates()
  const shells = useShells()
  /**
   * The browser pane's views, which live in the main process.
   *
   * The recent-address list is handed in rather than kept here because main is
   * what writes it - it is the side that knows a navigation succeeded - so it
   * arrives on `settings:changed` like any other setting.
   */
  const browsers = useBrowsers(settings?.browserRecentUrls ?? DEFAULT_SETTINGS.browserRecentUrls)
  const browserViews = browsers.views

  /**
   * What the Terminal group shows, and one writer for them.
   *
   * Written through `settings:write` like everything else, which is also what
   * pushes them to the terminals: the main process answers with the whole
   * settings object, `useLauncher` adopts it, and the registries that own the
   * live terminals are told from there (termprefs.ts). Nothing here reaches a
   * terminal directly.
   *
   * Six of the seven are terminal preferences and travel that route.
   * `projectShellHeightPct` is not one - it is the project page's layout, it
   * reaches no terminal, and it is in this group because it is where somebody
   * looks for the shell under a project. `sessionSplitPct` is the second of
   * those and rides along for the same reason.
   */
  const terminalSettings = useMemo(
    () => ({
      terminalFontFamily: settings?.terminalFontFamily ?? null,
      terminalFontSize: settings?.terminalFontSize ?? DEFAULT_SETTINGS.terminalFontSize,
      terminalCursorStyle: settings?.terminalCursorStyle ?? DEFAULT_SETTINGS.terminalCursorStyle,
      terminalCursorBlink: settings?.terminalCursorBlink ?? DEFAULT_SETTINGS.terminalCursorBlink,
      terminalScrollback: settings?.terminalScrollback ?? DEFAULT_SETTINGS.terminalScrollback,
      terminalShell: settings?.terminalShell ?? null,
      projectShellHeightPct:
        settings?.projectShellHeightPct ?? DEFAULT_SETTINGS.projectShellHeightPct,
      sessionSplitPct: settings?.sessionSplitPct ?? DEFAULT_SETTINGS.sessionSplitPct
    }),
    [settings]
  )

  const { writeSettings } = launcher
  const locateShell = useCallback(() => {
    void helm.invoke('path:chooseFile', { title: 'Choose a shell' }).then(({ path }) => {
      if (path !== null) writeSettings({ terminalShell: path })
    })
  }, [writeSettings])

  const savedShellHeight = settings?.projectShellHeightPct ?? DEFAULT_SETTINGS.projectShellHeightPct

  const savedSplitPct = settings?.sessionSplitPct ?? DEFAULT_SETTINGS.sessionSplitPct

  /**
   * The remembered split, put on the row.
   *
   * Runs on mount and whenever the setting changes - which includes the
   * broadcast that follows this component's own write on release, and that one
   * is a no-op because the drag already left the property at that value.
   *
   * **Skipped while a drag is running.** A `settings:changed` from anywhere
   * else mid-gesture would otherwise pull the boundary out from under the
   * pointer, which is the failure mode of the attempt this replaces, arriving
   * by a different route.
   *
   * `useLayoutEffect`, so the property is on the row before the browser paints.
   * Settings arrive asynchronously and the CSS fallback is the 45% default, so
   * an ordinary effect would show one frame of the default to anybody whose
   * split is not 45 - a flash on every launch, on the one setting whose entire
   * purpose is that the app stops forgetting.
   */
  useLayoutEffect(() => {
    if (draggingSplit.current) return
    splitRowRef.current?.style.setProperty('--split', String(savedSplitPct / 100))
  }, [savedSplitPct])

  /**
   * Point Helm at a `gh` it did not find. Written straight through
   * `settings:write`, whose ladder re-resolves the binary and re-arms the
   * poller - so what the GitHub group reports afterwards is the executable
   * actually in force rather than the file that was picked.
   */
  const locateGh = useCallback(() => {
    void helm
      .invoke('path:chooseFile', { title: 'Locate the gh executable' })
      .then(({ path }) => {
        if (path !== null) writeSettings({ ghPath: path })
      })
  }, [writeSettings])

  /**
   * Puts one repository back on the pull-request surface.
   *
   * The whole list is written, because that is the setting - and it is composed
   * from `settings`, not from the snapshot, so a chip clicked while a fetch is
   * in flight cannot write a list assembled from a half-built view. The ladder
   * behind `settings:write` republishes the snapshot and starts a pass, so the
   * repository comes back with whatever it had and then with what it has.
   */
  const unignoreRepo = useCallback(
    (slug: string) => {
      const held = settings?.prIgnoredRepos ?? DEFAULT_SETTINGS.prIgnoredRepos
      writeSettings({ prIgnoredRepos: withRepoIgnored(held, slug, false) })
    },
    [settings, writeSettings]
  )

  /**
   * The sidebar's star, both directions.
   *
   * Composed from `settings` rather than from what the sidebar is holding, the
   * same rule `unignoreRepo` follows: the setting is the whole list, and a list
   * assembled from a rendered view is a list assembled from whatever had
   * arrived by then. `withProjectPinned` decides on and off from the list
   * itself, so this needs no state of its own and two stars pressed in quick
   * succession cannot each write the other away.
   */
  const togglePin = useCallback(
    (path: string) => {
      const held = settings?.pinnedProjects ?? DEFAULT_SETTINGS.pinnedProjects
      writeSettings({
        pinnedProjects: withProjectPinned(held, path, !isProjectPinned(held, path))
      })
    },
    [settings, writeSettings]
  )

  /** The profile being edited, `'new'` for one being created from scratch, or
   * a seeded draft from "save as profile". Null when the dialog is closed. */
  const [editing, setEditing] = useState<Profile | ProfileDraft | null>(null)
  const [saveProblems, setSaveProblems] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  /**
   * The WSL distributions, read once and held for the window.
   *
   * A property of the machine rather than of the app's state, so it is asked
   * for at mount rather than every time the editor opens - and it is the cheap
   * half of the pair on purpose: `wsl:distros` enumerates without starting
   * anything, where `wsl:probe` boots a stopped distribution to answer.
   *
   * An empty list is the ordinary answer on a machine with no WSL, and the
   * editor renders the same either way.
   */
  const [distros, setDistros] = useState<WslDistro[]>([])
  useEffect(() => {
    let live = true
    helm
      .invoke('wsl:distros')
      .then((found) => {
        if (live) setDistros(found)
      })
      .catch(() => {
        // No WSL is not a problem to report. The picker simply offers Windows.
      })
    return () => {
      live = false
    }
  }, [])

  const projectsByPath = useMemo(() => {
    const map = new Map<string, Project>()
    for (const project of discovery?.projects ?? []) map.set(project.path, project)
    return map
  }, [discovery])

  const sessionsById = useMemo(() => {
    const map = new Map<number, SessionRecord>()
    for (const session of sessions) map.set(session.id, session)
    return map
  }, [sessions])

  /**
   * Both strips, derived rather than synced in an effect.
   *
   * A rescan that no longer sees a project should close its tab, and every
   * session main is hosting should have one - including sessions this renderer
   * did not launch, which is the case after a reload (dev HMR, or a crashed
   * render process) where the processes outlive the strip that was showing
   * them. Writing either as `useEffect` + `setState` renders once with the
   * wrong tabs and then again with the right ones, for a value that is a pure
   * function of what we already have.
   *
   * The order arrays therefore hold placement, not membership: a session that
   * has never been moved or closed is simply appended.
   */
  /**
   * The strip as arranged: this run's placement, or the saved one until
   * something has been opened, closed or moved.
   *
   * Unfiltered on purpose - a project the scan has not reached yet is dropped
   * by `openPanes` below and stays here, so a slow discovery hides a restored
   * tab for a moment rather than losing it.
   */
  const savedStrip = settings?.workspaceTabs ?? null
  const placedOrder = order ?? savedStrip?.panes ?? EMPTY_STRIP
  const settingsLoaded = settings !== null

  const openPanes = useMemo(() => {
    const placed = placedOrder.filter((ref) => {
      if (ref.kind === 'project') return !discovery || projectsByPath.has(ref.path)
      // A pull request tab follows its project, by the same rule: the project
      // is where it was opened from and where a review would run, so a rescan
      // that no longer sees the directory closes the tab with it.
      if (ref.kind === 'pr') return !discovery || projectsByPath.has(ref.repoPath)
      // A browser tab follows its view, which main owns: a view that has gone -
      // the cap, a crashed render process, `before-quit` - takes its tab.
      if (ref.kind === 'browser') return browserViews.has(ref.id)
      return true
    })
    /*
     * Views main is holding that this strip has never heard of.
     *
     * Derived rather than synced in an effect, for the reason `sessionIds` is:
     * a `window.open` inside a page, and a renderer reload that left live views
     * behind, both produce a view with no tab, and writing that as
     * `useEffect` + `setState` renders once with the wrong strip.
     */
    const known = new Set(placed.filter((ref) => ref.kind === 'browser').map((ref) => ref.id))
    const appended: PaneRef[] = [...browserViews.keys()]
      .filter((id) => !known.has(id))
      .map((id) => ({ kind: 'browser' as const, id }))
    return appended.length === 0 ? placed : [...placed, ...appended]
  }, [placedOrder, discovery, projectsByPath, browserViews])

  const sessionIds = useMemo(() => {
    const placed = sessionOrder.filter((id) => sessionsById.has(id))
    const known = new Set(placed)
    const appended = sessions.filter((s) => !known.has(s.id)).map((s) => s.id)
    return [...placed, ...appended]
  }, [sessionOrder, sessions, sessionsById])

  // The saved active tab stands in until something is asked for, by the same
  // rule `placedOrder` follows. It is only ever compared against the ids on the
  // strip, so an id whose pane is gone falls through to the last tab exactly as
  // a stale `requestedId` does.
  const requested = requestedId ?? savedStrip?.activeId ?? null
  const activeId =
    requested !== null && openPanes.some((ref) => tabId(ref) === requested)
      ? requested
      : (openPanes.map(tabId).at(-1) ?? null)
  const activePane = openPanes.find((ref) => tabId(ref) === activeId) ?? null

  const activeSessionId =
    requestedSession !== null && sessionIds.includes(requestedSession)
      ? requestedSession
      : (sessionIds.at(-1) ?? null)

  /*
   * The process pass runs only while the sessions pane is the pane on screen.
   *
   * One enumeration costs 400ms of a child process where the registry poll
   * beside it costs 0.15ms, so "off unless somebody is looking" is the whole
   * budget rather than an optimisation. Balanced by the cleanup, and
   * reference-counted in main, so a tab switch that unmounts one watcher while
   * another is still there cannot switch the pass off under it.
   */
  const sessionsPaneOpen = activePane?.kind === 'sessions'
  const watchResources = machineSessions.watch
  useEffect(() => {
    if (!sessionsPaneOpen) return undefined
    watchResources(true)
    return () => watchResources(false)
  }, [sessionsPaneOpen, watchResources])

  /**
   * The sessions row's second line, and the tab's hover hint.
   *
   * Composed here rather than in the sidebar for the reason `pullsSummaryLine`
   * is: it is a fact about a machine, not about the tree. The second half is
   * the one worth the width - "one outside Helm" is what changes what somebody
   * does next, and it is why the listing behind it is machine-wide at all.
   */
  const sessionsSummaryLine = ((): string => {
    const all = machineSessions.sessions
    if (machineSessions.readAtMs === null) return 'Reading…'
    if (all.length === 0) return 'Nothing running'
    const outside = all.filter((session) => session.helmSessionId === null).length
    const running = `${String(all.length)} running`
    return outside === 0 ? `${running} · all in Helm` : `${running} · ${String(outside)} outside Helm`
  })()

  /**
   * The saved strip, written back whenever the arrangement changes.
   *
   * Debounced because a drag moves a tab at a time and every write is a
   * settings round trip that comes back as a `settings:changed` broadcast.
   * `activeId` travels with it, so which tab was in front is restored with the
   * arrangement rather than falling to the last one.
   *
   * Gated on a boolean rather than on `settings` itself, and that is the whole
   * reason `settingsLoaded` exists: `settings` is a new object after every
   * write, so depending on it here would make this effect re-arm its own timer
   * and write forever at 500ms.
   *
   * What is saved is `openPanes` - the strip on screen - even though `order`
   * is what a restore is folded into. A tab whose project the scan no longer
   * finds is gone from the strip the user is looking at, and writing it down
   * again would resurrect it on the next launch.
   */
  useEffect(() => {
    if (!settingsLoaded) return
    const timer = setTimeout(() => {
      // Browser panes are dropped here rather than being made persistable, and
      // the type is what says so: `WorkspaceTab` has no browser variant, so
      // this filter is what makes the write compile. See `PaneRef`.
      const panes = openPanes.filter((ref): ref is WorkspaceTab => ref.kind !== 'browser')
      writeSettings({ workspaceTabs: { panes, activeId } })
    }, 500)
    return () => clearTimeout(timer)
  }, [settingsLoaded, openPanes, activeId, writeSettings])

  const hasSessions = sessionIds.length > 0
  // Derived rather than reset in an effect: with no sessions there is no
  // split, so a held maximize simply stops meaning anything until the next
  // launch gives it a pane to apply to.
  const effectiveMaximize = hasSessions ? maximize : null
  const showSessions = hasSessions && effectiveMaximize !== 'workspace'
  const showWorkspace = !showSessions || effectiveMaximize !== 'sessions'

  /**
   * Which browser view is the one in front, told to every view.
   *
   * The pane reports its own rectangle while it is mounted; a tab switch
   * unmounts it, so the view it was showing has to be stood down by something
   * that is still rendering. This is that. The rectangle is kept on the other
   * side, so returning to the tab puts the page straight back where it was -
   * which is the whole reason the view is not destroyed on unmount.
   */
  const { setShowing: setBrowserShowing } = browsers
  useEffect(() => {
    const front =
      showWorkspace && activePane?.kind === 'browser' ? activePane.id : null
    for (const id of browserViews.keys()) setBrowserShowing(id, id === front)
  }, [browserViews, activePane, showWorkspace, setBrowserShowing])

  // Main decides whether an exiting session is worth a notification, and that
  // turns on which session is actually in view - which only this side knows.
  const { reportFocus } = sessionState
  useEffect(() => {
    reportFocus(showSessions ? activeSessionId : null)
  }, [showSessions, activeSessionId, reportFocus])

  // The split divider: a plain mouse drag, bounded so neither side can be
  // dragged out of usefulness.
  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (!draggingSplit.current || !splitRowRef.current) return
      // A move with no button held is not this drag any more, so end it here
      // rather than follow the pointer.
      //
      // This is the failure the shell handle's `setPointerCapture` comment
      // names from the other side: release the button outside the window and
      // no `mouseup` is ever delivered, so `draggingSplit` stays true and the
      // divider is still tracking the pointer when it comes back - moving on a
      // hover, with nothing held down. `buttons` is the only thing that says
      // so, because the release itself was never seen.
      //
      // It is also what stops a driver's synthetic hover from passing for a
      // drag. Chromium delivers `sendInputEvent` moves as `buttons: 0` unless
      // the caller passes `leftbuttondown`, and this handler answering them
      // anyway is why nothing noticed that no drag in this app had ever been
      // exercised by a check - see `drag()` in main/bridge.ts.
      if (event.buttons === 0) {
        draggingSplit.current = false
        document.body.style.userSelect = ''
        return
      }
      // Re-measured every move rather than cached at `mousedown`. The row's box
      // can change under a drag - the window is resizable while one is running
      // - and a cached one turns the pointer's position into the wrong
      // fraction from the moment it does.
      const box = splitRowRef.current.getBoundingClientRect()
      if (box.width < 1) return
      const fraction = 1 - (event.clientX - box.left) / box.width
      const bounded = Math.min(
        SESSION_SPLIT_PCT.max / 100,
        Math.max(SESSION_SPLIT_PCT.min / 100, fraction)
      )
      splitDragged.current = bounded
      // The whole move: one custom property, no state, nothing reconciled. What
      // this costs does not grow with what is in either pane, which is the
      // difference the session history made so visible - 966 rows rebuilt per
      // frame so that a boundary could move four pixels.
      splitRowRef.current.style.setProperty('--split', String(bounded))
    }
    const onUp = (): void => {
      draggingSplit.current = false
      document.body.style.userSelect = ''
      // One write for the whole gesture, and none for a press that never moved:
      // a click on the divider is not a decision about anything. Per frame this
      // would be a database round trip per `mousemove`, and each one comes back
      // as a `settings:changed` broadcast into the middle of the drag.
      const landed = splitDragged.current
      splitDragged.current = null
      if (landed === null) return
      const pct = Math.round(landed * 100)
      // Snap the property to the rounded value the setting will hold, whether
      // or not there is a write to make. Otherwise a drag that lands back on
      // the percentage already stored leaves the row at the unrounded fraction
      // it was dragged to, and the next `settings:changed` from anywhere at all
      // moves the boundary a few pixels for no reason anybody could see.
      splitRowRef.current?.style.setProperty('--split', String(pct / 100))
      if (pct !== savedSplitPct) writeSettings({ sessionSplitPct: pct })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // `onUp` compares against the remembered value before writing, so it has to
    // see the current one. Re-subscribing two window listeners when a setting
    // changes costs nothing, and a drag in progress survives it: what says one
    // is running is a ref, not the closure.
  }, [savedSplitPct, writeSettings])

  // `placedOrder` and not the raw `order`, so the first tab opened in a window
  // whose strip came from the last launch is appended to that strip rather than
  // replacing it.
  const openPane = useCallback(
    (ref: PaneRef) => {
      setOrder((current) => {
        const strip = current ?? placedOrder
        return strip.some((r) => tabId(r) === tabId(ref)) ? strip : [...strip, ref]
      })
      setRequestedId(tabId(ref))
    },
    [placedOrder]
  )

  const openProject = useCallback(
    (project: Project | null) => {
      if (!project) return
      openPane({ kind: 'project', path: project.path })
    },
    [openPane]
  )

  const openSessions = useCallback(() => openPane({ kind: 'sessions' }), [openPane])
  const openHistory = useCallback(() => openPane({ kind: 'history' }), [openPane])
  const openPulls = useCallback(() => openPane({ kind: 'pulls' }), [openPane])

  /**
   * A row in the Pulls pane opens the pull request in a tab of its own.
   *
   * `openPane` already focuses a tab that is open rather than opening a second
   * one, so clicking the same row twice is a way back to it.
   */
  const openPull = useCallback(
    (repo: { path: string }, pull: { number: number }) =>
      openPane({ kind: 'pr', repoPath: repo.path, number: pull.number }),
    [openPane]
  )

  /**
   * Config and Content open on the scope they already had. They used to be
   * per-harness links that carried a scope in, which meant the only way to
   * reach either pane was through a harness that happened to be expanded.
   * Both panes own a scope switcher, so the entry point does not need to.
   */
  const openConfig = useCallback(() => openPane({ kind: 'config' }), [openPane])
  const openContent = useCallback(() => openPane({ kind: 'content' }), [openPane])

  /**
   * The same two panes, opened **on** a project - the project pane's links.
   *
   * These do not make either pane per-project again; the sidebar rows above are
   * still the unscoped way in, which is the whole of what DESIGN.md 5b asks
   * for. What a link from a project adds is the scope, so the pane arrives
   * pointed at the project that was on screen instead of at whatever it last
   * held. The view is deliberately left alone: the scope is the project's to
   * decide and the view is the pane's.
   *
   * Re-pointing goes through the hook's own setter, because that is what clears
   * the open file - a pane still showing the last scope's file beside this
   * scope's tree would be two scopes on one screen. Skipped when the scope is
   * already the one asked for, so clicking the link to *return* to a pane does
   * not throw away what was open in it.
   */
  const { scopePath: configScopePath, setScopePath: setConfigScope } = configState
  const openConfigAt = useCallback(
    (project: Project) => {
      if (configScopePath.toLowerCase() !== project.path.toLowerCase()) {
        setConfigScope(project.path)
      }
      openPane({ kind: 'config' })
    },
    [configScopePath, setConfigScope, openPane]
  )

  const { scopePath: contentScopePath, setScopePath: setContentScope } = contentState
  const openContentAt = useCallback(
    (project: Project) => {
      if (contentScopePath.toLowerCase() !== project.path.toLowerCase()) {
        setContentScope(project.path)
      }
      openPane({ kind: 'content' })
    },
    [contentScopePath, setContentScope, openPane]
  )

  /**
   * Settings is a workspace pane like any other rather than a modal: it is a
   * place, it is worth leaving open beside a session, and a dialog over the
   * window would be one more thing to dismiss before looking at what a setting
   * changed. Its entry point is in the title bar because what it configures is
   * the app, not whatever project happens to be selected.
   */
  const openSettings = useCallback(() => openPane({ kind: 'settings' }), [openPane])

  /**
   * A browser tab.
   *
   * The strip's `+` opens one on whichever project is in front, so the pane
   * arrives on that project's last address rather than empty - which is the
   * whole of "last URL remembered per project" from a user's side. Main decides
   * that from `browserProjectUrls`; nothing here reads it.
   */
  const openBrowser = useCallback(
    (request: { url?: string; project?: string | null } = {}) => {
      void browsers
        .open({
          ...request,
          project: request.project ?? activePaneProjectRef.current
        })
        .then((state) => {
          if (state !== null) setRequestedId(`browser:${String(state.id)}`)
        })
    },
    [browsers]
  )

  /**
   * Ctrl+L focuses the address bar, as it does in every browser.
   *
   * A counter rather than a boolean, because "focus it" is an event and not a
   * state: pressing it twice while the bar already has focus has to re-select,
   * and a boolean that is already true does nothing the second time.
   */
  const [focusAddressAt, setFocusAddressAt] = useState(0)

  /**
   * A link in rendered content: "Open in Helm browser" where URLs already are.
   *
   * This is the entry point the milestone asks for, and it is a **rule rather
   * than a second button**, because the honest answer to "which of these two
   * browsers did you mean" is knowable from the address. A loopback URL - a
   * note saying the dev server is on 3000, a README linking `localhost:8080` -
   * is by definition a thing running on this machine, which is precisely what
   * this pane exists to look at; and the handoff back out is one click away in
   * the pane's own toolbar. Everything else still goes straight to the browser
   * the user actually uses, because Helm will never beat it and must not try.
   *
   * `isLoopbackUrl` is the same function the certificate exception and the
   * reach rule are made of, so "what counts as this machine" has one answer.
   */
  const openLink = useCallback(
    (url: string) => {
      if (isLoopbackUrl(url)) openBrowser({ url })
      else void helmOpenExternal(url)
    },
    [openBrowser]
  )

  /** A launched session lands in the session strip and takes the front. */
  const adoptIntoStrip = useCallback((id: number) => {
    setSessionOrder((current) => (current.includes(id) ? current : [...current, id]))
    setRequestedSession(id)
    setMaximize((current) => (current === 'workspace' ? null : current))
  }, [])

  const launch = useCallback(
    async (project: Project) => {
      setLaunching(true)
      try {
        const id = await sessionState.launch(project, paneRef.current)
        if (id === null) return
        adoptIntoStrip(id)
      } finally {
        setLaunching(false)
      }
    },
    [sessionState, adoptIntoStrip]
  )

  /**
   * A profile launch lands in the strip exactly the way a project launch does
   * - it does not care which produced the session, only that one exists.
   */
  const launchProfile = useCallback(
    async (profile: Profile) => {
      const session = await profileState.launch(profile, paneRef.current)
      if (!session) return
      sessionState.adopt(session)
      adoptIntoStrip(session.id)
    },
    [profileState, sessionState, adoptIntoStrip]
  )

  /**
   * A resumed conversation is a session like any other once it exists - the
   * only difference is upstream, where main decided whether it could be
   * reopened at all and built `--resume` argv for it.
   */
  const resumeSession = useCallback(
    async (session: HistorySession) => {
      const record = await historyState.resume(session, paneRef.current)
      if (!record) return
      sessionState.adopt(record)
      adoptIntoStrip(record.id)
    },
    [historyState, sessionState, adoptIntoStrip]
  )

  /**
   * "Review with Claude", from a pull request tab.
   *
   * Lands in the strip exactly as a resume does, and for the same reason: what
   * comes back is a session like any other, and nothing downstream of this line
   * cares that a pull request is what started it.
   *
   * Note what is *not* here. The prompt is composed in the main process from
   * the cached pull request and the stored template, so this sends a repository
   * path, a number and the grid - the same three-field shape a profile launch
   * has (`LaunchProfileRequest`), and for the same reason: argv assembled in a
   * window is argv that can drift from what was saved. The rejection is
   * re-thrown rather than swallowed because the pull request's own pane is
   * where a dirty tree or a missing `gh` has to be read.
   */
  const reviewPull = useCallback(
    async (repoPath: string, number: number) => {
      const { cols, rows } = estimateGrid(paneRef.current)
      const launched = await helm.invoke('pr:review', { repoPath, number, cols, rows })
      sessionState.adopt(launched.session)
      adoptIntoStrip(launched.session.id)
      return launched
    },
    [sessionState, adoptIntoStrip]
  )

  const blankProfile = useCallback(
    (root: string, name: string): ProfileDraft => ({
      name,
      root,
      overlays: [],
      access: [],
      model: null,
      effort: null,
      permissionMode: null,
      agent: null,
      mcp: [],
      openingPrompt: null,
      pinnedOrder: null,
      // Windows, which is what a new profile has always meant. The editor's
      // picker is where somebody chooses otherwise.
      target: null
    }),
    []
  )

  /**
   * What the profile editor's agent and MCP pickers offer.
   *
   * The same `config:effective` the config console calls, asked about the
   * composition being *typed* rather than a saved one - so the request carries a
   * cwd and overlays rather than a profile id, which is the branch that exists
   * for exactly this.
   */
  const predictProfile = useCallback(
    async (root: string, overlays: string[]): Promise<ProfilePrediction> => {
      const view = await helm.invoke('config:effective', { cwd: root, overlays })
      return { agents: view.agents, mcpServers: view.mcpServers }
    },
    []
  )

  const saveProfile = useCallback(
    async (draft: ProfileDraft) => {
      setSaving(true)
      try {
        const id = editing !== null && 'id' in editing ? editing.id : null
        const { ok, problems } = await profileState.save(draft, id)
        setSaveProblems(problems)
        if (ok) setEditing(null)
      } finally {
        setSaving(false)
      }
    },
    [editing, profileState]
  )

  // Main asks the user first, so this can be fired and forgotten: the list
  // refreshes from `profiles:changed` if the answer was yes and does not if it
  // was no.
  const deleteProfile = useCallback(
    (profile: Profile) => void profileState.remove(profile.id),
    [profileState]
  )

  const closeTab = useCallback(
    (id: string) => {
      const ref = openPanes.find((candidate) => tabId(candidate) === id)
      if (!ref) return
      // The shell dies with its tab, not with a render: hiding the pane keeps
      // it, closing the project ends it.
      if (ref.kind === 'project') void disposeShell(ref.path)
      // Same idea, one layer down: what the pane last painted outlives an
      // unmount so a tab switch does not flash, and a *closed* tab is the point
      // at which nobody is coming back to it.
      if (ref.kind === 'pr') forgetPullDetail(ref.repoPath, ref.number)
      // And the same rule again for the native view: hiding the pane keeps the
      // page, closing the tab destroys it. This is `disposeShell`'s counterpart
      // - the one moment a `WebContentsView` is torn down other than quitting.
      if (ref.kind === 'browser') browsers.close(ref.id)
      setOrder(openPanes.filter((candidate) => tabId(candidate) !== id))
    },
    [openPanes, browsers]
  )

  const closeSession = useCallback(
    (id: number) => {
      // The process gets a say: main confirms before ending a live session, and
      // the tab stays if the answer is no. A closed session drops out of
      // `sessions`, so the strip loses it whether or not it was ever placed.
      void sessionState.close(id).then((closed) => {
        if (closed) setSessionOrder((current) => current.filter((held) => held !== id))
      })
    },
    [sessionState]
  )

  // Written back as the whole strip, so a tab that had only been appended is
  // placed by the same gesture that moved it.
  const reorderTabs = useCallback(
    (id: string, toIndex: number) => {
      const from = openPanes.findIndex((ref) => tabId(ref) === id)
      if (from < 0 || from === toIndex) return
      const next = [...openPanes]
      const [moved] = next.splice(from, 1)
      if (!moved) return
      next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved)
      setOrder(next)
    },
    [openPanes]
  )

  const reorderSessions = useCallback(
    (id: string, toIndex: number) => {
      const sessionId = sessionIdFromTab(id)
      const from = sessionIds.indexOf(sessionId)
      if (from < 0 || from === toIndex) return
      const next = [...sessionIds]
      next.splice(from, 1)
      next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, sessionId)
      setSessionOrder(next)
    },
    [sessionIds]
  )

  // Ctrl+Tab cycles both strips as one ring, in capture so it never reaches
  // the focused terminal. Ctrl+Shift+Tab is not bound by Claude Code either;
  // Shift+Tab alone is (it cycles permission modes) and is deliberately left
  // alone.
  /**
   * Ctrl+L, the address bar, and only while a browser tab is in front.
   *
   * In capture like the Ctrl+Tab ring above and for the same reason - a focused
   * terminal would otherwise eat it - but gated on the active pane, because
   * Ctrl+L is *clear the screen* in every shell Helm hosts and stealing it from
   * a session would be a worse bug than not having the shortcut.
   */
  useEffect(() => {
    if (activePane?.kind !== 'browser') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'l' || !event.ctrlKey || event.altKey || event.shiftKey) return
      if (document.activeElement?.closest('.xterm')) return
      event.preventDefault()
      event.stopPropagation()
      setFocusAddressAt((at) => at + 1)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [activePane])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !event.ctrlKey || event.altKey) return
      const workspaceIds = openPanes.map(tabId)
      const ring = [...workspaceIds, ...sessionIds.map(sessionTabId)]
      if (ring.length < 2) return
      event.preventDefault()
      event.stopPropagation()
      const current =
        showSessions && activeSessionId !== null && document.activeElement?.closest('.xterm')
          ? sessionTabId(activeSessionId)
          : (activeId ?? '')
      const at = ring.indexOf(current)
      const step = event.shiftKey ? -1 : 1
      const next = ring[(at + step + ring.length) % ring.length]
      if (next === undefined) return
      if (next.startsWith('session:')) setRequestedSession(sessionIdFromTab(next))
      else setRequestedId(next)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [openPanes, sessionIds, activeId, activeSessionId, showSessions])

  const tabs: Tab[] = openPanes.flatMap((ref): Tab[] => {
    if (ref.kind === 'sessions') {
      return [
        {
          id: SESSIONS_TAB,
          title: 'Sessions',
          hint: sessionsSummaryLine,
          icon: <TerminalIcon width={13} height={13} />
        }
      ]
    }

    if (ref.kind === 'history') {
      return [
        {
          id: HISTORY_TAB,
          title: 'Session history',
          hint: historyState.summary?.historyFile ?? 'Every session on this machine',
          icon: <HistoryIcon width={13} height={13} />
        }
      ]
    }

    if (ref.kind === 'pulls') {
      return [
        {
          id: PULLS_TAB,
          title: 'Pull requests',
          hint: pullsSummaryLine(pullsState.snapshot),
          icon: <PullRequestIcon width={13} height={13} />
        }
      ]
    }

    if (ref.kind === 'pr') {
      // The title comes from the list snapshot, which is the same row the tab
      // was opened from. A pull request that has closed since drops out of the
      // snapshot and the tab keeps its number - which is the honest label for a
      // tab whose pane is about to say the same thing.
      const repo = pullsState.snapshot?.repos.find(
        (candidate) => candidate.path.toLowerCase() === ref.repoPath.toLowerCase()
      )
      const pull = repo?.pulls.find((candidate) => candidate.number === ref.number)
      const label = `#${String(ref.number)}`
      return [
        {
          id: tabId(ref),
          title: pull ? `${label} ${truncate(pull.title, 34)}` : label,
          hint: pull ? `${pull.title} - ${ref.repoPath}` : ref.repoPath,
          ...(repo ? { subtitle: repo.name } : {}),
          icon: <PullRequestIcon width={13} height={13} />
        }
      ]
    }

    if (ref.kind === 'config') {
      return [
        {
          id: CONFIG_TAB,
          title: 'Config',
          hint: configState.scope?.path ?? 'Browse and edit .claude configuration',
          ...(configState.scope ? { subtitle: configState.scope.label } : {}),
          icon: <SlidersIcon width={13} height={13} />
        }
      ]
    }

    if (ref.kind === 'content') {
      return [
        {
          id: CONTENT_TAB,
          title: 'Content',
          hint: contentState.selected?.path ?? 'Notes, docs, skills and artifacts',
          ...(contentState.scope ? { subtitle: contentState.scope.label } : {}),
          icon: <BookIcon width={13} height={13} />
        }
      ]
    }

    if (ref.kind === 'settings') {
      return [
        {
          id: SETTINGS_TAB,
          title: 'Settings',
          hint: "Helm's own settings",
          icon: <GearIcon width={13} height={13} />
        }
      ]
    }

    if (ref.kind === 'browser') {
      const view = browserViews.get(ref.id)
      if (!view) return []
      // The page's own title, and the host underneath it - which is what tells
      // three tabs on one dev server apart while every one of them is called
      // "Vite + React". An empty page is "New tab" rather than blank: a tab
      // with no label is a tab you cannot aim at.
      //
      // And, where a session opened it, that session's name beside the host.
      // A tab that appeared because Claude opened it and one the user opened
      // are otherwise identical in the strip, and the first is the one somebody
      // will want to know the provenance of.
      const subtitle =
        view.openedBy === null
          ? view.host
          : view.host === ''
            ? view.openedBy
            : `${view.host} · ${view.openedBy}`
      return [
        {
          id: tabId(ref),
          title: view.title === '' ? 'New tab' : truncate(view.title, 34),
          ...(subtitle === '' ? {} : { subtitle: truncate(subtitle, 40), subtitleMono: true }),
          hint:
            (view.url === '' ? 'A browser tab with no address yet' : view.url) +
            (view.openedBy === null ? '' : `\nOpened by the session “${view.openedBy}”`),
          icon: <GlobeIcon width={13} height={13} />
        }
      ]
    }

    const project = projectsByPath.get(ref.path)
    if (!project) return []
    const Icon = KIND_ICON[project.kind]
    return [
      {
        id: tabId(ref),
        title: project.name,
        hint: project.path,
        icon: <Icon width={13} height={13} />
      }
    ]
  })

  const sessionTabs: Tab[] = sessionIds.flatMap((id): Tab[] => {
    const session = sessionsById.get(id)
    if (!session) return []
    /**
     * The dot.
     *
     * How the session *ended* outranks what it last said it was doing: a row
     * that has exited is a fact Helm established, and the registry's last word
     * about a dead process is by definition out of date.
     *
     * While it runs, the session's own answer is preferred and `running` is the
     * fallback for every way of not having one - a record that has not appeared
     * yet, a process that cannot be proved alive, a status this build does not
     * recognise. All three paint exactly what this tab painted before any of
     * this existed, which is the point: a CLI that renames a status degrades to
     * the old behaviour rather than to a guess.
     */
    const live = session.status === 'running' ? sessionActivity.get(session.id) : undefined
    const indicator: TabIndicator =
      session.status !== 'running'
        ? session.exitCode
          ? 'failed'
          : 'ended'
        : (live?.activity ?? 'running')
    const project = session.projectPath ? projectsByPath.get(session.projectPath) : undefined
    const label = sessionLabel(session)
    /**
     * The branch first, and the project's name only when there is no branch.
     *
     * Several sessions against one project is the normal case - that is what
     * tabs are for - and in that case the titles are `dev`, `dev 2`, `dev 3`,
     * none of which says what the session is doing. The branch is what those
     * sessions actually differ by, and the subtitle slot is empty in precisely
     * that case, because the old rule only painted when the project's name
     * differed from the session's.
     *
     * `session.branch` is the branch the cwd was on **when the session was
     * spawned**, captured on the row - not a live reading. The argument for
     * that is at the capture site in `main/sessions.ts`; the short version is
     * that two sessions in one working tree share a HEAD, so a live reading
     * would give them the same subtitle.
     *
     * A cwd that is not a repository has no branch, and there the old rule
     * keeps its turn: the project's name, when it is not already the title.
     */
    const subtitle =
      session.branch ?? (project && project.name !== label ? project.name : undefined)
    return [
      {
        id: sessionTabId(id),
        title: label,
        /**
         * The session's own sentence for why it is blocked, where it has one.
         *
         * Verbatim, and never matched against: it comes from whichever dialog
         * is on top - `"permission prompt"` and `"dialog open"` were the two
         * measured - so anything that tried to interpret it would be a second
         * parser of a string the CLI can change freely. It goes in the hint
         * rather than on the tab because 240px are already spoken for, and
         * because the dot has said the load-bearing half.
         */
        hint:
          live?.waitingFor === undefined || live.waitingFor === null
            ? `${label} · ${session.cwd}`
            : `${label} · ${session.cwd}\nWaiting: ${live.waitingFor}`,
        ...(subtitle === undefined ? {} : { subtitle }),
        // A branch is machine data and reads in mono (DESIGN.md); a project's
        // name is a name.
        subtitleMono: session.branch !== null,
        indicator,
        // A session tab lifts into the terminal's fixed ground, not the
        // island's - see Tab.ground.
        ground: 'terminal' as const,
        renamable: true
      }
    ]
  })

  const activeProject =
    activePane?.kind === 'project' ? (projectsByPath.get(activePane.path) ?? null) : null
  const selectedPath = activeProject?.path ?? null
  /**
   * The live sessions already in the project on screen - the launch warning.
   *
   * Reduced with core's own `liveSessionsIn`, which is `samePath`'s comparison,
   * so this and the sidebar's grouping cannot disagree about whether two paths
   * are one folder. Memoised on `selectedPath` rather than done inline in the
   * pane's props, so a project with nothing running in it hands `ProjectPane`
   * the same empty array on every render instead of a new one.
   */
  const liveHere = useMemo(
    () =>
      selectedPath === null ? EMPTY_LIVE : liveSessionsIn(machineSessions.sessions, selectedPath),
    [machineSessions.sessions, selectedPath]
  )
  // Kept for `openBrowser`, which runs long after this. Written in an effect
  // rather than during render because it is a ref: assigning one while
  // rendering is a write during the render phase, which React may discard.
  useEffect(() => {
    activePaneProjectRef.current = selectedPath
  }, [selectedPath])

  /**
   * Whether the open project is itself one of the scanned folders, which is
   * what decides whether its pane offers to remove it.
   *
   * Case-insensitively, like every other path comparison the window makes: the
   * root was typed into a picker and the project's path came out of a directory
   * listing, and two spellings of one Windows directory are one directory.
   *
   * A `useMemo` for a two-line comparison, and not for the cost of it.
   * `selectedPath` is what the shell drag's `useCallback` is keyed on, and
   * calling a method on it in the render body is enough for the React Compiler
   * to treat it as possibly mutated and give up preserving that memoization -
   * `react-hooks/preserve-manual-memoization`, an error in this repo. Inside a
   * memo whose dependencies it can see, the same lines are fine.
   */
  const activeProjectIsRoot = useMemo(
    () =>
      selectedPath !== null &&
      (settings?.scanRoots ?? []).some(
        (root) => root.toLowerCase() === selectedPath.toLowerCase()
      ),
    [settings, selectedPath]
  )

  /**
   * The harness the open project *is*, when it is one.
   *
   * Only its `template:` is wanted, and that lives on the harness discovery
   * built rather than on the project row. Found by path rather than carried
   * down from the row that was clicked, because the pane is also reached from a
   * tab restored across a restart, where no row was involved.
   *
   * A `useMemo` for the reason `activeProjectIsRoot` above is one, and it is
   * the same trap: calling `.toLowerCase()` on `selectedPath` in the render
   * body makes the React Compiler treat it as possibly mutated and give up on
   * the shell drag's memoization two hundred lines away.
   */
  const activeHarness = useMemo(
    () =>
      selectedPath === null
        ? null
        : (launcher.discovery?.harnesses.find(
            (harness) => harness.path.toLowerCase() === selectedPath.toLowerCase()
          ) ?? null),
    [launcher.discovery, selectedPath]
  )

  // -------------------------------------------------------------------------
  // The project shell's drag handle
  // -------------------------------------------------------------------------
  //
  // The setting is the state, and while a drag is in flight the DOM is ahead of
  // it: a `pointermove` sets the pane's height itself and `pointerup` writes it
  // once. Two things fall out of that and both are the point. A settings write
  // per frame is a database write per frame, which is what the criterion for
  // this feature forbids. And re-rendering the page sixty times a second to
  // move one edge would re-render the project pane and the terminal with it -
  // React state is the wrong home for a value in flight.
  //
  // The shell pane still renders its height from `savedShellHeight`, so once
  // the write lands React and the DOM agree on a value they already both hold
  // and nothing moves. That is also what makes the settings row and this handle
  // the same control rather than two that fight.
  const shellPaneRef = useRef<HTMLDivElement>(null)
  /**
   * Where inside the handle it was grabbed, and what the drag has reached.
   *
   * The grab offset is why the shell does not jump on the first move: the
   * pointer lands anywhere in the handle's 8px, and without remembering where,
   * the first `pointermove` would snap the top edge onto the pointer.
   */
  const shellGrab = useRef(0)
  const shellDragged = useRef<number | null>(null)

  /**
   * Pointer capture rather than the window listeners the session split's
   * divider uses. That divider predates this one and has the bug capture
   * exists to prevent: let go outside the window and no `mouseup` ever
   * arrives, so the drag is still running when the pointer comes back.
   */
  const startShellDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    shellGrab.current = event.clientY - event.currentTarget.getBoundingClientRect().bottom
    shellDragged.current = null
    document.body.style.userSelect = 'none'
  }, [])

  const moveShellDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const column = projectColumnRef.current
      const pane = shellPaneRef.current
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
      if (column === null || pane === null || selectedPath === null) return
      const box = column.getBoundingClientRect()
      if (box.height < 1) return

      const next = shellHeightFor(box, event.clientY - shellGrab.current)
      if (next === shellDragged.current) return
      shellDragged.current = next
      pane.style.height = `${String(next)}%`
      // The pane re-measures because the pane moved its own box - the same
      // contract `park` keeps in pterms.ts, and the same one the height effect
      // in ProjectShellPane keeps for every route that is not this one.
      //
      // Measured, so it is not claimed to be more than it is: `terminal.ts`
      // observes the container too, and a drag with this line taken out still
      // took the grid from 12 rows to 22 while the button was down. It stays
      // because the observer is the terminal's and this is the pane's: the
      // code that changed the box is the code that knows the grid is stale,
      // and `refit` tells the pty only when the answer actually changed.
      getShell(selectedPath)?.refit()
    },
    [selectedPath]
  )

  const endShellDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      document.body.style.userSelect = ''
      const landed = shellDragged.current
      shellDragged.current = null
      // One write for the whole gesture, and none at all for a pointer that
      // never moved: a click on the handle is not a decision about anything.
      if (landed !== null && landed !== savedShellHeight) {
        writeSettings({ projectShellHeightPct: landed })
      }
    },
    [savedShellHeight, writeSettings]
  )

  /**
   * Double-click puts it back to the third of the page it starts at.
   *
   * Written through the setting like any other change, and the pane's height
   * follows from the render rather than from here - a drag is the only thing
   * that gets to touch the style directly, because a drag is the only thing
   * that happens between two renders.
   */
  const resetShellHeight = useCallback(() => {
    writeSettings({ projectShellHeightPct: DEFAULT_SETTINGS.projectShellHeightPct })
  }, [writeSettings])
  const runningSessions = sessions.filter((session) => session.status === 'running').length
  /**
   * Which sidebar rows get a live dot, and what those sessions are called.
   *
   * The labels travel with the paths rather than the sidebar being handed a
   * count, so the row's tooltip names the sessions running there the same way
   * their tabs do - through `sessionLabel`, the one helper, so a renamed session
   * cannot be one thing in the strip and another in the tree.
   */
  const liveSessions = useMemo(() => {
    const byPath = new Map<string, string[]>()
    for (const session of sessions) {
      if (session.status !== 'running' || session.projectPath === null) continue
      const key = session.projectPath.toLowerCase()
      const names = byPath.get(key)
      if (names) names.push(sessionLabel(session))
      else byPath.set(key, [sessionLabel(session)])
    }
    return byPath
  }, [sessions])

  /**
   * "This session is still running", asked by the main process and answered
   * here. Main owns process lifetime, so it owns the question; the renderer
   * owns everything the user looks at, so it draws it.
   *
   * The answer is sent before the state clears, and only when a request is
   * actually pending: main matches replies by id, and a second reply to an id
   * it has already resolved is a reply for a decision that has been taken.
   */
  const [confirmRequest, setConfirmRequest] = useState<SessionConfirmRequest | null>(null)

  useEffect(() => helm.on('session:confirm', setConfirmRequest), [])

  const answerConfirm = useCallback(
    (agreed: boolean) => {
      if (confirmRequest === null) return
      helm.send('session:confirmed', { id: confirmRequest.id, agreed })
      setConfirmRequest(null)
    },
    [confirmRequest]
  )

  /**
   * Rendered by both branches below, for the same reason `harnessDialog` is -
   * and one more: main holds the window's `close` open on this promise, so a
   * branch that did not draw the dialog would be a branch Helm could not quit
   * from until the fallback timer ran out.
   */
  const confirmDialog =
    confirmRequest === null ? null : (
      <ConfirmSessionDialog
        kind={confirmRequest.kind}
        message={confirmRequest.message}
        detail={confirmRequest.detail}
        confirmLabel={confirmRequest.confirmLabel}
        sessionNames={confirmRequest.sessionNames}
        onConfirm={() => answerConfirm(true)}
        onCancel={() => answerConfirm(false)}
      />
    )

  /**
   * Rendered by both branches below. Creating a harness is a first-run action
   * and an every-day one, and having two copies of the dialog is how the two
   * would drift apart.
   */
  const harnessDialog =
    setup.dialog === null || templates.managerOpen ? null : (
      <NewHarnessDialog
        mode={setup.dialog}
        dir={setup.dialogDir}
        onChooseDir={setup.chooseDialogDir}
        distros={setup.distros}
        onModeChange={setup.setDialogMode}
        problems={setup.dialogProblems}
        busy={setup.creating}
        templates={setup.templates}
        template={setup.template}
        onTemplateChange={setup.chooseTemplate}
        templatesDir={setup.templatesDir}
        onManageTemplates={templates.openManager}
        templateProblems={setup.templateProblems}
        preview={setup.templatePreview}
        onCreate={setup.createHarness}
        onCancel={setup.closeDialog}
      />
    )

  /**
   * The template manager, and the dialog that freezes a folder into one.
   *
   * Rendered beside the harness dialog rather than inside it, and the harness
   * dialog is **withheld while this is up** - two `Overlay`s at once is two
   * scrims, and the second would dim the first. Withholding rather than closing
   * is what makes "Manage templates…" safe to press half way through filling
   * the harness dialog in: its name, folder and chosen template live in
   * `useSetup`, so closing the manager paints it back exactly as it was, with a
   * template list that has been re-read.
   */
  const templateDialogs =
    templates.saveDialog !== null ? (
      <SaveAsTemplateDialog
        kind={templates.saveDialog.kind}
        dir={templates.saveDialog.dir}
        {...(templates.saveDialog.kind === 'folder'
          ? { onChooseDir: templates.chooseSaveDir }
          : {})}
        preview={templates.savePreview}
        busy={templates.saveBusy}
        problems={templates.saveProblems}
        onSave={templates.save}
        onCancel={templates.closeSaveDialog}
      />
    ) : templates.managerOpen ? (
      <TemplateManager
        templates={templates.templates}
        templatesDir={templates.templatesDir}
        listProblems={templates.listProblems}
        selected={templates.selected}
        onSelect={templates.select}
        detail={templates.detail}
        scopes={templates.scopes}
        importScope={templates.importScope}
        onImportScopeChange={templates.setImportScope}
        importTree={templates.importTree}
        busy={templates.busy}
        problems={templates.problems}
        notice={templates.notice}
        onCreate={templates.create}
        onSaveMetadata={templates.saveMetadata}
        onDelete={templates.remove}
        onReveal={launcher.reveal}
        onMakeSubstitutable={templates.makeSubstitutable}
        onImport={templates.importFiles}
        onImportFolder={templates.openImportFolder}
        onClose={() => {
          templates.closeManager()
          // The harness dialog behind this may be showing a picker built before
          // a template was created, renamed or deleted. It re-reads on open and
          // has no other reason to; this is that other reason.
          setup.refreshTemplates()
        }}
      />
    ) : null

  /**
   * New, Rename and Delete for one entry in a `.claude` tree.
   *
   * Only one is ever open, so they share the busy flag and the error - and the
   * error is the dialog's own, because every refusal these three have is about
   * what was typed into the box that is still on screen. Rendered beside the
   * other modals rather than inside the console: a dialog nested in a pane that
   * a split can narrow to 119px is a dialog that gets clipped.
   */
  const configEntryDialog =
    configState.scope === null || configState.entryDialog === null ? null : configState
      .entryDialog === 'new' ? (
      <ConfigNewDialog
        scope={configState.scope}
        files={configState.tree?.files ?? []}
        busy={configState.entryBusy}
        error={configState.entryError}
        onCreate={configState.createFile}
        onCancel={() => configState.openEntryDialog(null)}
      />
    ) : configState.selected === null ? null : configState.entryDialog === 'rename' ? (
      <ConfigRenameDialog
        scope={configState.scope}
        file={configState.selected}
        files={configState.tree?.files ?? []}
        busy={configState.entryBusy}
        error={configState.entryError}
        onRename={configState.renameFile}
        onCancel={() => configState.openEntryDialog(null)}
      />
    ) : (
      <ConfigDeleteDialog
        file={configState.selected}
        files={configState.tree?.files ?? []}
        busy={configState.entryBusy}
        error={configState.entryError}
        onDelete={configState.deleteFile}
        onCancel={() => configState.openEntryDialog(null)}
      />
    )

  /**
   * Setup owns the whole window rather than sitting in a tab.
   *
   * There is nothing else to look at: no roots means no tree, no config scopes
   * and no content. A launcher painted empty behind a dismissible dialog would
   * be four broken surfaces framing the one that works.
   */
  if (setup.needed) {
    return (
      <div className="flex h-full w-full flex-col bg-bg text-fg">
        <TitleBar />
        <div className="min-h-0 flex-1">
          <SetupPane
            status={setup.status}
            roots={settings?.scanRoots ?? []}
            suggestions={setup.suggestions}
            projectCount={discovery?.projects.length ?? 0}
            scanning={launcher.scanning}
            checking={setup.checking}
            onRecheck={setup.recheck}
            onLocateClaude={setup.locateClaude}
            onAddFolder={launcher.addRoot}
            onAcceptSuggestion={setup.acceptSuggestion}
            onCreateHarness={() => setup.openDialog('new')}
            onConvertFolder={() => setup.openDialog('convert')}
            onFinish={setup.finish}
          />
        </div>
        {harnessDialog}
        {templateDialogs}
        {confirmDialog}
      </div>
    )
  }

  // A fact about the machine that qualifies the whole window: the CLI is
  // missing, or it is a version outside what this build was measured against.
  // It warns and does not gate - see `VersionBanner`.
  const versionWarning =
    setup.status !== null &&
    !setup.bannerDismissed &&
    (setup.status.path === null || setup.status.version === null || !setup.status.tested)

  return (
    <AppShell
      banner={
        versionWarning && setup.status ? (
          <VersionBanner
            version={setup.status.version}
            range={setup.status.testedRange}
            error={setup.status.error}
            onDismiss={setup.dismissBanner}
            onLocate={setup.locateClaude}
          />
        ) : null
      }
      sidebar={
        !showWorkspace ? null : (
        <Sidebar
          liveSessions={liveSessions}
          profiles={
            <ProfileList
              profiles={profileState.profiles}
              harnesses={discovery?.harnesses ?? []}
              launchingIds={profileState.launching}
              onLaunch={(profile) => void launchProfile(profile)}
              onCreate={() => {
                setSaveProblems([])
                setEditing(blankProfile(discovery?.roots[0] ?? '', ''))
              }}
              onEdit={(profile) => {
                setSaveProblems([])
                setEditing(profile)
              }}
              onDelete={deleteProfile}
              onExport={(profile) => void profileState.exportProfile(profile.id)}
              onImport={() => void profileState.importProfile()}
              onTogglePin={(profile) => void profileState.togglePin(profile)}
              onReorder={(ids) => void profileState.reorder(ids)}
            />
          }
          onOpenSessions={openSessions}
          sessionsDetail={sessionsSummaryLine}
          sessionsActive={activePane?.kind === 'sessions'}
          onOpenHistory={openHistory}
          {...(historyState.summary
            ? {
                historyCount: historyState.summary.sessions,
                historyResumable: historyState.summary.resumable
              }
            : {})}
          historyActive={activePane?.kind === 'history'}
          onOpenPulls={openPulls}
          pullsDetail={pullsSummaryLine(pullsState.snapshot)}
          pullsActive={activePane?.kind === 'pulls'}
          onOpenConfig={openConfig}
          configActive={activePane?.kind === 'config'}
          onOpenContent={openContent}
          contentActive={activePane?.kind === 'content'}
          discovery={discovery}
          scanning={launcher.scanning}
          scanError={launcher.scanError}
          selectedPath={selectedPath}
          pinnedPaths={settings?.pinnedProjects ?? DEFAULT_SETTINGS.pinnedProjects}
          onTogglePin={togglePin}
          onSelect={openProject}
          onRescan={launcher.rescan}
          onAddRoot={launcher.addRoot}
          onCreateHarness={() => setup.openDialog('new')}
        />
        )
      }
      titleActions={
        <>
          <ThemeToggle value={settings?.theme ?? 'system'} onChange={launcher.setTheme} />
          {/* Beside the toggle, because both are window-level: one is a setting
              with a shortcut in the chrome, the other is where every setting
              lives. A ghost button (DESIGN.md) - the segmented control next to
              it already carries an outline, and two bordered controls in a 36px
              strip read as a toolbar. */}
          <button
            type="button"
            data-open-settings
            onClick={openSettings}
            aria-label="Settings"
            title="Settings"
            className={cn(
              'grid size-7 shrink-0 place-items-center rounded-well transition-colors',
              activePane?.kind === 'settings'
                ? 'bg-hover text-fg'
                : 'text-fg-subtle hover:bg-hover hover:text-fg'
            )}
          >
            <GearIcon width={14} height={14} />
          </button>
        </>
      }
      statusBar={
        <StatusBar
          // The mode is shown only when this copy is not an ordinary install.
          // `dev`, `dev · live` and `portable` all change what the binary is and
          // where the data lives, so they are worth a word; an installed build
          // is the case that needs none, and labelling it only adds a segment
          // every user reads once.
          build={
            info === null
              ? '…'
              : info.mode === 'installed'
                ? info.version
                : `${info.version} · ${MODE_LABEL[info.mode]}`
          }
          // From the setup status, not from `app:info`. `app:info` is read once
          // at startup, so after the CLI is relocated the strip would keep
          // naming the old version while the banner above it names the new one
          // - two numbers on screen at once, both claiming to be `claude`.
          claudeVersion={setup.status?.version ?? info?.claudeVersion ?? null}
          scanning={launcher.scanning}
          runningSessions={runningSessions}
          usage={usage}
          usageDisplay={settings?.usageDisplay ?? 'percent'}
          onUsageDisplayChange={launcher.setUsageDisplay}
          update={update}
          onOpenUpdate={(url) => void helmOpenExternal(url)}
          lastScan={
            discovery && discovery.durationMs > 0
              ? {
                  projects: discovery.projects.length,
                  durationMs: discovery.durationMs,
                  at: discovery.scannedAt
                }
              : null
          }
        />
      }
    >
      <div ref={splitRowRef} className="split-row relative flex h-full w-full">
        {showWorkspace && (
          <div className={cn('flex min-w-0 flex-col', showSessions ? 'split-workspace' : 'split-whole')}>
            <TabBar
              tabs={tabs}
              activeId={activeId}
              onActivate={setRequestedId}
              onClose={closeTab}
              onReorder={reorderTabs}
              // A native view paints over the drop indicator and the dragged
              // tab's ghost, so it stands down for the length of the gesture.
              onDragging={browsers.setSuppressed}
              actions={
                <>
                  {/* The general way in. Beside the maximize control because
                      both are about the strip rather than about a pane. */}
                  <button
                    type="button"
                    data-open-browser
                    onClick={() => openBrowser()}
                    aria-label="New browser tab"
                    title="New browser tab"
                    className="grid size-6 place-items-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
                  >
                    <GlobeIcon width={13} height={13} />
                  </button>
                  {hasSessions ? (
                    <PaneMaxButton
                      maximized={effectiveMaximize === 'workspace'}
                      what="workspace"
                      onToggle={() =>
                        setMaximize((current) => (current === 'workspace' ? null : 'workspace'))
                      }
                    />
                  ) : null}
                </>
              }
            />
            <div ref={paneRef} className="relative min-h-0 flex-1 overflow-hidden">
        {activePane?.kind === 'history' && (
          <div className="absolute inset-0">
            <SessionHistory
              summary={historyState.summary}
              page={historyState.page}
              loading={historyState.loading}
              error={historyState.error}
              search={historyState.search}
              onSearchChange={historyState.setSearch}
              scope={historyState.scope}
              onScopeChange={historyState.setScope}
              archiveStats={historyState.archiveStats}
              grouping={historyState.grouping}
              onGroupingChange={historyState.setGrouping}
              resumableOnly={historyState.resumableOnly}
              onResumableOnlyChange={historyState.setResumableOnly}
              project={historyState.project}
              onProjectChange={historyState.setProject}
              selected={historyState.selected}
              onSelect={historyState.select}
              prompts={historyState.prompts}
              promptsLoading={historyState.promptsLoading}
              conversation={historyState.conversation}
              conversationLoading={historyState.conversationLoading}
              onRename={(sessionId, name) => void historyState.rename(sessionId, name)}
              onRefresh={historyState.refresh}
              refreshing={historyState.refreshing}
              onResume={(session) => void resumeSession(session)}
              resuming={historyState.resuming}
              resumeError={historyState.resumeError}
              onDismissResumeError={historyState.dismissResumeError}
              onReveal={launcher.reveal}
              compact={showSessions}
            />
          </div>
        )}

        {activePane?.kind === 'sessions' && (
          <div className="absolute inset-0">
            <SessionsPane
              sessions={machineSessions.sessions}
              readAtMs={machineSessions.readAtMs}
              records={sessionsById}
              resources={machineSessions.resources}
              selectedPid={selectedLivePid}
              onSelect={(session) => setSelectedLivePid(session?.pid ?? null)}
              // Bringing the terminal forward is the one thing this pane does
              // *to* a session. It maximizes nothing and closes nothing: the
              // pane is for looking, and the tab is where a session is worked.
              onOpenSession={activateSession}
              onReveal={launcher.reveal}
              compact={showSessions}
            />
          </div>
        )}

        {activePane?.kind === 'pulls' && (
          <div className="absolute inset-0">
            <PullsPane
              snapshot={pullsState.snapshot}
              onRefresh={pullsState.refresh}
              refreshing={pullsState.refreshing}
              error={pullsState.error}
              onOpenPull={openPull}
              // The reveal direction only. Ignoring is done in Settings, where
              // the setting lives; this is the undo standing beside the thing
              // it undoes.
              onUnignoreRepo={unignoreRepo}
              // The one piece of this pane's triage that is a preference. The
              // filter and the grouping beside it are the pane's own state and
              // are deliberately nowhere near settings.
              staleDays={settings?.prStaleDays ?? DEFAULT_SETTINGS.prStaleDays}
              compact={showSessions}
            />
          </div>
        )}

        {activePane?.kind === 'pr' && (
          <div className="absolute inset-0">
            <PullRequestTab
              // Keyed on the tab, so switching between two pull request tabs
              // rebuilds the pane rather than leaving one PR's view selected
              // over another's conversation.
              key={tabId(activePane)}
              repoPath={activePane.repoPath}
              number={activePane.number}
              reviewTemplate={settings?.prReviewPrompt ?? DEFAULT_SETTINGS.prReviewPrompt}
              checkout={settings?.prCheckout ?? DEFAULT_SETTINGS.prCheckout}
              reviewModel={settings?.prReviewModel ?? DEFAULT_SETTINGS.prReviewModel}
              reviewEffort={settings?.prReviewEffort ?? DEFAULT_SETTINGS.prReviewEffort}
              onReview={reviewPull}
              onOpenExternal={(url) => void helmOpenExternal(url)}
              compact={showSessions}
            />
          </div>
        )}

        {activePane?.kind === 'config' && (
          <div className="absolute inset-0">
            <ConfigConsole
              scopes={configState.scopes}
              scopePath={configState.scopePath}
              onScopeChange={configState.setScopePath}
              view={configState.view}
              onViewChange={configState.setView}
              tree={configState.tree}
              treeLoading={configState.treeLoading}
              live={configState.live}
              selected={configState.selected}
              onSelect={configState.select}
              dirty={configState.dirty}
              onRefresh={configState.refresh}
              refreshing={configState.refreshing}
              compact={showSessions}
              onBack={() => configState.select(null)}
              onNew={
                configState.scope === null
                  ? undefined
                  : () => configState.openEntryDialog('new')
              }
              notice={
                configState.deleted === null ? null : (
                  <ConfigDeletedNotice
                    label={configState.deleted.label}
                    fileCount={configState.deleted.files.length}
                    busy={configState.entryBusy}
                    onUndo={configState.undoDelete}
                    onDismiss={configState.dismissDeleted}
                  />
                )
              }
            >
              {configState.view === 'files' ? (
                configState.selected === null ? (
                  <ConfigNothingSelected
                    scope={configState.scope}
                    fileCount={configState.tree?.files.length ?? 0}
                  />
                ) : (
                  <ConfigEditor
                    // Keyed on the path so switching files rebuilds the editor
                    // rather than leaving one file's draft in another's box.
                    key={configState.selected.path}
                    file={configState.selected}
                    loaded={configState.loaded}
                    rendered={configState.rendered}
                    live={configState.live}
                    siblings={configState.tree?.files ?? []}
                    snapshots={configState.snapshots}
                    saving={configState.saving}
                    error={configState.editorError}
                    external={configState.external}
                    onSave={configState.save}
                    onReload={configState.reload}
                    onRestore={configState.restore}
                    onReveal={launcher.reveal}
                    onOpenPath={configState.openPath}
                    onOpenExternal={openLink}
                    onDirtyChange={configState.setDirty}
                    onHighlight={helmHighlight}
                    onRename={() => configState.openEntryDialog('rename')}
                    onDelete={() => configState.openEntryDialog('delete')}
                    justCreated={configState.selected.path === configState.createdPath}
                  />
                )
              ) : configState.view === 'effective' ? (
                <EffectiveViewPane
                  profiles={profileState.profiles}
                  profileId={configState.effectiveProfileId}
                  onProfileChange={configState.setEffectiveProfileId}
                  cwd={configState.effectiveCwd}
                  onCwdChange={configState.setEffectiveCwd}
                  view={configState.effective}
                  loading={configState.effectiveLoading}
                  error={configState.effectiveError}
                  onReveal={launcher.reveal}
                  onOpenFile={configState.openPath}
                />
              ) : configState.view === 'mcp' ? (
                <McpPanel
                  cwd={
                    configState.scope?.kind === 'user'
                      ? (configState.scopes.find((s) => s.kind !== 'user')?.path ?? '')
                      : (configState.scope?.path ?? '')
                  }
                  servers={configState.mcpServers}
                  listing={configState.mcpListing}
                  listing_busy={configState.mcpListing_busy}
                  onList={configState.runMcpList}
                  draft={configState.mcpDraft}
                  onDraftChange={configState.setMcpDraft}
                  preview={configState.mcpPreview}
                  onPreview={configState.requestMcpPreview}
                  onApply={configState.applyMcp}
                  onCancelPreview={configState.cancelMcpPreview}
                  applying={configState.mcpApplying}
                  result={configState.mcpResult}
                  onDismissResult={configState.dismissMcpResult}
                  onRemove={configState.removeMcp}
                  onApprove={configState.approveMcp}
                  onOpenFile={configState.openPath}
                />
              ) : (
                <HealthPanel
                  report={configState.doctor}
                  running={configState.doctorRunning}
                  onRun={configState.runDoctor}
                  claudeVersion={info?.claudeVersion ?? null}
                  // Derived from the scope's path, which is the whole rule: a
                  // `\\wsl$\<distro>\...` scope is served by that
                  // distribution's Claude Code, and the panel says so rather
                  // than reporting on this machine's under a heading that
                  // claims to be about the CLI sessions here actually use.
                  distro={wslDistroOf(configState.scope?.path ?? '')}
                />
              )}
            </ConfigConsole>
          </div>
        )}

        {activePane?.kind === 'content' && (
          <div className="absolute inset-0">
            <ContentViewer
              scopes={contentState.scopes}
              scopePath={contentState.scopePath}
              onScopeChange={contentState.setScopePath}
              tree={contentState.tree}
              treeLoading={contentState.treeLoading}
              view={contentState.view}
              onViewChange={contentState.setView}
              viewIsDefault={contentState.viewIsDefault}
              dirs={contentState.dirs}
              expanded={contentState.expanded}
              onToggleDir={contentState.toggleDir}
              loadingDirs={contentState.loadingDirs}
              query={contentState.query}
              onQueryChange={contentState.setQuery}
              search={contentState.search}
              searching={contentState.searching}
              selected={contentState.selected}
              selectedPath={contentState.selectedPath}
              onSelect={contentState.select}
              onOpenPath={contentState.openPath}
              onReveal={launcher.reveal}
              dirty={contentState.dirty}
              onRefresh={contentState.refresh}
              refreshing={contentState.refreshing}
              compact={showSessions}
              onBack={() => contentState.select(null)}
            >
              {contentState.selected === null ? (
                <ContentNothingSelected
                  scope={contentState.scope}
                  view={contentState.view}
                  fileCount={contentState.tree?.files.length ?? 0}
                />
              ) : (
                <ContentDocumentPane
                  // Keyed on the path so opening another note rebuilds the
                  // pane rather than leaving one document's draft in another's
                  // editor - the same rule the config editor follows.
                  key={contentState.selected.path}
                  file={contentState.selected}
                  document={contentState.document}
                  preview={contentState.preview}
                  previewPending={contentState.previewPending}
                  mode={contentState.mode}
                  onModeChange={contentState.setMode}
                  artifactUrl={contentState.artifactUrl}
                  artifactConsole={contentState.artifactConsole}
                  snapshots={contentState.snapshots}
                  saving={contentState.saving}
                  error={contentState.error}
                  external={contentState.external}
                  highlight={contentState.highlight}
                  wrapDefault={settings?.contentWrap ?? DEFAULT_SETTINGS.contentWrap}
                  wrapIndent={settings?.contentWrapIndent ?? DEFAULT_SETTINGS.contentWrapIndent}
                  onHighlight={helmHighlight}
                  onSave={contentState.save}
                  onReload={contentState.reload}
                  onRestore={contentState.restore}
                  onReveal={launcher.reveal}
                  onDirtyChange={contentState.setDirty}
                  onDraftChange={contentState.setDraft}
                  onOpenPath={contentState.openPath}
                  onOpenWikilink={contentState.openWikilink}
                  onOpenExternal={openLink}
                />
              )}
            </ContentViewer>
          </div>
        )}

        {activePane?.kind === 'browser' &&
          (() => {
            const view = browserViews.get(activePane.id)
            if (!view) return null
            return (
              <div className="absolute inset-0">
                <BrowserPane
                  // Keyed on the view, so switching between two browser tabs
                  // rebuilds the bar rather than leaving one page's address in
                  // the other's box for a frame.
                  key={view.id}
                  state={view}
                  entries={browsers.entries.get(view.id) ?? EMPTY_CONSOLE}
                  recent={browsers.recent}
                  focusAddressAt={focusAddressAt}
                  onBounds={(rect) => browsers.sendBounds(view.id, rect, true)}
                  onNavigate={(input) => browsers.navigate(view.id, input)}
                  onBack={() => browsers.back(view.id)}
                  onForward={() => browsers.forward(view.id)}
                  onReload={(hard) => browsers.reload(view.id, hard)}
                  onDevTools={() => browsers.devtools(view.id)}
                  onOpenExternal={(url) => void helmOpenExternal(url)}
                  onFind={(query, forward) => browsers.find(view.id, query, forward)}
                  onStopFind={() => browsers.stopFind(view.id)}
                  onZoom={(level) => browsers.zoom(view.id, level)}
                  onClearStorage={() => browsers.clearStorage(view.id)}
                  onEvaluate={(source) => browsers.evaluate(view.id, source)}
                  // The address dropdown hangs over the page; the view stands
                  // down for it, the same way it does for a tab drag.
                  onCovering={browsers.setSuppressed}
                />
              </div>
            )
          })()}

        {activePane?.kind === 'settings' && (
          <div className="absolute inset-0">
            <SettingsWithWsl
              status={setup.status}
              checking={setup.checking}
              onRecheck={setup.recheck}
              onLocateClaude={setup.locateClaude}
              onClearClaudeOverride={launcher.clearClaudePath}
              roots={settings?.scanRoots ?? []}
              projectCount={discovery?.projects.length ?? 0}
              scanning={launcher.scanning}
              onAddRoot={launcher.addRoot}
              onRemoveRoot={launcher.removeRoot}
              // Anything already scanned is not a suggestion, and the filter is
              // here rather than in the component so the pane renders a list
              // rather than deciding what belongs in one.
              suggestedRoots={setup.suggestions.filter(
                (suggestion) =>
                  !(settings?.scanRoots ?? []).some(
                    (root) => root.toLowerCase() === suggestion.toLowerCase()
                  )
              )}
              onAcceptRoot={setup.acceptSuggestion}
              pinnedProjects={settings?.pinnedProjects ?? DEFAULT_SETTINGS.pinnedProjects}
              // The same writer the sidebar's star goes through, so the two
              // surfaces cannot hold different ideas of what is pinned.
              onUnpinProject={togglePin}
              theme={settings?.theme ?? 'system'}
              onThemeChange={launcher.setTheme}
              usageDisplay={settings?.usageDisplay ?? 'percent'}
              updateCheck={settings?.updateCheck ?? DEFAULT_SETTINGS.updateCheck}
              onUpdateCheckChange={(updateCheck) => writeSettings({ updateCheck })}
              onUsageDisplayChange={launcher.setUsageDisplay}
              appVersion={info?.version ?? null}
              // From `app:info` rather than from a check's result: the states
              // that produce no result are exactly the ones where somebody
              // wants this link.
              releasesUrl={info?.releasesUrl ?? null}
              // `attempted`, not `answered` - see the narrowing above the
              // status bar's `update`.
              update={check.attempted}
              updateChecking={check.checking}
              onCheckForUpdate={check.check}
              onOpenReleases={() => {
                if (info?.releasesUrl !== undefined) void helmOpenExternal(info.releasesUrl)
              }}
              // The same fact the status bar's cycle turns on, from the same
              // snapshot, so the pane cannot offer a mode the segment skips.
              hasCostEstimate={usage?.spend != null}
              terminal={terminalSettings}
              onTerminalChange={launcher.writeSettings}
              // The stack the terminals are actually running, so the preview
              // well cannot show a font the panes are not using.
              terminalFontStack={terminalFontStack(terminalSettings.terminalFontFamily)}
              shells={shells}
              onLocateShell={locateShell}
              // The archive's own figures, out of the same state the history
              // pane reads them from - one subscription to `archive:changed`,
              // so the pane and the settings group cannot disagree about how
              // much is stored.
              archiveStats={historyState.archiveStats}
              transcriptArchiveMaxBytes={
                settings?.transcriptArchiveMaxBytes ?? DEFAULT_SETTINGS.transcriptArchiveMaxBytes
              }
              // The authored templates, so the built-in Minimal row does not
              // make an empty templates folder read as one that has something
              // in it. Read on mount here rather than only when the manager
              // opens - this is a figure on a pane somebody scrolls past.
              templateCount={templates.templates.filter((choice) => !choice.builtIn).length}
              templatesDir={templates.templatesDir}
              onManageTemplates={templates.openManager}
              onRevealTemplates={() => launcher.reveal(templates.templatesDir)}
              browserReach={settings?.browserReach ?? DEFAULT_SETTINGS.browserReach}
              onBrowserReachChange={(browserReach) => writeSettings({ browserReach })}
              browserMcp={settings?.browserMcp ?? DEFAULT_SETTINGS.browserMcp}
              onBrowserMcpChange={(browserMcp) => writeSettings({ browserMcp })}
              browserMcpLocalOnly={
                settings?.browserMcpLocalOnly ?? DEFAULT_SETTINGS.browserMcpLocalOnly
              }
              onBrowserMcpLocalOnlyChange={(browserMcpLocalOnly) =>
                writeSettings({ browserMcpLocalOnly })
              }
              sessionMcp={settings?.sessionMcp ?? DEFAULT_SETTINGS.sessionMcp}
              onSessionMcpChange={(sessionMcp) => writeSettings({ sessionMcp })}
              // The WSL group's state is not passed from here at all. It is
              // mounted with the pane by `SettingsWithWsl`, which is what makes
              // its two reads happen on every open rather than once per window
              // - see that file for the two bugs that were.
              //
              // Nothing about it is a row in `app_settings`, deliberately:
              // `networkingMode` lives in the user's own `.wslconfig` and is
              // machine-wide, so Helm keeps no copy of it that could disagree
              // with the file. The group reads that file and writes that file.
              contentWrap={settings?.contentWrap ?? DEFAULT_SETTINGS.contentWrap}
              onContentWrapChange={(contentWrap) => writeSettings({ contentWrap })}
              contentWrapIndent={
                settings?.contentWrapIndent ?? DEFAULT_SETTINGS.contentWrapIndent
              }
              onContentWrapIndentChange={(contentWrapIndent) =>
                writeSettings({ contentWrapIndent })
              }
              onTranscriptArchiveMaxBytesChange={(transcriptArchiveMaxBytes) =>
                writeSettings({ transcriptArchiveMaxBytes })
              }
              // What `gh` actually resolved to, out of the same snapshot the
              // Pulls pane paints - so the pane cannot report one executable
              // while the fetches use another.
              gh={pullsState.snapshot?.gh ?? null}
              onLocateGh={locateGh}
              onClearGhOverride={() => writeSettings({ ghPath: null })}
              prPollMinutes={settings?.prPollMinutes ?? DEFAULT_SETTINGS.prPollMinutes}
              onPrPollMinutesChange={(prPollMinutes) => writeSettings({ prPollMinutes })}
              prStaleDays={settings?.prStaleDays ?? DEFAULT_SETTINGS.prStaleDays}
              onPrStaleDaysChange={(prStaleDays) => writeSettings({ prStaleDays })}
              // Built from the snapshot rather than from the setting, because
              // the choices are the repositories discovery found - and it is
              // the same snapshot the Pulls pane paints, so the two surfaces
              // cannot disagree about which repositories exist.
              prRepos={pullRepoChoices(
                pullsState.snapshot?.repos ?? [],
                pullsState.snapshot?.ignored ?? []
              )}
              onPrIgnoredReposChange={(prIgnoredRepos) => writeSettings({ prIgnoredRepos })}
              // The review launch's two settings live here rather than in the
              // Pulls pane's header: settings for Helm are in one place, and a
              // disclosure strip inside a pane is a second place for one to
              // hide. The pane shows the *result* of these - the exact command
              // and prompt - which is disclosure, not configuration.
              prReviewPrompt={settings?.prReviewPrompt ?? DEFAULT_SETTINGS.prReviewPrompt}
              onPrReviewPromptChange={(prReviewPrompt) => writeSettings({ prReviewPrompt })}
              prCheckout={settings?.prCheckout ?? DEFAULT_SETTINGS.prCheckout}
              onPrCheckoutChange={(prCheckout) => writeSettings({ prCheckout })}
              prReviewModel={settings?.prReviewModel ?? DEFAULT_SETTINGS.prReviewModel}
              onPrReviewModelChange={(prReviewModel) => writeSettings({ prReviewModel })}
              prReviewEffort={settings?.prReviewEffort ?? DEFAULT_SETTINGS.prReviewEffort}
              onPrReviewEffortChange={(prReviewEffort) => writeSettings({ prReviewEffort })}
            />
          </div>
        )}

        {activeProject && (
          // No `gap-2`: the handle below is the gutter, exactly as the session
          // split's divider is the gutter of its row. Two children with a gap
          // and a handle between them would be 8px of nothing either side of it.
          <div ref={projectColumnRef} className="absolute inset-0 flex flex-col">
            <div className="min-h-0 flex-1">
              <ProjectPane
                key={activeProject.path}
                project={activeProject}
                harness={activeHarness}
                onReveal={launcher.reveal}
                onLaunch={(project) => void launch(project)}
                launching={launching}
                launchError={sessionState.launchError}
                liveHere={liveHere}
                onSaveAsProfile={(project) => {
                  setSaveProblems([])
                  // Seeded with what is on screen: this project as the root, and
                  // itself composed, which is the launch the button is beside.
                  setEditing({
                    ...blankProfile(project.path, project.name),
                    overlays: [project.path],
                    access: [project.path]
                  })
                }}
                onOpenConfig={openConfigAt}
                onOpenContent={openContentAt}
                // A harness only. It is the one kind of project with a layout
                // to freeze - a repo is somebody else's tree, and a folder is
                // not a scaffold. Decided here rather than in the pane for the
                // reason `onRemoveRoot` is: the pane is handed a project, and
                // whether that project is a harness root is discovery's answer.
                {...(activeHarness !== null
                  ? { onSaveAsTemplate: (project: Project) => templates.openSaveAs(project.path) }
                  : {})}
                // Only where this project *is* a scan root, which is the whole
                // of what removal can act on. Decided here rather than in the
                // pane because a root is a setting and the pane is handed
                // discovery; see `activeProjectIsRoot`.
                {...(activeProjectIsRoot
                  ? {
                      onRemoveRoot: (project: Project) => {
                        // The shell goes with the pane, exactly as it does in
                        // `closeTab`. Removing a folder takes it out of
                        // discovery, which drops its pane from `openPanes`
                        // without going through the close button - so nothing
                        // else is going to end the pty, and it would sit in the
                        // registry with no tab in front of it until Helm quits.
                        // Measured: settings-check's shell registry still held
                        // a removed folder's shell three groups later.
                        void disposeShell(project.path)
                        launcher.removeRoot(project.path)
                      }
                    }
                  : {})}
                                // The whole snapshot, not this project's slice of it. The pane
                // reduces it itself (`projectPulls`), so the project page and
                // the Pulls pane read one answer rather than two - and the
                // ignore list, which is structurally absent from `repos`, is
                // still reachable to say that it is what is hiding the rows.
                pulls={pullsState.snapshot}
                onOpenPull={openPull}
                onRefreshPulls={pullsState.refresh}
                onUnignoreRepo={unignoreRepo}
              />
            </div>
            {/* The project's own shell, in the project's own directory. Its
                process and scrollback live in pterms.ts and outlive every
                render of this.

                It used to be dropped while the session split was open, on the
                reasoning that the space belonged to the session then. The space
                is not the session's - the session has its own column - so what
                that actually did was take the shell away at the exact moment a
                second terminal is most useful, and leave the project pane's own
                column ending in dead space.

                Keyed by path for the reason ProjectPane above it is: this is
                one project's shell, and handing the same component a different
                project made it re-mount someone else's terminal into a box that
                still held the last one. */}
            {/* The shell's drag handle, living in the gutter it replaces.
                Dragging up grows the shell, down shrinks it, double-click puts
                it back to the default.

                `cursor: ns-resize`, and it is a `separator` rather than a
                button. `pnpm affordance-check` asserts `cursor: pointer` on
                every *control* it can reach - buttons, links, selects, tabs,
                checkboxes - and a separator is not one, so this sits outside
                that claim by what it is rather than by an exemption granted to
                it. Making it a pointer to satisfy the walk would be adopting a
                wrong cursor to please a checker, and DESIGN.md already records
                the cursor being asked to carry more of an argument than it
                should. What the walk does say about it is AFF-6, which is the
                converse claim over the set the pointer rule does not cover: a
                separator has to compute the resize cursor its own orientation
                calls for, and a `ns-resize` on the vertical divider or a
                `default` here would be caught there. */}
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize the shell"
              title="Drag to resize the shell, double-click to reset"
              onPointerDown={startShellDrag}
              onPointerMove={moveShellDrag}
              onPointerUp={endShellDrag}
              onPointerCancel={endShellDrag}
              onDoubleClick={resetShellHeight}
              className="group flex h-2 shrink-0 cursor-ns-resize items-center justify-center"
            >
              {/* The session split's divider recipe, rotated: a 3px
                  `border-strong` grip that goes accent on hover (DESIGN.md
                  "Split view"). The grip is a mark and the row is the target -
                  the whole 8px is draggable.

                  It was a full-width hairline first, which is what a horizontal
                  divider wants to be. The screenshot says otherwise: the gutter
                  is 8px, so a line down the middle of it lands 4px under the
                  project pane's bottom edge and 4px above the shell's top one,
                  and three hairlines in nine pixels read as a doubled border
                  rather than as something to hold. */}
              <span className="h-[3px] w-10 rounded-full bg-border-strong transition-colors group-hover:bg-accent" />
            </div>
            <ProjectShellPane
              key={activeProject.path}
              ref={shellPaneRef}
              path={activeProject.path}
              windowsBuild={info?.windowsBuild ?? null}
              visible
              shells={shells}
              heightPct={savedShellHeight}
            />
          </div>
        )}

        {activePane === null && (
          <div className="absolute inset-0">
            <WelcomePane
              roots={settings?.scanRoots ?? []}
              projectCount={discovery?.projects.length ?? 0}
              onAddRoot={launcher.addRoot}
              onCreateHarness={() => setup.openDialog('new')}
            />
          </div>
        )}
            </div>
          </div>
        )}

        {showWorkspace && showSessions && (
          <div
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize"
            onMouseDown={(event) => {
              event.preventDefault()
              draggingSplit.current = true
              document.body.style.userSelect = 'none'
            }}
            className="group flex w-2 shrink-0 cursor-col-resize items-center justify-center"
          >
            <span className="h-10 w-[3px] rounded-full bg-border-strong transition-colors group-hover:bg-accent" />
          </div>
        )}

        {showSessions && (
          <div className={cn('flex min-w-0 flex-col', showWorkspace ? 'split-sessions' : 'split-whole')}>
            <TabBar
              tabs={sessionTabs}
              activeId={activeSessionId === null ? null : sessionTabId(activeSessionId)}
              onActivate={(id) => setRequestedSession(sessionIdFromTab(id))}
              onClose={(id) => closeSession(sessionIdFromTab(id))}
              onReorder={reorderSessions}
              onRename={(id, label) => void sessionState.rename(sessionIdFromTab(id), label)}
              actions={
                <PaneMaxButton
                  maximized={effectiveMaximize === 'sessions'}
                  what="session"
                  onToggle={() =>
                    setMaximize((current) => (current === 'sessions' ? null : 'sessions'))
                  }
                />
              }
            />
            <div className="relative min-h-0 flex-1 overflow-hidden">
              {/* Every terminal stays mounted and only the active one is shown.
                  Unmounting a pane to switch tabs would take the session's
                  scrollback with it, and re-attaching a live pty to a fresh
                  terminal cannot recover what has already scrolled past. */}
              {sessionIds.map((id) => {
                const session = sessionsById.get(id)
                if (!session) return null
                const visible = id === activeSessionId
                return (
                  <div
                    key={id}
                    className={cn('absolute inset-0', visible ? 'block' : 'hidden')}
                    aria-hidden={!visible}
                  >
                    <TerminalPane
                      session={session}
                      active={visible}
                      windowsBuild={info?.windowsBuild ?? null}
                      onClose={closeSession}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {harnessDialog}
        {templateDialogs}
        {confirmDialog}
        {configEntryDialog}

        {/* What a launch composed, and anything that went wrong doing it.
            Over the pane rather than in it, because a profile is launched from
            the sidebar and whatever is on screen at the time is unrelated.

            At the top, not the bottom: the pane below is usually a hosted TUI
            whose composer and status line live along its bottom edge, and a
            toast there covers the one part of the terminal the user is about to
            type into.

            A browser refusal that produced no tab shares it, and that is the
            reason it is here rather than in the pane: there is no pane. The
            tab cap's sentence had been reachable and painted nowhere at all,
            so "Helm holds at most ten browser tabs" was a click that did
            nothing. Anything that *did* produce a tab says so on that tab's own
            problem line instead - see `failed` in `useBrowsers`. */}
        {(profileState.notice !== null ||
          profileState.error !== null ||
          browsers.error !== null) && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center p-3">
            {/*
              Two elements for one island, and the outer one is the fix rather
              than the frame: `bg-danger/10` is a *tint*, and a tint over a
              transparent container is a tint over whatever is behind it. This
              toast is drawn at the top of the workspace column, which is where
              the tab strip is - so the error variant had the tab labels showing
              through the sentence and was unreadable at the moment it had
              something to say. The notice variant never showed it, because
              `bg-surface` is opaque. So: an opaque ground here, and the tint
              composited onto it there, which is the same two layers every other
              danger surface in the app gets for free by sitting on a pane.
            */}
            <div className="pointer-events-auto max-w-2xl overflow-hidden rounded-raised bg-surface shadow-panel">
              <div
                role="status"
                className={cn(
                  'flex items-start gap-3 rounded-raised border px-3 py-2 text-[12px]',
                  profileState.error !== null || browsers.error !== null
                    ? 'border-danger/30 bg-danger/10 text-danger'
                    : 'border-border text-fg-muted'
                )}
              >
                <span className="min-w-0">
                  {browsers.error ?? profileState.error ?? profileState.notice}
                </span>
                <button
                  type="button"
                  onClick={
                    browsers.error !== null
                      ? browsers.dismissError
                      : profileState.error !== null
                        ? profileState.dismissError
                        : profileState.dismissNotice
                  }
                  aria-label="Dismiss"
                  className="shrink-0 text-fg-subtle hover:text-fg"
                >
                  ×
                </button>
              </div>
            </div>
          </div>
        )}

        {editing !== null && (
          <ProfileEditor
            initial={editing}
            projects={discovery?.projects ?? []}
            distros={distros}
            predict={predictProfile}
            problems={saveProblems}
            saving={saving}
            onSave={(draft) => void saveProfile(draft)}
            onCancel={() => setEditing(null)}
            // Only for a profile that exists. The same call the list's trash
            // icon makes; the editor closes because the row it edits is gone.
            {...('id' in editing
              ? {
                  onDelete: () => {
                    deleteProfile(editing)
                    setEditing(null)
                  }
                }
              : {})}
          />
        )}
      </div>
    </AppShell>
  )
}

/** The ⤢ / ⇱ at the end of each strip: give this pane the whole row, or give
 * the split back. */
function PaneMaxButton({
  maximized,
  what,
  onToggle
}: {
  maximized: boolean
  what: 'workspace' | 'session'
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      data-maximize={what}
      title={maximized ? 'Restore the split' : `Maximize the ${what} pane`}
      aria-label={maximized ? 'Restore the split' : `Maximize the ${what} pane`}
      onClick={onToggle}
      className="grid size-6 place-items-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
    >
      {maximized ? '⇱' : '⤢'}
    </button>
  )
}

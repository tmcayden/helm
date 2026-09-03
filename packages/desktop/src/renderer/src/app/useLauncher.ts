import { useCallback, useEffect, useState } from 'react'
import type {
  AppSettings,
  CachedProject,
  DiscoveryResult,
  Project,
  ThemePreference,
  UsageDisplayMode
} from '@helm/core'
import type { AppInfo, ResolvedTheme } from '../../../shared/ipc'
import { helm } from './bridge'
import { applyTerminalSettings } from './termprefs'

/**
 * All of the launcher's state, in one hook.
 *
 * The order matters more than the shape: the cache paints first, a scan
 * replaces it when it lands, and git refreshes on its own afterwards. A window
 * that waits for a full scan before drawing anything spends its first second
 * blank on a machine with eleven repos, and considerably longer on one with a
 * hundred.
 */

export interface LauncherState {
  info: AppInfo | null
  settings: AppSettings | null
  discovery: DiscoveryResult | null
  scanning: boolean
  scanError: string | undefined
  selected: Project | null
  select: (project: Project | null) => void
  rescan: () => void
  /** Opens the folder picker. `startIn` opens it inside a distribution. */
  addRoot: (startIn?: string) => void
  removeRoot: (path: string) => void
  setTheme: (theme: ThemePreference) => void
  setUsageDisplay: (mode: UsageDisplayMode) => void
  /** Forgets a hand-picked `claude`, back to whatever discovery finds. */
  clearClaudePath: () => void
  reveal: (path: string) => void
  /** Any subset of the settings, for a pane that owns several of them. */
  writeSettings: (patch: Partial<AppSettings>) => void
}

/** Turns cached rows into something the tree can render before a scan runs. */
function discoveryFromCache(cached: CachedProject[], roots: string[]): DiscoveryResult | null {
  if (cached.length === 0) return null
  return {
    roots,
    harnesses: cached
      .filter((p) => p.kind === 'harness')
      .map((p) => ({
        path: p.path,
        name: p.name,
        // Carried by the cache since M13, so the template a harness was built
        // from is on its row in the first painted frame rather than appearing
        // when the scan lands. `version` is still null here: nothing reads it
        // back and nothing shows it, so there is nothing for a column to be
        // worth yet.
        template: p.template,
        version: null,
        repoPaths: cached.filter((c) => c.harnessPath === p.path).map((c) => c.path)
      })),
    projects: cached,
    errors: [],
    scannedAt: cached[0]?.lastSeenAt ?? new Date().toISOString(),
    durationMs: 0
  }
}

function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.style.colorScheme = resolved
}

export function useLauncher(): LauncherState {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | undefined>(undefined)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  /**
   * Every settings landing goes through here, because two things have to
   * happen and only one of them is React's.
   *
   * The terminals live outside the component tree (terminals.ts, pterms.ts), so
   * a font or cursor change cannot reach them as a prop. `applyTerminalSettings`
   * is the other half of the push and is a no-op when nothing terminal-shaped
   * moved, which is most writes.
   */
  const adopt = useCallback((next: AppSettings) => {
    setSettings(next)
    applyTerminalSettings(next)
  }, [])

  useEffect(() => {
    const offs = [
      helm.on('discovery:updated', (result) => {
        setDiscovery(result)
        setScanError(undefined)
      }),
      helm.on('scan:status', (status) => {
        setScanning(status.running)
        setScanError(status.error)
      }),
      helm.on('settings:changed', adopt),
      helm.on('theme:changed', ({ resolved }) => applyTheme(resolved))
    ]

    void (async () => {
      const [appInfo, loaded, resolved] = await Promise.all([
        helm.invoke('app:info'),
        helm.invoke('settings:read'),
        helm.invoke('theme:resolved')
      ])
      setInfo(appInfo)
      adopt(loaded)
      applyTheme(resolved)

      const cached = await helm.invoke('discovery:cached')
      // A scan started by the main process may already have landed; do not let
      // the cache overwrite fresher data.
      setDiscovery((current) => current ?? discoveryFromCache(cached, loaded.scanRoots))
    })()

    // Tells the main process the window is listening. It answers with the
    // current settings and theme and kicks off the first scan.
    helm.send('renderer:ready')

    return () => {
      for (const off of offs) off()
    }
  }, [adopt])

  /**
   * Git state refreshed on window focus. The trigger lives in the main process
   * - see `win.on('focus')` - because a renderer cannot tell reliably that its
   * window came back to the front. This side only merges the result, keyed by
   * path, so a project that has since disappeared from the tree is ignored
   * rather than resurrected.
   */
  useEffect(
    () =>
      helm.on('git:updated', (states) => {
        setDiscovery((current) =>
          current
            ? {
                ...current,
                projects: current.projects.map((project) =>
                  project.path in states ? { ...project, git: states[project.path] ?? null } : project
                )
              }
            : current
        )
      }),
    []
  )

  const rescan = useCallback(() => {
    setScanning(true)
    void helm
      .invoke('discovery:scan', { includeGit: true })
      .then(setDiscovery)
      .catch((err: unknown) => {
        setScanError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setScanning(false))
  }, [])

  const addRoot = useCallback((startIn?: string) => {
    void helm.invoke('roots:add', startIn === undefined ? {} : { startIn }).then((roots) => {
      setSettings((current) => (current ? { ...current, scanRoots: roots } : current))
      rescan()
    })
  }, [rescan])

  /**
   * The other half of `addRoot`, and the reason the channel exists: a root
   * added by mistake, or a folder that has moved on, was until now a row in a
   * table with no way out of it. A rescan follows for the same reason it
   * follows an addition - the tree is a view of the roots, so it has to stop
   * showing what is no longer scanned.
   */
  const removeRoot = useCallback(
    (path: string) => {
      void helm.invoke('roots:remove', { path }).then((roots) => {
        setSettings((current) => (current ? { ...current, scanRoots: roots } : current))
        rescan()
      })
    },
    [rescan]
  )

  /**
   * One writer for every setting a pane owns.
   *
   * The answer is adopted rather than the patch: `settings:write` returns the
   * whole object as the main process now holds it, and a surface that trusted
   * its own patch would drift from a value a validator had rejected.
   */
  const writeSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      void helm.invoke('settings:write', patch).then(adopt)
    },
    [adopt]
  )

  const setTheme = useCallback(
    (theme: ThemePreference) => writeSettings({ theme }),
    [writeSettings]
  )

  // Persisted rather than held in the window, so the choice survives a restart
  // - and written through the same channel every other setting uses, so the
  // main process is the one that decides what the settings are.
  const setUsageDisplay = useCallback(
    (usageDisplay: UsageDisplayMode) => writeSettings({ usageDisplay }),
    [writeSettings]
  )

  /**
   * Written through `settings:write` rather than through a channel of its own,
   * because the main process's side-effect ladder is what hands the cleared
   * path to the session host - a write that skipped it would leave sessions
   * launching from the executable the user just forgot.
   */
  const clearClaudePath = useCallback(
    () => writeSettings({ claudePath: null }),
    [writeSettings]
  )

  const reveal = useCallback((path: string) => {
    void helm.invoke('shell:showItem', { path })
  }, [])

  const select = useCallback((project: Project | null) => {
    setSelectedPath(project?.path ?? null)
  }, [])

  // Resolved from the current discovery rather than held as state, so a rescan
  // that changes a project's git or inventory updates the open pane too.
  const selected =
    (selectedPath && discovery?.projects.find((p) => p.path === selectedPath)) || null

  return {
    info,
    settings,
    discovery,
    scanning,
    scanError,
    selected,
    select,
    rescan,
    addRoot,
    removeRoot,
    setTheme,
    setUsageDisplay,
    clearClaudePath,
    reveal,
    writeSettings
  }
}

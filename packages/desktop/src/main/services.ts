import {
  cacheProjects,
  cleanStaleShims,
  disprovedProjectPaths,
  forgetProjects,
  openStore,
  readCachedProjects,
  readGitStates,
  readSettings,
  reconcileRunningSessions,
  scan,
  seedTemplates,
  suggestRoots,
  writeSettings,
  type AppSettings,
  type DiscoveryResult,
  type GitState,
  type SeedResult,
  type Store
} from '@helm/core'
import { dbFile, shimRoot, templatesDir } from './paths'
import { wslHomes } from './wsl'

/**
 * The main process's stateful bits, in one object rather than module-level
 * singletons: the spike modes never open a database, and a module that opened
 * one on import would create a file the fidelity harness has no use for.
 */

export interface Services {
  store: Store
  settings: AppSettings
  /** Last completed scan, or null before the first one. */
  lastScan: DiscoveryResult | null
  /**
   * Sessions the previous run left claiming to be running - a crash, or a kill
   * from Task Manager. Reconciled on the way in, and counted so the number can
   * be reported rather than silently swallowed.
   */
  lostSessions: number
  /**
   * Overlay shim directories left behind by the previous run. Counted for the
   * same reason lost sessions are: it is evidence of how the last run ended.
   */
  staleShims: number
  /**
   * What the templates directory needed on the way in. `seeded: false` is the
   * ordinary case - it was already there and nothing was touched.
   */
  templates: SeedResult
}

export function createServices(): Services {
  const store = openStore({ file: dbFile })
  return {
    store,
    settings: readSettings(store),
    lastScan: null,
    lostSessions: reconcileRunningSessions(store),
    /*
     * The shims no live process is holding.
     *
     * This used to sweep *every* shim, reasoning that at this point in startup
     * nothing is hosting a session and therefore nothing is reading a plugin
     * directory. That reasoning was wrong, and wrong in the way that matters:
     * it is a statement about this process, and the directory belongs to the
     * machine. A second Helm - the dev build beside the installed one, a
     * portable copy beside an install, two installs - starting while the first
     * has a live session unlinked that session's `--plugin-dir` out from under
     * it. The session kept running and silently lost its skills.
     *
     * So a shim now records the processes holding it and `cleanStaleShims`
     * asks the kernel about each one, removing only what it can positively
     * establish is dead. This is still the only place they are swept: doing it
     * per launch would churn directories a session in *this* app is reading.
     */
    staleShims: cleanStaleShims(shimRoot).length,
    /*
     * The shipped README and example template, written once.
     *
     * At start rather than lazily when the dialog opens, and for the same
     * reason the shim sweep is here: it is a claim about the state a Helm
     * begins in, and a directory created the first time somebody happens to
     * open a dialog is a directory whose contents depend on what they did
     * first. It never overwrites - the trigger is the directory being absent -
     * so this costs one `existsSync` on every start after the first.
     */
    templates: seedTemplates(templatesDir)
  }
}

export function updateSettings(services: Services, patch: Partial<AppSettings>): AppSettings {
  services.settings = writeSettings(services.store, patch)
  return services.settings
}

/**
 * Whether the setup pane owns the window.
 *
 * One question with one answer: has this profile been through setup. Not "does
 * it have roots" - during setup it acquires roots, and a pane that vanished the
 * moment the first folder was added would close itself halfway through the
 * thing it exists to do. The stamp is written by the button, and by nothing
 * else.
 */
export function needsFirstRun(services: Services): boolean {
  return services.settings.firstRunCompletedAt === null
}

/**
 * An install that predates the setup pane, brought up to date.
 *
 * It has roots and no stamp, which the rule above would read as "never set up"
 * and answer with a setup pane over a working launcher. Done here rather than
 * during the first scan because the window is created immediately afterwards:
 * a stamp written a second later would show that pane and then take it away.
 */
export function adoptExistingProfile(services: Services): boolean {
  if (services.settings.firstRunCompletedAt !== null) return false
  if (services.settings.scanRoots.length === 0) return false
  updateSettings(services, { firstRunCompletedAt: new Date().toISOString() })
  return true
}

/**
 * Ensures there is something to scan.
 *
 * A profile that has been through setup adopts whatever discovery can justify
 * if it somehow has no roots - the harness Helm is running inside, most often.
 * What it deliberately does *not* do any more is adopt before setup: guessing a
 * scan root before the user has been asked is how a fresh install ends up
 * quietly pointed at somebody else's directory. Until then the suggestions are
 * offered in the pane, where they can be declined.
 */
export async function ensureScanRoots(services: Services): Promise<string[]> {
  if (services.settings.scanRoots.length > 0) return services.settings.scanRoots
  if (needsFirstRun(services)) return []

  // Same list the setup pane offers, distro homes included - a profile that
  // adopts here and a profile that is asked must never be pointed at different
  // places, which is what a second call site with a shorter argument list would
  // quietly produce.
  const suggested = await suggestRoots(process.cwd(), await wslHomes())
  if (suggested.length === 0) return []
  updateSettings(services, { scanRoots: suggested })
  return suggested
}

export async function runScan(
  services: Services,
  opts: { includeGit?: boolean } = {}
): Promise<DiscoveryResult> {
  const roots = await ensureScanRoots(services)
  const result = await scan({ roots, includeGit: opts.includeGit ?? true })
  cacheProjects(services.store, result.projects, result.harnesses)
  // The cache is written to on every pass and read from at every start, so a
  // row a scan can *disprove* has to go: otherwise a project that has been
  // deleted, or one an older Helm listed by a rule since corrected, paints for
  // a second at every launch for the rest of the install's life. Only where
  // this pass walked the root without error - `disprovedProjectPaths` is where
  // that argument lives, and where the unplugged drive is kept.
  forgetProjects(
    services.store,
    disprovedProjectPaths(
      readCachedProjects(services.store).map((project) => project.path),
      result
    )
  )
  services.lastScan = result
  return result
}

/**
 * Re-reads git only. The launcher calls this when the window regains focus:
 * a scan walks every `.claude` tree, which is wasted work when the thing that
 * changed while the user was in an editor is the working tree.
 */
export async function refreshGit(services: Services): Promise<Record<string, GitState | null>> {
  const paths = (services.lastScan?.projects ?? readCachedProjects(services.store)).map(
    (p) => p.path
  )
  const states = await readGitStates(paths)

  const asRecord: Record<string, GitState | null> = {}
  for (const [path, state] of states) asRecord[path] = state

  if (services.lastScan) {
    for (const project of services.lastScan.projects) {
      project.git = states.get(project.path) ?? null
    }
    // The harnesses go in with them: this write is an upsert over the same
    // rows, so passing the projects alone would put null over every recorded
    // `template:` the moment the window regained focus.
    cacheProjects(services.store, services.lastScan.projects, services.lastScan.harnesses)
  }
  return asRecord
}

export function cachedProjects(services: Services): ReturnType<typeof readCachedProjects> {
  return readCachedProjects(services.store)
}

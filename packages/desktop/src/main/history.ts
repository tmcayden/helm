import { watch, statSync, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  claudeHome,
  directoryExists,
  historyCursor,
  historyFileIn,
  indexHistory,
  projectsDirIn,
  readHistoryTail,
  resolveRecordedPath,
  scanTranscripts,
  type HistorySummary,
  type Store,
  type TranscriptFile,
  type WslHome
} from '@helm/core'

/**
 * Keeping the session index level with a file Helm does not own.
 *
 * `history.jsonl` is written by every `claude` on the machine, including the
 * ones started from a terminal while Helm is open - so the launcher is only
 * honest if it notices those. Two mechanisms, because they fail differently:
 *
 *   `fs.watch` on the containing directory fires within milliseconds, and is
 *   documented as not available everywhere. The directory rather than the file
 *   so that a rotation - the file being replaced rather than appended to -
 *   still reports, which a watch on the inode does not.
 *
 *   A stat poll every few seconds costs one syscall and covers the case where
 *   the watch never fires at all.
 *
 * Both funnel into the same debounced refresh, which is incremental: only the
 * bytes appended since the last pass are read.
 */

/** Long enough for a burst of appends to settle, short enough to feel immediate. */
const DEBOUNCE_MS = 150

/**
 * The backstop, not the mechanism. Four seconds keeps the criterion ("within
 * seconds") true even on a filesystem where `fs.watch` is silent. All it does
 * is stat the file, so the cost of it being redundant is one syscall.
 */
const POLL_MS = 4000

/**
 * How often a pass runs with nothing to read. A transcript being reaped and a
 * project directory being deleted change what can be resumed without touching
 * the history file, so the index has to look occasionally on its own - but the
 * pass costs tens of milliseconds of SQLite, which is not something to spend
 * every four seconds for a change that happens weekly.
 */
const SWEEP_EVERY = 15

export interface HistoryService {
  /** Reads whatever has appeared since the last pass and returns the totals. */
  refresh: () => HistorySummary
  /** Last known totals, without touching the disk. */
  summary: () => HistorySummary
  /** Begins watching. Safe to call twice. */
  start: () => void
  stop: () => void
  /** The primary file being indexed; the resume path and the UI both name it. */
  file: string
  /**
   * Adds the WSL distributions' history files to the index.
   *
   * Separate from construction because finding them is a `wsl.exe` per
   * distribution and the window must not wait on it: the index starts on this
   * machine's history, which is what it has always done, and the distros join
   * when the probe lands. Idempotent, and safe after `start` - it re-watches.
   *
   * Passing a list that is already indexed does nothing, so the startup call
   * and a later refresh after somebody installs a distro are the same call.
   */
  useHomes: (homes: readonly WslHome[]) => void
}

export interface HistoryServiceDeps {
  store: Store
  /** Called after any pass that changed the totals. */
  onChange: (summary: HistorySummary) => void
  /**
   * The transcript archive, fed the walk this service has already done.
   *
   * `scanTranscripts` runs on every pass here because resumability is a
   * property of the disk right now. The archive needs the same answer keyed by
   * the same thing, so it is a second consumer of this walk rather than a
   * second walk - see `main/archive.ts`, which explains why it is this walk and
   * not the usage index's.
   */
  onTranscripts?: ((transcripts: Map<string, TranscriptFile>) => void) | undefined
  /** Overridden by `--history-check` to index a fixture instead of the real tree. */
  home?: string | undefined
}

export function createHistoryService({
  store,
  onChange,
  onTranscripts,
  home = claudeHome()
}: HistoryServiceDeps): HistoryService {
  const file = historyFileIn(home)

  /**
   * Every `~/.claude` being indexed, this machine's first.
   *
   * The head never changes; the tail is the distros, added by `useHomes` when
   * the probe that finds them lands. Order matters only for the summary, whose
   * `historyFile` is the one the UI names when it has room for one.
   */
  let homes: readonly string[] = [home]
  const filesOf = (): string[] => homes.map(historyFileIn)

  /**
   * The distros, for translating the project paths their sessions recorded.
   *
   * A session in a distro writes `/home/me/harness` into its `history.jsonl`,
   * because that is the directory its CLI was in. `statSync` on Windows
   * resolves a leading `/` against the current drive root, so every one of
   * those reads as absent - and `projectExists` is what decides whether a
   * conversation can be offered for resume at all. Measured before this: 214
   * distro conversations with a surviving transcript, 0 of them resumable.
   */
  let distros: readonly WslHome[] = []

  /**
   * Whether a recorded working directory is still there, in either spelling.
   *
   * Runs once per distinct directory per pass, not once per session, which is
   * what makes the extra UNC stats affordable - 55 directories on this machine.
   */
  const projectExists = (path: string): boolean => {
    const resolved = resolveRecordedPath(path, distros, directoryExists)
    return resolved !== null && directoryExists(resolved)
  }

  let last: HistorySummary = {
    sessions: 0,
    prompts: 0,
    projects: 0,
    resumable: 0,
    latestAt: null,
    historyFile: file,
    historyFiles: [file],
    indexedBytes: historyCursor(store, file)
  }
  let watchers: FSWatcher[] = []
  let poll: NodeJS.Timeout | null = null
  let debounce: NodeJS.Timeout | null = null
  let lastSizes = new Map<string, number>()

  function refresh(): HistorySummary {
    /**
     * A reset in any source re-reads every source from zero.
     *
     * `indexHistory` empties both tables when it sees one, because the rows do
     * not record which file they came from - so the sources that did *not*
     * reset would be wiped and then only topped up from their cursors, leaving
     * the index holding the tail of a file and calling it the whole of it. One
     * extra full read of a 1.2 MB file, on the rare pass where a history file
     * has been rotated or deleted, is the price of not needing a column that
     * would have to be right about rows written before it existed.
     */
    let sources = homes.map((where) => {
      const path = historyFileIn(where)
      return { file: path, tail: readHistoryTail(path, historyCursor(store, path)) }
    })
    if (sources.some((source) => source.tail.reset) && sources.length > 1) {
      sources = sources.map((source) => ({
        file: source.file,
        tail: source.tail.reset ? source.tail : readHistoryTail(source.file, 0)
      }))
    }

    // One map across every home. Session ids are UUIDs, so the merge is a
    // union with no key to reconcile, and the archive downstream wants the
    // same single answer to "what can still be opened".
    const transcripts = new Map<string, TranscriptFile>()
    for (const where of homes) {
      for (const [id, found] of scanTranscripts(projectsDirIn(where))) transcripts.set(id, found)
    }

    const next = indexHistory(store, { sources, transcripts, directoryExists: projectExists })
    const changed =
      next.sessions !== last.sessions ||
      next.prompts !== last.prompts ||
      next.resumable !== last.resumable ||
      next.indexedBytes !== last.indexedBytes ||
      next.error !== last.error
    last = next
    if (changed) onChange(next)
    // After the index, and outside its transaction: the archive is a separate
    // set of tables with a separate cursor, and a slow pass over a transcript
    // that has grown must not hold the write lock the launcher's list reads
    // through. A throw here is the archive's problem and not the index's.
    if (onTranscripts !== undefined) {
      try {
        onTranscripts(transcripts)
      } catch (err) {
        console.warn(`transcript archive pass failed: ${String(err)}`)
      }
    }
    return next
  }

  function scheduleRefresh(): void {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      try {
        refresh()
      } catch (err) {
        // A pass that throws must not take the interval with it: the next
        // append is the next chance to get back in step.
        console.warn(`history index refresh failed: ${String(err)}`)
      }
    }, DEBOUNCE_MS)
  }

  /**
   * One watch per home, rebuilt whenever the list of homes changes.
   *
   * **A distro's home never gets one.** Measured 2026-09-03: `fs.watch` over a
   * `\\wsl$\` path throws `EISDIR` immediately - on the directory, on the
   * directory recursively, and on the file itself - so the 9P share behind it
   * carries no change notification of any kind. That is caught below and the
   * home is simply left to the poll, which is the mechanism this was written
   * around anyway: it stats every file and trusts no watch. The visible
   * consequence is that a prompt typed in a distro reaches the launcher within
   * the poll interval rather than within the debounce.
   */
  function rewatch(): void {
    for (const open of watchers) open.close()
    watchers = []
    for (const path of filesOf()) {
      try {
        // Non-recursive: the directory holds the whole `.claude` tree, and a
        // recursive watch over `projects/` would fire on every token a live
        // session writes to its transcript.
        const open = watch(dirname(path), { persistent: false }, (_event, name) => {
          if (name === null || basename(String(name)) === basename(path)) scheduleRefresh()
        })
        open.on('error', () => {
          open.close()
          watchers = watchers.filter((held) => held !== open)
        })
        watchers.push(open)
      } catch {
        // Left to the poll.
      }
    }
  }

  let started = false

  return {
    file,
    refresh,
    summary: () => last,

    useHomes(next) {
      // This machine's home is always the head and is never one of these, so a
      // distro whose `$HOME` somehow resolved to it cannot be indexed twice.
      const added = next.filter(
        (home) => !homes.some((held) => held.toLowerCase() === home.claudeHome.toLowerCase())
      )
      if (added.length === 0) return
      homes = [...homes, ...added.map((home) => home.claudeHome)]
      distros = [...distros, ...added]
      if (!started) return
      rewatch()
      scheduleRefresh()
    },

    start() {
      if (started) return
      started = true
      rewatch()

      let ticks = 0
      poll = setInterval(() => {
        ticks++
        // Size, not mtime: an append always changes it, and a stat that reports
        // no change costs nothing further. A file that cannot be stat'd reads
        // as -1, which is a change the next pass will report as an error.
        let moved = false
        for (const path of filesOf()) {
          let size: number
          try {
            size = statSync(path).size
          } catch {
            size = -1
          }
          if (lastSizes.get(path) === size) continue
          lastSizes.set(path, size)
          moved = true
        }
        if (moved) {
          scheduleRefresh()
          return
        }
        if (ticks % SWEEP_EVERY !== 0) return
        try {
          refresh()
        } catch {
          // As above: a failed pass is not a reason to stop looking.
        }
      }, POLL_MS)
      poll.unref()
    },

    stop() {
      started = false
      if (debounce) clearTimeout(debounce)
      debounce = null
      if (poll) clearInterval(poll)
      poll = null
      for (const open of watchers) open.close()
      watchers = []
      lastSizes = new Map()
    }
  }
}

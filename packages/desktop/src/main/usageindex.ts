import {
  forgetUsageFiles,
  indexUsageFile,
  indexedUsageFiles,
  readUsageSpend,
  readUsageTail,
  usageScanUnits,
  walkUsageTranscriptsUntil,
  usageCursor,
  type Store,
  type TranscriptStat,
  type UsageScanUnit,
  type UsageSpend
} from '@helm/core'

/**
 * Keeping the token index level with 178 transcripts Helm does not own.
 *
 * The same shape as the session index, applied to many files instead of one:
 * a byte cursor per transcript, tail reads because a transcript is append-only
 * while its session runs, and the aggregate in SQLite. What it buys is measured
 * - a full parse of every transcript is 1,018 ms over 214 MB, and the status
 * bar cannot spend that on a repaint, or on a keystroke, or at all.
 *
 * Two things here that the single-file indexes do not need:
 *
 *   The first pass is **chunked**. It reads 214 MB and writes 22,180 rows, and
 *   doing that in one turn would freeze the window for a second at startup. A
 *   pass stops after a byte budget and schedules the next one, so the main
 *   process stays responsive while the index catches up behind the app.
 *
 *   Transcripts are **reaped** on Claude Code's schedule, so the file list is
 *   re-read rather than assumed. A cursor for a file that has gone is dropped;
 *   the rows it produced stay, because the tokens were still spent.
 */

/**
 * How much a single catch-up pass will read before yielding.
 *
 * Sixteen megabytes is roughly 70 ms of parsing at the rate measured here -
 * long enough that the first index finishes in a handful of ticks, short enough
 * that no single one of them is a visible stall.
 */
const CHUNK_BYTES = 16 * 1024 * 1024

/**
 * How long a single pass will spend *looking* for transcripts before yielding.
 *
 * The companion to `CHUNK_BYTES`, and it exists because the byte budget bounded
 * only the half of a pass that reads. The other half - the `statSync` per
 * transcript that says whether anything was appended - had no bound at all, and
 * the whole tree was walked on every tick.
 *
 * That was affordable while every tree was local. Measured 2026-09-03: this
 * machine's `projects/` is 23 transcripts and scans in 1-2 ms; the same
 * directory inside WSL is 1,066 transcripts and takes **2,492-2,633 ms** over
 * `\\wsl$\`. On a ten-second timer, on the main thread, that is a quarter of
 * the main thread spent finding out that nothing had changed - and `U-8` caught
 * it at 2,357 ms against a 250 ms budget, reading zero files.
 *
 * 80 ms is chosen against the same yardstick `CHUNK_BYTES` uses: shorter than
 * one frame's worth of slack, so no single tick is a visible stall.
 */
const SCAN_BUDGET_MS = 80

/** How often the index looks for transcripts that have grown. */
const POLL_MS = 10_000

export interface UsageIndexPass {
  /** Files whose tails were read this pass. */
  files: number
  /** Rows added to the index. Duplicates from a fork are not counted. */
  rows: number
  /** Cursors dropped for transcripts Claude Code has reaped. */
  forgotten: number
  /** True when everything on disk is now indexed. */
  caughtUp: boolean
  ms: number
}

export interface UsageIndexDeps {
  store: Store
  /**
   * Every `~/.claude/projects` to index, this machine's first.
   *
   * A function rather than a list because the WSL distributions' homes are
   * found by a probe that has not finished when the service is built, and a
   * spend figure that silently omitted a distro's transcripts would be a wrong
   * number rather than a missing one - which is the failure the usage surface
   * exists to avoid. Asked on every pass, so a distro installed while Helm is
   * open joins the index at the next tick.
   *
   * The rows are keyed by the transcript's own uuid and the cursors by file
   * path, so directories merge with nothing to reconcile.
   */
  projectsDirs: () => readonly string[]
}

export interface UsageIndex {
  /** One chunk of work. Call again while `caughtUp` is false. */
  pass: () => UsageIndexPass
  /** Session / today / 7-day totals from whatever is indexed right now. */
  spend: (sessionResetsAtMs: number | null, indexMs: number) => UsageSpend
  /** Whether the first catch-up has finished. */
  ready: () => boolean
  /** Milliseconds the last pass took. */
  lastPassMs: () => number
}

/**
 * Local midnight, in the main process's own timezone.
 *
 * Computed rather than taken as `now - 24h`, because "today" means the calendar
 * day the user is in - and computed in the main process rather than the window
 * because that is where the index lives, and the two are the same machine.
 */
export function localMidnight(nowMs: number): number {
  const date = new Date(nowMs)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function createUsageIndex({ store, projectsDirs }: UsageIndexDeps): UsageIndex {
  let caughtUp = false
  let lastPassMs = 0

  /**
   * The scan, spread across passes.
   *
   * `queue` is what is left to look at in the current round, `round` is what
   * this round has found so far, and `recent` is the previous round's answer
   * for how lately each directory was written to. A round ends when the queue
   * empties, and only then is the listing complete enough to say a transcript
   * has gone.
   *
   * `recent` is what keeps the lag honest without costing anything: ordering
   * the queue needs a "which directories are active" signal, and stat-ing every
   * directory to get one would be the cost this is avoiding. The previous
   * round already learned it, for free.
   */
  let queue: UsageScanUnit[] = []
  let round = new Map<string, TranscriptStat>()
  const recent = new Map<string, number>()

  function pass(): UsageIndexPass {
    const started = performance.now()

    if (queue.length === 0) {
      // A new round. One `readdir` per home - no `stat` - then the directories
      // that were most recently written to first, so an active conversation is
      // seen in the first tick of a round rather than the last.
      queue = projectsDirs().flatMap((dir) => usageScanUnits(dir))
      queue.sort((a, b) => (recent.get(b.dir) ?? 0) - (recent.get(a.dir) ?? 0))
      round = new Map()
    }

    const scanBy = performance.now() + SCAN_BUDGET_MS
    while (queue.length > 0 && performance.now() < scanBy) {
      const unit = queue.shift()
      if (unit === undefined) break
      const step = walkUsageTranscriptsUntil(unit, scanBy)
      let newest = recent.get(unit.dir) ?? 0
      for (const found of step.found) {
        round.set(found.file, found)
        if (found.mtimeMs > newest) newest = found.mtimeMs
      }
      recent.set(unit.dir, newest)
      // What the deadline interrupted goes back to the front, so the next tick
      // resumes where this one stopped instead of starting the directory again.
      if (step.unfinished.length > 0) queue.unshift(...step.unfinished)
    }
    const scanned = queue.length === 0

    const onDisk = [...round.values()]
    const known = indexedUsageFiles(store)

    /*
     * A cursor whose file is gone: Claude Code reaped the transcript. Drop the
     * cursor so the table does not grow forever with paths that cannot be read;
     * the rows stay, because the tokens were spent whether or not the record of
     * them survives. This is also the argument for the transcript archive
     * backlog - without it, usage history is a 26-day window.
     *
     * **Only when the round is complete.** A partial listing is not evidence
     * that anything is missing, and dropping cursors against one would read
     * every not-yet-scanned transcript as reaped, forget its cursor, and re-read
     * the file from zero next round - forever. That hazard is why the scan used
     * to gather every home before this line, and it is the one thing the budget
     * had to preserve.
     */
    const present = new Set(onDisk.map((t) => t.file))
    const gone = scanned ? [...known.keys()].filter((file) => !present.has(file)) : []
    const forgotten = forgetUsageFiles(store, gone)

    let files = 0
    let rows = 0
    let budget = CHUNK_BYTES
    let remaining = false

    for (const transcript of onDisk) {
      const cursor = known.get(transcript.file) ?? usageCursor(store, transcript.file)
      // Equal means nothing appended. Smaller means the file was replaced,
      // which `readUsageTail` reports as a reset and re-reads from zero.
      if (transcript.bytes === cursor) continue
      if (budget <= 0) {
        remaining = true
        break
      }

      const tail = readUsageTail(transcript.file, cursor)
      if (tail.error !== undefined) {
        // A transcript that cannot be read right now - being written, locked,
        // removed between the scan and the read - is not a reason to stop.
        continue
      }
      rows += indexUsageFile(store, { file: transcript.file, tail })
      files++
      budget -= Math.max(0, transcript.bytes - cursor)
    }

    // Both halves, because either one being unfinished means the index is not
    // level yet: bytes left to read, or directories left to look in. Without
    // the second, `ready()` would answer true while most of a distribution's
    // transcripts had not been looked at once.
    caughtUp = !remaining && scanned
    lastPassMs = performance.now() - started
    return { files, rows, forgotten, caughtUp, ms: lastPassMs }
  }

  return {
    pass,
    ready: () => caughtUp,
    lastPassMs: () => lastPassMs,
    spend: (sessionResetsAtMs, indexMs) => {
      const nowMs = Date.now()
      return readUsageSpend(store, {
        nowMs,
        sessionResetsAtMs,
        todayStartMs: localMidnight(nowMs),
        indexMs
      })
    }
  }
}

export const USAGE_INDEX_POLL_MS = POLL_MS

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readTail } from '../discovery/tail'

/**
 * Token usage, out of the transcripts Claude Code writes as it works.
 *
 * Every `assistant` row carries a `usage` object - 22,180 of 22,180 on the
 * machine this was written against - so the tokens are all there. What is not
 * there is a price: `spend.enabled` is false on a subscription plan, so a
 * dollar figure has to be Helm's own arithmetic over these rows against a price
 * table Helm carries. That is why everything downstream of this file is
 * labelled an estimate.
 *
 * The cost of doing it naively is measured: 178 files, 214 MB, 22,180 rows,
 * 1,018 ms for a full parse. Far too slow to sit behind a status bar, hence the
 * same treatment the session index gave `history.jsonl` - a per-file byte
 * cursor, tail reads,
 * and the aggregate in SQLite.
 */

/** One assistant message's tokens, priced separately by class. */
export interface UsageRow {
  /**
   * The transcript row's own uuid, and the dedup key. A forked conversation
   * copies its parent's history into a new file, so the same message can appear
   * twice on disk; 0 of 22,180 uuids collided otherwise, so this is safe as a
   * primary key.
   */
  uuid: string
  /** Epoch ms from the row's ISO `timestamp`. */
  at: number
  model: string
  input: number
  output: number
  /**
   * Cache writes, split by TTL, because they are priced differently: a
   * five-minute write is 1.25x base input and a one-hour write is 2x.
   */
  cacheWrite5m: number
  cacheWrite1h: number
  /** The class that dominates the volume - 390M in one day here - at 0.1x. */
  cacheRead: number
}

export interface UsageTail {
  rows: UsageRow[]
  bytes: number
  reset: boolean
  /** Lines that were not usable. Skipped, not fatal. */
  skipped: number
  error?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * One transcript line, if it is an assistant message with usage on it.
 *
 * Everything else in the file - `user`, `system`, `attachment`,
 * `file-history-snapshot`, `queue-operation` and a dozen more - is skipped
 * silently rather than counted as a failure, because it is not a failure: those
 * rows have no tokens to attribute.
 */
export function parseUsageLine(raw: string): UsageRow | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(value)) return null
  if (value['type'] !== 'assistant') return null

  const uuid = value['uuid']
  if (typeof uuid !== 'string' || uuid === '') return null

  const message = value['message']
  if (!isObject(message)) return null
  const usage = message['usage']
  if (!isObject(usage)) return null

  const at = Date.parse(String(value['timestamp'] ?? ''))
  if (!Number.isFinite(at)) return null

  const model = message['model']
  if (typeof model !== 'string' || model === '') return null

  // `cache_creation` splits the write total by TTL. When it is absent the whole
  // total is a five-minute write, which is the default TTL - the conservative
  // reading, since it is the cheaper of the two.
  const creation = usage['cache_creation']
  const writeTotal = count(usage['cache_creation_input_tokens'])
  let write1h = 0
  let write5m = writeTotal
  if (isObject(creation)) {
    write1h = count(creation['ephemeral_1h_input_tokens'])
    write5m = count(creation['ephemeral_5m_input_tokens'])
    // Trust the total over the parts if they disagree: the total is the field
    // the API documents and the parts are a breakdown of it.
    const parts = write1h + write5m
    if (parts !== writeTotal) {
      if (parts === 0) write5m = writeTotal
      else if (writeTotal > parts) write5m += writeTotal - parts
    }
  }

  return {
    uuid,
    at,
    model,
    input: count(usage['input_tokens']),
    output: count(usage['output_tokens']),
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    cacheRead: count(usage['cache_read_input_tokens'])
  }
}

/** The rows appended to one transcript since `fromBytes`. */
export function readUsageTail(file: string, fromBytes: number): UsageTail {
  const tail = readTail(file, fromBytes)
  if (tail.error !== undefined) {
    return { rows: [], bytes: tail.bytes, reset: tail.reset, skipped: 0, error: tail.error }
  }

  const rows: UsageRow[] = []
  let skipped = 0
  for (const raw of tail.text.split('\n')) {
    if (raw === '') continue
    // A cheap gate before the parse: most lines in a transcript are not
    // assistant messages, and `JSON.parse` on a 200 KB attachment row to
    // discover that is the difference between a fast pass and a slow one.
    if (!raw.includes('"assistant"')) continue
    const row = parseUsageLine(raw)
    if (row === null) skipped++
    else rows.push(row)
  }

  return { rows, bytes: tail.bytes, reset: tail.reset, skipped }
}

export interface TranscriptStat {
  file: string
  bytes: number
  mtimeMs: number
}

/**
 * Every transcript under `projects/`, at any depth.
 *
 * Deeper than the session index looks, and deliberately: a subagent writes to
 * `<sessionId>/subagents/agent-*.jsonl`, and those rows are real usage against
 * the same plan - 583 M tokens of the 4.86 B on this machine, 12%. The session
 * index ignores them because their names are not session ids; the usage index
 * must not, because the plan does not ignore them.
 */
export function scanUsageTranscripts(projectsDir: string): TranscriptStat[] {
  const found = walkUsageTranscripts(projectsDir, 4)
  // Most recently written first: on a first index this puts the transcripts a
  // 7-day window actually needs in front of the 26-day tail.
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found
}

/**
 * One directory's transcripts, so a caller can scan a tree a piece at a time.
 *
 * Split out of `scanUsageTranscripts` because **the whole tree is not always
 * affordable in one go**. Measured 2026-09-03 on this machine: this machine's
 * own `projects/` is 23 transcripts and scans in 1-2 ms, while the same
 * directory inside a WSL distribution is 1,066 transcripts and takes
 * **2,492-2,633 ms** over `\\wsl$\` - about 2.3 ms per `statSync` against 0.06
 * ms locally. The usage index ran that on the main thread every ten seconds,
 * which is a quarter of the main thread gone on any machine with WSL, and what
 * queues behind it is pty resizes and IPC replies (CLAUDE.md, "the process pass
 * is budgeted").
 *
 * `statSync` per file is unavoidable: `readdirSync` with file types says what
 * is a file but not how big it is, and the size is what tells an append from a
 * quiet file. So the answer is not a cheaper scan but a *bounded* one, and this
 * is the unit the bound is applied between.
 *
 * `maxDepth` is counted from `dir`, so a caller starting at a project
 * directory passes the remaining budget rather than the original one.
 */
export function walkUsageTranscripts(dir: string, maxDepth: number): TranscriptStat[] {
  return walkUsageTranscriptsUntil({ dir, depth: maxDepth, from: 0 }, Infinity).found
}

/**
 * Where a bounded walk had got to: a directory and how far into its listing.
 *
 * `from` is an index into `readdirSync`'s answer rather than a filename,
 * because resuming re-lists the directory - one `readdir`, no `stat`, which is
 * the cheap half - and an index survives that at no cost. A file created in the
 * middle of the listing between two passes can therefore be skipped until the
 * next round, which is the accepted price: the round after sees it, and the
 * alternative is holding a directory's entire listing across ticks so that a
 * transcript can be found a few seconds sooner.
 */
export interface UsageScanUnit {
  dir: string
  /**
   * How many levels **below this directory** may still be walked.
   *
   * A remaining allowance, not a position in the tree, and the distinction is
   * not academic: written as a position, a unit for `projects/<project>` said
   * "3" meaning three more levels while the walker read it as "already three
   * deep" and refused to descend at all. Every subagent transcript under
   * `<project>/<session>/subagents/` was silently skipped, the index came out
   * at 51,270 messages against 135,850, and it reported itself caught up after
   * fifteen passes because there was so little left to find. `U-11` is what
   * caught it, by parsing the same trees a second way.
   */
  depth: number
  from: number
}

/**
 * Walks until the deadline, and says what it did not reach.
 *
 * The deadline is checked **between files**, not between directories, and that
 * is the whole point of this shape. Checking between directories bounds nothing
 * useful: one project directory inside a distribution holds hundreds of
 * transcripts, so a single unit overruns any budget on its own - measured at
 * 852 ms against an 80 ms budget on the first attempt at this, which is better
 * than the 2,357 ms it replaced and still four times what it was allowed.
 */
export function walkUsageTranscriptsUntil(
  start: UsageScanUnit,
  deadlineMs: number
): { found: TranscriptStat[]; unfinished: UsageScanUnit[] } {
  const found: TranscriptStat[] = []
  // A stack rather than recursion, so what is left when the clock runs out is a
  // value this can hand back rather than a call chain it would have to unwind.
  const stack: UsageScanUnit[] = [start]

  while (stack.length > 0) {
    const unit = stack.pop()
    if (unit === undefined) break
    if (unit.depth < 0) continue

    let entries
    try {
      entries = readdirSync(unit.dir, { withFileTypes: true })
    } catch {
      continue
    }

    let at = unit.from
    for (; at < entries.length; at++) {
      // At least one entry per call, always. Checked only *after* the first,
      // because a deadline already past when the walk begins would otherwise
      // hand back the same `from` it was given: the caller re-queues it, the
      // next call also does nothing, and the scan livelocks having made no
      // progress at all. Caught by the resume test, which passes exactly that
      // deadline on purpose.
      if (at > unit.from && performance.now() >= deadlineMs) break
      const entry = entries[at]
      if (entry === undefined) continue
      const path = join(unit.dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink()) stack.push({ dir: path, depth: unit.depth - 1, from: 0 })
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      try {
        const stats = statSync(path)
        found.push({ file: path, bytes: stats.size, mtimeMs: stats.mtimeMs })
      } catch {
        continue
      }
    }

    if (at < entries.length) {
      // Out of time part way through this directory. It goes back with the
      // offset, and everything still stacked behind it comes back untouched.
      return { found, unfinished: [{ dir: unit.dir, depth: unit.depth, from: at }, ...stack] }
    }
  }

  return { found, unfinished: [] }
}

/**
 * The directories a bounded scan of `projects/` can be split across.
 *
 * One `readdirSync` of the root - cheap even over `\\wsl$\`, because it is a
 * single listing and no `stat` - returning each project directory plus the root
 * itself, which is where a stray transcript would sit. The root is scanned
 * shallowly so its files are seen without walking the projects again.
 */
export function usageScanUnits(projectsDir: string): UsageScanUnit[] {
  const units: UsageScanUnit[] = [{ dir: projectsDir, depth: 0, from: 0 }]
  let entries
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true })
  } catch {
    return units
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    units.push({ dir: join(projectsDir, entry.name), depth: 3, from: 0 })
  }
  return units
}

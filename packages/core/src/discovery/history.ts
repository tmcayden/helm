import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { samePath } from '../config/live'
import { readTail } from './tail'

/**
 * Claude Code's own record of what has been asked of it.
 *
 * Two files, and they do not agree with each other - which is the whole reason
 * this module exists:
 *
 *   `history.jsonl`      every prompt ever submitted, on every project, append
 *                        only, forever. 3,470 lines / 799 sessions / 37
 *                        projects on the machine this was written against.
 *   `projects/<dir>/`    the transcripts `--resume` actually reads. Reaped on
 *                        Claude Code's schedule: 105 of those 799 survive.
 *
 * So the prompt history is the list, and the transcript directory is the
 * question of what can still be opened. Helm reads both and writes to neither.
 */

/** `~/.claude`, or wherever the CLI has been pointed instead. */
export function claudeHome(): string {
  const override = process.env['CLAUDE_CONFIG_DIR']
  return override && override.trim() !== '' ? override : join(homedir(), '.claude')
}

export function historyFileIn(home: string): string {
  return join(home, 'history.jsonl')
}

export function projectsDirIn(home: string): string {
  return join(home, 'projects')
}

/** One line of `history.jsonl`, after the fields Helm uses have been checked. */
export interface HistoryLine {
  sessionId: string
  project: string
  timestamp: number
  display: string
}

export interface HistoryTail {
  lines: HistoryLine[]
  /**
   * Byte offset the next pass should resume from. Always the end of the last
   * complete line, so a read that caught the CLI mid-append does not consume
   * half a record and then parse the other half as a whole one.
   */
  bytes: number
  /**
   * The file is not the one the cursor belonged to - it shrank, or it is gone.
   * The caller has to discard what it had rather than append to it.
   */
  reset: boolean
  /** Lines that were not valid JSON, or lacked a field. Skipped, not fatal. */
  skipped: number
  /** Set when the file could not be read at all. */
  error?: string
}

/** JSON with the four fields Helm needs, and nothing assumed about the rest. */
function parseLine(raw: string): HistoryLine | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>

  const sessionId = record['sessionId']
  const project = record['project']
  const timestamp = record['timestamp']
  const display = record['display']

  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (typeof project !== 'string' || project === '') return null
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null

  return {
    sessionId,
    project,
    timestamp,
    // A prompt submitted as an empty line is still a submission; only a
    // non-string is a record Helm cannot use.
    display: typeof display === 'string' ? display : ''
  }
}

/**
 * Reads the part of `history.jsonl` that has appeared since `fromBytes`.
 *
 * Incremental because the file only ever grows: re-reading 875 KB to learn
 * about one new prompt is affordable today and stops being so, and the cursor
 * costs one integer. The byte arithmetic - the shrink check and the unconsumed
 * trailing fragment - is in `readTail`, which the usage index shares.
 */
export function readHistoryTail(file: string, fromBytes: number): HistoryTail {
  const tail = readTail(file, fromBytes)
  if (tail.error !== undefined) {
    return { lines: [], bytes: tail.bytes, reset: tail.reset, skipped: 0, error: tail.error }
  }

  const lines: HistoryLine[] = []
  let skipped = 0
  for (const raw of tail.text.split('\n')) {
    if (raw.trim() === '') continue
    const parsed = parseLine(raw)
    if (parsed === null) skipped++
    else lines.push(parsed)
  }

  return { lines, bytes: tail.bytes, reset: tail.reset, skipped }
}

/** A transcript file that is still on disk. */
export interface TranscriptFile {
  sessionId: string
  file: string
  bytes: number
  modifiedMs: number
}

/**
 * Session ids that still have a transcript, keyed by id.
 *
 * Found by walking `projects/*` rather than by deriving a path from the
 * project a session recorded, because the two do not always agree. The
 * directory name is built from whatever casing the CLI was invoked with, and
 * `history.jsonl` records its own: two transcripts on this machine live under
 * `...-repos-Acme-Reporting` for sessions whose recorded project is
 * `...\repos\acme-reporting`. A derived path misses them and reports a
 * resumable conversation as reaped. The id is the join key that always holds.
 *
 * Only the top level of each project directory is read. Below it are
 * `<sessionId>/subagents/agent-*.jsonl` and `tool-results/`, whose names are
 * not session ids - hence the UUID shape test rather than a bare `.jsonl`
 * check.
 */
const TRANSCRIPT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

/** Whether a file name is the shape of a session transcript. */
export function isTranscriptName(name: string): boolean {
  return TRANSCRIPT_NAME.test(name)
}

export function scanTranscripts(projectsDir: string): Map<string, TranscriptFile> {
  const found = new Map<string, TranscriptFile>()

  let dirs: string[]
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // No projects directory means no transcripts, which is a true answer and
    // not an error: every session is then history-only.
    return found
  }

  for (const dir of dirs) scanProjectDir(join(projectsDir, dir), found)

  return found
}

/**
 * One project directory's transcripts, merged into `found`.
 *
 * Split out of the walk so that an index fed by events (`transcripts-live.ts`)
 * can re-read the one directory an event named instead of the whole tree.
 */
export function scanProjectDir(full: string, found: Map<string, TranscriptFile>): void {
  let names: string[]
  try {
    names = readdirSync(full)
  } catch {
    return
  }
  for (const name of names) {
    if (!TRANSCRIPT_NAME.test(name)) continue
    recordTranscript(join(full, name), found)
  }
}

/**
 * Stats one transcript and records it. False when there is nothing there.
 *
 * A session id can appear under two project directories when the same folder
 * was opened with different casing. Keep the larger file: it is the one with
 * the conversation in it. The same file seen again always wins over its own
 * earlier size, so an append - or a truncation - is recorded.
 */
export function recordTranscript(file: string, found: Map<string, TranscriptFile>): boolean {
  let stats
  try {
    stats = statSync(file)
  } catch {
    return false
  }
  if (!stats.isFile()) return false
  const sessionId = basename(file).slice(0, -'.jsonl'.length).toLowerCase()
  const existing = found.get(sessionId)
  if (existing && !samePath(existing.file, file) && existing.bytes >= stats.size) return false
  found.set(sessionId, {
    sessionId,
    file,
    bytes: stats.size,
    modifiedMs: stats.mtimeMs
  })
  return true
}

/** Whether a recorded working directory is still a directory. */
export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

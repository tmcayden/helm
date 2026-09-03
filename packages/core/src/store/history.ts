import { basename } from 'node:path'
import type { TranscriptFile, HistoryTail } from '../discovery/history'
import { deriveSessionTitle, titleRank } from '../discovery/title'
import { HISTORY_NAME_MAX } from '../types'
import type {
  ArchiveSessionState,
  HistoryPage,
  HistoryProject,
  HistoryPrompt,
  HistoryQuery,
  HistorySession,
  HistorySummary
} from '../types'
import { searchArchive, type ArchiveMatch } from './archive'
import type { Store } from './db'

/**
 * The session index: `~/.claude/history.jsonl` and the surviving transcripts,
 * mirrored into SQLite so the launcher can search and group 799 sessions
 * instead of re-parsing 875 KB per keystroke.
 *
 * Written with the driver rather than through Drizzle. Two of the statements
 * here - the aggregate rebuild and the substring search - are an
 * `INSERT ... SELECT ... ON CONFLICT` and a `LIKE ... ESCAPE`, neither of which
 * the query builder expresses; splitting the work so that half went through it
 * would buy nothing and hide where the cost is.
 */

const DEFAULT_LIMIT = 2000

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * One `history.jsonl` and what has appeared in it since the last pass.
 *
 * There is more than one whenever a WSL distribution is installed. A session
 * hosted in a distro is a `claude` process inside that distro writing to that
 * distro's `~/.claude/history.jsonl`, which this process reaches over
 * `\\wsl$\<distro>\...` but which is a different file with a cursor of its own.
 */
export interface HistorySource {
  /** The history file these lines came from; also the cursor's key. */
  file: string
  tail: HistoryTail
}

export interface HistoryIndexInput {
  /**
   * Every history file, indexed in one pass.
   *
   * One pass rather than one per file because the tables are shared and two of
   * the steps are whole-table operations: `applyTranscripts` clears the
   * transcript columns before re-marking, and `rebuildSessions` groups over
   * every prompt. Run per file, each pass would undo the last one's transcript
   * marks and the sessions from the other distro would flicker in and out of
   * being resumable.
   *
   * Session ids are UUIDs, so rows from two homes coexist in the tables with no
   * ambiguity and nothing has to record which home a session came from.
   */
  sources: readonly HistorySource[]
  /** Session ids that still have a transcript, keyed by lowercased id. */
  transcripts: Map<string, TranscriptFile>
  /**
   * Answers "is this recorded working directory still there". Injected so the
   * check runs inside the same transaction as everything else it has to agree
   * with, and so a test can answer it without a filesystem.
   */
  directoryExists: (path: string) => boolean
}

/** Bytes of `file` already consumed, or 0 if it has never been indexed. */
export function historyCursor(store: Store, file: string): number {
  const row = store.raw
    .prepare('SELECT bytes FROM history_index WHERE file = ?')
    .get(file) as { bytes: number } | undefined
  return row?.bytes ?? 0
}

/**
 * Applies one pass over the history file and the transcript directory.
 *
 * Everything happens in a single transaction, so a reader in the window never
 * sees an index that has the new prompts but not the aggregate built from
 * them - under WAL it sees the whole previous state until this commits.
 *
 * The aggregate is rebuilt in full rather than only for the sessions this pass
 * touched. It is one GROUP BY over the prompt table - a few milliseconds at
 * 3,470 rows - and the alternative is arithmetic that has to stay correct
 * across resets, re-reads and the same session appearing in two passes.
 */
export function indexHistory(store: Store, input: HistoryIndexInput): HistorySummary {
  const { sources, transcripts, directoryExists } = input

  /**
   * A reset wipes everything, not just the file that reset.
   *
   * The prompt table does not record which file a row came from, and giving it
   * a column would be a schema that has to be right about the past - rows
   * written before the column existed would have no source and no migration
   * could invent one. So the rare case pays for the common one: a file that
   * shrank or vanished rebuilds the whole index, which is correct by
   * construction because the caller re-reads every source from zero when this
   * is true (see `createHistoryService`).
   */
  const reset = sources.some((source) => source.tail.reset)
  const lines = sources.flatMap((source) => source.tail.lines)

  const apply = store.raw.transaction(() => {
    if (reset) {
      store.raw.prepare('DELETE FROM history_prompts').run()
      store.raw.prepare('DELETE FROM history_sessions').run()
    }

    if (lines.length > 0) {
      const next = store.raw
        .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM history_prompts')
        .get() as { seq: number }
      const insert = store.raw.prepare(
        `INSERT INTO history_prompts (seq, session_id, project, at, text, title_rank)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      let seq = next.seq
      for (const line of lines) {
        insert.run(
          seq++,
          line.sessionId,
          line.project,
          line.timestamp,
          line.display,
          titleRank(line.display)
        )
      }
    }

    // Always, because a database written before `title_rank` existed has every
    // row unranked and no new prompt is coming to trigger a pass.
    const backfilled = rankUnranked(store)

    if (reset || lines.length > 0 || backfilled > 0) {
      rebuildSessions(store)
    }

    // Always, even when no prompt was added: a transcript can be reaped, and a
    // project directory deleted, without the history file changing at all.
    applyTranscripts(store, transcripts)
    applyProjectExistence(store, directoryExists)

    const cursor = store.raw.prepare(
      `INSERT INTO history_index (file, bytes, indexed_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(file) DO UPDATE SET
         bytes = excluded.bytes, indexed_at = excluded.indexed_at`
    )
    for (const source of sources) cursor.run(source.file, source.tail.bytes)
  })
  apply()

  const summary = historySummary(
    store,
    sources.map((source) => source.file)
  )
  // The first error, and named, because "the index could not be read" over two
  // files is a sentence that does not say which one is missing.
  const failed = sources.find((source) => source.tail.error !== undefined)
  return failed === undefined
    ? summary
    : { ...summary, error: `${failed.file}: ${String(failed.tail.error)}` }
}

/**
 * Ranks the prompts that have no rank yet, and says how many it found.
 *
 * The one thing a migration could not do. `title_rank` is produced by a
 * function - `discovery/title.ts` - so the column arrives null on every row an
 * older build wrote, and nothing but a pass through JavaScript can fill it.
 * Running it on every pass rather than once behind a flag means the answer does
 * not depend on a marker that could be wrong: unranked rows are the only
 * evidence needed, and once there are none this is a scan that finds nothing.
 */
function rankUnranked(store: Store): number {
  const rows = store.raw
    .prepare('SELECT seq, text FROM history_prompts WHERE title_rank IS NULL')
    .all() as Array<{ seq: number; text: string }>
  if (rows.length === 0) return 0

  const set = store.raw.prepare('UPDATE history_prompts SET title_rank = ? WHERE seq = ?')
  for (const row of rows) set.run(titleRank(row.text), row.seq)
  return rows.length
}

/**
 * Recomputes every session row from the prompts.
 *
 * `project` and `first_prompt` are taken from the session's earliest prompt by
 * joining back on its `seq`, not with a bare column beside the aggregate:
 * SQLite would accept that and pick an arbitrary row, which is the kind of
 * thing that is right until the day it is not.
 *
 * `title_prompt` is the same join one rank down. The earliest prompt that says
 * something, or failing that the earliest that is at least legible - the order
 * `sessionTitleFrom` states in one line and this expresses as two `MIN`s, so
 * that choosing a title costs nothing beyond the GROUP BY already being run.
 * Both can be null - every prompt in the session being an image, or the ranks
 * not being backfilled yet - and the opening prompt is what it falls back to,
 * which is what this column showed before it existed.
 *
 * The conflict clause deliberately leaves the transcript columns alone - they
 * are owned by `applyTranscripts`, which knows what is on disk. Overwriting
 * them here would mark every session reaped on every pass. `history_names` is
 * untouched for a stronger reason: it is not derived from anything here, which
 * is why it is a table of its own.
 */
function rebuildSessions(store: Store): void {
  store.raw
    .prepare(
      `INSERT INTO history_sessions (
         session_id, project, project_key, prompt_count,
         first_at, last_at, first_prompt, title_prompt,
         transcript_file, transcript_bytes, project_exists
       )
       SELECT a.session_id, f.project, lower(f.project), a.n,
              a.first_at, a.last_at, f.text, COALESCE(t.text, f.text),
              NULL, NULL, 0
       FROM (
         SELECT session_id,
                COUNT(*) AS n,
                MIN(at)  AS first_at,
                MAX(at)  AS last_at,
                MIN(seq) AS first_seq,
                COALESCE(
                  MIN(CASE WHEN title_rank = 0 THEN seq END),
                  MIN(CASE WHEN title_rank = 1 THEN seq END)
                ) AS title_seq
         FROM history_prompts
         GROUP BY session_id
       ) a
       JOIN history_prompts f ON f.seq = a.first_seq
       LEFT JOIN history_prompts t ON t.seq = a.title_seq
       ON CONFLICT(session_id) DO UPDATE SET
         project      = excluded.project,
         project_key  = excluded.project_key,
         prompt_count = excluded.prompt_count,
         first_at     = excluded.first_at,
         last_at      = excluded.last_at,
         first_prompt = excluded.first_prompt,
         title_prompt = excluded.title_prompt`
    )
    .run()

  // A session can only lose all its prompts by the file being rewritten, which
  // resets the table anyway - but a row with nothing behind it would be a
  // session the launcher offers and cannot explain.
  store.raw
    .prepare(
      `DELETE FROM history_sessions
       WHERE session_id NOT IN (SELECT session_id FROM history_prompts)`
    )
    .run()
}

/** What is on disk now, not what was on disk when the row was written. */
function applyTranscripts(store: Store, transcripts: Map<string, TranscriptFile>): void {
  store.raw
    .prepare('UPDATE history_sessions SET transcript_file = NULL, transcript_bytes = NULL')
    .run()

  const mark = store.raw.prepare(
    `UPDATE history_sessions
     SET transcript_file = ?, transcript_bytes = ?
     WHERE lower(session_id) = ?`
  )
  for (const transcript of transcripts.values()) {
    mark.run(transcript.file, transcript.bytes, transcript.sessionId)
  }
}

/** One stat per distinct recorded directory, not one per session. */
function applyProjectExistence(store: Store, exists: (path: string) => boolean): void {
  const rows = store.raw
    .prepare('SELECT DISTINCT project, project_key FROM history_sessions')
    .all() as Array<{ project: string; project_key: string }>

  const set = store.raw.prepare('UPDATE history_sessions SET project_exists = ? WHERE project_key = ?')
  for (const row of rows) {
    set.run(exists(row.project) ? 1 : 0, row.project_key)
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface SessionRow {
  session_id: string
  project: string
  prompt_count: number
  first_at: number
  last_at: number
  first_prompt: string
  title_prompt: string | null
  label: string | null
  transcript_file: string | null
  transcript_bytes: number | null
  project_exists: number
  archive_state: ArchiveSessionState | null
  archived_messages: number | null
  match?: string | null
}

function toSession(row: SessionRow): HistorySession {
  // Derived here rather than stored, so a change to the rule reaches sessions
  // indexed by an older build without a re-index. `title_prompt` is which
  // prompt; this is what it reads as.
  const title = deriveSessionTitle(row.title_prompt ?? row.first_prompt)
  const session: HistorySession = {
    sessionId: row.session_id,
    project: row.project,
    projectName: basename(row.project) || row.project,
    promptCount: row.prompt_count,
    firstAt: row.first_at,
    lastAt: row.last_at,
    firstPrompt: row.first_prompt,
    title: title.text,
    titleFallback: title.fallback,
    label: row.label,
    transcriptFile: row.transcript_file,
    transcriptBytes: row.transcript_bytes,
    projectExists: row.project_exists === 1,
    archive: row.archive_state,
    archivedMessages: row.archived_messages
  }
  if (row.match !== undefined && row.match !== null) session.match = row.match
  return session
}

/**
 * The archive columns, joined onto every session read.
 *
 * A LEFT JOIN rather than a second query, because the list needs this on every
 * row it paints: which of the three states a session is in - resumable, kept
 * here, dropped for space - is a property of the row, not something to fetch
 * per selection. `history_sessions` is a table of ~800 rows and
 * `transcript_sessions` is keyed by the same id, so the join is an index lookup
 * per row.
 */
const ARCHIVE_JOIN = 'LEFT JOIN transcript_sessions a ON a.session_id = lower(s.session_id)'
const ARCHIVE_COLUMNS = `, a.state AS archive_state,
              CASE WHEN a.session_id IS NULL THEN NULL ELSE a.message_count END AS archived_messages`

/**
 * The hand-given name, joined on beside the derived one.
 *
 * Same shape as the archive join and for the same reason: which name a row
 * shows is a property of the row, and a second query per selection would mean
 * the list painting one name and the detail another. Lower-cased on the way in,
 * because that is how `history_names` is keyed.
 */
const NAME_JOIN = 'LEFT JOIN history_names n ON n.session_id = lower(s.session_id)'
const NAME_COLUMN = ', n.name AS label'

/**
 * A substring of a prompt or a project path, as a LIKE pattern.
 *
 * FTS5 was the other option and is the wrong one here. This box filters a list
 * while you type, so `geofenc` has to match `geofencing` and `--resume` has to
 * match itself; a tokenising index matches whole words and would find neither.
 * The cost is a table scan, which at 3,470 rows and 284 KB of prompt text
 * measures around a millisecond - see `pnpm history-check`, which asserts on
 * it.
 */
function likePattern(search: string): string {
  const escaped = search.replace(/[\\%_]/g, (char) => `\\${char}`)
  return `%${escaped}%`
}

interface Filters {
  where: string
  params: Record<string, string | number>
  /** Bound positionally, ahead of the named parameters. See `readHistorySessions`. */
  ids: string[]
  searching: boolean
}

function buildFilters(query: HistoryQuery, archived: Map<string, ArchiveMatch> | null): Filters {
  const clauses: string[] = []
  const params: Record<string, string | number> = {}
  const ids: string[] = []

  const search = query.search?.trim() ?? ''

  if (search !== '' && archived !== null) {
    // The archive's answer, as a list of ids. Empty is a real answer - nothing
    // said that - and it has to produce no rows rather than no filter, hence
    // the `IN ()` that a zero-length list would not express: the impossible
    // clause is written explicitly.
    ids.push(...archived.keys())
    clauses.push(
      ids.length === 0
        ? '0'
        : `lower(s.session_id) IN (${ids.map(() => '?').join(', ')})`
    )
  } else if (search !== '') {
    params['like'] = likePattern(search)
    // The project counts as well as the prompt. "Every session in that
    // repository" is the same gesture as "the session where I asked about X",
    // and the project dropdown beside this box only answers the first once you
    // already know which project you want - which a history spanning dozens of
    // them is exactly the case you do not. Matched against `project_key`, which
    // is stored lower-cased, so the comparison does not depend on LIKE's
    // ASCII-only case folding.
    params['likeKey'] = likePattern(search.toLowerCase())
    // A hand-given name counts too. It is what the row shows, so a search that
    // could not find it would be a name you can read and cannot look up.
    clauses.push(
      `(s.session_id IN (SELECT session_id FROM history_prompts WHERE text LIKE @like ESCAPE '\\')
        OR s.project_key LIKE @likeKey ESCAPE '\\'
        OR n.name LIKE @like ESCAPE '\\')`
    )
  }

  const project = query.project?.trim()
  if (project !== undefined && project !== '') {
    params['project'] = project.toLowerCase()
    clauses.push('s.project_key = @project')
  }

  if (query.resumableOnly === true) {
    clauses.push('s.transcript_file IS NOT NULL AND s.project_exists = 1')
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    ids,
    searching: search !== ''
  }
}

/**
 * Most recently active first. `total` is the match count before `limit`.
 *
 * `scope: 'messages'` searches the archive instead of the prompts: FTS5 answers
 * with session ids, and this filters the list to them. The two scopes are kept
 * apart rather than unioned - see `HistorySearchScope` - and the shape of the
 * query is what enforces it, so a caller cannot accidentally get both.
 */
export function readHistorySessions(store: Store, query: HistoryQuery = {}): HistoryPage {
  const started = performance.now()
  const search = query.search?.trim() ?? ''
  const overMessages = query.scope === 'messages' && search !== ''
  const archived = overMessages ? searchArchive(store, search) : null

  const { where, params, ids, searching } = buildFilters(query, archived)
  const limit = Math.max(1, query.limit ?? DEFAULT_LIMIT)

  // Only computed when there is a prompt search to have matched: an unfiltered
  // listing pays nothing for a column it would not show, and a message search
  // already has its match in hand from FTS5.
  const matchColumn =
    searching && archived === null
      ? `, (SELECT p.text FROM history_prompts p
          WHERE p.session_id = s.session_id AND p.text LIKE @like ESCAPE '\\'
          ORDER BY p.seq LIMIT 1) AS match`
      : ''

  // Anonymous parameters first, then the named ones as the final argument -
  // better-sqlite3's own convention for a statement that carries both. The
  // anonymous ones are the archive's session ids, which cannot be named because
  // there is an unknown number of them.
  const rows = store.raw
    .prepare(
      `SELECT s.session_id, s.project, s.prompt_count, s.first_at, s.last_at,
              s.first_prompt, s.title_prompt, s.transcript_file, s.transcript_bytes,
              s.project_exists${ARCHIVE_COLUMNS}${NAME_COLUMN}${matchColumn}
       FROM history_sessions s
       ${ARCHIVE_JOIN}
       ${NAME_JOIN}
       ${where}
       ORDER BY s.last_at DESC, s.session_id
       LIMIT @limit`
    )
    .all(...ids, { ...params, limit }) as SessionRow[]

  const { total } = store.raw
    .prepare(
      `SELECT COUNT(*) AS total FROM history_sessions s ${ARCHIVE_JOIN} ${NAME_JOIN} ${where}`
    )
    .get(...ids, params) as { total: number }

  const sessions = rows.map(toSession)
  if (archived !== null) {
    for (const session of sessions) {
      const hit = archived.get(session.sessionId.toLowerCase())
      if (hit !== undefined) session.match = hit.text
    }
  }

  return { sessions, total, tookMs: performance.now() - started }
}

/** Every prompt of one session, in submission order. */
export function readHistoryPrompts(store: Store, sessionId: string): HistoryPrompt[] {
  const rows = store.raw
    .prepare(
      `SELECT seq, session_id, at, text FROM history_prompts
       WHERE session_id = ? ORDER BY seq`
    )
    .all(sessionId) as Array<{ seq: number; session_id: string; at: number; text: string }>

  return rows.map((row) => ({
    sessionId: row.session_id,
    seq: row.seq,
    text: row.text,
    at: row.at
  }))
}

/** The recorded working directories, busiest-most-recent first. */
export function readHistoryProjects(store: Store): HistoryProject[] {
  const rows = store.raw
    .prepare(
      `SELECT project_key,
              MAX(project)      AS project,
              COUNT(*)          AS sessions,
              SUM(prompt_count) AS prompts,
              MAX(last_at)      AS last_at,
              SUM(CASE WHEN transcript_file IS NOT NULL AND project_exists = 1
                       THEN 1 ELSE 0 END) AS resumable,
              MAX(project_exists) AS exists_flag
       FROM history_sessions
       GROUP BY project_key
       ORDER BY last_at DESC`
    )
    .all() as Array<{
    project: string
    sessions: number
    prompts: number
    last_at: number
    resumable: number
    exists_flag: number
  }>

  return rows.map((row) => ({
    project: row.project,
    name: basename(row.project) || row.project,
    sessions: row.sessions,
    prompts: row.prompts,
    lastAt: row.last_at,
    resumable: row.resumable,
    exists: row.exists_flag === 1
  }))
}

/**
 * The totals, over every source at once.
 *
 * The aggregate has always been a scan of the whole table rather than a
 * per-file sum, which is why two homes needed nothing here: a session is a
 * session, and the launcher's list, its project grouping and its resumable
 * count were already answering "what is in the index" rather than "what is in
 * that file". Only the cursor is per file, and it is summed.
 *
 * `files` is primary-first: the head of it is what the UI names when it has
 * room for one file, and the whole of it is what it lists when it does not.
 */
export function historySummary(store: Store, files: readonly string[]): HistorySummary {
  const totals = store.raw
    .prepare(
      `SELECT COUNT(*)                        AS sessions,
              COALESCE(SUM(prompt_count), 0)  AS prompts,
              COUNT(DISTINCT project_key)     AS projects,
              COALESCE(MAX(last_at), 0)       AS latest_at,
              SUM(CASE WHEN transcript_file IS NOT NULL AND project_exists = 1
                       THEN 1 ELSE 0 END)     AS resumable
       FROM history_sessions`
    )
    .get() as {
    sessions: number
    prompts: number
    projects: number
    latest_at: number
    resumable: number | null
  }

  return {
    sessions: totals.sessions,
    prompts: totals.prompts,
    projects: totals.projects,
    resumable: totals.resumable ?? 0,
    latestAt: totals.latest_at > 0 ? totals.latest_at : null,
    historyFile: files[0] ?? '',
    historyFiles: [...files],
    indexedBytes: files.reduce((sum, file) => sum + historyCursor(store, file), 0)
  }
}

/** One session by id, or null. The resume path's lookup. */
export function readHistorySession(store: Store, sessionId: string): HistorySession | null {
  const row = store.raw
    .prepare(
      `SELECT s.session_id, s.project, s.prompt_count, s.first_at, s.last_at, s.first_prompt,
              s.title_prompt, s.transcript_file, s.transcript_bytes,
              s.project_exists${ARCHIVE_COLUMNS}${NAME_COLUMN}
       FROM history_sessions s ${ARCHIVE_JOIN} ${NAME_JOIN} WHERE s.session_id = ?`
    )
    .get(sessionId) as SessionRow | undefined
  return row ? toSession(row) : null
}

/**
 * Names a session by hand, or clears the name it was given.
 *
 * The one write in this file that is not derived from a file Helm does not own,
 * and it goes to `history_names` rather than to a column on `history_sessions`
 * for the reason that table's comment gives: the aggregate is rebuilt in full,
 * and anything authored that lived on it would last until the next pass.
 *
 * Clearing **deletes the row** rather than writing an empty string, so a
 * cleared session is one that was never renamed - which is what makes it fall
 * back to the derived title instead of to a blank line. The name is sanitised
 * the way a tab's is: a control or zero-width character is invisible in the
 * field and reorders the row it lands in.
 *
 * Returns the session as it now reads, or null for an id the index does not
 * have - a caller asking about a session from a database this build has never
 * seen gets to say so rather than to write a row nothing joins to.
 */
export function renameHistorySession(
  store: Store,
  sessionId: string,
  name: string | null
): HistorySession | null {
  const key = sessionId.toLowerCase()
  const clean = (name ?? '').replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim()

  if (clean === '') {
    store.raw.prepare('DELETE FROM history_names WHERE session_id = ?').run(key)
  } else {
    store.raw
      .prepare(
        `INSERT INTO history_names (session_id, name, renamed_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(session_id) DO UPDATE SET
           name = excluded.name, renamed_at = excluded.renamed_at`
      )
      .run(key, clean.slice(0, HISTORY_NAME_MAX))
  }

  return readHistorySession(store, sessionId)
}

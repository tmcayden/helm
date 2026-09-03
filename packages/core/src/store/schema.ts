import { sql } from 'drizzle-orm'
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex
} from 'drizzle-orm/sqlite-core'
import type { PullDetail, PullPatch, PullSummary } from '../github/types'

/**
 * `profiles` and `config_snapshots` are not read by any surface yet - they exist
 * so that profiles and the config console's snapshots start from a
 * migrated schema rather than a schema change on a database that already holds
 * a user's data.
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

/**
 * A saved launch composition: cwd, overlays, access dirs, model flags. Stored
 * as JSON columns rather than join tables - a profile is edited and launched
 * whole, never queried by its parts, and YAML export (SPEC 3) is a straight
 * serialisation of this row.
 */
export const profiles = sqliteTable(
  'profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    root: text('root').notNull(),
    /** JSON array of project paths composed via `--plugin-dir`. */
    overlays: text('overlays', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** JSON array of paths passed to `--add-dir`. */
    access: text('access', { mode: 'json' }).$type<string[]>().notNull().default([]),
    model: text('model'),
    effort: text('effort'),
    permissionMode: text('permission_mode'),
    agent: text('agent'),
    /** JSON array of MCP server names. */
    mcp: text('mcp', { mode: 'json' }).$type<string[]>().notNull().default([]),
    openingPrompt: text('opening_prompt'),
    /** Launcher ordering; null means unpinned. */
    pinnedOrder: integer('pinned_order'),
    /**
     * Where this profile's sessions run: null or `windows`, or `wsl:<distro>`.
     *
     * One text column rather than two, and nullable, because every row written
     * before this existed means Windows - which is exactly what a null reads
     * back as. The same spelling the YAML export uses, so the column and the
     * file are not two formats for one fact.
     */
    target: text('target'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now)
  },
  (t) => [uniqueIndex('profiles_name_unique').on(t.name)]
)

/**
 * Every project discovery has ever seen. Cached so the launcher paints before
 * the first scan finishes, and so a project that has gone missing can be shown
 * as missing rather than silently vanishing.
 */
export const projects = sqliteTable(
  'projects',
  {
    path: text('path').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['harness', 'repo', 'folder'] }).notNull(),
    harnessPath: text('harness_path'),
    /**
     * `template:` from the harness manifest, for a `kind: 'harness'` row only.
     *
     * Provenance rather than behaviour: nothing reads it back to decide
     * anything, and a harness is free to stop resembling the template it came
     * from the moment it exists. It is here because the launcher paints from
     * this cache before the first scan lands, and a fact that the cache drops
     * is a fact that flickers on every start.
     */
    template: text('template'),
    hasClaudeDir: integer('has_claude_dir', { mode: 'boolean' }).notNull().default(false),
    /** JSON `ClaudeInventory`. */
    inventory: text('inventory', { mode: 'json' }).notNull(),
    /** JSON `GitState`, or null for a directory that is not a repo. */
    git: text('git', { mode: 'json' }),
    lastSeenAt: text('last_seen_at').notNull().default(now)
  },
  (t) => [index('projects_harness_idx').on(t.harnessPath)]
)

/**
 * A copy of a config file taken immediately before Helm overwrites it.
 * Content is stored inline: `.claude` files are small, and a snapshot that
 * depends on the file still being on disk is not a snapshot.
 */
export const configSnapshots = sqliteTable(
  'config_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Project the file belongs to; not a foreign key, so a snapshot outlives
     * the project row if the directory is removed. */
    projectPath: text('project_path').notNull(),
    /** Path relative to the project root, e.g. `.claude/settings.json`. */
    filePath: text('file_path').notNull(),
    content: text('content').notNull(),
    /** sha256 of `content`, so an unchanged write can skip a row. */
    contentHash: text('content_hash').notNull(),
    /** What caused the snapshot: `edit`, `import`, `revert`. */
    reason: text('reason').notNull(),
    createdAt: text('created_at').notNull().default(now)
  },
  (t) => [index('config_snapshots_file_idx').on(t.projectPath, t.filePath, t.createdAt)]
)

/**
 * Every hosted `claude` process Helm has spawned, with how it ended.
 *
 * Written on spawn rather than on exit: a row that exists only once a process
 * has terminated cannot answer "what is running right now", and it loses the
 * session entirely if the app dies first. The cost is that a crash leaves rows
 * claiming to be running, which the next launch reconciles to `lost`.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Passed to the CLI as `-n`; what `/resume` shows later. */
    name: text('name').notNull(),
    /**
     * What Helm calls this session on screen. Null means "no label, use `name`".
     *
     * A SECOND COLUMN, AND THE DIVERGENCE IS THE POINT. `name` was handed to a
     * process that is already running - it is in that session's argv, it is what
     * Claude Code's own `/resume` list prints, and rewriting it here would make
     * this table disagree with a fact about a spawned process that nothing can
     * go back and change. So a rename writes here and `name` is never touched.
     *
     * The consequence is deliberate and one-directional: a session the user
     * renamed to "PR review" is still `dev 2` in `/resume`. That is the honest
     * shape. Helm's tab is Helm's own label for a conversation, `/resume`'s row
     * is Claude Code's, and the alternative - passing a rename back to the CLI -
     * is not available for a process that was spawned an hour ago, so the only
     * way to keep the two identical would be to refuse to rename at all.
     *
     * Nothing derives this from what the session printed (CLAUDE.md "Helm
     * renders nothing for a live session"): it is null until a person types
     * something into the tab.
     */
    label: text('label'),
    cwd: text('cwd').notNull(),
    /**
     * The git branch `cwd` was on **when this session was spawned**, or null for
     * a cwd that is not a repository, is on a detached HEAD, or could not be
     * read.
     *
     * A column rather than a lookup through `project_path`, because a working
     * tree has one branch at a time and the whole question this answers is how
     * two sessions *in that same tree* differ. Deriving it live would paint the
     * same subtitle on both of them the moment the branch moved, which is the
     * case the subtitle exists for. See `readGitBranch`'s call site in
     * `main/sessions.ts` for why it is captured and not followed.
     */
    branch: text('branch'),
    /** Path of the discovered project, or null for a cwd chosen another way. */
    projectPath: text('project_path'),
    /** The profile this was launched from. Deliberately not a foreign key - a
     * session row is history, and deleting a profile does not unmake it. */
    profileId: integer('profile_id'),
    /** JSON array of the argv after the executable. */
    argv: text('argv', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /**
     * The Claude Code conversation id, **assigned by Helm at launch** through
     * `--session-id` rather than discovered afterwards.
     *
     * A column rather than something derived from `argv`, which already carries
     * the flag: parsing a string this repository wrote, to recover a value it
     * had in hand at the moment it wrote it, is a second parser with a second
     * way to be wrong.
     *
     * Nullable, and null is a real answer in three cases - a row from before
     * this column existed, a CLI with no `--session-id` flag, and a resume of a
     * conversation whose id the history index did not have. All three mean "no
     * durable join to the conversation", which the reader treats as a fact
     * rather than an error.
     *
     * **Not unique, deliberately.** `/clear` gives a live process a new
     * conversation id under the same pid, so this records the id a session
     * *started* as; two rows sharing one is not a state to refuse at the
     * database. What is never reused is the id passed at launch - the CLI
     * refuses a uuid that already exists outright.
     */
    claudeSessionId: text('claude_session_id'),
    status: text('status', { enum: ['running', 'exited', 'lost'] })
      .notNull()
      .default('running'),
    startedAt: text('started_at').notNull().default(now),
    endedAt: text('ended_at'),
    durationMs: integer('duration_ms'),
    exitCode: integer('exit_code')
  },
  // The launcher lists sessions newest-first across every project, which is
  // the one query
  // this table is going to be asked for at any size.
  (t) => [index('sessions_started_idx').on(t.startedAt), index('sessions_status_idx').on(t.status)]
)

/**
 * Every prompt `~/.claude/history.jsonl` has ever recorded, on any project.
 *
 * A mirror of a file Helm does not own, kept in SQLite so it can be searched
 * and grouped rather than re-parsed per keystroke. `seq` is submission order,
 * assigned by the indexer as lines arrive - the file has no id of its own, and
 * the timestamp is not unique enough to order by on its own.
 */
export const historyPrompts = sqliteTable(
  'history_prompts',
  {
    seq: integer('seq').primaryKey(),
    sessionId: text('session_id').notNull(),
    /** Working directory as recorded, casing and all. */
    project: text('project').notNull(),
    /** Epoch milliseconds. */
    at: integer('at').notNull(),
    text: text('text').notNull(),
    /**
     * How usable this prompt is as the session's title: 0 says something, 1 is
     * legible but subjectless, 2 is nothing at all. `titleRank` in
     * `discovery/title.ts` is the authority and the only thing that writes it.
     *
     * Stored rather than computed on read so the aggregate can pick a session's
     * title prompt with a `MIN(seq)` per rank instead of pulling 284 KB of
     * prompt text into JavaScript on every pass.
     *
     * **Nullable, and that is the upgrade path.** A database written before
     * this column existed has 4,000 rows with no rank, and a migration cannot
     * compute one - the rule is a function, not SQL. So null means "not ranked
     * yet" and the next index pass backfills it; see `rankUnranked`.
     */
    titleRank: integer('title_rank')
  },
  // The search is a substring match, which no index can serve - so the index
  // that matters is the one that turns a matched session back into its
  // prompts, and the one that finds a session's opening prompt.
  (t) => [index('history_prompts_session_idx').on(t.sessionId, t.seq)]
)

/**
 * One row per session in `history_prompts`, aggregated, plus what the disk
 * currently says about resuming it.
 *
 * Derived rather than authoritative: everything except the transcript columns
 * is recomputed from `history_prompts`, and the transcript columns are
 * recomputed from `projects/*`. The table exists because the launcher's default
 * view is 799 sessions ordered by recency, and doing that as a GROUP BY on
 * every repaint is work with a known answer.
 */
export const historySessions = sqliteTable(
  'history_sessions',
  {
    sessionId: text('session_id').primaryKey(),
    project: text('project').notNull(),
    /** Lowercased `project`. The same folder gets recorded under more than one
     * casing, and grouping by the raw string splits it in two. */
    projectKey: text('project_key').notNull(),
    promptCount: integer('prompt_count').notNull(),
    firstAt: integer('first_at').notNull(),
    lastAt: integer('last_at').notNull(),
    firstPrompt: text('first_prompt').notNull(),
    /**
     * The prompt the title is derived from: the earliest one with the best
     * `title_rank`, which is the opener only when the opener says something.
     * Raw text, cleaned and truncated on the way out by `deriveSessionTitle` -
     * a stored title would be a second copy of a rule that can change.
     */
    titlePrompt: text('title_prompt'),
    /** Null once Claude Code has reaped it; the session is then history-only. */
    transcriptFile: text('transcript_file'),
    transcriptBytes: integer('transcript_bytes'),
    projectExists: integer('project_exists', { mode: 'boolean' }).notNull().default(false)
  },
  (t) => [
    index('history_sessions_last_idx').on(t.lastAt),
    index('history_sessions_project_idx').on(t.projectKey, t.lastAt)
  ]
)

/**
 * A name somebody gave a session by hand.
 *
 * **Its own table, and that is the whole design.** Every other `history_*`
 * table is derived: `indexHistory` empties `history_sessions` on a reset and
 * rebuilds it in full from the prompts, deliberately, so its arithmetic cannot
 * drift. A `label` column on that table would therefore last exactly until the
 * next re-index. This one is the only thing in the family that is authored
 * rather than computed, so it is the only one nothing rebuilds - the rebuild
 * does not know it exists, and the read joins it back on.
 *
 * Lower-cased, like `transcript_sessions`: `history.jsonl` and the transcript
 * file names disagree on the casing of a session id, and a rename keyed on the
 * raw string would come back attached to nothing.
 */
export const historyNames = sqliteTable('history_names', {
  sessionId: text('session_id').primaryKey(),
  /** Never empty - clearing a name deletes the row, it does not blank it. */
  name: text('name').notNull(),
  renamedAt: text('renamed_at').notNull().default(now)
})

/**
 * How much of the history file has been consumed, so the next pass reads only
 * what has appeared since. Keyed by path: pointing `CLAUDE_CONFIG_DIR` at a
 * different tree is a different cursor, not a corrupt one.
 */
export const historyIndex = sqliteTable('history_index', {
  file: text('file').primaryKey(),
  bytes: integer('bytes').notNull(),
  indexedAt: text('indexed_at').notNull().default(now)
})

/**
 * One assistant message's token usage, out of a transcript under `projects/`.
 *
 * Rows rather than pre-summed buckets. The windows this answers - the 5-hour
 * one aligned with the plan's own reset time, local midnight to now, a rolling
 * 7 days - all slide, and none of them land on an hour boundary, so a bucketed
 * table would be wrong by up to a bucket at every edge. 22,180 rows over the
 * surviving 26 days is small enough that a SUM over an index on `at` is not
 * worth optimising away.
 *
 * The primary key is the transcript row's own uuid, which is what makes the
 * index idempotent: a forked conversation copies its parent's history into a
 * new file, and re-reading a file from zero re-offers rows already counted.
 */
export const usageMessages = sqliteTable(
  'usage_messages',
  {
    uuid: text('uuid').primaryKey(),
    /** Epoch ms. */
    at: integer('at').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Split by TTL: a 5-minute write is 1.25x base input, an hour is 2x. */
    cacheWrite5mTokens: integer('cache_write_5m_tokens').notNull().default(0),
    cacheWrite1hTokens: integer('cache_write_1h_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0)
  },
  // Every query this table serves is a range over `at`, grouped by model.
  (t) => [index('usage_messages_at_idx').on(t.at, t.model)]
)

/**
 * How much of each transcript has been consumed. Keyed by path, like
 * `history_index`, so pointing at a different tree is a different cursor rather
 * than a corrupt one.
 */
export const usageIndex = sqliteTable('usage_index', {
  file: text('file').primaryKey(),
  bytes: integer('bytes').notNull(),
  /** Rows taken from this file. Lets a pass report progress without a COUNT. */
  rows: integer('rows').notNull().default(0),
  indexedAt: text('indexed_at').notNull().default(now)
})

/**
 * One archived conversation, keyed by the session id `history_sessions` uses so
 * the two join.
 *
 * The row outlives the transcript it was read from, which is the entire point:
 * Claude Code reaps transcripts on its own schedule and 91% of the
 * conversations behind `history.jsonl` were already gone when this was measured
 * (744 sessions recorded, 68 transcripts surviving, 2026-08-08).
 *
 * `state` is what makes "we had this and dropped it to stay under your limit" a
 * different sentence from "this was reaped before Helm ever saw it". An evicted
 * row keeps every figure it had - the message count, the bytes, when it was
 * captured - and loses only its messages, so the surface can say which happened
 * and the archive cannot re-capture what the ceiling just threw away.
 */
export const transcriptSessions = sqliteTable(
  'transcript_sessions',
  {
    /** Lower-cased, because `history.jsonl` and the file names disagree on case. */
    sessionId: text('session_id').primaryKey(),
    /** The transcript this was read from. May no longer exist; that is expected. */
    sourceFile: text('source_file').notNull(),
    /** `archived` while the messages are here, `evicted` once the ceiling took them. */
    state: text('state', { enum: ['archived', 'evicted'] })
      .notNull()
      .default('archived'),
    /** Epoch ms of the first and last message captured. */
    firstAt: integer('first_at'),
    lastAt: integer('last_at'),
    messageCount: integer('message_count').notNull().default(0),
    /** Message text as it was read, in bytes, before compression. */
    rawBytes: integer('raw_bytes').notNull().default(0),
    /** What is actually in this database for it. The ceiling is enforced on this. */
    storedBytes: integer('stored_bytes').notNull().default(0),
    capturedAt: text('captured_at').notNull().default(now),
    /** When the ceiling dropped it. Null while `state` is `archived`. */
    evictedAt: text('evicted_at')
  },
  // Eviction asks one question - which archived session is oldest - and the
  // settings pane asks the other, which is how much is stored.
  (t) => [index('transcript_sessions_oldest_idx').on(t.state, t.lastAt)]
)

/**
 * The messages, one row each.
 *
 * `uuid` is the dedup key for the reason `usage_messages` gives: a forked
 * conversation copies its parent's history into a new file, so the same message
 * genuinely is on disk twice, and re-reading a file from zero re-offers every
 * row it has ever had. It is a UNIQUE column rather than the primary key
 * because the FTS index below is keyed by rowid, and an integer `id` is the
 * rowid rather than an alias for a 36-character string.
 *
 * `body` is compressed (`node:zlib` raw deflate) unless compressing it made it
 * bigger, which happens for the short ones - hence `compressed`, and hence
 * `stored_bytes` being recorded rather than derived. The ceiling is enforced
 * against what is on disk, so what is on disk is what gets counted.
 */
export const transcriptMessages = sqliteTable(
  'transcript_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    uuid: text('uuid').notNull(),
    sessionId: text('session_id').notNull(),
    /** `user` or `assistant`. Stored as text; a transcript has two speakers. */
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    /** Epoch ms. Ordering within a session, and the archive's own time axis. */
    at: integer('at').notNull(),
    body: blob('body').notNull(),
    compressed: integer('compressed', { mode: 'boolean' }).notNull().default(false),
    rawBytes: integer('raw_bytes').notNull().default(0),
    storedBytes: integer('stored_bytes').notNull().default(0)
  },
  (t) => [
    uniqueIndex('transcript_messages_uuid_unique').on(t.uuid),
    index('transcript_messages_session_idx').on(t.sessionId, t.at, t.id)
  ]
)

/**
 * How much of each transcript has been archived. Keyed by path, like
 * `usage_index` and `history_index`, so pointing `CLAUDE_CONFIG_DIR` at a
 * different tree is a different cursor rather than a corrupt one.
 *
 * Separate from `usage_index` deliberately, even though both are cursors into
 * the same files: that one records bytes whose *tokens* have been counted, and
 * a database that already has it at EOF would otherwise mean the archive could
 * only ever capture what was appended after this feature shipped.
 */
export const transcriptIndex = sqliteTable('transcript_index', {
  file: text('file').primaryKey(),
  bytes: integer('bytes').notNull(),
  /** Messages taken from this file. Lets a pass report progress without a COUNT. */
  messages: integer('messages').notNull().default(0),
  indexedAt: text('indexed_at').notNull().default(now)
})

/*
 * THERE IS A FOURTH ARCHIVE TABLE AND IT IS NOT IN THIS FILE.
 *
 * `transcript_fts` is an FTS5 virtual table, and drizzle-kit does not model
 * virtual tables at all - it cannot generate one and it cannot see one that
 * exists. So the table, its trigger and its `PRAGMA` live as hand-written SQL
 * appended to the end of the generated migration that created the three tables
 * above (`drizzle/0007_*.sql`). `pnpm db:generate` re-runs
 * `scripts/embed-migrations.mjs` over whatever is in that folder, so a
 * hand-edited migration survives regeneration; a *new* migration that needs to
 * touch the FTS table has to carry its own hand-written SQL the same way.
 *
 * Two things about it will trip up the next schema change here:
 *
 *   It is **contentless** (`content=''`). The message text is not in it - the
 *   text lives compressed in `transcript_messages.body`, and there is no column
 *   a trigger could read it out of. So an INSERT into the index is done in code,
 *   beside the INSERT into `transcript_messages` and inside the same
 *   transaction (`store/archive.ts`). A search returns rowids and the text is
 *   decompressed to show it.
 *
 *   The DELETE *is* a trigger (`AFTER DELETE ON transcript_messages`), because
 *   it needs only `old.id`, and because eviction is the path that would
 *   otherwise silently leak index entries for messages that no longer exist.
 *   That needs `contentless_delete=1`, which is SQLite 3.43+; better-sqlite3 13
 *   bundles 3.53.
 */

/** Single-row-per-key JSON blobs. See `AppSettings` for the key space. */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  /** JSON-encoded value. */
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(now)
})

/**
 * What each discovered project's `origin` remote turned out to be.
 *
 * Keyed by path rather than by slug, because the question this answers is
 * "which of the directories on this machine are GitHub repositories" - and two
 * checkouts of the same repository are two rows with one slug between them,
 * which is exactly the shape a fetch wants to deduplicate against.
 *
 * A `slug` of null is an answer, not a gap: it means the remote was read and is
 * not github.com. `checked_at` is what separates that from "not yet looked at",
 * so a machine full of non-GitHub folders is asked once rather than every pass.
 */
export const prRepos = sqliteTable('pr_repos', {
  path: text('path').primaryKey(),
  /** `git remote get-url origin`, credentials stripped. Null: no origin. */
  url: text('url'),
  /** `owner/name`, or null when the origin is not a github.com remote. */
  slug: text('slug'),
  /** When the remote was last read. Null means never. */
  checkedAt: text('checked_at'),
  /** When a fetch last **succeeded**; what the pane's age caption reports. */
  fetchedAt: text('fetched_at'),
  /** Why the last attempt failed. Cached pull requests outlive it. */
  error: text('error')
})

/**
 * Open pull requests, cached so the pane paints before any `gh` has run.
 *
 * Keyed by (slug, number) rather than by repository path: a pull request
 * belongs to a repository on GitHub, not to a directory, and two checkouts of
 * the same repository must not hold two copies of the same list.
 *
 * `summary` is what the list needs and `detail` is the conversation behind it,
 * fetched only when a pull request is opened and null until then - two columns
 * because they cost two very different requests and go stale on different
 * schedules.
 */
export const pullRequests = sqliteTable(
  'pull_requests',
  {
    slug: text('slug').notNull(),
    number: integer('number').notNull(),
    /** JSON `PullSummary`. */
    summary: text('summary', { mode: 'json' }).$type<PullSummary>().notNull(),
    /** JSON `PullDetail`, or null until the pull request has been opened. */
    detail: text('detail', { mode: 'json' }).$type<PullDetail>(),
    /**
     * JSON `PullPatch`: `gh pr diff`, capped at `MAX_DIFF_BYTES`.
     *
     * The patch and not the parse, which is the call the rendered markdown makes
     * and for the same reason: what git said is a fact that keeps, and a column
     * of parsed hunks would be this month's shape of `PullDiffLine` frozen into
     * a database that outlives it. Null means no patch has been fetched - a pull
     * request cached before Helm fetched patches at all, or one whose `pr diff`
     * failed - and is a different fact from an empty `text`, which is a pull
     * request that genuinely changed nothing.
     */
    diff: text('diff', { mode: 'json' }).$type<PullPatch>(),
    fetchedAt: text('fetched_at').notNull().default(now),
    detailFetchedAt: text('detail_fetched_at')
  },
  (t) => [primaryKey({ columns: [t.slug, t.number] })]
)

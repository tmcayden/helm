import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HistoryTail, TranscriptFile } from '../discovery/history'
import { canResume } from '../types'
import { openStore, type Store } from './db'
import {
  historyCursor,
  historySummary,
  indexHistory,
  readHistoryProjects,
  readHistoryPrompts,
  readHistorySession,
  readHistorySessions,
  renameHistorySession
} from './history'

let dir: string
let store: Store
const HISTORY = 'C:\\Users\\x\\.claude\\history.jsonl'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'helm-history-store-'))
  store = openStore({ file: join(dir, 'helm.db') })
})

afterEach(async () => {
  store.close()
  await rm(dir, { recursive: true, force: true })
})

const ALPHA = 'C:\\repos\\alpha'
const BETA = 'C:\\repos\\beta'

interface Prompt {
  sessionId: string
  text: string
  project?: string
  at?: number
}

let clock = 1_700_000_000_000

function tail(prompts: Prompt[], overrides: Partial<HistoryTail> = {}): HistoryTail {
  return {
    lines: prompts.map((p) => ({
      sessionId: p.sessionId,
      project: p.project ?? ALPHA,
      timestamp: p.at ?? (clock += 1000),
      display: p.text
    })),
    bytes: 100,
    reset: false,
    skipped: 0,
    ...overrides
  }
}

function transcripts(...ids: string[]): Map<string, TranscriptFile> {
  return new Map(
    ids.map((id) => [
      id.toLowerCase(),
      { sessionId: id.toLowerCase(), file: join(dir, `${id}.jsonl`), bytes: 1234, modifiedMs: 1 }
    ])
  )
}

/** Everything present: the common case, so the interesting tests say less. */
function index(
  prompts: Prompt[],
  opts: {
    transcripts?: Map<string, TranscriptFile>
    missingProjects?: string[]
    tail?: Partial<HistoryTail>
  } = {}
): ReturnType<typeof indexHistory> {
  const missing = new Set((opts.missingProjects ?? []).map((p) => p.toLowerCase()))
  return indexHistory(store, {
    sources: [{ file: HISTORY, tail: tail(prompts, opts.tail) }],
    transcripts: opts.transcripts ?? new Map(),
    directoryExists: (path) => !missing.has(path.toLowerCase())
  })
}

describe('indexHistory', () => {
  it('turns a file of prompts into sessions ordered by recency', () => {
    index([
      { sessionId: 'a', text: 'first thing' },
      { sessionId: 'a', text: 'second thing' },
      { sessionId: 'b', text: 'another session', project: BETA }
    ])

    const { sessions, total } = readHistorySessions(store)
    expect(total).toBe(2)
    expect(sessions.map((s) => s.sessionId)).toEqual(['b', 'a'])
    expect(sessions[1]).toMatchObject({
      sessionId: 'a',
      project: ALPHA,
      projectName: 'alpha',
      promptCount: 2,
      firstPrompt: 'first thing'
    })
  })

  it('records the cursor so the next pass can resume from it', () => {
    index([{ sessionId: 'a', text: 'x' }], { tail: { bytes: 4096 } })
    expect(historyCursor(store, HISTORY)).toBe(4096)
    expect(historyCursor(store, 'C:\\somewhere\\else.jsonl')).toBe(0)
  })

  it('merges an appended pass into the sessions already indexed', () => {
    index([{ sessionId: 'a', text: 'first' }])
    index([
      { sessionId: 'a', text: 'follow up' },
      { sessionId: 'c', text: 'new session' }
    ])

    const { sessions } = readHistorySessions(store)
    expect(sessions).toHaveLength(2)
    const a = sessions.find((s) => s.sessionId === 'a')
    expect(a?.promptCount).toBe(2)
    // The opening prompt is the opening prompt, not the most recent one.
    expect(a?.firstPrompt).toBe('first')
    expect(a?.lastAt).toBeGreaterThan(a?.firstAt ?? 0)
  })

  it('discards everything when the file has been replaced', () => {
    index([{ sessionId: 'a', text: 'old world' }])
    index([{ sessionId: 'z', text: 'new world' }], { tail: { reset: true } })

    const { sessions } = readHistorySessions(store)
    expect(sessions.map((s) => s.sessionId)).toEqual(['z'])
    expect(readHistoryPrompts(store, 'a')).toEqual([])
  })

  it('marks a session resumable only when the transcript and the directory are both there', () => {
    index(
      [
        { sessionId: 'kept', text: 'has a transcript' },
        { sessionId: 'reaped', text: 'transcript is gone' },
        { sessionId: 'homeless', text: 'project is gone', project: BETA }
      ],
      { transcripts: transcripts('kept', 'homeless'), missingProjects: [BETA] }
    )

    const byId = new Map(readHistorySessions(store).sessions.map((s) => [s.sessionId, s]))

    expect(canResume(byId.get('kept')!)).toBe(true)
    expect(byId.get('kept')?.transcriptBytes).toBe(1234)

    // Reaped: history-only, and the prompts are still there to read.
    expect(byId.get('reaped')?.transcriptFile).toBeNull()
    expect(canResume(byId.get('reaped')!)).toBe(false)

    // The transcript survived but the folder it belongs to did not, which
    // `--resume` cannot work around: it resolves the id against the cwd.
    expect(byId.get('homeless')?.transcriptFile).not.toBeNull()
    expect(byId.get('homeless')?.projectExists).toBe(false)
    expect(canResume(byId.get('homeless')!)).toBe(false)
  })

  it('notices a transcript that has been reaped since the last pass', () => {
    index([{ sessionId: 'a', text: 'x' }], { transcripts: transcripts('a') })
    expect(readHistorySession(store, 'a')?.transcriptFile).not.toBeNull()

    // Nothing new in the history file; the transcript is simply gone.
    index([], { transcripts: new Map() })
    expect(readHistorySession(store, 'a')?.transcriptFile).toBeNull()
    expect(historySummary(store, [HISTORY]).resumable).toBe(0)
  })

  it('matches a transcript to its session whatever case the id was written in', () => {
    // Session ids are lowercase hex in practice; the join is case-folded so a
    // directory listing that reports otherwise cannot silently miss.
    index([{ sessionId: 'AbC', text: 'x' }], { transcripts: transcripts('aBc') })
    expect(readHistorySession(store, 'AbC')?.transcriptFile).not.toBeNull()
  })

  it('groups a directory recorded under two casings as one project', () => {
    index([
      { sessionId: 'a', text: 'x', project: 'C:\\repos\\Alpha' },
      { sessionId: 'b', text: 'y', project: 'C:\\repos\\alpha' }
    ])

    const projects = readHistoryProjects(store)
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ sessions: 2, prompts: 2, name: expect.any(String) })
  })

  it('is idempotent: re-running a pass changes nothing', () => {
    const first = index([{ sessionId: 'a', text: 'x' }], { transcripts: transcripts('a') })
    const again = indexHistory(store, {
      sources: [{ file: HISTORY, tail: tail([], { bytes: first.indexedBytes }) }],
      transcripts: transcripts('a'),
      directoryExists: () => true
    })
    expect(again).toEqual(first)
  })

  it('reports a read error without losing what was already indexed', () => {
    index([{ sessionId: 'a', text: 'x' }])
    const summary = index([], { tail: { error: 'EBUSY' } })

    // Named, because with a distro's history file indexed beside this
    // machine's, "EBUSY" alone does not say which of them could not be read.
    expect(summary.error).toBe(`${HISTORY}: EBUSY`)
    expect(summary.sessions).toBe(1)
  })

  describe('more than one history file', () => {
    const WSL = '\\\\wsl$\\Ubuntu\\home\\me\\.claude\\history.jsonl'

    /** Two homes in one pass, which is how the service always calls it. */
    function both(
      windows: Prompt[],
      wsl: Prompt[],
      opts: { transcripts?: Map<string, TranscriptFile> } = {}
    ): ReturnType<typeof indexHistory> {
      return indexHistory(store, {
        sources: [
          { file: HISTORY, tail: tail(windows, { bytes: 100 }) },
          { file: WSL, tail: tail(wsl, { bytes: 250 }) }
        ],
        transcripts: opts.transcripts ?? new Map(),
        directoryExists: () => true
      })
    }

    it('counts sessions from both homes as one index', () => {
      const summary = both(
        [{ sessionId: 'win', text: 'on this machine' }],
        [{ sessionId: 'nix', text: 'in the distro', project: '\\\\wsl$\\Ubuntu\\home\\me\\work' }]
      )

      expect(summary.sessions).toBe(2)
      expect(summary.projects).toBe(2)
      expect(readHistorySessions(store).sessions.map((s) => s.sessionId).sort()).toEqual([
        'nix',
        'win'
      ])
    })

    it('keeps a cursor per file and sums them for the version key', () => {
      const summary = both([{ sessionId: 'win', text: 'x' }], [{ sessionId: 'nix', text: 'y' }])

      expect(historyCursor(store, HISTORY)).toBe(100)
      expect(historyCursor(store, WSL)).toBe(250)
      expect(summary.indexedBytes).toBe(350)
    })

    it('names this machine as the primary and still lists every file', () => {
      const summary = both([], [])
      expect(summary.historyFile).toBe(HISTORY)
      expect(summary.historyFiles).toEqual([HISTORY, WSL])
    })

    it('marks a distro session resumable from its own transcript', () => {
      // The transcript lives under the distro's `~/.claude/projects`, which is
      // a `\\wsl$\` path here and an ordinary file to everything downstream.
      const summary = both([], [{ sessionId: 'nix', text: 'x' }], {
        transcripts: transcripts('nix')
      })
      expect(summary.resumable).toBe(1)
      expect(canResume(readHistorySession(store, 'nix')!)).toBe(true)
    })

    it('a reset in one file empties the index for both', () => {
      // The rows do not record which file they came from, so a partial wipe is
      // not expressible - which is why the service re-reads every source from
      // zero whenever it sees one, and why this pass supplies both in full.
      both([{ sessionId: 'win', text: 'old' }], [{ sessionId: 'nix', text: 'old' }])

      indexHistory(store, {
        sources: [
          { file: HISTORY, tail: tail([{ sessionId: 'win2', text: 'new' }], { reset: true }) },
          { file: WSL, tail: tail([{ sessionId: 'nix2', text: 'new' }], { bytes: 250 }) }
        ],
        transcripts: new Map(),
        directoryExists: () => true
      })

      expect(readHistorySessions(store).sessions.map((s) => s.sessionId).sort()).toEqual([
        'nix2',
        'win2'
      ])
    })
  })
})

describe('readHistorySessions', () => {
  beforeEach(() => {
    index(
      [
        { sessionId: 'a', text: 'add geofencing to the map' },
        { sessionId: 'a', text: 'now write the tests' },
        { sessionId: 'b', text: 'fix the geofence radius', project: BETA },
        { sessionId: 'c', text: 'unrelated work' },
        { sessionId: 'd', text: '50% of the rows are _wrong_' }
      ],
      { transcripts: transcripts('a') }
    )
  })

  it('filters by a substring of any prompt in the session', () => {
    const { sessions, total } = readHistorySessions(store, { search: 'geofenc' })
    expect(total).toBe(2)
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'b'])
  })

  it('matches case-insensitively and reports the prompt that matched', () => {
    const { sessions } = readHistorySessions(store, { search: 'WRITE THE TESTS' })
    expect(sessions).toHaveLength(1)
    // Not the opening prompt: the point of the field is to show where the hit was.
    expect(sessions[0]?.match).toBe('now write the tests')
    expect(sessions[0]?.firstPrompt).toBe('add geofencing to the map')
  })

  it('leaves the match field unset when nothing was searched for', () => {
    expect(readHistorySessions(store).sessions[0]?.match).toBeUndefined()
  })

  it('treats LIKE wildcards in the search box as literal characters', () => {
    // Without escaping, `%` matches everything and `_` matches any character,
    // so a search for a literal one silently returns the whole list.
    expect(readHistorySessions(store, { search: '50%' }).total).toBe(1)
    expect(readHistorySessions(store, { search: '_wrong_' }).total).toBe(1)
    expect(readHistorySessions(store, { search: '%' }).total).toBe(1)
    expect(readHistorySessions(store, { search: 'r_ws' }).total).toBe(0)
  })

  it('filters by project, case-insensitively', () => {
    expect(readHistorySessions(store, { project: BETA }).total).toBe(1)
    expect(readHistorySessions(store, { project: BETA.toUpperCase() }).total).toBe(1)
  })

  it('searches the project path as well as the prompts', () => {
    // No prompt in the fixture says "beta"; the only thing that does is the
    // directory session b ran in.
    const { sessions, total } = readHistorySessions(store, { search: 'beta' })
    expect(total).toBe(1)
    expect(sessions[0]?.sessionId).toBe('b')
  })

  it('matches a project whatever case the search box was typed in', () => {
    expect(readHistorySessions(store, { search: 'BETA' }).total).toBe(1)
    expect(readHistorySessions(store, { search: 'repos\\beta' }).total).toBe(1)
  })

  it('counts a session once when the search matches its project and a prompt', () => {
    // `a` matches by prompt only, `b` by both. A join instead of the IN/OR
    // would return `b` twice and report three matches for two sessions.
    expect(readHistorySessions(store, { search: 'geofenc' }).total).toBe(2)
    const { sessions, total } = readHistorySessions(store, { search: 'e' })
    expect(total).toBe(sessions.length)
    expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(sessions.length)
  })

  it('filters to what can actually be resumed', () => {
    const { sessions, total } = readHistorySessions(store, { resumableOnly: true })
    expect(total).toBe(1)
    expect(sessions[0]?.sessionId).toBe('a')
  })

  it('reports the match count separately from the page it returned', () => {
    const page = readHistorySessions(store, { limit: 2 })
    expect(page.sessions).toHaveLength(2)
    expect(page.total).toBe(4)
    expect(page.tookMs).toBeGreaterThanOrEqual(0)
  })
})

describe('session titles', () => {
  /** The rule itself is `discovery/title.test.ts`; this is the index applying it. */
  it('titles a session from the first prompt that says something', () => {
    index([
      { sessionId: 'a', text: '/usage' },
      { sessionId: 'a', text: '[Image #1]' },
      { sessionId: 'a', text: 'why is the status bar blank on a fresh install' }
    ])

    const session = readHistorySession(store, 'a')
    expect(session?.title).toBe('why is the status bar blank on a fresh install')
    expect(session?.titleFallback).toBe(false)
    // The opening prompt is still recorded as what was said first.
    expect(session?.firstPrompt).toBe('/usage')
  })

  it('falls back to something legible when no prompt says anything', () => {
    index([{ sessionId: 'a', text: '/usage' }])
    expect(readHistorySession(store, 'a')).toMatchObject({
      title: '/usage',
      titleFallback: false
    })

    index([{ sessionId: 'b', text: '[Image #1]' }])
    expect(readHistorySession(store, 'b')).toMatchObject({
      title: 'Image only',
      titleFallback: true
    })
  })

  it('re-titles a session when a later pass brings a better prompt', () => {
    index([{ sessionId: 'a', text: '/usage' }])
    expect(readHistorySession(store, 'a')?.title).toBe('/usage')

    index([{ sessionId: 'a', text: 'rename the profiles pane' }])
    expect(readHistorySession(store, 'a')?.title).toBe('rename the profiles pane')
  })

  it('ranks the prompts a build without the column left unranked', () => {
    index([
      { sessionId: 'a', text: '/usage' },
      { sessionId: 'a', text: 'add geofencing to the map' }
    ])
    // What an upgrade finds: rows written before `title_rank` existed.
    store.raw.prepare('UPDATE history_prompts SET title_rank = NULL').run()
    store.raw.prepare('UPDATE history_sessions SET title_prompt = NULL').run()
    expect(readHistorySession(store, 'a')?.title).toBe('/usage')

    // A pass with nothing new to read is enough - there is no next prompt
    // coming for a session that ended months ago.
    index([])
    expect(readHistorySession(store, 'a')?.title).toBe('add geofencing to the map')
  })
})

describe('renameHistorySession', () => {
  beforeEach(() => {
    index([
      { sessionId: 'a', text: '/usage' },
      { sessionId: 'a', text: 'add geofencing to the map' },
      { sessionId: 'b', text: 'unrelated work', project: BETA }
    ])
  })

  it('is what the list shows once it is set', () => {
    const renamed = renameHistorySession(store, 'a', '  Geofencing  ')
    expect(renamed?.label).toBe('Geofencing')
    // The derived title is still there, which is what makes clearing possible.
    expect(renamed?.title).toBe('add geofencing to the map')

    const { sessions } = readHistorySessions(store)
    expect(sessions.find((s) => s.sessionId === 'a')?.label).toBe('Geofencing')
    expect(sessions.find((s) => s.sessionId === 'b')?.label).toBeNull()
  })

  it('survives a full re-index', () => {
    renameHistorySession(store, 'a', 'Geofencing')
    // The whole aggregate thrown away and rebuilt, which is what a rewritten
    // history file does - and what a label column on it would not survive.
    index([{ sessionId: 'a', text: 'add geofencing to the map' }], { tail: { reset: true } })

    expect(readHistorySession(store, 'a')?.label).toBe('Geofencing')
  })

  it('returns the row to its derived title when the name is cleared', () => {
    renameHistorySession(store, 'a', 'Geofencing')
    const cleared = renameHistorySession(store, 'a', '   ')

    expect(cleared?.label).toBeNull()
    expect(cleared?.title).toBe('add geofencing to the map')
    expect(
      store.raw.prepare('SELECT COUNT(*) AS n FROM history_names').get()
    ).toEqual({ n: 0 })
  })

  it('finds a session by the name it was given', () => {
    renameHistorySession(store, 'a', 'Monarch budget spike')
    const { sessions, total } = readHistorySessions(store, { search: 'monarch' })
    expect(total).toBe(1)
    expect(sessions[0]?.sessionId).toBe('a')
  })

  it('keys the name on the id whatever case it is asked with', () => {
    renameHistorySession(store, 'A', 'Geofencing')
    expect(readHistorySession(store, 'a')?.label).toBe('Geofencing')
  })

  it('strips the characters that would corrupt the row it lands in', () => {
    const renamed = renameHistorySession(store, 'a', 'alpha beta​gamma')
    expect(renamed?.label).toBe('alpha beta gamma')
  })

  it('answers null for a session the index does not have', () => {
    expect(renameHistorySession(store, 'nope', 'whatever')).toBeNull()
  })
})

describe('readHistoryPrompts', () => {
  it('returns one session\'s prompts in submission order', () => {
    index([
      { sessionId: 'a', text: 'one' },
      { sessionId: 'b', text: 'other session' },
      { sessionId: 'a', text: 'two' },
      { sessionId: 'a', text: 'three' }
    ])

    expect(readHistoryPrompts(store, 'a').map((p) => p.text)).toEqual(['one', 'two', 'three'])
    expect(readHistoryPrompts(store, 'nope')).toEqual([])
  })
})

describe('historySummary', () => {
  it('counts what the launcher puts on screen', () => {
    index(
      [
        { sessionId: 'a', text: 'x' },
        { sessionId: 'a', text: 'y' },
        { sessionId: 'b', text: 'z', project: BETA }
      ],
      { transcripts: transcripts('a'), tail: { bytes: 900 } }
    )

    expect(historySummary(store, [HISTORY])).toMatchObject({
      sessions: 2,
      prompts: 3,
      projects: 2,
      resumable: 1,
      historyFile: HISTORY,
      indexedBytes: 900
    })
  })

  it('is empty rather than broken before anything is indexed', () => {
    expect(historySummary(store, [HISTORY])).toMatchObject({
      sessions: 0,
      prompts: 0,
      resumable: 0,
      latestAt: null,
      indexedBytes: 0
    })
  })
})

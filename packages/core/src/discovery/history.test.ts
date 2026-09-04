import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  directoryExists,
  historyFileIn,
  projectsDirIn,
  readHistoryTail,
  recordTranscript,
  scanTranscripts
} from './history'

let dir: string
let historyFile: string
let projectsDir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'helm-history-'))
  historyFile = historyFileIn(dir)
  projectsDir = projectsDirIn(dir)
  mkdirSync(projectsDir, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const line = (
  sessionId: string,
  display: string,
  project = 'C:\\repos\\alpha',
  timestamp = 1_700_000_000_000
): string => `${JSON.stringify({ display, pastedContents: {}, timestamp, project, sessionId })}\n`

/** A session id of the shape the transcript scanner recognises. */
const uuid = (n: number): string => {
  const hex = n.toString(16).padStart(2, '0')
  return `${hex.repeat(4)}-${hex.repeat(2)}-4${hex}0-8${hex}0-${hex.repeat(6)}`
}

describe('readHistoryTail', () => {
  it('reads every line of a file it has never seen', () => {
    writeFileSync(historyFile, line('s1', 'first') + line('s1', 'second') + line('s2', 'third'))

    const tail = readHistoryTail(historyFile, 0)

    expect(tail.lines.map((l) => l.display)).toEqual(['first', 'second', 'third'])
    expect(tail.skipped).toBe(0)
    expect(tail.reset).toBe(false)
    expect(tail.error).toBeUndefined()
  })

  it('reads only what was appended since the cursor', () => {
    writeFileSync(historyFile, line('s1', 'first'))
    const first = readHistoryTail(historyFile, 0)

    appendFileSync(historyFile, line('s2', 'second'))
    const second = readHistoryTail(historyFile, first.bytes)

    expect(second.lines.map((l) => l.display)).toEqual(['second'])
    expect(second.reset).toBe(false)
  })

  it('reports nothing new when the file has not grown', () => {
    writeFileSync(historyFile, line('s1', 'first'))
    const first = readHistoryTail(historyFile, 0)

    const again = readHistoryTail(historyFile, first.bytes)
    expect(again.lines).toEqual([])
    expect(again.bytes).toBe(first.bytes)
    expect(again.reset).toBe(false)
  })

  it('leaves a half-written trailing record for the next pass', () => {
    // The CLI appends while Helm reads: the last record is a fragment, and
    // consuming it would parse half a line now and the other half later.
    writeFileSync(historyFile, line('s1', 'complete') + '{"display":"half w')

    const tail = readHistoryTail(historyFile, 0)
    expect(tail.lines.map((l) => l.display)).toEqual(['complete'])
    expect(tail.skipped).toBe(0)
    expect(tail.bytes).toBe(Buffer.byteLength(line('s1', 'complete')))

    // Once the rest lands, the record is read exactly once.
    writeFileSync(historyFile, line('s1', 'complete') + line('s2', 'half written'))
    const next = readHistoryTail(historyFile, tail.bytes)
    expect(next.lines.map((l) => l.display)).toEqual(['half written'])
  })

  it('keeps the cursor on a byte boundary when a prompt is not ASCII', () => {
    // A cursor placed mid-sequence would decode the next read as U+FFFD.
    const prompt = 'ελληνικά 日本語 🚀'
    writeFileSync(historyFile, line('s1', prompt))
    const first = readHistoryTail(historyFile, 0)
    expect(first.lines[0]?.display).toBe(prompt)

    appendFileSync(historyFile, line('s2', 'after'))
    expect(readHistoryTail(historyFile, first.bytes).lines.map((l) => l.display)).toEqual(['after'])
  })

  it('asks for a full reindex when the file has shrunk', () => {
    writeFileSync(historyFile, line('s1', 'first') + line('s2', 'second'))
    const first = readHistoryTail(historyFile, 0)

    writeFileSync(historyFile, line('s3', 'only one now'))
    const after = readHistoryTail(historyFile, first.bytes)

    expect(after.reset).toBe(true)
    expect(after.lines.map((l) => l.display)).toEqual(['only one now'])
  })

  it('skips a malformed line instead of losing the rest of the file', () => {
    writeFileSync(
      historyFile,
      line('s1', 'good') + 'not json at all\n' + '{"display":"no session"}\n' + line('s2', 'also good')
    )

    const tail = readHistoryTail(historyFile, 0)
    expect(tail.lines.map((l) => l.display)).toEqual(['good', 'also good'])
    expect(tail.skipped).toBe(2)
  })

  it('keeps a prompt that was submitted empty', () => {
    writeFileSync(historyFile, `${JSON.stringify({ display: '', timestamp: 1, project: 'p', sessionId: 's' })}\n`)
    expect(readHistoryTail(historyFile, 0).lines).toHaveLength(1)
  })

  it('reports a missing file as a reset rather than throwing', () => {
    const tail = readHistoryTail(join(dir, 'nope.jsonl'), 512)
    expect(tail.lines).toEqual([])
    expect(tail.reset).toBe(true)
    expect(tail.bytes).toBe(0)
    expect(tail.error).toBeDefined()
  })
})

describe('scanTranscripts', () => {
  const transcript = (projectDir: string, id: string, body = '{}\n'): string => {
    mkdirSync(join(projectsDir, projectDir), { recursive: true })
    const file = join(projectsDir, projectDir, `${id}.jsonl`)
    writeFileSync(file, body)
    return file
  }

  it('finds transcripts across every project directory', () => {
    transcript('C--repos-alpha', uuid(1))
    transcript('C--repos-beta', uuid(2))

    const found = scanTranscripts(projectsDir)
    expect([...found.keys()].sort()).toEqual([uuid(1), uuid(2)].sort())
    expect(found.get(uuid(1))?.bytes).toBeGreaterThan(0)
  })

  it('ignores files whose name is not a session id', () => {
    transcript('C--repos-alpha', uuid(1))
    mkdirSync(join(projectsDir, 'C--repos-alpha'), { recursive: true })
    writeFileSync(join(projectsDir, 'C--repos-alpha', 'sessions-index.json'), '{}')
    writeFileSync(join(projectsDir, 'C--repos-alpha', 'notes.jsonl'), '{}')

    expect([...scanTranscripts(projectsDir).keys()]).toEqual([uuid(1)])
  })

  it('does not descend into a session\'s subagent transcripts', () => {
    // `<sessionId>/subagents/agent-*.jsonl` are not sessions, and one of them
    // counted as a surviving transcript would offer a resume that cannot work.
    const nested = join(projectsDir, 'C--repos-alpha', uuid(1), 'subagents')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, `${uuid(2)}.jsonl`), '{}')

    expect([...scanTranscripts(projectsDir).keys()]).toEqual([])
  })

  it('matches on the session id, not on a path derived from the project', () => {
    // Measured on the real machine: a directory recorded as
    // `...repos\acme-reporting` in history has its transcripts under
    // `...-repos-Acme-Reporting`, because the directory name carries
    // whatever casing the CLI was started with. Deriving the path from the
    // project string reports those sessions as reaped.
    transcript('C--repos-Alpha-Beta', uuid(1))
    expect(scanTranscripts(projectsDir).has(uuid(1))).toBe(true)
  })

  it('keeps the larger file when one id appears under two directories', () => {
    transcript('C--repos-alpha', uuid(1), '{}\n')
    transcript('C--repos-beta', uuid(1), '{"a":1}\n{"b":2}\n')

    const found = scanTranscripts(projectsDir)
    expect(found.get(uuid(1))?.bytes).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n'))
  })

  it('re-records a file it is seeing again rather than treating it as a rival', () => {
    // Two spellings of one directory are one file on Windows and two on Linux;
    // either way the same path seen twice is a re-read, never a smaller rival.
    const first = transcript('C--repos-alpha', uuid(1), '{"a":1}\n{"b":2}\n')
    const found = scanTranscripts(projectsDir)
    writeFileSync(first, '{}\n')
    expect(recordTranscript(first, found)).toBe(true)
    expect(found.get(uuid(1))?.bytes).toBe(Buffer.byteLength('{}\n'))
  })

  it('returns nothing when there is no projects directory', () => {
    rmSync(projectsDir, { recursive: true, force: true })
    expect(scanTranscripts(projectsDir).size).toBe(0)
  })
})

describe('directoryExists', () => {
  it('is true for a directory and false for a file or a missing path', () => {
    writeFileSync(join(dir, 'file.txt'), 'x')
    expect(directoryExists(dir)).toBe(true)
    expect(directoryExists(join(dir, 'file.txt'))).toBe(false)
    expect(directoryExists(join(dir, 'gone'))).toBe(false)
  })
})

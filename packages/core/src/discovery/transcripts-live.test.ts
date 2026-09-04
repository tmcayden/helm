import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanTranscripts } from './history'
import { createLiveTranscripts } from './transcripts-live'

let projects: string

beforeEach(async () => {
  // A space in the path, because CLAUDE.md says to test with one.
  const dir = await mkdtemp(join(tmpdir(), 'helm live transcripts-'))
  projects = join(dir, 'projects')
  mkdirSync(projects)
})

afterEach(async () => {
  await rm(join(projects, '..'), { recursive: true, force: true })
})

const uuid = (n: number): string => {
  const hex = n.toString(16).padStart(2, '0')
  return `${hex.repeat(4)}-${hex.repeat(2)}-4${hex}0-8${hex}0-${hex.repeat(6)}`
}

const transcript = (project: string, n: number, body = 'x'): string => {
  const dir = join(projects, project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${uuid(n)}.jsonl`)
  writeFileSync(file, body)
  return file
}

/** The real scan, counted. */
const counted = (): { scan: typeof scanTranscripts; calls: () => number } => {
  let calls = 0
  return {
    scan: (dir) => {
      calls++
      return scanTranscripts(dir)
    },
    calls: () => calls
  }
}

describe('createLiveTranscripts', () => {
  it('walks once and then answers from memory', () => {
    transcript('alpha', 1)
    const { scan, calls } = counted()
    const live = createLiveTranscripts(projects, scan)
    expect(live.primed()).toBe(false)
    expect(live.all().size).toBe(1)
    expect(live.all().size).toBe(1)
    expect(calls()).toBe(1)
    expect(live.primed()).toBe(true)
  })

  it('a new transcript is added by its event without a walk', () => {
    const { scan, calls } = counted()
    const live = createLiveTranscripts(projects, scan)
    live.all()
    const file = transcript('alpha', 2, 'hello')
    live.apply('changed', file, false)
    expect(live.all().get(uuid(2))).toMatchObject({ file, bytes: 5 })
    expect(calls()).toBe(1)
  })

  it('a transcript that grew has its size moved - the archive reads growth off it', () => {
    const file = transcript('alpha', 3, 'ab')
    const live = createLiveTranscripts(projects)
    expect(live.all().get(uuid(3))?.bytes).toBe(2)
    appendFileSync(file, 'cdef')
    live.apply('changed', file, false)
    expect(live.all().get(uuid(3))?.bytes).toBe(6)
  })

  it('a removed transcript is dropped', () => {
    const file = transcript('alpha', 4)
    const live = createLiveTranscripts(projects)
    expect(live.all().has(uuid(4))).toBe(true)
    rmSync(file)
    live.apply('removed', file, false)
    expect(live.all().has(uuid(4))).toBe(false)
  })

  it('removing the smaller of two files sharing an id keeps the larger', () => {
    // The real case is one folder opened with two casings; on this filesystem
    // those are one directory, so two names stand in for them.
    const small = transcript('acme-reporting-old', 5, 'x')
    const large = transcript('acme-reporting', 5, 'xxxx')
    const live = createLiveTranscripts(projects)
    expect(live.all().get(uuid(5))?.file).toBe(large)
    rmSync(small)
    live.apply('removed', small, false)
    expect(live.all().get(uuid(5))?.file).toBe(large)
  })

  it('a "changed" file that is already gone is dropped rather than kept stale', () => {
    const file = transcript('alpha', 6)
    const live = createLiveTranscripts(projects)
    live.all()
    rmSync(file)
    live.apply('changed', file, false)
    expect(live.all().has(uuid(6))).toBe(false)
  })

  it('a removed project directory takes its transcripts with it', () => {
    transcript('alpha', 7)
    transcript('alpha', 8)
    transcript('beta', 9)
    const live = createLiveTranscripts(projects)
    expect(live.all().size).toBe(3)
    const alpha = join(projects, 'alpha')
    rmSync(alpha, { recursive: true })
    live.apply('removed', alpha, true)
    expect([...live.all().keys()].sort()).toEqual([uuid(9)])
  })

  it('a project directory renamed into place is read, and the old name forgotten', () => {
    transcript('alpha', 10)
    const live = createLiveTranscripts(projects)
    expect(live.all().get(uuid(10))?.file).toContain('alpha')
    const from = join(projects, 'alpha')
    const to = join(projects, 'renamed')
    renameSync(from, to)
    live.apply('removed', from, true)
    expect(live.all().has(uuid(10))).toBe(false)
    live.apply('changed', to, true)
    expect(live.all().get(uuid(10))?.file).toBe(join(to, `${uuid(10)}.jsonl`))
  })

  it('a new project directory is read on its own, without a walk', () => {
    const { scan, calls } = counted()
    const live = createLiveTranscripts(projects, scan)
    live.all()
    transcript('gamma', 11)
    transcript('gamma', 12)
    live.apply('changed', join(projects, 'gamma'), true)
    expect(live.all().size).toBe(2)
    expect(calls()).toBe(1)
  })

  it('projects/ itself changing invalidates; so does invalidate()', () => {
    transcript('alpha', 13)
    const { scan, calls } = counted()
    const live = createLiveTranscripts(projects, scan)
    live.all()
    live.apply('removed', projects, true)
    expect(live.primed()).toBe(false)
    live.all()
    expect(calls()).toBe(2)
    live.invalidate()
    expect(live.primed()).toBe(false)
    live.all()
    expect(calls()).toBe(3)
  })

  it('events before the first walk are dropped, not applied to nothing', () => {
    const { scan, calls } = counted()
    const live = createLiveTranscripts(projects, scan)
    const file = transcript('alpha', 14)
    live.apply('changed', file, false)
    expect(calls()).toBe(0)
    expect(live.all().has(uuid(14))).toBe(true)
  })

  it('compares paths the way the filesystem does', () => {
    // Case-insensitively on Windows, where the upper-cased spelling is this
    // file; exactly on Linux, where it names a file that was never held.
    const file = transcript('alpha', 15)
    const live = createLiveTranscripts(projects)
    live.all()
    rmSync(file)
    live.apply('removed', file.toUpperCase(), false)
    expect(live.all().has(uuid(15))).toBe(process.platform !== 'win32')
  })
})

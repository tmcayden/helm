import { describe, expect, it } from 'vitest'
import type { SessionRecord, SessionRegistryEntry } from '@helm/core/types'
import { shapeHistory } from './history.ts'
import { findResumable } from './resume.ts'
import { shapeLiveSessions } from './sessions.ts'
import { configScopes } from './pick.ts'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const row = (over: Partial<SessionRecord>): SessionRecord => ({
  id: 1,
  name: 'wa',
  label: null,
  cwd: '/h',
  branch: null,
  projectPath: null,
  profileId: null,
  argv: [],
  claudeSessionId: 'AAAA-1',
  status: 'exited',
  startedAt: '2026-09-04T00:00:00.000Z',
  endedAt: null,
  durationMs: null,
  exitCode: 0,
  ...over
})

describe('history shaping', () => {
  it('marks resumable by transcript, case-insensitively, and prefers the label', () => {
    const rows = [row({ label: 'Work' }), row({ id: 2, claudeSessionId: null }), row({ id: 3, claudeSessionId: 'gone' })]
    const shaped = shapeHistory(rows, new Set(['aaaa-1']))
    expect(shaped.map((r) => [r.name, r.resumable])).toEqual([['Work', true], ['wa', false], ['wa', false]])
  })
})

describe('findResumable', () => {
  const rows = [row({ id: 7, claudeSessionId: 'X-1' }), row({ id: 8, claudeSessionId: 'x-1' })]
  it('takes a row id or a conversation id', () => {
    expect(findResumable(rows, '8')?.id).toBe(8)
    expect(findResumable(rows, 'x-1')?.id).toBe(7)
    expect(findResumable(rows, '9')).toBeNull()
  })
})

describe('live session shaping', () => {
  const entry = (over: Partial<SessionRegistryEntry>): SessionRegistryEntry => ({
    file: '1.json',
    pid: 1,
    procStart: null,
    sessionId: null,
    cwd: '/x',
    name: 'n',
    version: null,
    entrypoint: null,
    startedAt: null,
    activity: null,
    rawStatus: null,
    waitingFor: null,
    statusUpdatedAt: null,
    ...over
  })
  it('joins hosted rows by conversation id and keeps an unknown status null', () => {
    const live = shapeLiveSessions(
      [entry({ pid: 5, sessionId: 'aaaa-1' }), entry({ pid: 6, sessionId: 'other', activity: 'busy' })],
      [row({ id: 3, status: 'running', label: 'Mine' })]
    )
    expect(live.map((s) => [s.pid, s.helmSessionId, s.name, s.activity])).toEqual([
      [5, 3, 'Mine', null],
      [6, null, 'n', 'busy']
    ])
  })
})

describe('configScopes', () => {
  it('lists user, harness, and only repos with a .claude', () => {
    const harness = mkdtempSync(join(tmpdir(), 'helm-cli-'))
    mkdirSync(join(harness, 'repos', 'a', '.claude'), { recursive: true })
    mkdirSync(join(harness, 'repos', 'b'), { recursive: true })
    expect(configScopes([harness], '/home/u')).toEqual([
      { kind: 'user', dir: '/home/u' },
      { kind: 'harness', dir: harness },
      { kind: 'repo', dir: join(harness, 'repos', 'a') }
    ])
  })
})

import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeConfigFileIn, freshestUsage, readUsage, readUsageAcross } from './read'
import { nextUsageMode, parseUsage, usageView, USAGE_STALE_AFTER_MS } from './shape'

/**
 * The unit half of "prefer showing nothing". The driver asserts the same rules
 * against the real window; these assert them against the shapes a CLI release
 * could plausibly hand over, which is quicker to write one of for every case.
 */

const NOW = Date.parse('2026-08-10T09:00:00Z')
const FETCHED = Date.parse('2026-08-10T08:55:00Z')

/** The 2.1.225 shape, with the fields that vary made arguments. */
function claudeJson(
  overrides: {
    fetchedAtMs?: number | null
    limits?: unknown
    omitKey?: boolean
    cached?: unknown
  } = {}
): unknown {
  const limits = overrides.limits ?? [
    {
      kind: 'session',
      group: 'session',
      percent: 51,
      severity: 'normal',
      resets_at: '2026-08-10T13:10:00.721285+00:00',
      scope: null,
      is_active: true
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 38,
      severity: 'warning',
      resets_at: '2026-08-11T19:00:00.721310+00:00',
      scope: null,
      is_active: false
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 21,
      severity: 'normal',
      resets_at: '2026-08-11T18:59:59.721602+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false
    }
  ]

  const root: Record<string, unknown> = { numStartups: 42, projects: {} }
  if (overrides.omitKey === true) return root
  if ('cached' in overrides) {
    root['cachedUsageUtilization'] = overrides.cached
    return root
  }
  root['cachedUsageUtilization'] = {
    fetchedAtMs: overrides.fetchedAtMs === undefined ? FETCHED : overrides.fetchedAtMs,
    accountUuid: 'a5438327-5c7d-4ecd-97cd-47307ff36d81',
    utilization: {
      five_hour: { utilization: 51, resets_at: '2026-08-10T13:10:00.721285+00:00' },
      seven_day: { utilization: 38, resets_at: '2026-08-11T19:00:00.721310+00:00' },
      tangelo: null,
      nimbus_quill: { utilization: 0, resets_at: null },
      limits,
      spend: { used: { amount_minor: 0, currency: 'USD' }, enabled: false, percent: 0 },
      extra_usage: { is_enabled: false, daily: null, weekly: null }
    }
  }
  return root
}

describe('parseUsage', () => {
  it('reads the limits a 2.1.225 reading carries', () => {
    const snapshot = parseUsage(claudeJson(), 'claude.json')

    expect(snapshot.problem).toBeNull()
    expect(snapshot.fetchedAtMs).toBe(FETCHED)
    expect(snapshot.limits.map((l) => [l.kind, l.percent])).toEqual([
      ['session', 51],
      ['weekly_all', 38],
      ['weekly_scoped', 21]
    ])
    expect(snapshot.limits[2]?.scope).toBe('Fable')
    expect(snapshot.limits[1]?.severity).toBe('warning')
  })

  it('parses the six-digit offset timestamps the CLI writes', () => {
    const snapshot = parseUsage(claudeJson(), 'claude.json')

    expect(snapshot.limits[0]?.resetsAtMs).toBe(Date.parse('2026-08-10T13:10:00.721Z'))
  })

  it('reports a missing key rather than inventing a zero', () => {
    const snapshot = parseUsage(claudeJson({ omitKey: true }), 'claude.json')

    expect(snapshot.problem?.kind).toBe('missing-key')
    expect(snapshot.limits).toEqual([])
  })

  it('reports an unusable fetchedAtMs, because an age cannot be judged without one', () => {
    for (const value of [null, 'yesterday', 0, Number.NaN]) {
      const snapshot = parseUsage(claudeJson({ fetchedAtMs: value as number }), 'claude.json')
      expect(snapshot.problem?.kind).toBe('unrecognised')
    }
  })

  it('reports a reshaped limits array rather than showing what it recognised', () => {
    const snapshot = parseUsage(
      claudeJson({
        limits: [
          { kind: 'session', group: 'session', utilizationPercent: 51 },
          { kind: 'weekly_all', bucket: 'weekly', percent: 38 }
        ]
      }),
      'claude.json'
    )

    expect(snapshot.problem?.kind).toBe('unrecognised')
    expect(snapshot.limits).toEqual([])
  })

  it('keeps the limits it recognises when a new kind appears beside them', () => {
    const snapshot = parseUsage(
      claudeJson({
        limits: [
          { kind: 'session', group: 'session', percent: 12, resets_at: null },
          { kind: 'weekly_cowork', group: 'weekly', percent: 4, resets_at: null },
          { kind: 'something_new', group: 'monthly', percent: 90 }
        ]
      }),
      'claude.json'
    )

    // The unknown *kind* is kept - it declares a group Helm shows. The unknown
    // *group* is dropped, because there is nowhere honest to put it.
    expect(snapshot.limits.map((l) => l.kind)).toEqual(['session', 'weekly_cowork'])
  })

  it('rejects a percent that is not one', () => {
    const snapshot = parseUsage(
      claudeJson({
        limits: [{ kind: 'session', group: 'session', percent: '51%', resets_at: null }]
      }),
      'claude.json'
    )

    expect(snapshot.problem?.kind).toBe('unrecognised')
  })

  it('reports a null cachedUsageUtilization as missing, not as reshaped', () => {
    expect(parseUsage(claudeJson({ cached: null }), 'f').problem?.kind).toBe('missing-key')
    expect(parseUsage(claudeJson({ cached: 'nope' }), 'f').problem?.kind).toBe('unrecognised')
  })
})

describe('usageView', () => {
  it('shows the session limit and the binding weekly one', () => {
    const view = usageView(parseUsage(claudeJson(), 'claude.json'), NOW)

    expect(view.problem).toBeNull()
    expect(view.buckets.map((b) => [b.label, b.percent, b.scope])).toEqual([
      ['Session', 51, null],
      ['Week', 38, null]
    ])
  })

  it('surfaces the per-model weekly limit when it is the binding one', () => {
    const view = usageView(
      parseUsage(
        claudeJson({
          limits: [
            {
              kind: 'session',
              group: 'session',
              percent: 10,
              resets_at: '2026-08-10T13:10:00Z'
            },
            {
              kind: 'weekly_all',
              group: 'weekly',
              percent: 38,
              resets_at: '2026-08-11T19:00:00Z'
            },
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 77,
              resets_at: '2026-08-11T19:00:00Z',
              scope: { model: { display_name: 'Fable' } }
            }
          ]
        }),
        'claude.json'
      ),
      NOW
    )

    expect(view.buckets[1]?.percent).toBe(77)
    expect(view.buckets[1]?.scope).toBe('Fable')
    expect(view.buckets[1]?.kind).toBe('weekly_scoped')
  })

  it('does not choose by is_active, which was observed on the lower limit', () => {
    const view = usageView(
      parseUsage(
        claudeJson({
          limits: [
            {
              kind: 'weekly_all',
              group: 'weekly',
              percent: 38,
              resets_at: '2026-08-11T19:00:00Z',
              is_active: false
            },
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 90,
              resets_at: '2026-08-11T19:00:00Z',
              is_active: true,
              scope: { model: { display_name: 'Fable' } }
            }
          ]
        }),
        'claude.json'
      ),
      NOW
    )

    expect(view.buckets.map((b) => b.percent)).toEqual([90])
  })

  it('turns the figures into lower bounds once past the staleness horizon', () => {
    // Blanking a stale reading outright is what this used to assert, and in
    // practice it blanked the segment nearly always: Claude Code refreshes
    // `cachedUsageUtilization` on its own schedule, measured at well over an
    // hour between writes, so a thirty-minute horizon was not choosing between
    // a good figure and a bad one - it was discarding the only figure there is.
    // A window accumulates until it resets, so a reading taken inside a window
    // that is still running can only understate it.
    const snapshot = parseUsage(claudeJson(), 'claude.json')
    const justInside = usageView(snapshot, FETCHED + USAGE_STALE_AFTER_MS - 1000)
    const justOutside = usageView(snapshot, FETCHED + USAGE_STALE_AFTER_MS + 1000)

    expect(justInside.buckets).toHaveLength(2)
    expect(justInside.atLeast).toBe(false)

    // Same numbers, now flagged as floors rather than withheld.
    expect(justOutside.buckets.map((b) => b.percent)).toEqual(
      justInside.buckets.map((b) => b.percent)
    )
    expect(justOutside.atLeast).toBe(true)
    expect(justOutside.problem).toBeNull()
    expect(justOutside.ageMs).toBe(USAGE_STALE_AFTER_MS + 1000)
  })

  it('still shows nothing when a stale reading has also rolled over', () => {
    // The ordering that makes the floor honest. Age alone is survivable; a
    // window that has ended is not, because that reading bounds a window which
    // no longer exists. Both are true here, and rollover has to win.
    const snapshot = parseUsage(
      claudeJson({
        fetchedAtMs: NOW - 6 * 60 * 60_000,
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 59,
            resets_at: new Date(NOW - 60 * 60_000).toISOString()
          }
        ]
      }),
      'claude.json'
    )
    const view = usageView(snapshot, NOW)

    expect(view.buckets).toEqual([])
    expect(view.atLeast).toBe(false)
    expect(view.problem?.kind).toBe('rolled-over')
  })

  it('drops a window that has already reset and keeps the one that has not', () => {
    // The five-hour window rolled over four minutes ago; the reading itself is
    // one minute old, so it is not stale - only the session figure is dead.
    const rolled = parseUsage(
      claudeJson({
        fetchedAtMs: NOW - 60_000,
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 51,
            resets_at: new Date(NOW - 4 * 60_000).toISOString()
          },
          {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 38,
            resets_at: '2026-08-11T19:00:00Z'
          }
        ]
      }),
      'claude.json'
    )

    const view = usageView(rolled, NOW)

    expect(view.buckets.map((b) => b.label)).toEqual(['Week'])
  })

  it('shows nothing when every window in the reading has reset', () => {
    const rolled = parseUsage(
      claudeJson({
        fetchedAtMs: NOW - 60_000,
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 51,
            resets_at: new Date(NOW - 1000).toISOString()
          },
          {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 38,
            resets_at: new Date(NOW - 1000).toISOString()
          }
        ]
      }),
      'claude.json'
    )

    expect(usageView(rolled, NOW).problem?.kind).toBe('rolled-over')
  })

  it('keeps a limit the server sent no reset time for', () => {
    const view = usageView(
      parseUsage(
        claudeJson({
          fetchedAtMs: NOW,
          limits: [{ kind: 'session', group: 'session', percent: 7, resets_at: null }]
        }),
        'claude.json'
      ),
      NOW
    )

    expect(view.buckets.map((b) => [b.percent, b.resetsAtMs])).toEqual([[7, null]])
  })

  it('shows nothing when the reading is dated in the future', () => {
    const snapshot = parseUsage(claudeJson({ fetchedAtMs: NOW + 10 * 60_000 }), 'claude.json')

    expect(usageView(snapshot, NOW).problem?.kind).toBe('unrecognised')
  })

  it('passes a read problem straight through', () => {
    expect(usageView(parseUsage(claudeJson({ omitKey: true }), 'f'), NOW).problem?.kind).toBe(
      'missing-key'
    )
    expect(usageView(null, NOW).buckets).toEqual([])
  })
})

describe('nextUsageMode', () => {
  it('skips cost while there is no estimate to show', () => {
    expect(nextUsageMode('percent', ['percent', 'off'])).toBe('off')
    expect(nextUsageMode('off', ['percent', 'off'])).toBe('percent')
  })

  it('cycles all three once the index has an estimate', () => {
    expect(nextUsageMode('percent', ['percent', 'cost', 'off'])).toBe('cost')
    expect(nextUsageMode('cost', ['percent', 'cost', 'off'])).toBe('off')
    expect(nextUsageMode('off', ['percent', 'cost', 'off'])).toBe('percent')
  })

  it('leaves a mode that is no longer offered rather than jumping', () => {
    expect(nextUsageMode('cost', [])).toBe('cost')
  })
})

describe('readUsage', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'helm-usage-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('finds .claude.json beside the config directory', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude.json'), JSON.stringify(claudeJson()))

    expect(claudeConfigFileIn(join(dir, '.claude'))).toBe(join(dir, '.claude.json'))
  })

  it('prefers one inside the config directory when that is where it is', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', '.claude.json'), '{}')

    expect(claudeConfigFileIn(join(dir, '.claude'))).toBe(join(dir, '.claude', '.claude.json'))
  })

  it('reports a file that is not there', () => {
    expect(readUsage(join(dir, 'nothing.json')).problem?.kind).toBe('no-file')
  })

  it('reports a half-written file rather than throwing', () => {
    const file = join(dir, '.claude.json')
    writeFileSync(file, '{"cachedUsageUtilization": {"fetched')

    expect(readUsage(file).problem?.kind).toBe('not-json')
  })

  it('reads a real reading off the disk', () => {
    const file = join(dir, '.claude.json')
    writeFileSync(file, JSON.stringify(claudeJson()))

    const snapshot = readUsage(file)

    expect(snapshot.problem).toBeNull()
    expect(snapshot.limits).toHaveLength(3)
    expect(snapshot.file).toBe(file)
  })
})

/**
 * The rule that decides *which* install's reading is shown, once there is more
 * than one - this machine's `~/.claude.json` and one per WSL distribution. They
 * cache the same account's limits, so the question is never how to combine them
 * and always which is the most recent description of the one thing they
 * describe.
 *
 * Nothing here needs WSL installed, and that is deliberate rather than
 * convenient: the mechanism is a second path, so a temp directory standing in
 * for a distro's home exercises the same code the `\wsl$\` one does.
 */
describe('freshestUsage', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'helm-usage-homes-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** A `.claude.json` in its own subdirectory, as a home's would be. */
  function homeFile(name: string, fetchedAtMs: number | null): string {
    const home = join(dir, name)
    mkdirSync(home, { recursive: true })
    const file = join(home, '.claude.json')
    writeFileSync(file, JSON.stringify(claudeJson({ fetchedAtMs })))
    return file
  }

  it('takes the most recently fetched reading, whichever home it is in', () => {
    const windows = homeFile('windows', FETCHED - 60 * 60_000)
    const distro = homeFile('ubuntu', FETCHED)

    const snapshot = readUsageAcross([windows, distro])

    expect(snapshot.file).toBe(distro)
    expect(snapshot.fetchedAtMs).toBe(FETCHED)
  })

  it('keeps this machine on a tie, because the caller passes it first', () => {
    // Two files stamped the same millisecond are the same reading, and the one
    // that needs no sentence beside it in the tooltip is the local one.
    const windows = homeFile('windows', FETCHED)
    const distro = homeFile('ubuntu', FETCHED)

    expect(readUsageAcross([windows, distro]).file).toBe(windows)
  })

  it('paints nothing, with the first candidate reason, when no home has one', () => {
    // The all-absent case: the surface must degrade exactly as it did when
    // there was one file, and the reason must name a file somebody can look at
    // rather than being invented from the fact that several were tried.
    const windows = join(dir, 'windows', '.claude.json')
    const distro = join(dir, 'ubuntu', '.claude.json')

    const snapshot = readUsageAcross([windows, distro])

    expect(snapshot.limits).toEqual([])
    expect(snapshot.problem?.kind).toBe('no-file')
    expect(snapshot.file).toBe(windows)
  })

  it('never lets an absent or unreadable file outrank a real reading', () => {
    // Order-independent, which is the point: a problem snapshot carries no
    // `fetchedAtMs`, so it cannot win from either end of the list.
    const missing = join(dir, 'gone', '.claude.json')
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{"cachedUsageUtilization": {"fetched')
    const real = homeFile('ubuntu', FETCHED)

    expect(readUsageAcross([missing, broken, real]).file).toBe(real)
    expect(readUsageAcross([real, missing, broken]).file).toBe(real)
  })

  it('ranks by fetch time and not by which reading would paint a number', () => {
    // Both of these are past `USAGE_STALE_AFTER_MS`, and picking between them
    // by which one `usageView` would let through is choosing the answer first
    // and the evidence after. The fresher file wins on its timestamp alone, and
    // what may be painted from it stays `usageView`'s decision - here a floor,
    // because that is what a stale reading of a live window is.
    const older = homeFile('windows', NOW - 90 * 60_000)
    const stale = homeFile('ubuntu', NOW - 35 * 60_000)

    const snapshot = readUsageAcross([older, stale])

    expect(snapshot.file).toBe(stale)
    const view = usageView(snapshot, NOW)
    expect(view.atLeast).toBe(true)
    expect(view.ageMs).toBe(35 * 60_000)
  })

  it('is readUsage when there is one home, which is the ordinary machine', () => {
    const only = homeFile('windows', FETCHED)

    expect(readUsageAcross([only])).toEqual(readUsage(only))
  })

  it('reports rather than throws when handed no candidates at all', () => {
    expect(readUsageAcross([]).problem?.kind).toBe('no-file')
  })

  it('ranks snapshots it is handed, so the rule is testable without files', () => {
    const early = parseUsage(claudeJson({ fetchedAtMs: FETCHED - 1 }), 'early.json')
    const late = parseUsage(claudeJson({ fetchedAtMs: FETCHED }), 'late.json')

    expect(freshestUsage([early, late]).file).toBe('late.json')
    expect(freshestUsage([late, early]).file).toBe('late.json')
  })
})

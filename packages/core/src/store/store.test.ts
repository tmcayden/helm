import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  EMPTY_INVENTORY,
  PINNED_PROJECTS_MAX,
  isProjectPinned,
  sessionLabel,
  withProjectPinned,
  type AppSettings,
  type Project
} from '../types'
import { openStore, type Store } from './db'
import { knownMigrations } from './migrate'
import { cacheProjects, forgetProjects, readCachedProjects } from './projects'
import {
  finishSession,
  readSessions,
  reconcileRunningSessions,
  renameSession,
  runningSessionNames,
  startSession
} from './sessions'
import {
  readSettings,
  validateSetting,
  writeSetting,
  writeSettings,
  SettingsValidationError
} from './settings'

let dir: string
let store: Store

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'helm-store-'))
  store = openStore({ file: join(dir, 'helm.db') })
})

afterEach(async () => {
  store.close()
  await rm(dir, { recursive: true, force: true })
})

const project = (overrides: Partial<Project> = {}): Project => ({
  path: join(dir, 'repos', 'alpha'),
  name: 'alpha',
  kind: 'repo',
  harnessPath: dir,
  hasClaudeDir: true,
  inventory: { ...EMPTY_INVENTORY, skills: 7, agents: 16, commands: 20, claudeMd: true },
  git: { branch: 'main', detached: false, dirty: 3, ahead: 1, behind: 0 },
  ...overrides
})

describe('openStore', () => {
  it('creates the file and applies every migration', () => {
    expect(existsSync(store.file)).toBe(true)
    expect(store.migrations.applied).toEqual(knownMigrations())
    expect(knownMigrations().length).toBeGreaterThan(0)
  })

  it('creates every declared table', () => {
    const names = store.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name)

    expect(names).toEqual(
      expect.arrayContaining([
        'profiles',
        'projects',
        'config_snapshots',
        'app_settings',
        'sessions',
        'history_prompts',
        'history_sessions',
        'history_index'
      ])
    )
  })

  it('runs in WAL mode', () => {
    const [mode] = store.raw.pragma('journal_mode') as Array<{ journal_mode: string }>
    expect(mode?.journal_mode).toBe('wal')
  })

  it('is idempotent: reopening applies nothing and loses nothing', () => {
    writeSetting(store, 'theme', 'dark')
    store.close()

    const reopened = openStore({ file: join(dir, 'helm.db') })
    try {
      expect(reopened.migrations.applied).toEqual([])
      expect(reopened.migrations.alreadyApplied).toEqual(knownMigrations())
      expect(readSettings(reopened).theme).toBe('dark')
    } finally {
      reopened.close()
    }
  })
})

describe('settings', () => {
  it('returns defaults for an empty database', () => {
    expect(readSettings(store)).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips every value type in AppSettings', () => {
    const written = {
      theme: 'light',
      scanRoots: [dir, join(dir, 'other')],
      pinnedProjects: [join(dir, 'alpha'), join(dir, 'beta')],
      windowBounds: { width: 1280, height: 820, x: 40, y: 60 },
      // Every pane kind, because the validator checks each one's own fields and
      // a strip of only the field-less kinds would not exercise them.
      workspaceTabs: {
        panes: [
          { kind: 'project', path: dir },
          { kind: 'history' },
          { kind: 'pulls' },
          { kind: 'pr', repoPath: dir, number: 42 },
          { kind: 'config' },
          { kind: 'content' },
          { kind: 'settings' }
        ],
        activeId: `project:${dir}`
      },
      firstRunCompletedAt: '2026-08-09T12:00:00.000Z',
      claudePath: join(dir, 'claude.exe'),
      usageDisplay: 'cost',
      terminalFontFamily: 'Consolas',
      terminalFontSize: 17,
      terminalCursorStyle: 'bar',
      terminalCursorBlink: false,
      terminalScrollback: 2500,
      terminalShell: join(dir, 'pwsh.exe'),
      projectShellHeightPct: 42,
      sessionSplitPct: 62,
      contentWrap: true,
      contentWrapIndent: 6,
      transcriptArchiveMaxBytes: 256 * 1024 * 1024,
      ghPath: join(dir, 'gh.exe'),
      prPollMinutes: 15,
      prStaleDays: 7,
      prIgnoredRepos: ['acme/noisy', 'other/quiet'],
      prReviewPrompt: 'review {slug}#{number} on {branch}',
      prCheckout: 'checkout',
      prReviewModel: 'opus',
      prReviewEffort: 'high',
      updateCheck: false,
      lastUpdateCheckAt: '2026-08-11T20:04:06.641Z',
      browserReach: 'local',
      browserMcp: false,
      browserMcpLocalOnly: true,
      browserRecentUrls: ['http://localhost:3000/', 'https://example.com/docs'],
      browserProjectUrls: { [join(dir, 'alpha').toLowerCase()]: 'http://localhost:5173/' },
      sessionMcp: false
    } satisfies AppSettings

    writeSettings(store, written)

    expect(readSettings(store)).toEqual(written)
    // Every key of the interface, not merely the ones this test remembered to
    // list: a key added without a line here would otherwise round-trip untested.
    expect(Object.keys(written).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })

  it('survives a restart', () => {
    writeSettings(store, { theme: 'dark', scanRoots: [dir] })
    store.close()

    const reopened = openStore({ file: join(dir, 'helm.db') })
    try {
      expect(readSettings(reopened)).toMatchObject({ theme: 'dark', scanRoots: [dir] })
    } finally {
      reopened.close()
    }
  })

  it('ignores keys it does not recognise instead of surfacing them', () => {
    store.raw
      .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('legacyKey', '1', '')")
      .run()

    expect(readSettings(store)).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to the default for a value that is not valid JSON', () => {
    store.raw
      .prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('theme', '{oops', '')")
      .run()

    expect(readSettings(store).theme).toBe(DEFAULT_SETTINGS.theme)
  })
})

describe('settings validation', () => {
  /**
   * Every key, with a value that fits and one that does not.
   *
   * The good column is not decoration: a rejection test whose valid case is
   * never exercised cannot tell "the validator is right" from "the validator
   * refuses everything", which is the same trap CLAUDE.md's fixture rule
   * describes. Both columns run against the same key.
   */
  const cases: Array<{
    key: keyof typeof DEFAULT_SETTINGS
    good: unknown[]
    bad: unknown[]
  }> = [
    {
      key: 'theme',
      good: ['system', 'light', 'dark'],
      bad: ['purple', 'Dark', '', null, 1, ['dark'], { theme: 'dark' }]
    },
    {
      key: 'usageDisplay',
      good: ['percent', 'cost', 'off'],
      bad: ['dollars', 'PERCENT', null, 0, ['off']]
    },
    {
      key: 'scanRoots',
      good: [[], [join(tmpdir(), 'a')], [join(tmpdir(), 'a'), join(tmpdir(), 'b')]],
      bad: [null, 'C:\\work', ['repos/helm'], ['../up'], [''], [17], [null]]
    },
    {
      key: 'pinnedProjects',
      // Absolute paths, as a set. Two spellings of one path is the interesting
      // rejection and it is the same shape as `prIgnoredRepos`': the comparison
      // is case-insensitive, so `C:\Repos\Api` and `c:\repos\api` would present
      // as two rows in a section where un-pinning either removes both. Mixed
      // case across *different* paths is fine and is in the good column - and
      // on Linux, where case is a different directory, so is the re-cased pair.
      good: [
        [],
        [join(tmpdir(), 'alpha')],
        [join(tmpdir(), 'alpha'), join(tmpdir(), 'Beta')],
        [join(tmpdir(), 'a folder with spaces')],
        ...(process.platform === 'win32' ? [] : [[join(tmpdir(), 'alpha'), join(tmpdir(), 'ALPHA')]])
      ],
      bad: [
        ...(process.platform === 'win32' ? [[join(tmpdir(), 'alpha'), join(tmpdir(), 'ALPHA')]] : []),
        [join(tmpdir(), 'alpha'), join(tmpdir(), 'alpha')],
        ['repos/helm'],
        ['../up'],
        [''],
        ['   '],
        [17],
        [null],
        join(tmpdir(), 'alpha'),
        null,
        {},
        Array.from({ length: PINNED_PROJECTS_MAX + 1 }, (_, i) => join(tmpdir(), `p${String(i)}`))
      ]
    },
    {
      key: 'claudePath',
      good: [null, join(tmpdir(), 'claude.exe')],
      bad: ['claude', 'bin\\claude.exe', '', 42, {}]
    },
    {
      key: 'windowBounds',
      good: [null, { width: 1280, height: 820 }, { width: 1280, height: 820, x: 40, y: 60 }],
      bad: [
        { width: 0, height: 820 },
        { width: -1280, height: 820 },
        { width: 1280 },
        { width: '1280', height: '820' },
        { width: 1280, height: 820, x: 'left', y: 60 },
        { width: Number.NaN, height: 820 },
        [1280, 820],
        'maximized'
      ]
    },
    {
      key: 'workspaceTabs',
      good: [
        null,
        { panes: [], activeId: null },
        { panes: [{ kind: 'history' }], activeId: 'history' },
        {
          panes: [
            { kind: 'project', path: 'C:\\work\\helm' },
            { kind: 'pr', repoPath: 'C:\\work\\helm', number: 7 },
            { kind: 'pulls' },
            { kind: 'config' },
            { kind: 'content' },
            { kind: 'settings' }
          ],
          activeId: 'pr:C:\\work\\helm#7'
        }
      ],
      bad: [
        // Not a strip at all.
        [],
        'history',
        42,
        { activeId: null },
        { panes: {}, activeId: null },
        // A kind this build does not have, which is the shape a renamed pane
        // would arrive in.
        { panes: [{ kind: 'terminal' }], activeId: null },
        { panes: [{ kind: 'project' }], activeId: null },
        { panes: [{ kind: 'project', path: '' }], activeId: null },
        { panes: [{ kind: 'pr', repoPath: 'C:\\work\\helm' }], activeId: null },
        { panes: [{ kind: 'pr', repoPath: 'C:\\work\\helm', number: 0 }], activeId: null },
        { panes: [{ kind: 'pr', repoPath: 'C:\\work\\helm', number: 1.5 }], activeId: null },
        { panes: [{ kind: 'pr', repoPath: '', number: 7 }], activeId: null },
        { panes: ['history'], activeId: null },
        { panes: [null], activeId: null },
        // An id is compared against tabs, never parsed, so anything that is not
        // a string cannot match one.
        { panes: [], activeId: 7 },
        // Longer than any workspace: a runaway list is a bug, not an arrangement.
        { panes: Array.from({ length: 101 }, () => ({ kind: 'history' })), activeId: null }
      ]
    },
    {
      key: 'firstRunCompletedAt',
      good: [null, '2026-08-11T09:00:00.000Z'],
      bad: ['soon', '', 1786353684315, {}]
    },
    {
      key: 'terminalFontFamily',
      good: [null, 'Consolas', 'Cascadia Mono', 'MesloLGS NF'],
      bad: [
        '',
        '   ',
        // A stack, which would read as though it replaced the default one.
        'Fira Code, monospace',
        // Everything below ends a `font-family` declaration and starts
        // something else, inside an inline style xterm writes for us.
        'x; color: red',
        'x">',
        'x/*',
        42,
        ['Consolas']
      ]
    },
    {
      key: 'terminalFontSize',
      good: [8, 14, 32],
      bad: [7, 33, 0, -14, 14.5, '14', null, Number.NaN, Number.POSITIVE_INFINITY]
    },
    {
      key: 'terminalCursorStyle',
      good: ['block', 'underline', 'bar'],
      bad: ['beam', 'BLOCK', '', null, 0]
    },
    {
      key: 'terminalCursorBlink',
      good: [true, false],
      bad: ['true', 1, 0, null, {}]
    },
    {
      key: 'terminalScrollback',
      good: [500, 10_000, 200_000],
      bad: [499, 200_001, 0, -1, 1000.5, '10000', null]
    },
    {
      key: 'terminalShell',
      good: [null, join(tmpdir(), 'pwsh.exe'), join(tmpdir(), 'bin', 'bash')],
      bad: ['pwsh.exe', 'bin\\pwsh.exe', '', 42, {}]
    },
    {
      // A percentage of the project page's column. 51 is in the bad column
      // because the ceiling is the user's own ask - the project pane is never
      // the smaller half of its own page - and the non-finite cases are there
      // because this number becomes a `height`, where `NaN%` is a declaration
      // the style parser drops without a word.
      key: 'projectShellHeightPct',
      good: [10, 30, 50],
      bad: [9, 51, 0, -30, 100, 30.5, '30', null, Number.NaN, Number.POSITIVE_INFINITY]
    },
    {
      // The sessions column's share of the window. The bounds are wider than
      // the shell's because neither side of this divider is the subordinate
      // one - a workspace squeezed to a fifth is a choice somebody can make,
      // where a project page that is mostly shell is not.
      //
      // The non-finite cases matter here for the same reason: the fraction
      // becomes a `flex-grow`, and `flex: NaN 1 0%` is dropped by the parser,
      // which would collapse the column rather than fail.
      key: 'sessionSplitPct',
      good: [20, 45, 80],
      bad: [19, 81, 0, -45, 100, 45.5, '45', null, Number.NaN, Number.POSITIVE_INFINITY]
    },
    {
      // Whether a source file wraps. `'true'` and `1` are in the bad column
      // because this value is read straight into a class decision, where any
      // truthy string would switch wrapping on and `'false'` would too.
      key: 'contentWrap',
      good: [true, false],
      bad: ['true', 'false', 1, 0, null, {}, []]
    },
    {
      // The hanging indent, in columns. Zero is *good* - it is what a plain
      // editor does, and the setting has to be able to say so. Negative is bad
      // even though the CSS would accept it: a negative hang pulls a
      // continuation left of the code it belongs to, which reads as a new
      // statement rather than the same one.
      key: 'contentWrapIndent',
      good: [0, 4, 16],
      bad: [-1, 17, 4.5, '4', null, Number.NaN, Number.POSITIVE_INFINITY]
    },
    {
      // A byte count, and null is in the *bad* column deliberately: there is no
      // "no ceiling" for this key. The archive is always on and always bounded,
      // and an unbounded one is the state `helm.db` is not allowed to reach.
      key: 'transcriptArchiveMaxBytes',
      good: [1024, 1024 ** 3, 64 * 1024 ** 3],
      bad: [1023, 0, -1, 64 * 1024 ** 3 + 1, 1024.5, '1073741824', null, {}]
    },
    {
      key: 'ghPath',
      good: [null, join(tmpdir(), 'gh.exe')],
      bad: ['gh', 'bin\\gh.exe', '', 42, {}]
    },
    {
      key: 'prPollMinutes',
      // 0 is off; everything else is at least five minutes apart, because a
      // pass is one `gh` per remote against the user's own rate limit.
      good: [0, 5, 60, 1440],
      bad: [1, 4, 1441, -5, 5.5, '5', null, Number.NaN]
    },
    {
      key: 'prStaleDays',
      // 0 is off - one Open list and no split - and it is outside the range
      // rather than at the bottom of it, so 1 is the smallest cutoff there is.
      good: [0, 1, 2, 90],
      // A day and a half is the interesting rejection: the unit is days, the
      // pane's caption says "days", and a fractional cutoff would put a row in
      // a bucket no sentence on the surface describes.
      bad: [-1, 91, 1.5, '2', null, {}, Number.NaN, Number.POSITIVE_INFINITY]
    },
    {
      key: 'prIgnoredRepos',
      // A set of `owner/name`. The duplicate cases are the interesting ones:
      // the matcher is case-insensitive, so two spellings of one repository
      // would present as two rows that cannot be unticked independently.
      good: [[], ['acme/widget'], ['acme/widget', 'Acme/Other'], ['a.b/c-d_e']],
      bad: [
        ['acme/widget', 'ACME/Widget'],
        ['acme/widget', 'acme/widget'],
        ['acme'],
        ['acme/widget/extra'],
        ['/widget'],
        ['acme/'],
        ['acme widget/x'],
        [' acme/widget'],
        ['https://github.com/acme/widget'],
        [''],
        [42],
        [null],
        'acme/widget',
        null,
        {}
      ]
    },
    {
      key: 'prReviewPrompt',
      // A placeholder this build does not know is deliberately valid: it
      // survives into the prompt exactly as written, which is what makes a
      // typo visible in the pane rather than a word missing from the argv.
      good: ['/code-review {number}', 'look at {url}', 'review {whatever}', 'x'.repeat(2000)],
      bad: ['', '   ', 'x'.repeat(2001), null, 42, {}, ['/code-review']]
    },
    {
      key: 'prCheckout',
      good: ['none', 'checkout'],
      bad: ['worktree', 'None', '', true, null, 0]
    },
    {
      key: 'prReviewModel',
      // Null is "pass no --model", and a full model id is as valid as an alias:
      // this deliberately does not police the CLI's naming, only the shape of
      // an argv word (see the validator).
      good: [null, 'opus', 'sonnet', 'fable', 'claude-opus-5', 'claude-haiku-4-5-20251001'],
      bad: ['', '   ', ' opus', 'opus ', 'claude opus', '--model', '-o', 'x'.repeat(101), 42, {}]
    },
    {
      key: 'prReviewEffort',
      good: [null, 'low', 'medium', 'high', 'xhigh', 'max'],
      bad: ['none', 'High', '', 'maximum', 3, true, ['high']]
    },
    {
      key: 'updateCheck',
      good: [true, false],
      bad: ['true', 'false', 1, 0, null, {}, []]
    },
    {
      // `'never'` and `'soon'` are the interesting rejections: an unparseable
      // instant here would make every throttle comparison NaN, and NaN fails
      // every `>`, so one bad row would mean "never check again" rather than
      // "check now" - and it would do it silently.
      key: 'lastUpdateCheckAt',
      good: [null, '2026-08-11T20:04:06.641Z', '2026-08-11T14:04:06-06:00'],
      bad: ['never', 'soon', '', 0, 1786478646641, true, {}]
    },
    {
      key: 'browserReach',
      good: ['web', 'local'],
      bad: ['none', 'Web', 'loopback', '', null, true, ['web']]
    },
    {
      // `'false'` is the interesting rejection for both, and it is the same one
      // `updateCheck` has: a row hand-edited into that string would switch the
      // endpoint **on** while the pane read it as off, since every non-empty
      // string is truthy.
      key: 'browserMcp',
      good: [true, false],
      bad: ['false', 'true', 0, 1, null, [], {}]
    },
    {
      key: 'browserMcpLocalOnly',
      good: [true, false],
      bad: ['false', 'true', 0, 1, null, [], {}]
    },
    {
      // And the same again for the session tools, which decide the same thing:
      // whether a route exists at all.
      key: 'sessionMcp',
      good: [true, false],
      bad: ['false', 'true', 0, 1, null, [], {}]
    },
    {
      // The interesting rejections are the ones that would put a row in the
      // dropdown that does nothing when clicked: a bare word, a relative path,
      // and `file:` - which the pane refuses to navigate to, so it must not be
      // offered one either.
      key: 'browserRecentUrls',
      good: [[], ['http://localhost:3000/'], ['https://example.com/a', 'http://127.0.0.1:8080/b']],
      bad: [
        null,
        'http://localhost:3000/',
        ['localhost:3000'],
        ['file:///C:/tmp/x.html'],
        ['/docs'],
        [''],
        [42],
        Array.from({ length: 11 }, (_, i) => `http://localhost:${String(3000 + i)}/`)
      ]
    },
    {
      key: 'browserProjectUrls',
      good: [
        {},
        { [join(tmpdir(), 'alpha').toLowerCase()]: 'http://localhost:5173/' },
        {
          [join(tmpdir(), 'alpha').toLowerCase()]: 'http://localhost:5173/',
          [join(tmpdir(), 'beta').toLowerCase()]: 'https://example.com/'
        }
      ],
      bad: [
        null,
        [],
        'http://localhost:5173/',
        // Not lower-cased, so two spellings of one project would each keep a
        // URL and the second would never be found.
        { [join(tmpdir(), 'Alpha')]: 'http://localhost:5173/' },
        { 'repos/alpha': 'http://localhost:5173/' },
        { [join(tmpdir(), 'alpha').toLowerCase()]: 'localhost:5173' },
        { [join(tmpdir(), 'alpha').toLowerCase()]: null }
      ]
    }
  ]

  /**
   * A key with no row above generates no test, and generates it silently.
   *
   * The table is an array, so nothing makes a missing key an error - it simply
   * produces one `it` fewer, in a file that already prints seventy of them. The
   * same table one level up, in `settingscheck.ts`, went stale exactly this way
   * when the content viewer's two wrapping keys landed: both were validated,
   * neither was probed, and the only thing that noticed was a boolean buried in
   * a check that takes minutes to reach. That one is a
   * `Record<keyof AppSettings, ...>` now and fails to compile. This one cannot
   * be, so it is asserted instead - and here, where it costs a second.
   */
  it('has a case for every key of AppSettings', () => {
    expect(cases.map((entry) => entry.key).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })

  for (const { key, good, bad } of cases) {
    it(`accepts every valid ${key} and rejects the rest`, () => {
      for (const value of good) {
        expect(validateSetting(key, value)).toBeNull()
        expect(() => writeSetting(store, key, value as never)).not.toThrow()
        expect(readSettings(store)[key]).toEqual(value)
      }

      for (const value of bad) {
        expect(validateSetting(key, value)).toContain(key)
        expect(() => writeSetting(store, key, value as never)).toThrow(SettingsValidationError)
      }
    })
  }

  it('leaves the stored value untouched when a write is rejected', () => {
    writeSetting(store, 'theme', 'dark')

    expect(() => writeSetting(store, 'theme', 'purple' as never)).toThrow(SettingsValidationError)
    expect(readSettings(store).theme).toBe('dark')

    const row = store.raw.prepare("SELECT value FROM app_settings WHERE key = 'theme'").get()
    expect((row as { value: string }).value).toBe('"dark"')
  })

  it('applies a patch as one edit: one bad key writes none of them', () => {
    writeSettings(store, { theme: 'dark', usageDisplay: 'cost' })

    expect(() =>
      writeSettings(store, { theme: 'light', usageDisplay: 'dollars' as never })
    ).toThrow(SettingsValidationError)

    expect(readSettings(store)).toMatchObject({ theme: 'dark', usageDisplay: 'cost' })
  })

  it('names every problem in the patch, not just the first', () => {
    let thrown: SettingsValidationError | null = null
    try {
      writeSettings(store, { theme: 'purple' as never, claudePath: 'claude' })
    } catch (err) {
      thrown = err as SettingsValidationError
    }

    expect(thrown?.problems).toHaveLength(2)
    expect(thrown?.message).toContain('theme')
    expect(thrown?.message).toContain('claudePath')
  })

  it('still ignores keys it does not recognise rather than rejecting the patch', () => {
    const after = writeSettings(store, {
      theme: 'light',
      // A key from a build that is not this one. Tolerated on the way in for
      // the same reason `readSettings` tolerates it on the way out.
      somethingLater: 'whatever'
    } as never)

    expect(after.theme).toBe('light')
    expect(store.raw.prepare("SELECT * FROM app_settings WHERE key = 'somethingLater'").get()).toBe(
      undefined
    )
  })

  it('accepts a settings object read straight back out of the database', () => {
    // The round trip that matters: whatever `readSettings` returns has to be
    // writable again, or a surface that reads, edits one field and writes the
    // whole object back would be rejected for values it never touched.
    writeSettings(store, {
      theme: 'dark',
      scanRoots: [dir],
      pinnedProjects: [join(dir, 'alpha')],
      windowBounds: { width: 1280, height: 820, x: 40, y: 60 },
      workspaceTabs: { panes: [{ kind: 'project', path: dir }, { kind: 'config' }], activeId: 'config' },
      firstRunCompletedAt: '2026-08-11T09:00:00.000Z',
      claudePath: join(dir, 'claude.exe'),
      usageDisplay: 'off',
      terminalFontFamily: 'Cascadia Mono',
      terminalFontSize: 12,
      terminalCursorStyle: 'underline',
      terminalCursorBlink: false,
      terminalScrollback: 50_000,
      terminalShell: join(dir, 'cmd.exe'),
      projectShellHeightPct: 45,
      sessionSplitPct: 70,
      contentWrap: true,
      contentWrapIndent: 2,
      transcriptArchiveMaxBytes: 512 * 1024 * 1024,
      ghPath: join(dir, 'gh.exe'),
      prPollMinutes: 0,
      prStaleDays: 3,
      prIgnoredRepos: ['acme/noisy'],
      prReviewPrompt: '/code-review {number}',
      prCheckout: 'none',
      prReviewModel: 'sonnet',
      prReviewEffort: null,
      updateCheck: true,
      lastUpdateCheckAt: null,
      browserReach: 'local',
      browserMcp: false,
      browserMcpLocalOnly: true,
      browserRecentUrls: ['http://localhost:3000/'],
      browserProjectUrls: { [join(dir, 'alpha').toLowerCase()]: 'http://localhost:5173/' },
      sessionMcp: false
    })

    expect(() => writeSettings(store, readSettings(store))).not.toThrow()
    expect(readSettings(store)).toEqual(DEFAULT_SETTINGS_SHAPE(dir))
  })
})

/** What the round-trip test above expects, spelled out away from the writer. */
const DEFAULT_SETTINGS_SHAPE = (dir: string): typeof DEFAULT_SETTINGS => ({
  theme: 'dark',
  scanRoots: [dir],
  pinnedProjects: [join(dir, 'alpha')],
  windowBounds: { width: 1280, height: 820, x: 40, y: 60 },
  workspaceTabs: { panes: [{ kind: 'project', path: dir }, { kind: 'config' }], activeId: 'config' },
  firstRunCompletedAt: '2026-08-11T09:00:00.000Z',
  claudePath: join(dir, 'claude.exe'),
  usageDisplay: 'off',
  terminalFontFamily: 'Cascadia Mono',
  terminalFontSize: 12,
  terminalCursorStyle: 'underline',
  terminalCursorBlink: false,
  terminalScrollback: 50_000,
  terminalShell: join(dir, 'cmd.exe'),
  projectShellHeightPct: 45,
  sessionSplitPct: 70,
  contentWrap: true,
  contentWrapIndent: 2,
  transcriptArchiveMaxBytes: 512 * 1024 * 1024,
  ghPath: join(dir, 'gh.exe'),
  prPollMinutes: 0,
  prStaleDays: 3,
  prIgnoredRepos: ['acme/noisy'],
  prReviewPrompt: '/code-review {number}',
  prCheckout: 'none',
  prReviewModel: 'sonnet',
  prReviewEffort: null,
  updateCheck: true,
  lastUpdateCheckAt: null,
  browserReach: 'local',
  browserMcp: false,
  browserMcpLocalOnly: true,
  browserRecentUrls: ['http://localhost:3000/'],
  browserProjectUrls: { [join(dir, 'alpha').toLowerCase()]: 'http://localhost:5173/' },
  sessionMcp: false
})

describe('pinned projects', () => {
  const a = 'C:\\Repos\\Api'
  const b = 'C:\\Repos\\web'

  it('matches a path however it was spelled', () => {
    // Windows paths are case-insensitive, and the two places this list meets
    // the tree - the Pinned section and the harness group a pinned project is
    // *left out* of - both compare with `toLowerCase`. If this did not, a pin
    // written in one casing would print the project twice.
    expect(isProjectPinned([a], 'c:\\repos\\api')).toBe(true)
    expect(isProjectPinned(['c:\\repos\\api'], a)).toBe(true)
    expect(isProjectPinned([a], 'C:\\Repos\\Api2')).toBe(false)
    expect(isProjectPinned([], a)).toBe(false)
  })

  it('adds and removes, sorted, so the value does not depend on click order', () => {
    expect(withProjectPinned([], b, true)).toEqual([b])
    expect(withProjectPinned([b], a, true)).toEqual([a, b])
    expect(withProjectPinned([a, b], a, false)).toEqual([b])
  })

  it('never leaves a second spelling of the same project behind', () => {
    expect(withProjectPinned([a], 'c:\\repos\\api', false)).toEqual([])
    expect(withProjectPinned([a], 'c:\\repos\\api', true)).toEqual(['c:\\repos\\api'])
  })

  it('leaves the list it was given alone', () => {
    const held = [a]
    expect(withProjectPinned(held, b, true)).toEqual([a, b])
    expect(held).toEqual([a])
  })

  it('produces a list the validator accepts', () => {
    // The toggle and the validator have to agree about what a set is: a helper
    // that could produce two spellings would build a value nothing can write.
    // Absolute on the host running the suite, since the validator asks the
    // host's `path`; the toggle's fold is a Windows one, so on Linux the second
    // spelling is a distinct directory and the set grows.
    const win = process.platform === 'win32'
    const api = win ? a : '/repos/Api'
    const web = win ? b : '/repos/web'
    let held: string[] = []
    for (const path of [api, web, api.toLowerCase(), web.toUpperCase()]) {
      held = withProjectPinned(held, path, true)
      expect(validateSetting('pinnedProjects', held)).toBeNull()
    }
    expect(held).toHaveLength(2)
  })
})

describe('project cache', () => {
  it('round-trips a project including its inventory and git state', () => {
    cacheProjects(store, [project()], [])

    const [cached] = readCachedProjects(store)
    expect(cached).toMatchObject({
      name: 'alpha',
      kind: 'repo',
      hasClaudeDir: true,
      inventory: { skills: 7, agents: 16, commands: 20 },
      git: { branch: 'main', dirty: 3, ahead: 1 }
    })
    expect(cached?.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('upserts on path rather than duplicating', () => {
    cacheProjects(store, [project()], [])
    cacheProjects(store, [project({ git: { branch: 'main', detached: false, dirty: 0, ahead: 0, behind: 0 } })], [])

    const cached = readCachedProjects(store)
    expect(cached).toHaveLength(1)
    expect(cached[0]?.git?.dirty).toBe(0)
  })

  it('stores a null git state for a directory that is not a repo', () => {
    cacheProjects(store, [project({ git: null })], [])
    expect(readCachedProjects(store)[0]?.git).toBeNull()
  })

  /*
   * The harness's `template:` is the one thing a cached row carries that is not
   * on the `Project` object, so it comes in beside the projects rather than on
   * them. The second half of this is the one that matters: a later write that
   * forgot to pass the harnesses would put null over it, and the launcher would
   * paint a harness with no provenance for the first frame of every start.
   */
  it('carries a harness template through the cache, and only for the harness row', () => {
    const harnessRow = project({ path: dir, name: 'work', kind: 'harness' })
    const harness = { path: dir, name: 'work', template: 'demo', version: '1', repoPaths: [] }
    cacheProjects(store, [harnessRow, project()], [harness])

    const cached = readCachedProjects(store)
    expect(cached.find((p) => p.kind === 'harness')?.template).toBe('demo')
    expect(cached.find((p) => p.kind === 'repo')?.template).toBeNull()

    cacheProjects(store, [harnessRow, project()], [harness])
    expect(readCachedProjects(store).find((p) => p.kind === 'harness')?.template).toBe('demo')
  })

  it('forgets rows by path, however they were spelled, and only those', () => {
    const alpha = join(dir, 'repos', 'alpha')
    const beta = join(dir, 'repos', 'beta')
    cacheProjects(store, [project(), project({ path: beta, name: 'beta' })], [])

    // Another spelling of the same directory on Windows; on Linux that would be
    // a directory nothing cached, so the row is named the way it was written.
    expect(forgetProjects(store, [process.platform === 'win32' ? alpha.toUpperCase() : alpha])).toBe(1)
    expect(readCachedProjects(store).map((p) => p.path)).toEqual([beta])
    // Idempotent, because the caller works out what to forget from a list that
    // may already have been reconciled by the scan that preceded it.
    expect(forgetProjects(store, [alpha])).toBe(0)
    expect(forgetProjects(store, [])).toBe(0)
    expect(readCachedProjects(store)).toHaveLength(1)
  })
})

describe('session log', () => {
  const started = (name = 'alpha'): ReturnType<typeof startSession> =>
    startSession(store, {
      name,
      cwd: join(dir, 'repos', 'alpha'),
      projectPath: join(dir, 'repos', 'alpha'),
      argv: ['-n', name]
    })

  it('records a session as running from the moment it is spawned', () => {
    const session = started()

    expect(session).toMatchObject({
      name: 'alpha',
      status: 'running',
      argv: ['-n', 'alpha'],
      endedAt: null,
      durationMs: null,
      exitCode: null
    })
    expect(session.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('records the exit code and a measured duration when it ends', () => {
    const session = started()
    const ended = finishSession(store, session.id, { exitCode: 0 })

    expect(ended).toMatchObject({ id: session.id, status: 'exited', exitCode: 0 })
    expect(ended?.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // Measured, not guessed: a real duration is small here but never negative,
    // which is the failure mode of subtracting two different clocks.
    expect(ended?.durationMs).toBeGreaterThanOrEqual(0)
    expect(ended?.durationMs).toBeLessThan(60_000)
  })

  it('keeps a non-zero exit code rather than flattening it to a failure flag', () => {
    const session = started()
    expect(finishSession(store, session.id, { exitCode: 130 })?.exitCode).toBe(130)
  })

  it('ignores a second finish, so a shutdown sweep cannot overwrite a real exit', () => {
    const session = started()
    finishSession(store, session.id, { exitCode: 0 })

    expect(finishSession(store, session.id, { exitCode: null })).toBeNull()
    expect(readSessions(store)[0]?.exitCode).toBe(0)
  })

  it('reconciles sessions left running by a host that did not survive them', () => {
    const alive = started('alpha')
    const ended = started('beta')
    finishSession(store, ended.id, { exitCode: 0 })

    expect(reconcileRunningSessions(store)).toBe(1)

    const rows = readSessions(store)
    expect(rows.find((r) => r.id === alive.id)).toMatchObject({
      status: 'lost',
      endedAt: null,
      durationMs: null
    })
    // The one that ended cleanly keeps its outcome.
    expect(rows.find((r) => r.id === ended.id)).toMatchObject({ status: 'exited', exitCode: 0 })
  })

  it('lists newest first and filters by status and project', () => {
    const first = started('alpha')
    const second = started('beta')
    startSession(store, { name: 'gamma', cwd: dir, projectPath: null })
    finishSession(store, first.id, { exitCode: 0 })

    expect(readSessions(store).map((s) => s.id)).toEqual([
      expect.any(Number),
      second.id,
      first.id
    ])
    expect(readSessions(store, { status: 'running' }).map((s) => s.name)).toEqual([
      'gamma',
      'beta'
    ])
    expect(
      readSessions(store, { projectPath: join(dir, 'repos', 'alpha') }).map((s) => s.name)
    ).toEqual(['beta', 'alpha'])
  })

  it('reports the names a new session has to be unique against', () => {
    const one = started('alpha')
    started('alpha 2')
    finishSession(store, one.id, { exitCode: 0 })

    expect(runningSessionNames(store)).toEqual(['alpha 2'])
  })

  it('records the branch the cwd was on, and null for a cwd that is not on one', () => {
    const onBranch = startSession(store, { name: 'alpha', cwd: dir, branch: 'feat/tabs' })
    const noBranch = startSession(store, { name: 'beta', cwd: dir })

    expect(onBranch.branch).toBe('feat/tabs')
    expect(noBranch.branch).toBeNull()
  })

  it('records the conversation id the launch assigned, and null for none', () => {
    const uuid = '7b3d1c20-4a55-4f18-9c21-8e0c5a6d1f01'
    const assigned = startSession(store, { name: 'alpha', cwd: dir, claudeSessionId: uuid })
    // Null is a real answer, not a gap: a row from before this column, and a
    // CLI with no `--session-id` flag, both land here.
    const unassigned = startSession(store, { name: 'beta', cwd: dir })

    expect(assigned.claudeSessionId).toBe(uuid)
    expect(unassigned.claudeSessionId).toBeNull()
    // In the row rather than only in the answer.
    expect(readSessions(store).map((s) => s.claudeSessionId)).toContain(uuid)
  })

  it('starts with no label, so a session is called what the CLI was told', () => {
    const session = started()
    expect(session.label).toBeNull()
    expect(sessionLabel(session)).toBe('alpha')
  })

  it('renames a session without touching the name that went to the CLI', () => {
    const session = started()
    const renamed = renameSession(store, session.id, 'PR review')

    expect(renamed).toMatchObject({ id: session.id, label: 'PR review', name: 'alpha' })
    expect(sessionLabel(renamed!)).toBe('PR review')
    // And it is in the row, not only in the answer.
    expect(readSessions(store)[0]).toMatchObject({ label: 'PR review', name: 'alpha' })
  })

  it('treats an empty or whitespace label as clearing it, not as an empty title', () => {
    const session = started()
    renameSession(store, session.id, 'PR review')

    expect(renameSession(store, session.id, '   ')?.label).toBeNull()
    expect(sessionLabel(readSessions(store)[0]!)).toBe('alpha')
    expect(renameSession(store, session.id, null)?.label).toBeNull()
  })

  it('trims a label rather than storing the spaces around it', () => {
    const session = started()
    expect(renameSession(store, session.id, '  PR review  ')?.label).toBe('PR review')
  })

  it('answers null for a session id that is not in this database', () => {
    expect(renameSession(store, 9999, 'nope')).toBeNull()
  })

  it('keeps the label through the session ending, so a dead tab stays named', () => {
    const session = started()
    renameSession(store, session.id, 'PR review')

    expect(finishSession(store, session.id, { exitCode: 0 })?.label).toBe('PR review')
  })

  it('gives a new session none of a finished one’s label', () => {
    const first = started('alpha')
    renameSession(store, first.id, 'PR review')
    finishSession(store, first.id, { exitCode: 0 })

    // A label belongs to a row. Nothing recycles it onto the next session, which
    // is the failure the `-n` counter had.
    expect(started('alpha').label).toBeNull()
  })
})

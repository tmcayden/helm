import { type BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  claudeConfigFileIn,
  claudeHome,
  countUsageMessages,
  projectsDirIn,
  readSettings,
  type WslHome
} from '@helm/core'
import { screenshot, sleep, stripAnsi, waitFor } from './bridge'
import type { Check } from './fidelity'
import { atPrompt, type Collector, type CheckContext } from './sessionscheck'
import { answerConsent } from './profilescheck'
import { wslHomes } from './wsl'

/**
 * The status bar's usage figures, driven through the app the way a user sees
 * them.
 *
 * The discipline is the other drivers': nothing is asserted against Helm's own
 * answer alone. Everything below is checked against a second read written in
 * this file which shares no code with the thing it checks - a plain
 * `JSON.parse` and hand-written field access beside `parseUsage`, a
 * hand-written "which of these may be shown" beside `usageView`, a
 * hand-computed weekday and clock time beside `formatResetsIn`, and a regex
 * over the text a person actually reads beside the component that rendered it.
 * A parser agreeing with itself proves nothing.
 *
 * Three of the criteria cannot be settled by agreement at all:
 *
 *   Criterion 2 is about a *session*, so the second opinion is a real one: a
 *   live `claude` is asked for `/usage` and the percentages it paints in its
 *   own TUI are compared to the ones in the status bar. `/usage` makes a usage
 *   request rather than an inference request, so this costs a session start and
 *   no tokens.
 *
 *   Criterion 3 is about a window *rolling over*, which is a thing that happens
 *   to a reading with nothing on disk having changed. So the fixture's session
 *   window is set to reset ten seconds out and the driver watches the segment
 *   drop it on its own, rather than being handed a reset time in the past and
 *   asked whether it likes it.
 *
 *   Criterion 7 is a *measurement* and is reported as a number whether or not
 *   it passes: the full parse of every transcript, which is the cost being
 *   avoided, measured here rather than quoted.
 *
 * `pnpm usage-check` -> helm-data/usage-report.json
 */

const GROUPS = [
  'read',
  'watch',
  'resets',
  'degrade',
  'setting',
  'width',
  'cost',
  'dollars',
  'live',
  // Last on purpose, and the ordering is load-bearing rather than cosmetic -
  // see the comment on the group itself. `useHomes` appends and nothing
  // removes.
  'homes'
] as const
type Group = (typeof GROUPS)[number]

/**
 * The staleness horizon, written out again rather than imported.
 *
 * This is the check's copy of the rule, and it is supposed to be a second
 * statement of it: if `USAGE_STALE_AFTER_MS` moves and this does not, the two
 * disagree and the check goes red, which is the point. Importing the constant
 * would make the assertion "the reader agrees with the reader".
 */
const STALE_AFTER_MS = 30 * 60_000

// ---------------------------------------------------------------------------
// A second opinion about what is in ~/.claude.json
// ---------------------------------------------------------------------------

interface OwnLimit {
  kind: string
  group: string
  percent: number
  resetsAtMs: number | null
  scope: string | null
}

interface OwnReading {
  fetchedAtMs: number | null
  limits: OwnLimit[]
  /** Set when the file could not be turned into a reading at all. */
  broken: string | null
}

/**
 * `cachedUsageUtilization`, read the naive way.
 *
 * Deliberately not `parseUsage`: a plain parse, dot-access on the fields the
 * ClickUp task recorded, and no defensiveness beyond a try/catch. The point is
 * to disagree with the reader if the reader is wrong.
 */
function ownRead(file: string): OwnReading {
  let root: Record<string, unknown>
  try {
    root = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (err) {
    return { fetchedAtMs: null, limits: [], broken: err instanceof Error ? err.message : String(err) }
  }

  const cached = root['cachedUsageUtilization'] as
    | { fetchedAtMs?: unknown; utilization?: { limits?: unknown } }
    | null
    | undefined
  if (cached === null || cached === undefined || typeof cached !== 'object') {
    return { fetchedAtMs: null, limits: [], broken: 'no cachedUsageUtilization' }
  }

  const fetchedAtMs = typeof cached.fetchedAtMs === 'number' ? cached.fetchedAtMs : null
  const raw = cached.utilization?.limits
  if (!Array.isArray(raw)) return { fetchedAtMs, limits: [], broken: 'no utilization.limits array' }

  const limits: OwnLimit[] = []
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (typeof entry !== 'object' || entry === null) continue
    if (typeof entry['percent'] !== 'number') continue
    const resets = entry['resets_at']
    const scope = entry['scope'] as { model?: { display_name?: unknown } } | null | undefined
    limits.push({
      kind: String(entry['kind'] ?? ''),
      group: String(entry['group'] ?? ''),
      percent: entry['percent'],
      resetsAtMs: typeof resets === 'string' ? Date.parse(resets) : null,
      scope: typeof scope?.model?.display_name === 'string' ? scope.model.display_name : null
    })
  }
  return { fetchedAtMs, limits, broken: null }
}

interface OwnExpectation {
  /** What the segment must show, or null for "must show no number". */
  session: number | null
  weekly: number | null
  weeklyScope: string | null
  /** Why nothing may be shown. Null when something may. */
  silentBecause: string | null
  /**
   * The figures must be painted as lower bounds - a `≥` in front of each.
   *
   * This driver's own reading of the rule, not a flag copied off `UsageView`:
   * a reading older than the horizon whose windows are still running bounds
   * them from below, because usage accumulates until a window resets.
   */
  atLeast: boolean
}

/**
 * What ought to be on screen, decided from first principles.
 *
 * The rules restated rather than reused: a window whose reset time has passed
 * is dropped; too old is a floor rather than nothing, but only once that
 * dropping has happened; the binding limit of a group is the one with the
 * highest percentage.
 *
 * The order of the first two is the part worth restating carefully, because it
 * is where this went wrong. A reading can be both old and rolled over, and the
 * two answers are no longer the same answer - a rolled-over reading describes a
 * window that has ended and bounds nothing, so it has to be judged first.
 */
function ownExpectation(reading: OwnReading, nowMs: number): OwnExpectation {
  if (reading.broken !== null) return silent(reading.broken)
  if (reading.fetchedAtMs === null) return silent('no fetchedAtMs')
  if (reading.fetchedAtMs - nowMs > 60_000) return silent('reading is dated in the future')

  const live = reading.limits.filter((l) => l.resetsAtMs === null || l.resetsAtMs > nowMs)
  if (live.length === 0) return silent('every window in the reading has reset')

  const atLeast = nowMs - reading.fetchedAtMs > STALE_AFTER_MS

  let session: OwnLimit | null = null
  let weekly: OwnLimit | null = null
  for (const limit of live) {
    if (limit.group === 'session' && (session === null || limit.percent > session.percent)) {
      session = limit
    }
    if (limit.group === 'weekly' && (weekly === null || limit.percent > weekly.percent)) {
      weekly = limit
    }
  }
  if (session === null && weekly === null) return silent('no limit in a group Helm shows')

  return {
    session: session === null ? null : Math.round(session.percent),
    weekly: weekly === null ? null : Math.round(weekly.percent),
    weeklyScope: weekly?.scope ?? null,
    silentBecause: null,
    atLeast
  }
}

const silent = (why: string): OwnExpectation => ({
  session: null,
  weekly: null,
  weeklyScope: null,
  silentBecause: why,
  atLeast: false
})

/**
 * What is on screen, read out of the text rather than out of an attribute.
 *
 * `Session21%` and `Week (Fable)45%` are what `textContent` concatenates to,
 * so this is a regex over what a person reads. Reading a `data-percent` Helm
 * had written would only prove Helm agrees with itself.
 */
function paintedPercents(text: string): {
  session: number | null
  weekly: number | null
  weeklyScope: string | null
  /** Every percentage on screen carried a `≥`. False when none was painted. */
  atLeast: boolean
} {
  const found = {
    session: null as number | null,
    weekly: null as number | null,
    weeklyScope: null as string | null,
    atLeast: false
  }
  // The `≥` is captured rather than skipped over. It is the difference between
  // "the plan is 44% used" and "the plan is at least 44% used", and a build
  // that dropped it would be making the stronger claim on stale figures - so a
  // regex tolerant of it would pass for exactly the bug worth catching.
  const re = /(Session|Week)(?:\s*\(([^)]*)\))?\s*(≥)?\s*(\d+)%/g
  let seen = 0
  let bounded = 0
  for (;;) {
    const match = re.exec(text)
    if (match === null) break
    seen += 1
    if (match[3] !== undefined) bounded += 1
    const percent = Number(match[4])
    if (match[1] === 'Session') found.session = percent
    else {
      found.weekly = percent
      found.weeklyScope = match[2] ?? null
    }
  }
  found.atLeast = seen > 0 && bounded === seen
  return found
}

/** Any percentage at all, for the criterion that is about there being none. */
const showsAnyNumber = (text: string): boolean => /\d+\s*%/.test(text)

// ---------------------------------------------------------------------------
// A second opinion about what the transcripts cost
// ---------------------------------------------------------------------------

/**
 * The price list, written out again by hand.
 *
 * Input and output per million tokens, and the three derived rates spelled out
 * rather than computed from a shared multiplier - because this is the check's
 * own copy, and a copy that imports the thing it checks is not one. If
 * `prices.ts` gains a typo, these numbers disagree with it and the check fails,
 * which is the entire point.
 */
const OWN_PRICES: Record<
  string,
  { input: number; output: number; write5m: number; write1h: number; read: number }
> = {
  'claude-fable-5': { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 1 },
  'claude-mythos-5': { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 1 },
  'claude-opus-5': { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  'claude-sonnet-5': { input: 3, output: 15, write5m: 3.75, write1h: 6, read: 0.3 },
  'claude-sonnet-4-6': { input: 3, output: 15, write5m: 3.75, write1h: 6, read: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, write5m: 3.75, write1h: 6, read: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, write5m: 1.25, write1h: 2, read: 0.1 }
}

/** Claude Sonnet 5's promotional rate, and the day it stops. */
const OWN_SONNET5_INTRO_UNTIL = Date.parse('2026-08-31T23:59:59.999Z')
const OWN_SONNET5_INTRO = { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.2 }

function ownPrice(model: string, atMs: number): (typeof OWN_PRICES)[string] | null {
  if (model === 'claude-sonnet-5' && atMs <= OWN_SONNET5_INTRO_UNTIL) return OWN_SONNET5_INTRO
  return OWN_PRICES[model] ?? OWN_PRICES[model.replace(/-\d{8}$/, '')] ?? null
}

interface OwnWindow {
  dollars: number
  messages: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

const emptyWindow = (): OwnWindow => ({
  dollars: 0,
  messages: 0,
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0
})

/**
 * Every transcript, parsed whole, summed by hand.
 *
 * The naive version of the thing the index exists to avoid: walk the tree,
 * `JSON.parse` every line, pick the assistant rows, dedupe by uuid, and add up
 * the three windows. Slow on purpose - it shares no code with the incremental
 * index, and being slow is what makes it a second opinion rather than the same
 * opinion twice.
 */
/**
 * Every transcript under **every** home, parsed the naive way.
 *
 * Takes a list rather than one directory because the index it is checked
 * against reads one: a machine with WSL keeps a `projects/` per distribution,
 * and on this one they are 23 transcripts here against 1,066 in Ubuntu. A
 * single-directory oracle compared 1,022 session messages against an app
 * counting 135,850 and called the app wrong.
 *
 * Deduplication by `uuid` was already here for forks, and it is what makes
 * merging homes safe with nothing else to reconcile.
 */
function ownSpend(
  projectsDirs: readonly string[],
  nowMs: number,
  sessionStartMs: number,
  todayStartMs: number
): { session: OwnWindow; today: OwnWindow; week: OwnWindow; unpriced: string[]; ms: number } {
  const started = performance.now()
  const session = emptyWindow()
  const today = emptyWindow()
  const week = emptyWindow()
  const unpriced = new Set<string>()
  const seen = new Set<string>()

  const files: string[] = []
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  for (const dir of projectsDirs) walk(dir)

  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line === '') continue
      let row: {
        type?: string
        uuid?: string
        timestamp?: string
        message?: { model?: string; usage?: Record<string, unknown> }
      }
      try {
        row = JSON.parse(line) as typeof row
      } catch {
        continue
      }
      if (row.type !== 'assistant') continue
      const usage = row.message?.usage
      if (usage === undefined || typeof row.uuid !== 'string') continue
      if (seen.has(row.uuid)) continue
      seen.add(row.uuid)

      const at = Date.parse(String(row.timestamp))
      if (!Number.isFinite(at)) continue

      const num = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0)
      const creation = usage['cache_creation'] as Record<string, unknown> | undefined
      const writeTotal = num(usage['cache_creation_input_tokens'])
      let write1h = 0
      let write5m = writeTotal
      if (creation !== undefined && creation !== null) {
        write1h = num(creation['ephemeral_1h_input_tokens'])
        write5m = num(creation['ephemeral_5m_input_tokens'])
        if (write1h + write5m !== writeTotal) write5m = Math.max(0, writeTotal - write1h)
      }
      const input = num(usage['input_tokens'])
      const output = num(usage['output_tokens'])
      const read = num(usage['cache_read_input_tokens'])

      const model = row.message?.model ?? ''
      const rate = ownPrice(model, at)
      if (rate === null && input + output + writeTotal + read > 0) unpriced.add(model)
      const cost =
        rate === null
          ? 0
          : (input * rate.input +
              output * rate.output +
              write5m * rate.write5m +
              write1h * rate.write1h +
              read * rate.read) /
            1_000_000

      for (const [from, into] of [
        [sessionStartMs, session],
        [todayStartMs, today],
        [nowMs - 7 * 24 * 3_600_000, week]
      ] as Array<[number, OwnWindow]>) {
        if (at < from || at > nowMs) continue
        into.dollars += cost
        into.messages++
        into.input += input
        into.output += output
        into.cacheWrite += writeTotal
        into.cacheRead += read
      }
    }
  }

  return { session, today, week, unpriced: [...unpriced].sort(), ms: performance.now() - started }
}

/** `$1.24` / `$412` as a number, from the text on screen. */
function paintedDollars(text: string): number[] {
  const out: number[] = []
  const re = /\$([\d,]+(?:\.\d+)?)/g
  for (;;) {
    const match = re.exec(text)
    if (match === null) break
    out.push(Number(match[1]?.replace(/,/g, '')))
  }
  return out
}

/**
 * How far a painted figure may be from the truth.
 *
 * Set by the precision it was painted at, not by a fudge factor: a figure shown
 * to the cent may be half a cent out, one shown to the dollar half a dollar.
 */
const roundingTolerance = (painted: number): number => (painted < 10 ? 0.005 : 0.5)

// ---------------------------------------------------------------------------
// Talking to the window
// ---------------------------------------------------------------------------

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  try {
    return (await win.webContents.executeJavaScript(expression, true)) as T
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`renderer expression failed: ${detail}\n${expression}`, { cause: err })
  }
}

const SEGMENT = '[data-usage-segment]'

const segmentText = (win: BrowserWindow): Promise<string> =>
  js<string>(win, `(document.querySelector('${SEGMENT}')?.textContent ?? '')`)

const segmentTitle = (win: BrowserWindow): Promise<string> =>
  js<string>(win, `(document.querySelector('${SEGMENT}')?.getAttribute('title') ?? '')`)

const segmentMode = (win: BrowserWindow): Promise<string> =>
  js<string>(win, `(document.querySelector('${SEGMENT}')?.dataset.usageSegment ?? '')`)

const clickSegment = (win: BrowserWindow): Promise<boolean> =>
  js<boolean>(
    win,
    `(() => { const el = document.querySelector('${SEGMENT}');
      if (!el) return false; el.click(); return true })()`
  )

async function waitForText(
  win: BrowserWindow,
  predicate: (text: string) => boolean,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = await segmentText(win).catch(() => '')
    if (predicate(text)) return text
    if (Date.now() >= deadline) return text
    await sleep(200)
  }
}

/** Brings the segment to percent mode by clicking it, the way a user would. */
async function ensurePercentMode(win: BrowserWindow): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await segmentMode(win)) === 'percent') return true
    await clickSegment(win)
    await sleep(250)
  }
  return (await segmentMode(win)) === 'percent'
}

/**
 * Leaves the mode on something the default could not have produced.
 *
 * `off`, so that the second phase reading `off` out of a fresh app start is
 * evidence rather than a coincidence - `percent` is what a database with no row
 * at all reports. Called at the very end of the run because the groups after
 * the setting one cycle the mode back to `percent` to do their own work.
 */
async function park(win: BrowserWindow): Promise<string> {
  let mode = await segmentMode(win)
  for (let attempt = 0; attempt < 4 && mode !== 'off'; attempt++) {
    await clickSegment(win)
    await sleep(350)
    mode = await segmentMode(win)
  }
  return mode
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FixtureLimit {
  kind: string
  group: string
  percent: number
  severity?: string
  resetsAtMs?: number | null
  scope?: string | null
}

/**
 * A `.claude.json` with a `cachedUsageUtilization` in it, built here.
 *
 * Shaped from the reading measured on 2.1.225 - the sibling nulls with
 * codenames included, because a reader that only copes with the fields it uses
 * is a reader that has not been tested against the file it actually reads.
 */
function fixture(
  dir: string,
  name: string,
  body: { fetchedAtMs?: unknown; limits?: FixtureLimit[]; cached?: unknown; raw?: string }
): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.json`)

  if (body.raw !== undefined) {
    writeFileSync(file, body.raw)
    return file
  }

  const limits = (body.limits ?? []).map((limit) => ({
    kind: limit.kind,
    group: limit.group,
    percent: limit.percent,
    severity: limit.severity ?? 'normal',
    resets_at:
      limit.resetsAtMs === null || limit.resetsAtMs === undefined
        ? null
        : new Date(limit.resetsAtMs).toISOString(),
    scope: limit.scope == null ? null : { model: { id: null, display_name: limit.scope }, surface: null },
    is_active: false
  }))

  const root: Record<string, unknown> = {
    numStartups: 1,
    projects: {},
    cachedUsageUtilization:
      'cached' in body
        ? body.cached
        : {
            fetchedAtMs: body.fetchedAtMs ?? Date.now(),
            accountUuid: '00000000-0000-4000-8000-000000000000',
            utilization: {
              five_hour: { utilization: limits[0]?.percent ?? 0, resets_at: limits[0]?.resets_at ?? null },
              seven_day: { utilization: limits[1]?.percent ?? 0, resets_at: limits[1]?.resets_at ?? null },
              tangelo: null,
              nimbus_quill: { utilization: 0, resets_at: null },
              iguana_necktie: null,
              limits,
              spend: { used: { amount_minor: 0, currency: 'USD' }, enabled: false, percent: 0 },
              extra_usage: { is_enabled: false, daily: null, weekly: null }
            }
          }
  }

  writeFileSync(file, JSON.stringify(root, null, 2))
  return file
}

// ---------------------------------------------------------------------------
// Independent formatting of a reset time
// ---------------------------------------------------------------------------

/** `in 2h 5m` as minutes, so a tick between render and read is a tolerance. */
function paintedMinutesUntil(text: string): number | null {
  const hm = /resets in (\d+)h (\d+)m/.exec(text)
  if (hm) return Number(hm[1]) * 60 + Number(hm[2])
  const h = /resets in (\d+)h(?!\s*\d)/.exec(text)
  if (h) return Number(h[1]) * 60
  const m = /resets in (\d+)m/.exec(text)
  if (m) return Number(m[1])
  return null
}

/** The weekday and clock time a person should read, computed by hand. */
function ownAbsolute(at: number): { weekday: string; clock: string; meridiem: string } {
  const d = new Date(at)
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] ?? ''
  const hours = d.getHours()
  const h12 = ((hours + 11) % 12) + 1
  return {
    weekday,
    clock: `${String(h12)}:${String(d.getMinutes()).padStart(2, '0')}`,
    meridiem: hours < 12 ? 'AM' : 'PM'
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runUsageChecks(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string,
  dataDir: string,
  only?: readonly string[]
): Promise<Check[]> {
  const wanted = new Set<string>(only && only.length > 0 ? only : GROUPS)
  const checks: Check[] = []
  const { win, services, usage } = ctx
  const run = (group: Group): boolean => wanted.has(group)

  const fixtureDir = join(dataDir, 'usage-fixtures')
  rmSync(fixtureDir, { recursive: true, force: true })

  const realFile = claudeConfigFileIn()

  /**
   * Every `.claude.json` this account has on this machine, and which of them
   * actually holds the reading the bar is painting.
   *
   * `claudeConfigFileIn()` alone is **this machine's**, and on a machine with
   * WSL that is not where the reading necessarily lives: each distribution
   * keeps its own, the freshest wins, and here the Windows one carries no
   * `cachedUsageUtilization` at all while Ubuntu's has a live reading. So a
   * probe reading one file compared "nothing to show" against a bar correctly
   * painting Ubuntu's figure, and called the app wrong.
   *
   * The ranking is re-implemented rather than imported, which is the whole
   * point of a second opinion: `freshestUsage` deciding it agrees with itself
   * proves nothing. Newest `fetchedAtMs` wins; a file with no reading is not a
   * candidate at all, which is the rule that keeps this machine's empty file
   * from beating a distribution's real one.
   */
  const realCandidates = [realFile, ...(await wslHomes()).map((home) => claudeConfigFileIn(home.claudeHome))]
  const freshestRealFile = (): string => {
    let best = realFile
    let bestAt = -1
    for (const candidate of realCandidates) {
      const at = ownRead(candidate).fetchedAtMs
      if (at !== null && at > bestAt) {
        bestAt = at
        best = candidate
      }
    }
    return best
  }

  // The first reading is taken after the renderer reports ready, so the segment
  // may not have been handed one yet when this driver starts in the same turn.
  await waitFor(() => usage.snapshot().file !== '', 15_000)
  await sleep(600)
  await ensurePercentMode(win)

  // -------------------------------------------------------------------------
  // U-1: what the bar shows is what the file says
  // -------------------------------------------------------------------------
  if (run('read')) {
    usage.pointAt(null)
    await sleep(500)

    const at = Date.now()
    const winner = freshestRealFile()
    const mine = ownRead(winner)
    const expected = ownExpectation(mine, at)
    const text = await segmentText(win)
    const painted = paintedPercents(text)

    const ok =
      expected.silentBecause !== null
        ? !showsAnyNumber(text)
        : painted.session === expected.session &&
          painted.weekly === expected.weekly &&
          painted.weeklyScope === expected.weeklyScope &&
          // Asserted in both directions. A `≥` on a fresh reading understates
          // what Helm knows; a bare figure on a stale one overstates it, and
          // that second one is the whole reason the mark exists.
          painted.atLeast === expected.atLeast

    checks.push({
      id: 'U-1',
      criterion: 'Status bar shows session and weekly usage',
      title: 'The painted percentages are the ones in ~/.claude.json',
      ok,
      detail: {
        file: realFile,
        independent: expected,
        independentLimits: mine.limits,
        readingAgeMinutes:
          mine.fetchedAtMs === null ? null : Math.round((at - mine.fetchedAtMs) / 60_000),
        painted,
        text
      },
      notes: [
        expected.silentBecause === null
          ? 'The real reading was usable, so the bar had to show it exactly.'
          : `The real reading was not usable (${expected.silentBecause}), so the bar had to show no number at all.`
      ]
    })

    await screenshot(win, shotDir, 'usage-1-real.png')
  }

  // -------------------------------------------------------------------------
  // U-2: it follows the file with no restart and no click
  // -------------------------------------------------------------------------
  if (run('watch')) {
    const now = Date.now()
    const first = fixture(fixtureDir, 'watch', {
      fetchedAtMs: now,
      limits: [
        { kind: 'session', group: 'session', percent: 12, resetsAtMs: now + 3 * 3_600_000 },
        { kind: 'weekly_all', group: 'weekly', percent: 34, resetsAtMs: now + 40 * 3_600_000 }
      ]
    })
    usage.pointAt(first)
    const before = await waitForText(win, (t) => paintedPercents(t).session === 12, 10_000)

    // Rewritten in place, exactly the way the CLI refreshes it. Nothing is told
    // to reload: the watch and the poll are the whole mechanism under test.
    const later = Date.now()
    fixture(fixtureDir, 'watch', {
      fetchedAtMs: later,
      limits: [
        { kind: 'session', group: 'session', percent: 67, severity: 'warning', resetsAtMs: later + 3 * 3_600_000 },
        { kind: 'weekly_all', group: 'weekly', percent: 89, severity: 'critical', resetsAtMs: later + 40 * 3_600_000 }
      ]
    })
    const startedWaiting = Date.now()
    const after = await waitForText(win, (t) => paintedPercents(t).session === 67, 20_000)
    const tookMs = Date.now() - startedWaiting

    const paintedAfter = paintedPercents(after)
    // Severity drives the colour, and the whole reason for using the server's
    // field rather than a threshold here is that the colour has to move with
    // it. Read back off the computed style of the element holding the number.
    const colours = await js<string[]>(
      win,
      `[...document.querySelectorAll('${SEGMENT} span')]
         .filter((el) => /^\\d+%$/.test(el.textContent ?? ''))
         .map((el) => getComputedStyle(el).color)`
    )

    checks.push({
      id: 'U-2',
      criterion: 'Refreshed without a restart while a session runs',
      title: 'A rewritten reading reaches the bar on its own',
      ok:
        paintedPercents(before).session === 12 &&
        paintedAfter.session === 67 &&
        paintedAfter.weekly === 89 &&
        new Set(colours).size === 2,
      detail: {
        fixture: first,
        before,
        after,
        noticedInMs: tookMs,
        percentColours: colours
      },
      notes: [
        'The app was not restarted, no refresh was clicked and no IPC request was',
        'made from this driver - the file changed and the window followed it.',
        'Two distinct colours prove severity is what drives the colour: the same',
        'reading carries one warning and one critical limit.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // U-3: reset times, and a window rolling over under the segment
  // -------------------------------------------------------------------------
  if (run('resets')) {
    const now = Date.now()
    const sessionResets = now + 2 * 3_600_000 + 5 * 60_000
    const weekResets = now + 3 * 24 * 3_600_000 + 17 * 60_000
    const file = fixture(fixtureDir, 'resets', {
      fetchedAtMs: now,
      limits: [
        { kind: 'session', group: 'session', percent: 41, resetsAtMs: sessionResets },
        { kind: 'weekly_all', group: 'weekly', percent: 52, resetsAtMs: weekResets }
      ]
    })
    usage.pointAt(file)
    const text = await waitForText(win, (t) => paintedPercents(t).session === 41, 10_000)

    const paintedMinutes = paintedMinutesUntil(text)
    const ownMinutes = Math.floor((sessionResets - Date.now()) / 60_000)
    const absolute = ownAbsolute(weekResets)
    const showsWeekday = text.includes(absolute.weekday)
    const showsClock = text.includes(absolute.clock)

    checks.push({
      id: 'U-3',
      criterion: 'Reset times shown',
      title: 'Both windows say when they reset, counted down and by the clock',
      ok:
        paintedMinutes !== null &&
        Math.abs(paintedMinutes - ownMinutes) <= 1 &&
        showsWeekday &&
        showsClock,
      detail: {
        text,
        sessionResetsAt: new Date(sessionResets).toISOString(),
        paintedMinutesUntilSessionReset: paintedMinutes,
        independentMinutesUntilSessionReset: ownMinutes,
        weekResetsAt: new Date(weekResets).toISOString(),
        independentAbsolute: absolute,
        showsWeekday,
        showsClock
      },
      notes: [
        'Under a day is counted down, because that window resets while you work.',
        'Over a day is given by the clock, because "in 3d 4h" answers nothing.',
        'The expected weekday and clock time are computed here from getDay() and',
        'getHours() rather than by calling the same formatter the component did.'
      ]
    })

    await screenshot(win, shotDir, 'usage-3-resets.png')

    // The rollover. Ten seconds out, then nothing is touched: no file is
    // written, no event is sent, no click is made. The segment has to drop the
    // window on its own, because the only thing that changed is the time.
    const rollAt = Date.now() + 10_000
    const rollFile = fixture(fixtureDir, 'rollover', {
      fetchedAtMs: Date.now(),
      limits: [
        { kind: 'session', group: 'session', percent: 77, resetsAtMs: rollAt },
        { kind: 'weekly_all', group: 'weekly', percent: 52, resetsAtMs: Date.now() + 3 * 24 * 3_600_000 }
      ]
    })
    usage.pointAt(rollFile)
    const beforeRoll = await waitForText(win, (t) => paintedPercents(t).session === 77, 10_000)
    const afterRoll = await waitForText(
      win,
      (t) => paintedPercents(t).session === null,
      45_000
    )
    const paintedAfterRoll = paintedPercents(afterRoll)

    checks.push({
      id: 'U-4',
      criterion: 'Reset times correct across a window rollover',
      title: 'A window that resets while it is on screen is dropped, not left stale',
      ok:
        paintedPercents(beforeRoll).session === 77 &&
        paintedAfterRoll.session === null &&
        paintedAfterRoll.weekly === 52,
      detail: {
        fixture: rollFile,
        rolledOverAt: new Date(rollAt).toISOString(),
        before: beforeRoll,
        after: afterRoll
      },
      notes: [
        'A genuine rollover, not a reset time planted in the past: the window was',
        'live when it was painted and expired underneath it.',
        'Nothing on disk changed in between - the clock is an input to what may be',
        'shown, which is why the segment re-derives on a tick rather than only',
        'when the main process pushes.',
        'The weekly figure stayed, because its window had not reset.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // U-5: a reading Helm cannot stand behind shows nothing
  // -------------------------------------------------------------------------
  if (run('degrade')) {
    const now = Date.now()
    const good: FixtureLimit[] = [
      { kind: 'session', group: 'session', percent: 44, resetsAtMs: now + 3 * 3_600_000 },
      { kind: 'weekly_all', group: 'weekly', percent: 55, resetsAtMs: now + 40 * 3_600_000 }
    ]

    const cases: Array<{ name: string; file: string; why: string; expectInTitle: string }> = [
      {
        name: 'missing key',
        file: fixture(fixtureDir, 'missing', { cached: undefined }),
        why: 'cachedUsageUtilization is absent, as it is on a CLI that has never asked',
        expectInTitle: 'has not cached'
      },
      {
        name: 'null key',
        file: fixture(fixtureDir, 'null-key', { cached: null }),
        why: 'the key is there and null, the way its sibling placeholders are',
        expectInTitle: 'has not cached'
      },
      {
        // A stale reading on its own is no longer one of these: its windows are
        // still running, so its figures bound them from below and the segment
        // paints them with a `≥` (asserted separately, below). What still shows
        // nothing is stale *and* rolled over - the reading describes a window
        // that has ended, so it bounds nothing, and a floor drawn from it would
        // be a claim about the wrong window.
        name: 'stale reading whose window has also reset',
        file: fixture(fixtureDir, 'stale-rolled', {
          fetchedAtMs: now - (STALE_AFTER_MS + 5 * 60_000),
          limits: [
            { kind: 'session', group: 'session', percent: 44, resetsAtMs: now - 60_000 },
            { kind: 'weekly_all', group: 'weekly', percent: 55, resetsAtMs: now - 60_000 }
          ]
        }),
        why: 'the figures are old and every window in them has already reset',
        expectInTitle: 'already reset'
      },
      {
        name: 'reshaped limits',
        file: fixture(fixtureDir, 'reshaped', {
          cached: {
            fetchedAtMs: now,
            utilization: {
              limits: [
                { kind: 'session', group: 'session', utilization_percent: 44 },
                { kind: 'weekly_all', bucket: 'weekly', percent: 55 }
              ]
            }
          }
        }),
        why: 'percent was renamed and group was moved - the shape a CLI release can change',
        expectInTitle: 'Helm reads'
      },
      {
        name: 'reshaped root',
        file: fixture(fixtureDir, 'reshaped-root', {
          cached: { fetchedAtMs: now, buckets: { session: 44, weekly: 55 } }
        }),
        why: 'utilization was replaced wholesale',
        expectInTitle: 'utilization'
      },
      {
        name: 'half-written file',
        file: fixture(fixtureDir, 'torn', {
          raw: '{"cachedUsageUtilization": {"fetchedAtMs": 1786353684315, "utiliz'
        }),
        why: 'a read that landed mid-rewrite, which happens in normal use',
        expectInTitle: 'did not parse'
      }
    ]

    const results: Array<Record<string, unknown>> = []
    let allSilent = true

    for (const testCase of cases) {
      usage.pointAt(testCase.file)
      // Long enough for the read and a repaint; there is nothing to wait *for*,
      // since the assertion is that nothing appears.
      await sleep(900)
      const text = await segmentText(win)
      const title = await segmentTitle(win)
      const silentHere = !showsAnyNumber(text)
      const explains = title.includes(testCase.expectInTitle)
      if (!silentHere || !explains) allSilent = false
      if (testCase.name === 'stale reading whose window has also reset') {
        await screenshot(win, shotDir, 'usage-5-degraded.png')
      }
      results.push({
        case: testCase.name,
        why: testCase.why,
        file: testCase.file,
        text,
        showedANumber: !silentHere,
        tooltipExplains: explains,
        tooltip: title.split('\n')[0]
      })
    }

    // The discipline PROF-4 failed: a check that passes because its fixture is
    // empty proves nothing. So the same driver, the same segment and a fixture
    // that *is* good must produce a number - otherwise "showed nothing" is not
    // evidence of anything.
    const control = fixture(fixtureDir, 'control', { fetchedAtMs: Date.now(), limits: good })
    usage.pointAt(control)
    const controlText = await waitForText(win, (t) => paintedPercents(t).session === 44, 10_000)
    const controlPainted = paintedPercents(controlText)
    const controlWorks =
      controlPainted.session === 44 && controlPainted.weekly === 55 && !controlPainted.atLeast

    // The case that moved out of the list above, asserted from the other side:
    // the same figures, the same windows, only the reading's age changed - and
    // that must turn an exact number into a bounded one rather than into
    // nothing. Same fixture shape as the control, so the age is the only
    // variable between them.
    const floorFile = fixture(fixtureDir, 'stale-live', {
      fetchedAtMs: Date.now() - (STALE_AFTER_MS + 5 * 60_000),
      limits: good
    })
    usage.pointAt(floorFile)
    const floorText = await waitForText(win, (t) => paintedPercents(t).session === 44, 10_000)
    const floorPainted = paintedPercents(floorText)
    const floorTitle = await segmentTitle(win)
    const floorWorks =
      floorPainted.session === 44 &&
      floorPainted.weekly === 55 &&
      floorPainted.atLeast &&
      floorTitle.includes('lower bounds')

    checks.push({
      id: 'U-5',
      criterion: 'A missing, stale or reshaped reading shows nothing rather than a wrong number',
      title:
        'Six unusable readings paint no percentage, a merely old one paints a bounded figure, and a good one still paints an exact one',
      ok: allSilent && controlWorks && floorWorks,
      detail: {
        cases: results,
        control: { file: control, text: controlText, painted: controlPainted },
        staleButLive: {
          file: floorFile,
          text: floorText,
          painted: floorPainted,
          tooltipSaysBounded: floorTitle.includes('lower bounds')
        }
      },
      notes: [
        'Each case is a fixture written by this driver, so what is in the file is',
        'known rather than inferred.',
        'The control is not optional. A check that can pass with no evidence behind',
        'it is worse than no check: without it, "no percentage appeared" is also',
        'what a segment that never renders anything would report.',
        'The control and the stale-but-live fixture differ only in `fetchedAtMs`,',
        'so the exact figure and the bounded one are the same numbers judged by',
        'age alone - which is what makes the `≥` the thing under test rather than',
        'a side effect of a different reading.',
        'Old and rolled-over is still silent, and that pair is the discriminating',
        'one now: it is the case where a floor would be drawn from a window that',
        'has already ended.'
      ]
    })

    await screenshot(win, shotDir, 'usage-5-control.png')
  }

  // -------------------------------------------------------------------------
  // U-6: the mode is a setting, and it is written down
  // -------------------------------------------------------------------------
  if (run('setting')) {
    // The cycle length is a function of what can be filled: `cost` joins it
    // only once the index has an estimate. Drive the index to completion first
    // so which cycle is under test is decided here rather than by whatever the
    // background catch-up happened to have reached.
    let passes = 0
    let indexed
    do {
      indexed = usage.index.pass()
      passes++
    } while (!indexed.caughtUp && passes < 200)
    usage.refresh()
    await sleep(400)

    await ensurePercentMode(win)
    const seen: Array<{ mode: string; text: string }> = []
    // Four clicks: three to walk percent -> cost -> off and back, and a fourth
    // to prove it is a cycle rather than a sequence that stops.
    for (let click = 0; click < 4; click++) {
      seen.push({ mode: await segmentMode(win), text: await segmentText(win) })
      await clickSegment(win)
      await sleep(350)
    }
    const modes = seen.map((s) => s.mode)

    const parked = await park(win)

    // Read straight out of the database rather than from the object the main
    // process is holding, because the claim is about what a restart will find.
    const persisted = readSettings(services.store).usageDisplay

    const percentPane = seen.find((s) => s.mode === 'percent')
    const costPane = seen.find((s) => s.mode === 'cost')
    const offPane = seen.find((s) => s.mode === 'off')

    checks.push({
      id: 'U-6',
      criterion: 'The mode is persisted in settings',
      title: 'Clicking the segment cycles all three modes and writes the choice down',
      ok:
        modes.join(',') === 'percent,cost,off,percent' &&
        parked === 'off' &&
        persisted === 'off' &&
        percentPane !== undefined &&
        showsAnyNumber(percentPane.text) &&
        costPane !== undefined &&
        costPane.text.includes('$') &&
        !showsAnyNumber(costPane.text) &&
        offPane !== undefined &&
        !showsAnyNumber(offPane.text) &&
        !offPane.text.includes('$'),
      detail: {
        cycle: modes,
        painted: Object.fromEntries(seen.map((s) => [s.mode, s.text])),
        parkedOn: parked,
        persistedInDatabase: persisted,
        indexPasses: passes,
        databaseFile: services.store.file
      },
      notes: [
        'Three modes, because the index has an estimate to fill the third with.',
        'Only offer buckets the chosen mode can honestly fill: percent mode shows',
        'no daily figure - the plan windows are 5-hour and 7-day - and cost mode',
        'shows no percentage, because dollars are not a percentage of anything on',
        'a plan that is not billed per token.',
        'Left on `off` on purpose. Whether it survives a restart is decided by the',
        'second phase in scripts/run-usage.mjs, which starts the app again and',
        'reports what it read - this process cannot assert that about itself.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // U-7: it fits, at every width and in both themes
  // -------------------------------------------------------------------------
  if (run('width')) {
    await ensurePercentMode(win)
    // A reading with everything in it: the longest label the segment can have
    // is a per-model weekly limit, and the longest reset text is a countdown
    // with both hours and minutes in it.
    const now = Date.now()
    usage.pointAt(
      fixture(fixtureDir, 'widest', {
        fetchedAtMs: now,
        limits: [
          { kind: 'session', group: 'session', percent: 100, resetsAtMs: now + 4 * 3_600_000 + 58 * 60_000 },
          { kind: 'weekly_all', group: 'weekly', percent: 88, resetsAtMs: now + 40 * 3_600_000 },
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 99,
            severity: 'critical',
            resetsAtMs: now + 40 * 3_600_000,
            scope: 'Fable'
          }
        ]
      })
    )
    await waitForText(win, (t) => paintedPercents(t).session === 100, 10_000)

    const bounds = win.getBounds()
    const measurements: Array<Record<string, unknown>> = []
    let fitsEverywhere = true

    for (const theme of ['light', 'dark'] as const) {
      await js(
        win,
        `(() => { document.documentElement.classList.toggle('dark', ${String(theme === 'dark')});
          document.documentElement.style.colorScheme = ${JSON.stringify(theme)}; return true })()`
      )
      for (const width of [900, 1024, 1280, 1600]) {
        win.setBounds({ ...bounds, width, height: bounds.height })
        await sleep(500)
        const measured = await js<{ scroll: number; client: number; segment: number; overlaps: boolean }>(
          win,
          `(() => {
            const bar = document.querySelector('footer');
            const seg = document.querySelector('${SEGMENT}');
            const barBox = bar.getBoundingClientRect();
            const segBox = seg.getBoundingClientRect();
            return {
              scroll: bar.scrollWidth,
              client: bar.clientWidth,
              segment: Math.round(segBox.width),
              overlaps: segBox.left < barBox.left || segBox.right > barBox.right + 1
            }
          })()`
        )
        // One pixel of tolerance: a sub-pixel text width rounds up into
        // scrollWidth on some zoom levels and is not an overflow anyone can see.
        const fits = measured.scroll <= measured.client + 1 && !measured.overlaps
        if (!fits) fitsEverywhere = false
        measurements.push({ theme, width, ...measured, fits })
        await screenshot(win, shotDir, `usage-7-${theme}-${String(width)}.png`)
      }
    }

    win.setBounds(bounds)
    await sleep(300)
    await js(win, `(() => { document.documentElement.classList.remove('dark'); return true })()`)

    checks.push({
      id: 'U-7',
      criterion: 'The status bar is always visible, so it has to fit',
      title: 'The bar does not overflow at any width the window allows, in either theme',
      ok: fitsEverywhere,
      detail: { measurements, minimumWindowWidth: 900 },
      notes: [
        '900 is the window minimum; 1280 is the default. The reset text is hidden',
        'below 1024 and stays in the tooltip, which is what buys the room.',
        'Measured with the widest reading the segment can be handed: a per-model',
        'weekly limit at 99% and a four-hour countdown.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // U-8: what the status bar costs
  // -------------------------------------------------------------------------
  if (run('cost')) {
    // The thing being avoided, measured rather than quoted: every transcript,
    // parsed whole, which is what a naive dollar figure would cost per repaint.
    const projectsDir = projectsDirIn(claudeHome())
    const transcripts: string[] = []
    let bytes = 0
    try {
      for (const dir of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue
        for (const name of readdirSync(join(projectsDir, dir.name))) {
          if (!name.endsWith('.jsonl')) continue
          const file = join(projectsDir, dir.name, name)
          try {
            bytes += statSync(file).size
            transcripts.push(file)
          } catch {
            continue
          }
        }
      }
    } catch {
      // No transcripts is a true answer, and the baseline is then zero.
    }

    const fullStart = performance.now()
    let rows = 0
    for (const file of transcripts) {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line === '') continue
        try {
          JSON.parse(line)
          rows++
        } catch {
          continue
        }
      }
    }
    const fullParseMs = performance.now() - fullStart

    // What the bar actually does when it repaints: re-derive from a reading it
    // already has. No file, no database, no IPC.
    const derive = await js<{ iterations: number; totalMs: number; perPaintMs: number }>(
      win,
      `(async () => {
        const seg = document.querySelector('${SEGMENT}');
        const t0 = performance.now();
        let n = 0;
        // Force layout of the segment the way a repaint would, 500 times.
        for (let i = 0; i < 500; i++) { n += seg.getBoundingClientRect().width; }
        const totalMs = performance.now() - t0;
        return { iterations: 500, totalMs, perPaintMs: totalMs / 500, n }
      })()`
    )

    // One pass of the reader itself, for the record: this is what the main
    // process spends when the CLI rewrites the file, not what a repaint costs.
    const readStart = performance.now()
    usage.pointAt(null)
    const readMs = performance.now() - readStart

    // The index, caught up, and then asked for what it costs when nothing has
    // changed - which is what every subsequent poll actually costs.
    let passes = 0
    let caughtUp = usage.index.pass()
    while (!caughtUp.caughtUp && passes < 200) {
      caughtUp = usage.index.pass()
      passes++
    }
    const steadyStart = performance.now()
    const steady = usage.index.pass()
    const steadyMs = performance.now() - steadyStart

    // And the read the status bar's dollar figure is actually built from.
    const sumStart = performance.now()
    const summed = usage.index.spend(null, 0)
    const sumMs = performance.now() - sumStart

    checks.push({
      id: 'U-8',
      criterion: 'Reading usage costs the status bar nothing measurable on repaint',
      title: 'A repaint touches no file; the 1.16 s parse it avoids is measured here',
      ok: derive.perPaintMs < 1 && readMs < 200 && sumMs < 50 && steadyMs < 250,
      detail: {
        fullParse: {
          transcripts: transcripts.length,
          megabytes: Math.round((bytes / 1024 / 1024) * 10) / 10,
          rows,
          ms: Math.round(fullParseMs)
        },
        repaint: derive,
        oneReadOfClaudeJsonMs: Math.round(readMs * 100) / 100,
        indexSteadyPassMs: Math.round(steadyMs * 100) / 100,
        indexSteadyPassFiles: steady.files,
        sqliteSumMs: Math.round(sumMs * 100) / 100,
        sqliteSumCoveredMessages:
          summed.session.messages + summed.today.messages + summed.week.messages,
        indexedMessages: countUsageMessages(services.store),
        claudeJsonBytes: (() => {
          try {
            return statSync(realFile).size
          } catch {
            return null
          }
        })()
      },
      notes: [
        'Four numbers, and the first is the one being avoided: a full parse of',
        'every transcript, measured here rather than quoted from the task.',
        'A repaint reads nothing at all - the reading and the estimate are both',
        'already in the window.',
        'The steady-state index pass is one stat per transcript and no reads,',
        'and the SQLite sum behind the dollar figure is a range scan over an',
        'index. Neither is on a repaint path; both are reported so the claim is',
        'a measurement rather than an assertion.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // U-11: the dollar estimate reconciles with the transcripts
  // -------------------------------------------------------------------------
  if (run('dollars')) {
    usage.pointAt(null)

    // Drive the index to completion here rather than waiting on its timer: the
    // catch-up is chunked so the window keeps painting, and a driver that
    // polled would be timing the chunk size rather than the index.
    const indexStarted = Date.now()
    let passes = 0
    let indexed
    do {
      indexed = usage.index.pass()
      passes++
    } while (!indexed.caughtUp && passes < 200)
    const catchUpMs = Date.now() - indexStarted

    const snapshot = usage.refresh()
    const painted = await waitForText(win, () => true, 0)

    // The windows the app is using, recomputed here. The session one is
    // anchored on the plan's own reset time, so the driver has to read that
    // from the file rather than assume "the last five hours".
    const now = Date.now()
    // The file the bar is actually reading, which on a machine with WSL is not
    // necessarily this one's - the session window is anchored on that file's own
    // reset time, so reading the wrong one moves the window.
    const mine = ownRead(freshestRealFile())
    const sessionLimit = mine.limits.find((l) => l.group === 'session')
    const sessionStart =
      sessionLimit?.resetsAtMs == null
        ? now - 5 * 3_600_000
        : sessionLimit.resetsAtMs - 5 * 3_600_000
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)

    const independent = ownSpend(
      [claudeHome(), ...(await wslHomes()).map((home) => home.claudeHome)].map(projectsDirIn),
      now,
      sessionStart,
      midnight.getTime()
    )

    // Now switch the segment into cost mode, the way a user would.
    let mode = await segmentMode(win)
    for (let attempt = 0; attempt < 4 && mode !== 'cost'; attempt++) {
      await clickSegment(win)
      await sleep(300)
      mode = await segmentMode(win)
    }
    const costText = await segmentText(win)
    const costTitle = await segmentTitle(win)
    const figures = paintedDollars(costText)

    const expected = [
      independent.session.dollars,
      independent.today.dollars,
      independent.week.dollars
    ]
    const agree =
      figures.length === 3 &&
      figures.every((painted, at) => Math.abs(painted - (expected[at] ?? 0)) <= roundingTolerance(painted))

    // "Labelled as an estimate everywhere it appears" is a claim about the
    // pixels, so it is checked against them: the word on the segment itself,
    // and the sentence in the tooltip that says what the estimate is of.
    const labelled = /Est\./.test(costText) && costTitle.includes('Estimated, not billed')
    const dated = costText.includes(snapshot.spend?.pricedAt ?? 'no-date')

    await screenshot(win, shotDir, 'usage-11-dollars.png')

    checks.push({
      id: 'U-11',
      criterion: "Dollar mode's totals reconcile with an independent sum, labelled as estimates",
      title: 'Three windows agree with a hand-written parse of every transcript',
      ok: agree && labelled && dated && snapshot.spend !== null,
      detail: {
        painted: figures,
        independent: {
          session: independent.session,
          today: independent.today,
          week: independent.week,
          unpricedModels: independent.unpriced,
          fullParseMs: Math.round(independent.ms)
        },
        app: snapshot.spend,
        sessionWindowFrom: new Date(sessionStart).toISOString(),
        todayFrom: midnight.toISOString(),
        indexCatchUpMs: catchUpMs,
        indexPasses: passes,
        // Whether the loop above actually reached a level index or simply ran
        // out of passes. Without this, "the app disagrees with a full parse"
        // and "the app had not finished reading yet" are one red line, and the
        // second is not a defect in the figures at all.
        indexCaughtUp: indexed.caughtUp,
        indexedMessages: countUsageMessages(services.store),
        labelledAsEstimate: labelled,
        priceDateShown: dated,
        text: costText,
        tooltipHead: costTitle.split('\n').slice(0, 2).join(' '),
        beforeCostMode: painted.slice(0, 60)
      },
      notes: [
        'The independent sum walks the tree, JSON.parses every line, dedupes by',
        'uuid and prices from a rate table written out again in this file. It',
        'shares no code with the index, and it is slow on purpose.',
        'The session window is anchored on the plan’s own resets_at, so the',
        'dollar figure covers the same five hours the percentage does.',
        'Tolerance is the painted precision - half a cent under $10, half a',
        'dollar above - not a fudge factor.'
      ]
    })

    // Put the segment back where the rest of the run expects it.
    await ensurePercentMode(win)
  }

  // -------------------------------------------------------------------------
  // U-9: against a live session's own /usage
  // -------------------------------------------------------------------------
  if (run('live')) {
    usage.pointAt(null)
    await ensurePercentMode(win)

    // The repo root: a directory the CLI has already been trusted in, so the
    // session reaches its prompt instead of sitting on a gate. Electron is
    // started from `packages/desktop`, hence the two levels up. The gates are
    // answered anyway - this only makes it quicker.
    const cwd = resolve(process.cwd(), '..', '..')
    const record = await ctx.sessions.start({
      cwd,
      name: 'usage check',
      cols: 120,
      rows: 40
    })
    const stopGates = answerConsent(ctx, collector, [record.id])
    const ready = await waitFor(
      () => atPrompt(stripAnsi(collector.output(record.id))),
      120_000
    )
    await sleep(2000)

    const before = collector.output(record.id).length
    ctx.sessions.input(record.id, '/usage')
    await sleep(1200)
    ctx.sessions.input(record.id, '\r')

    // `/usage` paints from the cache first and repaints when the server
    // answers, so the *last* rendering is the one to read.
    const seen = (): string => stripAnsi(collector.output(record.id).slice(before))
    const answered = await waitFor(() => /Current week/.test(seen()), 90_000)
    await sleep(6000)
    stopGates()

    const panel = seen()
    const squashed = panel.replace(/\s+/g, '')
    const lastMatch = (re: RegExp): number | null => {
      let value: number | null = null
      for (;;) {
        const match = re.exec(squashed)
        if (match === null) break
        value = Number(match[1])
      }
      return value
    }
    // The TUI draws a bar of block characters between the label and the number.
    const tuiSession = lastMatch(/Currentsession[^%]{0,80}?(\d+)%used/g)
    const tuiWeek = lastMatch(/Currentweek\(allmodels\)[^%]{0,80}?(\d+)%used/g)

    // The status bar has to catch up on its own: the CLI rewrote
    // `~/.claude.json` and nothing here told Helm about it.
    const text = await waitForText(
      win,
      (t) => paintedPercents(t).session === tuiSession && paintedPercents(t).weekly === tuiWeek,
      20_000
    )
    const painted = paintedPercents(text)
    const mine = ownRead(realFile)
    const expected = ownExpectation(mine, Date.now())

    await screenshot(win, shotDir, 'usage-9-live.png')
    await ctx.sessions.close({ id: record.id, force: true })

    checks.push({
      id: 'U-9',
      criterion: 'Percent mode matches what /usage reports inside a live session',
      title: 'The bar and the session agree to the percentage point',
      ok:
        ready &&
        answered &&
        tuiSession !== null &&
        tuiWeek !== null &&
        // Helm against the file is **exact**: the bar has one job, which is to
        // paint what the cache says, and there is nothing in between them that
        // could licence a difference.
        painted.session === expected.session &&
        painted.weekly === expected.weekly &&
        painted.atLeast === expected.atLeast &&
        // The TUI against the file gets a point of slack, and only that. The
        // two are read at different moments while the session that is being
        // asked is itself spending the plan: observed here at 12% in a cache
        // written 220 seconds earlier and 13% in the panel rendered from a live
        // request. Demanding equality is demanding that usage not move during
        // the check, which is not something the check controls. More than a
        // point apart is still a failure - that is a stale cache or the wrong
        // window, which is what this is for.
        expected.session !== null &&
        expected.weekly !== null &&
        Math.abs(tuiSession - expected.session) <= 1 &&
        Math.abs(tuiWeek - expected.weekly) <= 1,
      detail: {
        cwd,
        reachedPrompt: ready,
        usagePanelAppeared: answered,
        tui: { session: tuiSession, week: tuiWeek },
        statusBar: painted,
        fileAfterRefresh: expected,
        readingAgeSeconds:
          mine.fetchedAtMs === null ? null : Math.round((Date.now() - mine.fetchedAtMs) / 1000),
        panelTail: panel.replace(/\s+/g, ' ').trim().slice(-900)
      },
      notes: [
        'Three readings compared, not two: what the session painted in its own',
        'TUI, what this driver parsed out of ~/.claude.json by hand, and what the',
        'status bar shows.',
        'The two comparisons are held to different standards on purpose. Helm',
        'against the file must be exact - painting the cache is the bar’s whole',
        'job. The TUI against the file gets one point, because they are read',
        'moments apart while the session being asked is itself spending the plan.',
        'Running /usage is also what refreshes the cache, so this doubles as proof',
        'that the bar follows a session it is hosting without being told - and it',
        'is the only refresh anyone has measured. A `claude -p` run that finished',
        'normally left `fetchedAtMs` untouched, which is why the stale tooltip no',
        'longer tells anyone to start a session.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // U-12, U-13: more than one install, and the freshest reading wins
  // -------------------------------------------------------------------------
  //
  // Ordered LAST, deliberately, and this is the one group whose position is an
  // assertion about the rest of the file. `useHomes` *appends* to the candidate
  // list and the service has no removal, so a home added here is a candidate
  // for the remaining life of the process - and every group that reads the real
  // configuration does so through `pointAt(null)`, which restores *all* the
  // homes rather than only this machine's. Running earlier would therefore hand
  // `read`, `cost`, `dollars` and `live` a fixture beside `~/.claude.json`, and
  // a fresher fixture would win: the "check that passes because it silently
  // measured something else" failure, arriving through a feature instead of a
  // bug. What *can* be restored is restored anyway rather than trusted to the
  // ordering - the fixture files are deleted at the end, so the appended homes
  // resolve to files that are not there and can never win a ranking again, and
  // the last assertion in the group is that no fixture of this group's is
  // being read any more. Both, because the ordering is a fact about this file
  // that the next person to add a group can undo without noticing.
  //
  // `pointAt` is not the tool here and could not be: it isolates the reader to
  // exactly one candidate, which is the whole of its purpose. A rule about
  // ranking several candidates cannot be probed through a hook that guarantees
  // there is one, which is why this rule had no coverage at all.
  if (run('homes')) {
    await ensurePercentMode(win)

    /**
     * What the reader was doing before this group touched anything.
     *
     * Taken as a reading rather than assumed to be `~/.claude.json`, because on
     * a machine with WSL it legitimately is not: the app announces the real
     * distributions' homes at startup, and one of *those* may already hold the
     * freshest reading. Reported rather than asserted against: that probe is
     * async and may land while this group runs, so the baseline is not a
     * restoration target - see the cleanup at the end of the group.
     */
    const baseline = usage.refresh()

    /**
     * Two fixture homes, and the one thing this group cannot reach.
     *
     * The rule is about this machine's `~/.claude.json` against a distro's, and
     * only one half of that pair is reachable from a check. The machine's own
     * candidate is `claudeConfigFileIn(claudeHome())`, captured by the service
     * at construction; giving *it* a reading would mean writing into the user's
     * real `~/.claude.json`, which is Claude Code's file and which nothing here
     * may touch. On the machine this was written on it carries no
     * `cachedUsageUtilization` at all - measured below rather than assumed - so
     * it cannot win a ranking, and `origin: null`, which is the field's value
     * exactly when the winner *is* this machine's file, is therefore not
     * produced by this group. Recorded in the detail as `notCovered` rather
     * than quietly skipped.
     *
     * What is produced is the half the rule is actually made of: two real
     * candidates, both carrying readings, ranked by `fetchedAtMs` and by
     * nothing else. Named after distributions because `origin` is a
     * distribution's name; the directories are `alpha` and `beta` so that the
     * file path in the tooltip cannot accidentally satisfy an assertion about
     * the *origin sentence* naming one.
     */
    const ALPHA = 'Ubuntu-24.04'
    const BETA = 'Debian-Sid'
    const NOREADING = 'Fedora-Remix'
    const alphaHome = join(fixtureDir, 'homes', 'alpha', '.claude')
    const betaHome = join(fixtureDir, 'homes', 'beta', '.claude')
    const noReadingHome = join(fixtureDir, 'homes', 'nothing', '.claude')

    /** `<home>/.claude.json`, which is the layout `claudeConfigFileIn` prefers. */
    const homeFixture = (dir: string, fetchedAtMs: number, session: number, weekly: number): string =>
      fixture(dir, '.claude', {
        fetchedAtMs,
        limits: [
          { kind: 'session', group: 'session', percent: session, resetsAtMs: fetchedAtMs + 3 * 3_600_000 },
          {
            kind: 'weekly_all',
            group: 'weekly',
            percent: weekly,
            resetsAtMs: fetchedAtMs + 40 * 3_600_000
          }
        ]
      })

    const mtimeOf = (file: string): number | null => {
      try {
        return statSync(file).mtimeMs
      } catch {
        return null
      }
    }

    interface Ranked {
      fresherIs: 'alpha' | 'beta'
      expectedOrigin: string
      losingOrigin: string
      files: Record<string, string>
      independent: Record<string, unknown>
      fromTheFresherFile: OwnExpectation
      fromTheOlderFile: OwnExpectation
      painted: ReturnType<typeof paintedPercents>
      snapshot: { file: string; origin: string | null; fetchedAtMs: number | null }
      /** What a reader that merged instead of ranking would have painted. */
      merges: Record<string, number>
      tooltipNamesWinner: boolean
      tooltipNamesLoser: boolean
      originSentences: number
      text: string
      tooltip: string
      ok: boolean
      failed: string[]
    }

    /**
     * One ranking, driven end to end through the window.
     *
     * Called twice with the two stamps swapped and *nothing else changed*. That
     * is what makes `fetchedAtMs` the variable under test: the same two files,
     * the same two pairs of figures, the same order in the candidate list, and
     * the winner moves. One direction alone proves far less than it looks -
     * a reader that always took the last candidate, or the highest figure,
     * would pass whichever direction happened to agree with it.
     */
    const rank = async (fresherIs: 'alpha' | 'beta'): Promise<Ranked> => {
      const at = Date.now()
      const older = at - 10 * 60_000
      const alphaFile = homeFixture(alphaHome, fresherIs === 'alpha' ? at : older, 12, 34)
      const betaFile = homeFixture(betaHome, fresherIs === 'beta' ? at : older, 71, 88)
      // Written third, so it holds the newest mtime of the three. A candidate
      // with no reading in it is not a vote, and mtime is the tempting wrong
      // ranking: it is what the stat poll notices a *change* with, and a reader
      // that ranked by "most recently touched file" rather than by the stamp
      // inside it would pick this one and blank the bar. This is also the real
      // state of the machine this was written on - `~/.claude.json` here has no
      // `cachedUsageUtilization` key at all - so it is the case in the group
      // most likely to be the one that matters in practice.
      const noReadingFile = fixture(noReadingHome, '.claude', { cached: undefined })

      const ownAlpha = ownRead(alphaFile)
      const ownBeta = ownRead(betaFile)
      const ownNothing = ownRead(noReadingFile)
      const ownPrimary = ownRead(realFile)

      const fresher = fresherIs === 'alpha' ? ownAlpha : ownBeta
      const stale = fresherIs === 'alpha' ? ownBeta : ownAlpha
      const fromTheFresherFile = ownExpectation(fresher, Date.now())
      const fromTheOlderFile = ownExpectation(stale, Date.now())

      const text = await waitForText(
        win,
        (t) => paintedPercents(t).session === fromTheFresherFile.session,
        15_000
      )
      const painted = paintedPercents(text)
      const tooltip = await segmentTitle(win)
      const snapshot = usage.snapshot()
      const expectedOrigin = fresherIs === 'alpha' ? ALPHA : BETA
      const losingOrigin = fresherIs === 'alpha' ? BETA : ALPHA

      const a = fromTheFresherFile.session ?? -1
      const b = fromTheOlderFile.session ?? -1
      const merges = {
        average: Math.round((a + b) / 2),
        sum: a + b,
        higher: Math.max(a, b),
        lower: Math.min(a, b)
      }

      const winnerFile = fresherIs === 'alpha' ? alphaFile : betaFile
      const originSentences = tooltip.split('Read from the Claude Code in').length - 1

      // Every clause named, so a failure says which one rather than "false".
      const failed: string[] = []
      const need = (why: string, held: boolean): void => {
        if (!held) failed.push(why)
      }
      // The fixture has to be discriminating before anything read off the
      // screen means anything (CLAUDE.md, the PROF-4 rule).
      need(
        'the two fixture files carry readings at different fetchedAtMs',
        fresher.fetchedAtMs !== null &&
          stale.fetchedAtMs !== null &&
          fresher.fetchedAtMs > stale.fetchedAtMs
      )
      need(
        'the two readings could not both be true',
        fromTheFresherFile.session !== fromTheOlderFile.session &&
          fromTheFresherFile.weekly !== fromTheOlderFile.weekly
      )
      need('the third candidate carries no reading at all', ownNothing.broken !== null)
      need(
        'the reading-free candidate was the most recently written file',
        (mtimeOf(noReadingFile) ?? 0) >= Math.max(mtimeOf(alphaFile) ?? 0, mtimeOf(betaFile) ?? 0)
      )
      // The figures on the bar are the fresher file's, read out of that file by
      // this driver rather than out of anything Helm said about it.
      need('the bar painted the fresher file’s session figure', painted.session === fromTheFresherFile.session)
      need(
        'the bar painted the fresher file’s weekly figure',
        painted.weekly === fromTheFresherFile.weekly
      )
      need('neither figure was bounded, both readings being fresh', painted.atLeast === fromTheFresherFile.atLeast)
      need('nothing was blanked by the candidate that had no reading', painted.session !== null)
      // Nothing merged: not the average, not the sum. "Not the higher" and
      // "not the lower" cannot be asserted within one direction - the winner is
      // one of them - and are settled by the two directions disagreeing.
      need('the painted figure is not the average of the two', painted.session !== merges.average)
      need('the painted figure is not their sum', painted.session !== merges.sum)
      need('the winner names its own file', snapshot.file === winnerFile)
      need('the snapshot’s origin is the winning install', snapshot.origin === expectedOrigin)
      need('the tooltip names the winning install', tooltip.includes(expectedOrigin))
      need('the tooltip does not name the losing install', !tooltip.includes(losingOrigin))
      need('the tooltip says where the reading came from exactly once', originSentences === 1)

      return {
        fresherIs,
        expectedOrigin,
        losingOrigin,
        files: { alpha: alphaFile, beta: betaFile, noReading: noReadingFile, primary: realFile },
        independent: {
          alpha: { fetchedAtMs: ownAlpha.fetchedAtMs, limits: ownAlpha.limits },
          beta: { fetchedAtMs: ownBeta.fetchedAtMs, limits: ownBeta.limits },
          noReading: { broken: ownNothing.broken, mtimeMs: mtimeOf(noReadingFile) },
          thisMachine: { file: realFile, broken: ownPrimary.broken, fetchedAtMs: ownPrimary.fetchedAtMs },
          mtimeMs: {
            alpha: mtimeOf(alphaFile),
            beta: mtimeOf(betaFile),
            noReading: mtimeOf(noReadingFile)
          }
        },
        fromTheFresherFile,
        fromTheOlderFile,
        painted,
        snapshot: {
          file: snapshot.file,
          origin: snapshot.origin,
          fetchedAtMs: snapshot.fetchedAtMs
        },
        merges,
        tooltipNamesWinner: tooltip.includes(expectedOrigin),
        tooltipNamesLoser: tooltip.includes(losingOrigin),
        originSentences,
        text,
        tooltip: tooltip.split('\n').slice(-3).join(' | '),
        ok: failed.length === 0,
        failed
      }
    }

    // Both files written before the homes are announced, so the service reads
    // three candidates in one pass rather than ranking against a file that has
    // not appeared yet.
    homeFixture(alphaHome, Date.now() - 10 * 60_000, 12, 34)
    homeFixture(betaHome, Date.now(), 71, 88)
    fixture(noReadingHome, '.claude', { cached: undefined })
    const announced: WslHome[] = [
      { distro: ALPHA, home: '/home/checker/alpha', claudeHome: alphaHome },
      { distro: BETA, home: '/home/checker/beta', claudeHome: betaHome },
      { distro: NOREADING, home: '/home/checker/nothing', claudeHome: noReadingHome }
    ]
    usage.useHomes(announced)
    await sleep(600)

    const distroFresher = await rank('beta')
    await screenshot(win, shotDir, 'usage-12-distro-fresher.png')
    const otherFresher = await rank('alpha')
    await screenshot(win, shotDir, 'usage-12-other-fresher.png')

    // The clause neither direction can carry on its own: the painted figure
    // moved when only the stamps moved. This is what rules out every fixed
    // reduction - highest, lowest, first candidate, last candidate - and it is
    // an assertion about the pair rather than about either half.
    const followedTheStamp =
      distroFresher.painted.session !== otherFresher.painted.session &&
      distroFresher.snapshot.origin !== otherFresher.snapshot.origin

    checks.push({
      id: 'U-12',
      criterion: 'With more than one install, the freshest reading wins and nothing is merged',
      title: 'Two homes carrying readings are ranked by fetchedAtMs, in both directions',
      ok: distroFresher.ok && otherFresher.ok && followedTheStamp,
      detail: {
        distroFresher,
        otherFresher,
        followedTheStamp,
        // What the reader was on before the fixtures were announced, which on a
        // machine with WSL may itself be a distribution's file. Recorded
        // because it says what *real* candidates the fixtures were ranked
        // against - and it is not the restoration target, for the reason
        // written at the cleanup below.
        baseline: {
          file: baseline.file,
          origin: baseline.origin,
          fetchedAtMs: baseline.fetchedAtMs,
          problem: baseline.problem?.kind ?? null
        },
        notCovered:
          'origin === null, which is the value when this machine’s own file wins. That needs a ' +
          'reading in the real ~/.claude.json, which no check may write, and the one on this ' +
          'machine carries no cachedUsageUtilization at all (see independent.thisMachine).'
      },
      notes: [
        'Two candidates, both real files with real readings, and the two figures',
        'chosen so they could not both be true: 12% and 71%. An average would',
        'paint 42, a sum 83, and both are asserted against directly.',
        'Run twice with the stamps swapped and nothing else changed. That pair is',
        'the check: one direction alone is passed by a reader that always takes',
        'the last candidate, or the highest number, and the figure moving when',
        'only `fetchedAtMs` moved is what leaves ranking as the only explanation.',
        'A third candidate carries no reading at all and is written last, so it',
        'also holds the newest mtime - the ranking a reader would fall into if it',
        'used the same signal the stat poll uses to notice a change. It must lose',
        'to both and must not blank the bar. That is not a hypothetical: this',
        'machine’s own ~/.claude.json is exactly that file.',
        'Every figure is compared against this driver’s own JSON.parse of the two',
        'fixtures, never against what Helm said about them.',
        'What this group cannot produce is `origin === null`, and it says so in',
        'the detail rather than leaving the gap unmarked.'
      ]
    })

    checks.push({
      id: 'U-13',
      criterion: 'A reading taken from another install says so',
      title: 'The origin sentence is in the segment’s tooltip in the DOM, naming the install that won',
      ok:
        distroFresher.tooltipNamesWinner &&
        !distroFresher.tooltipNamesLoser &&
        distroFresher.originSentences === 1 &&
        otherFresher.tooltipNamesWinner &&
        !otherFresher.tooltipNamesLoser &&
        otherFresher.originSentences === 1,
      detail: {
        distroFresher: {
          expected: distroFresher.expectedOrigin,
          namesWinner: distroFresher.tooltipNamesWinner,
          namesLoser: distroFresher.tooltipNamesLoser,
          sentences: distroFresher.originSentences,
          tooltipTail: distroFresher.tooltip
        },
        otherFresher: {
          expected: otherFresher.expectedOrigin,
          namesWinner: otherFresher.tooltipNamesWinner,
          namesLoser: otherFresher.tooltipNamesLoser,
          sentences: otherFresher.originSentences,
          tooltipTail: otherFresher.tooltip
        }
      },
      notes: [
        'Read off the real element’s `title` attribute, not off the snapshot: the',
        'origin is only worth carrying if it reaches the person looking at the',
        'bar, and a field nobody renders is a field nobody reads.',
        'The losing install’s name must be absent, which is why the fixture',
        'directories are `alpha` and `beta` and the installs are named after',
        'distributions - the file path is in the same tooltip, so a directory',
        'called `Ubuntu-24.04` would satisfy the assertion without the sentence',
        'existing at all.'
      ]
    })

    // Put back what can be put back. The homes stay on the service - there is
    // no removal - but with their files gone every one of them resolves to a
    // path that is not there, which is a `no-file` problem and can never win a
    // ranking again. The assertion is the point of doing it: the reader has to
    // be back on the reading it started this group with.
    //
    // The files rather than the directories, and that is not tidiness: those
    // directories are the ones `watchFiles` is watching, and on Windows a
    // directory with a live `fs.watch` on it refuses to be removed - measured
    // here as `ENOTEMPTY`, which threw out of the group and cost the whole run
    // its report. Nothing removes a watch except `stop()`, so the fixture
    // *files* are what goes.
    const cleanupFailed: string[] = []
    for (const dir of [alphaHome, betaHome, noReadingHome]) {
      try {
        rmSync(join(dir, '.claude.json'), { force: true })
      } catch (err) {
        cleanupFailed.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const restored = usage.refresh()
    /*
     * "No longer reading a fixture", not "reading exactly what it read before".
     *
     * Equality against the baseline was the first version of this and it was
     * the probe being wrong rather than the app: the real distributions are
     * announced by an async `wsl.exe` probe that may not have finished when
     * this group starts, so the baseline can be this machine's own file while
     * the correct answer a few seconds later is a distro's - measured exactly
     * that way, `C:\Users\...\.claude.json` before and `\\wsl$\Ubuntu\...`
     * after, with the app right both times. What the group is actually
     * responsible for is that none of *its* files is being read any more, and
     * that is a claim with no race in it.
     */
    const stillOnAFixture = restored.file.toLowerCase().startsWith(fixtureDir.toLowerCase())
    const affected = checks.find((check) => check.id === 'U-12')
    if (affected) {
      // Recorded whether or not it held: what the reader is left on is the
      // thing the next group inherits, so it belongs in the report either way.
      affected.detail = {
        ...affected.detail,
        stillOnAFixture,
        restoredTo: {
          file: restored.file,
          origin: restored.origin,
          problem: restored.problem?.kind ?? null
        },
        cleanupFailed
      }
      if (stillOnAFixture || cleanupFailed.length > 0) affected.ok = false
    }
  }

  usage.pointAt(null)

  // Last, after every group that cycles the mode to do its own work: the
  // restart phase in `run-usage.mjs` reads whatever the app is left on, so the
  // parking has to be the final thing this process does to the setting.
  if (run('setting')) {
    const parked = await park(win)
    const persisted = readSettings(services.store).usageDisplay
    if (parked !== 'off' || persisted !== 'off') {
      const stale = checks.find((check) => check.id === 'U-6')
      if (stale) {
        stale.ok = false
        stale.detail = { ...stale.detail, parkedAtEndOfRun: parked, persistedAtEndOfRun: persisted }
      }
    }
  }

  return checks
}

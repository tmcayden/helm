/**
 * Claude Code's own copy of the server's answer about plan limits.
 *
 * The CLI caches it in `~/.claude.json` under `cachedUsageUtilization` and
 * refreshes it as it makes requests. That makes percentages free and
 * authoritative - no credentials, no API call, the same "read Claude Code's own
 * files" pattern the session index established for `history.jsonl`.
 *
 * It is also undocumented internal state. Measured on 2.1.225, the object next
 * to the ones this reads contains `tangelo`, `nimbus_quill`, `iguana_necktie`
 * and `cinder_cove`, all null placeholders with codenames for things that do
 * not exist yet. A shape like that changes between releases, so everything
 * below is written to answer "can I stand behind a number" rather than "can I
 * find one", and the answer to a question it cannot settle is nothing at all.
 *
 * Pure by construction - no `node:` imports - because `types.ts` re-exports it
 * and the renderer derives the view it paints from the same functions the main
 * process parses with. A status bar that decided staleness on its own would be
 * a second implementation of the one rule that matters here.
 */

// ---------------------------------------------------------------------------
// What a reading is
// ---------------------------------------------------------------------------

/** The two windows that actually exist. There is no daily bucket. */
export type UsageGroup = 'session' | 'weekly'

/**
 * The server's own judgement of how close a limit is. Used for colour rather
 * than a threshold invented here: Anthropic knows when 80% matters and Helm
 * does not, and a threshold in this file would silently disagree with the one
 * `/usage` paints the moment either changed.
 */
export type UsageSeverity = 'normal' | 'warning' | 'critical'

const SEVERITIES = new Set<string>(['normal', 'warning', 'critical'])

/** One entry of `utilization.limits`, after every field has been checked. */
export interface UsageLimit {
  /** `session`, `weekly_all`, `weekly_scoped`, or whatever comes next. */
  kind: string
  group: UsageGroup
  /** 0-100 as the server reported it. Not rounded, not derived. */
  percent: number
  severity: UsageSeverity
  /** Epoch ms, or null when the server sent no reset time. */
  resetsAtMs: number | null
  /** `scope.model.display_name` - the model a scoped weekly limit applies to. */
  scope: string | null
  /** The server's marker for the limit currently doing the binding. */
  isActive: boolean
}

/** Why there is no number to show. Every one of these renders as nothing. */
export type UsageProblemKind =
  /** `~/.claude.json` is not there. */
  | 'no-file'
  /** It is there and could not be read. */
  | 'unreadable'
  /** It is there and is not JSON. */
  | 'not-json'
  /** No `cachedUsageUtilization`: an older CLI, or one that has never asked. */
  | 'missing-key'
  /** The key is there and does not have the shape this was written against. */
  | 'unrecognised'
  /** The reading is too old to stand behind. */
  | 'stale'
  /** Every window in it has already reset, so its percentages describe a
   * window that no longer exists. */
  | 'rolled-over'

export interface UsageProblem {
  kind: UsageProblemKind
  /** One sentence, shown in the status bar's tooltip. */
  detail: string
}

/** A parse of one `~/.claude.json`, as the main process hands it over. */
export interface UsageSnapshot {
  /** The file it came from. Named in the tooltip so the number is traceable. */
  file: string
  /** When the CLI last had these figures from the server. */
  fetchedAtMs: number | null
  limits: UsageLimit[]
  /** Set exactly when `limits` is empty and something was wrong. */
  problem: UsageProblem | null
  /**
   * The estimated-dollars half, when the usage index has built one. Null in
   * percent mode and on any build where the index has not run.
   */
  spend: UsageSpend | null
  /**
   * Which install this reading was taken from, when it was not this machine's.
   *
   * A distribution's name, e.g. `Ubuntu`. Null for this machine's own reading,
   * which is the ordinary case and wants no sentence: a figure nobody has
   * reason to doubt should not be annotated into looking doubtful. Set only
   * where the choice between installs is made (`main/usage.ts`), because the
   * *name* of an install is the host's knowledge - `read.ts` ranks files and
   * has never heard of a distribution.
   *
   * A field rather than something the renderer parses back out of `file`: the
   * path is evidence, not a label, and it only happens to carry the distro's
   * name today.
   */
  origin: string | null
}

// ---------------------------------------------------------------------------
// Estimated spend (the `$` half; see `usage/cost.ts`)
// ---------------------------------------------------------------------------

/** The four token classes, priced separately. */
export interface UsageTokens {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export interface UsageWindowCost {
  tokens: UsageTokens
  /** US dollars, estimated from the price table. */
  dollars: number
  /** Assistant messages the figure is a sum over. */
  messages: number
}

/**
 * Estimated spend over the three windows a transcript index can honestly fill.
 *
 * Always an estimate, and labelled as one everywhere it appears: `spend.enabled`
 * is false on a subscription plan and every `*_dollars` the server sends is
 * null, because Anthropic is not billing per token. These numbers are Helm's
 * own arithmetic over the transcripts, priced from a table Helm carries.
 */
export interface UsageSpend {
  /** The 5-hour window, aligned with the session limit's own reset time. */
  session: UsageWindowCost
  /** Local midnight to now. Expressible in dollars, never as a percentage. */
  today: UsageWindowCost
  /** A rolling 7 days. */
  week: UsageWindowCost
  /** Version of the price table these came from, e.g. `2026-08-10`. */
  pricedAt: string
  /** Models seen in the window with no entry in the price table. */
  unpricedModels: string[]
  /** How long the last incremental pass took, in ms. */
  indexMs: number
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * An ISO 8601 instant as epoch ms, or null.
 *
 * The CLI sends `2026-08-10T08:10:00.721285+00:00` - six fractional digits,
 * which `Date.parse` handles, and an offset rather than a `Z`, which it also
 * handles. Anything it does not parse is null rather than a guess.
 */
function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * One limit, or null if it is not one.
 *
 * `kind` is kept as a free string on purpose: a new kind in a later release
 * should join the group it declares rather than be dropped for not being on a
 * list written today. `group` is the field that decides where it is shown, and
 * that one is closed - a limit in a group Helm has no place for is not shown,
 * which is the honest outcome.
 */
function parseLimit(value: unknown): UsageLimit | null {
  if (!isObject(value)) return null

  const group = value['group']
  if (group !== 'session' && group !== 'weekly') return null

  const percent = value['percent']
  // Above 100 is possible when extra usage is on, so the ceiling here is only
  // a sanity bound: a percentage that is not one means the field has been
  // repurposed, and a repurposed field must not be painted as a percentage.
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null
  if (percent < 0 || percent > 1000) return null

  const kind = value['kind']
  if (typeof kind !== 'string' || kind === '') return null

  const severity = value['severity']
  const scopeValue = value['scope']
  const model = isObject(scopeValue) ? scopeValue['model'] : null
  const displayName = isObject(model) ? model['display_name'] : null

  return {
    kind,
    group,
    percent,
    severity: typeof severity === 'string' && SEVERITIES.has(severity)
      ? (severity as UsageSeverity)
      : 'normal',
    resetsAtMs: parseInstant(value['resets_at']),
    scope: typeof displayName === 'string' && displayName !== '' ? displayName : null,
    isActive: value['is_active'] === true
  }
}

const problem = (kind: UsageProblemKind, detail: string): UsageProblem => ({ kind, detail })

/** A snapshot carrying nothing but the reason it carries nothing. */
export function usageProblem(file: string, kind: UsageProblemKind, detail: string): UsageSnapshot {
  return {
    file,
    fetchedAtMs: null,
    limits: [],
    problem: problem(kind, detail),
    spend: null,
    origin: null
  }
}

/**
 * `cachedUsageUtilization`, out of an already-parsed `~/.claude.json`.
 *
 * Every step can fail into a stated reason, and none of them can fail into a
 * number. The three that matter, in the order they are checked: the key is
 * absent on a CLI that predates it or has never made a request; `fetchedAtMs`
 * is what makes an age computable, so without it there is no way to know
 * whether the figures are current; and `limits` is the array the whole display
 * is built from, so an empty or absent one is a shape this build does not
 * recognise rather than a plan with no limits.
 */
export function parseUsage(root: unknown, file: string): UsageSnapshot {
  if (!isObject(root)) {
    return usageProblem(file, 'not-json', `${file} did not parse as a JSON object.`)
  }

  const cached = root['cachedUsageUtilization']
  if (cached === undefined || cached === null) {
    return usageProblem(
      file,
      'missing-key',
      'Claude Code has not cached any usage figures yet. Run a session and they appear.'
    )
  }
  if (!isObject(cached)) {
    return usageProblem(file, 'unrecognised', 'cachedUsageUtilization is not an object.')
  }

  const fetchedAtMs = cached['fetchedAtMs']
  if (typeof fetchedAtMs !== 'number' || !Number.isFinite(fetchedAtMs) || fetchedAtMs <= 0) {
    return usageProblem(
      file,
      'unrecognised',
      'cachedUsageUtilization has no usable fetchedAtMs, so its age cannot be judged.'
    )
  }

  const utilization = cached['utilization']
  if (!isObject(utilization)) {
    return usageProblem(file, 'unrecognised', 'cachedUsageUtilization.utilization is not an object.')
  }

  const rawLimits = utilization['limits']
  if (!Array.isArray(rawLimits)) {
    return usageProblem(file, 'unrecognised', 'utilization.limits is not an array.')
  }

  const limits: UsageLimit[] = []
  for (const raw of rawLimits) {
    const limit = parseLimit(raw)
    if (limit !== null) limits.push(limit)
  }

  if (limits.length === 0) {
    return usageProblem(
      file,
      'unrecognised',
      `utilization.limits held ${String(rawLimits.length)} entr${rawLimits.length === 1 ? 'y' : 'ies'} and none had the shape Helm reads.`
    )
  }

  return { file, fetchedAtMs, limits, problem: null, spend: null, origin: null }
}

// ---------------------------------------------------------------------------
// Deciding what may be shown
// ---------------------------------------------------------------------------

/**
 * How old a reading may be before Helm stops standing behind it.
 *
 * Thirty minutes, which is a live session with slack: the CLI refreshes as it
 * makes requests, and the figures were eight minutes old when this was first
 * measured against a session that had been idle for a few turns. Past that the
 * number can only be defended if nothing else has used the plan - another
 * machine, claude.ai, a `claude` in a terminal - and Helm cannot know that.
 */
export const USAGE_STALE_AFTER_MS = 30 * 60_000

/**
 * A reading dated in the future is a clock disagreeing with itself, not a
 * fresh one. A minute of tolerance covers ordinary skew between the CLI writing
 * and Helm reading; beyond that the age is meaningless and so is the reading.
 */
const FUTURE_TOLERANCE_MS = 60_000

/** One number the status bar is willing to paint. */
export interface UsageBucket {
  group: UsageGroup
  /** `Session` or `Week`. */
  label: string
  /** The model a scoped weekly limit applies to, e.g. `Fable`. */
  scope: string | null
  percent: number
  severity: UsageSeverity
  resetsAtMs: number | null
  /** The `kind` it came from, for the tooltip and for the checks. */
  kind: string
}

export interface UsageView {
  /** Empty means paint no number. Never partially filled with a guess. */
  buckets: UsageBucket[]
  /** Why `buckets` is empty. Null when it is not. */
  problem: UsageProblem | null
  /** Age of the reading, for the tooltip. Null when there is no reading. */
  ageMs: number | null
  /**
   * The percentages are **lower bounds**, because the reading is older than
   * `USAGE_STALE_AFTER_MS`.
   *
   * Blanking a stale reading outright was the original rule, and in practice it
   * blanked the segment nearly always: measured on 2.1.228, Claude Code left
   * `cachedUsageUtilization` untouched for an hour and three quarters of
   * continuous use, and a `claude -p` session that ran to completion did not
   * refresh it either. Thirty minutes is not a cadence the writer keeps, so the
   * rule was not choosing between a good number and a bad one - it was
   * discarding the only number there is.
   *
   * What makes a floor honest rather than a softened blank: a window's usage
   * only accumulates until the window resets, so a reading taken inside the
   * window that is still running can only *understate* it. That is a claim
   * Helm can stand behind, which was the point of the original rule. It holds
   * only because the rolled-over case is now settled first - a reading whose
   * window has ended describes a different window, and bounds nothing.
   */
  atLeast: boolean
}

const EMPTY: UsageView = { buckets: [], problem: null, ageMs: null, atLeast: false }

/**
 * The binding limit of a group.
 *
 * Highest percentage wins, which is what "binding" means: the one you will hit
 * first is the one worth a place in the status bar. `is_active` is the server's
 * own marker and is deliberately not used to choose - it was observed set on
 * the *session* limit while the weekly one sat higher, so choosing by it would
 * hide the number closer to its cap. It is kept on the limit for the tooltip.
 *
 * This is also how `weekly_scoped` surfaces: a per-model weekly limit that has
 * overtaken `weekly_all` is the binding one and takes the segment, carrying the
 * model's name with it.
 */
function binding(limits: UsageLimit[], group: UsageGroup): UsageLimit | null {
  let best: UsageLimit | null = null
  for (const limit of limits) {
    if (limit.group !== group) continue
    if (best === null || limit.percent > best.percent) best = limit
  }
  return best
}

function toBucket(limit: UsageLimit): UsageBucket {
  return {
    group: limit.group,
    label: limit.group === 'session' ? 'Session' : 'Week',
    scope: limit.scope,
    percent: limit.percent,
    severity: limit.severity,
    resetsAtMs: limit.resetsAtMs,
    kind: limit.kind
  }
}

/**
 * What may be painted right now, from a reading taken at some point in the past.
 *
 * Time is an argument rather than `Date.now()` because this decides two things
 * that change on their own with no file having changed: a reading goes stale
 * while the app sits idle, and a window rolls over while its percentage is on
 * screen. The status bar re-derives on a timer with the same snapshot, and the
 * checks call it with a fixed clock.
 */
export function usageView(snapshot: UsageSnapshot | null, nowMs: number): UsageView {
  if (snapshot === null) return EMPTY
  if (snapshot.problem !== null) {
    return { buckets: [], problem: snapshot.problem, ageMs: null, atLeast: false }
  }
  if (snapshot.fetchedAtMs === null) {
    return {
      buckets: [],
      problem: problem('unrecognised', 'The reading carries no timestamp, so its age is unknown.'),
      ageMs: null,
      atLeast: false
    }
  }

  const ageMs = nowMs - snapshot.fetchedAtMs
  if (ageMs < -FUTURE_TOLERANCE_MS) {
    return {
      buckets: [],
      problem: problem(
        'unrecognised',
        'Claude Code dated its usage figures in the future; this machine and the server disagree about the time.'
      ),
      ageMs,
      atLeast: false
    }
  }
  // A window whose reset time has passed took its percentage with it: the
  // server has started a new window and this reading describes the old one.
  //
  // Judged *before* age, which is the other way round from how this was first
  // written, and the ordering is the whole of the fix. Both questions used to
  // be answered "paint nothing", so their order did not matter; now age has a
  // milder answer and rollover keeps the strict one, so the strict test has to
  // get there first. A rolled-over reading is not a floor - it describes a
  // window that no longer exists - and must never be shown as one.
  const live = snapshot.limits.filter(
    (limit) => limit.resetsAtMs === null || limit.resetsAtMs > nowMs
  )
  if (live.length === 0) {
    return {
      buckets: [],
      problem: problem(
        'rolled-over',
        'Every usage window in this reading has already reset. The figures are from the window before it.'
      ),
      ageMs,
      atLeast: false
    }
  }

  const buckets: UsageBucket[] = []
  const session = binding(live, 'session')
  if (session !== null) buckets.push(toBucket(session))
  const weekly = binding(live, 'weekly')
  if (weekly !== null) buckets.push(toBucket(weekly))

  if (buckets.length === 0) {
    return {
      buckets: [],
      problem: problem('unrecognised', 'No limit in this reading belongs to a window Helm shows.'),
      ageMs,
      atLeast: false
    }
  }

  return { buckets, problem: null, ageMs, atLeast: ageMs > USAGE_STALE_AFTER_MS }
}

/** `3h 12m`, for a sentence about how old something is. */
export function describeAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`
  const days = Math.floor(hours / 24)
  return `${String(days)}d ${String(hours % 24)}h`
}

// ---------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------

/**
 * What the status bar's usage segment shows.
 *
 * `cost` is only offered once the transcript index has produced an estimate -
 * offering a mode that would paint nothing is offering a broken setting. The
 * setting lives in the settings pane's Appearance group; clicking the segment
 * cycles through whichever of these the current reading can honestly fill,
 * which is the quick accessor beside the thing it changes rather than the only
 * way to reach it.
 */
export type UsageDisplayMode = 'percent' | 'cost' | 'off'

export const USAGE_DISPLAY_MODES: readonly UsageDisplayMode[] = ['percent', 'cost', 'off']

/**
 * Which modes may be offered for a reading, in one place.
 *
 * The status bar cycles them and the settings pane lists them, and the rule
 * about `cost` is the same rule in both - so it is stated once here rather
 * than twice, where the two could drift into a segment that cycles through a
 * mode the pane has greyed out.
 */
export function offerableUsageModes(hasEstimate: boolean): UsageDisplayMode[] {
  return hasEstimate ? ['percent', 'cost', 'off'] : ['percent', 'off']
}

/** Why `cost` is not on offer yet, for a title on the disabled control. */
export const COST_MODE_UNAVAILABLE =
  'Reading the transcripts. The estimate appears when the index has caught up.'

/** The next mode in the cycle, skipping any this reading cannot fill. */
export function nextUsageMode(
  current: UsageDisplayMode,
  offerable: readonly UsageDisplayMode[]
): UsageDisplayMode {
  const cycle = USAGE_DISPLAY_MODES.filter((mode) => offerable.includes(mode))
  if (cycle.length === 0) return current
  const at = cycle.indexOf(current)
  return cycle[(at + 1) % cycle.length] ?? current
}

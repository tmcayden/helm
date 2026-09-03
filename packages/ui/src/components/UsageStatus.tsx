import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import {
  describeAge,
  nextUsageMode,
  offerableUsageModes,
  priceTableAgeDays,
  usageView,
  COST_MODE_UNAVAILABLE,
  PRICE_TABLE_FRESH_FOR_DAYS,
  type UsageBucket,
  type UsageDisplayMode,
  type UsageLimit,
  type UsageSnapshot,
  type UsageSpend,
  type UsageWindowCost
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { formatMoment, formatResetsIn } from '../lib/time'

/**
 * How much of the plan has been used, in the status bar.
 *
 * Two rules shape everything here. The first is that a number Helm cannot stand
 * behind does not appear: no stale figure, no invented one, no zero standing in
 * for "do not know". When the reading is too old, or its window has already
 * reset, or `cachedUsageUtilization` has changed shape under a CLI release, the
 * segment falls back to the word "Usage" and puts the reason in its tooltip.
 * The word stays because it is also the control - clicking it cycles what the
 * segment shows, and a control that vanishes when there is nothing to show is a
 * control that cannot be got back.
 *
 * The second is that the clock is an input. A reading goes stale, and a usage
 * window rolls over, with nothing on the disk having changed - so this ticks and
 * re-derives rather than waiting to be told, and it re-derives with the same
 * `usageView` the main process parsed with rather than a second opinion of its
 * own.
 */

export interface UsageStatusProps {
  /** The last reading from `~/.claude.json`, or null before the first one. */
  snapshot: UsageSnapshot | null
  mode: UsageDisplayMode
  onModeChange: (mode: UsageDisplayMode) => void
}

/**
 * How often the segment reconsiders what it may paint.
 *
 * Fifteen seconds keeps a minute-resolution countdown honest and costs one
 * re-render of one component - the tick is deliberately inside this component
 * rather than in the hook that holds the snapshot, so it does not re-render the
 * window around it four times a minute.
 */
const TICK_MS = 15_000

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

const SEVERITY_TEXT = {
  normal: 'text-fg-muted',
  warning: 'text-warn',
  critical: 'text-danger'
} as const

const SEVERITY_FILL = {
  normal: 'bg-fg-muted',
  warning: 'bg-warn',
  critical: 'bg-danger'
} as const

/** `Week (Fable)` for a per-model limit, `Week` for the plain one. */
function bucketLabel(bucket: UsageBucket): string {
  return bucket.scope === null ? bucket.label : `${bucket.label} (${bucket.scope})`
}

/** The same, for a limit in the tooltip - including ones not on screen. */
function limitLabel(limit: UsageLimit): string {
  if (limit.kind === 'session') return 'Session'
  if (limit.kind === 'weekly_all') return 'Week (all models)'
  if (limit.scope !== null) return `Week (${limit.scope})`
  return limit.kind
}

/**
 * Twenty-four pixels of "how close is this".
 *
 * Worth the pixels because it is the part that reads without being read: the
 * number answers precisely and the bar answers instantly, and a status bar is
 * glanced at far more often than it is studied. Colour comes from the server's
 * own `severity` rather than a threshold invented here.
 */
function Meter({ percent, severity }: Pick<UsageBucket, 'percent' | 'severity'>): JSX.Element {
  return (
    // `border-strong` rather than `border`: at three pixels tall on the status
    // bar's own surface the ordinary border colour disappears in dark mode, and
    // an invisible track turns the meter into a dash of varying length - which
    // conveys "some" but not "some out of what".
    <span aria-hidden className="h-[3px] w-6 shrink-0 overflow-hidden rounded-full bg-border-strong">
      <span
        className={cn('block h-full rounded-full', SEVERITY_FILL[severity])}
        // A limit can pass 100% when extra usage is enabled; the bar stops at
        // full and the number carries the truth.
        style={{ width: `${String(Math.max(2, Math.min(100, percent)))}%` }}
      />
    </span>
  )
}

function Bucket({
  bucket,
  now,
  atLeast,
  ageMs
}: {
  bucket: UsageBucket
  now: number
  /** The reading is stale, so this percentage is a floor. See `UsageView`. */
  atLeast: boolean
  ageMs: number | null
}): JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Meter percent={bucket.percent} severity={bucket.severity} />
      {/* One text run, not three flex items: the words between the label, the
          number and the reset time have to be real spaces, because that string
          is what a screen reader announces and what a copy takes. */}
      <span className="whitespace-nowrap tabular-nums">
        {bucketLabel(bucket)}{' '}
        <span className={cn('font-medium', SEVERITY_TEXT[bucket.severity])}>
          {/* The `≥` is not decoration and does not drop at narrow widths. It
              is the difference between what Helm knows and what it would be
              claiming without it, and a floor printed as an exact figure is
              the stale number this whole file exists to refuse. */}
          {atLeast && <span title="at least">&ge;</span>}
          {Math.round(bucket.percent)}%
        </span>
        {atLeast && ageMs !== null && (
          <span className="hidden text-fg-subtle lg:inline">
            <span aria-hidden className="px-1.5 text-fg-subtle/60">
              &middot;
            </span>
            {describeAge(ageMs)} old
          </span>
        )}
        {bucket.resetsAtMs !== null && (
          // Hidden rather than shrunk below a wide window: the reset time is
          // the first thing that can go without the segment becoming a bare
          // number, and it is in the tooltip at every width.
          <span className="hidden lg:inline">
            <span aria-hidden className="px-1.5 text-fg-subtle/60">
              &middot;
            </span>
            resets {formatResetsIn(bucket.resetsAtMs, now)}
          </span>
        )}
      </span>
    </span>
  )
}

function Divider(): JSX.Element {
  return <span aria-hidden className="h-2.5 w-px shrink-0 bg-border-strong" />
}

/**
 * Dollars, at the precision the number deserves.
 *
 * Cents below ten dollars, whole dollars above: an estimate reported to the
 * cent at $412.38 is claiming a precision a price table cannot give it.
 */
function dollars(amount: number): string {
  if (amount < 0.005) return '$0'
  if (amount < 10) return `$${amount.toFixed(2)}`
  return `$${Math.round(amount).toLocaleString()}`
}

function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

/**
 * The estimated-dollars half of the segment.
 *
 * Three windows, because those are the three a transcript index can honestly
 * fill - and "today" is here rather than in percent mode for exactly that
 * reason: the plan's real windows are 5-hour and 7-day, so a daily figure is
 * expressible in dollars and never as a percentage.
 *
 * The word "Est." leads, at every width, and the price table's date follows
 * where there is room. Both are load-bearing: `spend.enabled` is false on this
 * plan, so these are Helm's own arithmetic, and a price table that has gone
 * stale is worse than no figure because it still looks authoritative.
 */
function Spend({ spend, now }: { spend: UsageSpend; now: number }): JSX.Element {
  const age = priceTableAgeDays(now)
  const stale = age > PRICE_TABLE_FRESH_FOR_DAYS

  /**
   * `$124 5h`, with a real space rather than a flex gap.
   *
   * The amount and its window are one phrase, so the space between them has to
   * be a character: `textContent` is what a screen reader announces, what a
   * copy takes, and what the check asserts on, and a gap is invisible to all
   * three. Which also means this span must *not* be a flex container - its
   * children would become flex items, and a leading space in a flex item is
   * stripped from the rendering while staying in the text. That combination is
   * the worst of both: it reads `$1245h` on screen and passes a check.
   */
  const window = (label: string, cost: UsageWindowCost): JSX.Element => (
    <span key={label} className="shrink-0 whitespace-nowrap tabular-nums">
      <span className="font-medium text-fg-muted">{dollars(cost.dollars)}</span>{' '}
      <span>{label}</span>
    </span>
  )

  return (
    <>
      <span className="shrink-0 font-medium uppercase tracking-wide text-fg-subtle">Est.</span>
      {window('5h', spend.session)}
      <Divider />
      {window('today', spend.today)}
      <Divider />
      {window('7d', spend.week)}
      <Divider />
      <span className={cn('hidden shrink-0 whitespace-nowrap lg:inline', stale && 'text-warn')}>
        {spend.pricedAt} prices
      </span>
    </>
  )
}

export function UsageStatus({ snapshot, mode, onModeChange }: UsageStatusProps): JSX.Element {
  const now = useNow()
  const view = usageView(snapshot, now)

  // `cost` is only in the cycle once the index has produced an estimate.
  // Offering a mode that would paint nothing is offering a broken setting -
  // the same rule the settings pane's control follows, from the same function.
  const offerable: UsageDisplayMode[] = offerableUsageModes(snapshot?.spend != null)

  const showing = mode === 'percent' ? view.buckets : []
  const spend = mode === 'cost' ? (snapshot?.spend ?? null) : null
  const title = tooltip(snapshot, view.problem?.detail ?? null, view.ageMs, mode, now, view.atLeast)

  return (
    <button
      type="button"
      // The one hook `usage-check` locates this by. It reads the rendered text
      // from here and parses it with a regex of its own rather than reading a
      // number Helm put in an attribute, which would only prove Helm agrees
      // with itself.
      data-usage-segment={mode}
      onClick={() => onModeChange(nextUsageMode(mode, offerable))}
      title={title}
      className={cn(
        '-mx-1.5 flex shrink-0 items-center gap-2.5 rounded px-1.5 py-0.5',
        'transition-colors hover:bg-hover'
      )}
    >
      {spend !== null ? (
        <Spend spend={spend} now={now} />
      ) : showing.length === 0 ? (
        // Dotted underline only when there is a reason to read: it is the
        // conventional "there is an explanation behind this" affordance, and
        // hiding usage on purpose is not something that needs explaining.
        <span
          className={cn(
            mode === 'percent' &&
              view.problem !== null &&
              'underline decoration-border-strong decoration-dotted underline-offset-[3px]'
          )}
        >
          Usage
        </span>
      ) : (
        showing.map((bucket, at) => (
          <span key={bucket.group} className="flex items-center gap-2.5">
            {at > 0 && <Divider />}
            <Bucket bucket={bucket} now={now} atLeast={view.atLeast} ageMs={view.ageMs} />
          </span>
        ))
      )}
    </button>
  )
}

/**
 * Everything the segment could not fit, in the one place there is room for it.
 *
 * Including the limits that are *not* on screen: a non-binding per-model weekly
 * limit is still worth knowing about, and this is where it goes rather than
 * into a third segment nobody asked for.
 */
function tooltip(
  snapshot: UsageSnapshot | null,
  problem: string | null,
  ageMs: number | null,
  mode: UsageDisplayMode,
  nowMs: number,
  /** The percentages on the segment are lower bounds. See `UsageView`. */
  atLeast: boolean
): string {
  const lines: string[] = []

  if (mode === 'cost') {
    const spend = snapshot?.spend ?? null
    if (spend === null) {
      lines.push(COST_MODE_UNAVAILABLE)
    } else {
      lines.push(
        'Estimated, not billed. This plan is not charged per token, so these are Helm’s own',
        `sums over your transcripts at ${spend.pricedAt} list prices.`,
        ''
      )
      const row = (label: string, cost: UsageWindowCost): string =>
        `  ${label.padEnd(6)} ${dollars(cost.dollars).padStart(8)}   ` +
        `${tokens(cost.tokens.input)} in, ${tokens(cost.tokens.output)} out, ` +
        `${tokens(cost.tokens.cacheWrite)} cache write, ${tokens(cost.tokens.cacheRead)} cache read`
      lines.push(row('5h', spend.session), row('today', spend.today), row('7d', spend.week))
      const age = priceTableAgeDays(nowMs)
      if (age > PRICE_TABLE_FRESH_FOR_DAYS) {
        lines.push(
          '',
          `The price table is ${String(age)} days old and may no longer be right.`
        )
      }
      if (spend.unpricedModels.length > 0) {
        lines.push('', `Not priced (no rate on file): ${spend.unpricedModels.join(', ')}`)
      }
      lines.push('', `Index pass: ${spend.indexMs.toFixed(0)} ms`)
    }
  } else if (mode === 'off') {
    lines.push('Usage is hidden.')
  } else if (problem !== null) {
    lines.push(problem)
  } else if (snapshot !== null) {
    lines.push(
      `Plan limits as Claude Code last had them from the server${
        ageMs === null ? '' : `, ${describeAge(ageMs)} ago`
      }.`
    )
    if (atLeast) {
      // Says why the number can be trusted downward and not upward, which is
      // the entire claim the `≥` on the segment is making.
      lines.push(
        '',
        'Older than Helm stands behind exactly, so these are lower bounds: a',
        'window only accumulates until it resets, so the real figures are these',
        'or higher. Helm only reads Claude Code’s cache and never asks for usage',
        'itself, so they sharpen when Claude Code next writes a newer reading.'
      )
    }
    for (const limit of snapshot.limits) {
      const resets =
        limit.resetsAtMs === null ? '' : `, resets ${formatMoment(limit.resetsAtMs)}`
      lines.push(`  ${limitLabel(limit)}  ${String(Math.round(limit.percent))}%${resets}`)
    }
  } else {
    lines.push('Waiting for Claude Code to report its usage figures.')
  }

  if (snapshot !== null && snapshot.file !== '') {
    lines.push(snapshot.file)
    /*
     * Which install this reading came from, when it was not this machine's.
     *
     * Every Claude Code install caches the same account's utilisation in its
     * own `~/.claude.json`, and Helm shows whichever was fetched most recently
     * - so on a machine that also has WSL, the figures above can legitimately
     * come from a distribution. The path on the line before already says so to
     * anyone who reads `\\wsl$\Ubuntu\...` fluently; this says it in words,
     * because "why is my usage coming from somewhere else" is a question the
     * file path answers only if you already know the answer.
     *
     * Null for this machine, so the ordinary case gains no line.
     */
    if (snapshot.origin !== null) {
      lines.push(`Read from the Claude Code in ${snapshot.origin}, which had the newer reading.`)
    }
  }
  // Still the quick accessor it always was; it just is not the only way in any
  // more, and a control that is also a setting should say where the setting is.
  lines.push('Click to change what this shows, or set it in Settings > Appearance.')
  return lines.join('\n')
}

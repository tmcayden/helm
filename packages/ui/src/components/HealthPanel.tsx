import type { JSX } from 'react'
import type { DoctorReport } from '@helm/core'
import { cn } from '../lib/cn'
import { formatMoment } from '../lib/time'
import { PulseIcon, RefreshIcon } from './icons'

export interface HealthPanelProps {
  report: DoctorReport | null
  running: boolean
  onRun: () => void
  /** `claude --version` as the app read it at startup, or null if not found. */
  claudeVersion: string | null
  /**
   * The distribution whose Claude Code this panel is about, or null for this
   * machine's.
   *
   * Named on screen because the answer is about an *installation* and a machine
   * with WSL has more than one. It also decides whether `claudeVersion` is
   * printed: that string is this machine's CLI, read at startup, and putting it
   * beside a report from a distribution's CLI would attribute one
   * installation's version to another's health.
   */
  distro: string | null
}

/**
 * `claude doctor`, as a panel (SPEC 4.2).
 *
 * The rows are a layout of the CLI's own answer, not an interpretation of it -
 * a shell that paraphrased "auto-updates: enabled" into a green tick would be
 * inventing a judgement the CLI did not make. The raw output is kept below the
 * table for exactly the lines the parse did not recognise, which are the
 * interesting ones when something is wrong.
 */
export function HealthPanel({
  report,
  running,
  onRun,
  claudeVersion,
  distro
}: HealthPanelProps): JSX.Element {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-7">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] leading-snug font-medium tracking-tight text-fg">
              Installation health
            </h2>
            <p className="mt-1.5 text-[12px] leading-relaxed text-fg-muted" data-doctor-target={distro ?? ''}>
              <code className="font-mono">claude doctor</code>, run against the same CLI Helm
              launches sessions with
              {distro !== null ? (
                <>
                  {' '}
                  in this scope &mdash; the one inside{' '}
                  <span className="font-mono text-[11px]">{distro}</span>, not this machine&rsquo;s
                </>
              ) : (
                claudeVersion !== null && (
                  <>
                    {' '}
                    &mdash; <span className="font-mono text-[11px]">{claudeVersion}</span>
                  </>
                )
              )}
              .
            </p>
          </div>
          <button
            type="button"
            data-run-doctor
            onClick={onRun}
            disabled={running}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-well border border-accent px-2.5 py-1',
              'text-[11px] font-medium text-accent-text transition-colors',
              running ? 'cursor-default opacity-60' : 'hover:bg-accent-soft'
            )}
          >
            <RefreshIcon width={12} height={12} className={cn(running && 'animate-spin')} />
            {running ? 'Running…' : report === null ? 'Run it' : 'Run again'}
          </button>
        </header>

        {report === null ? (
          <div className="mt-10 grid place-items-center">
            <div className="max-w-sm text-center">
              <PulseIcon width={22} height={22} className="mx-auto text-fg-subtle" />
              <p className="mt-3 text-[12px] text-fg-muted">
                Nothing has been checked yet. This spawns the CLI, which takes a few seconds.
              </p>
            </div>
          </div>
        ) : (
          <>
            {report.error !== null && (
              <p
                role="alert"
                className="mt-4 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger"
              >
                {report.error}
              </p>
            )}

            <p className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-fg-subtle">
              <span data-doctor-exit={String(report.exitCode)}>
                exit {report.exitCode === null ? '?' : report.exitCode}
              </span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{(report.durationMs / 1000).toFixed(1)}s</span>
              <span aria-hidden>·</span>
              <span>{formatMoment(Date.parse(report.ranAt))}</span>
            </p>

            {report.rows.length > 0 && (
              <dl
                data-doctor-rows
                className="mt-4 overflow-hidden rounded-raised border border-border bg-surface-raised"
              >
                {report.rows.map((row, index) => (
                  <div
                    key={`${row.label}-${index}`}
                    className="flex items-baseline gap-4 border-b border-border px-3 py-1.5 last:border-b-0"
                  >
                    <dt className="w-44 shrink-0 truncate text-[11px] text-fg-subtle">
                      {row.label}
                    </dt>
                    <dd className="min-w-0 flex-1 font-mono text-[11px] break-words text-fg">
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            <section className="mt-6">
              <h3 className="mb-2 text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
                Output
              </h3>
              <pre
                data-doctor-output
                className="overflow-auto rounded-raised border border-border bg-surface-sunken px-3 py-2 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap text-fg-muted select-text"
              >
                {report.output || 'The CLI printed nothing.'}
              </pre>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

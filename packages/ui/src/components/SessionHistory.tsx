import type { JSX, KeyboardEvent, ReactNode } from 'react'
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ArchiveMessage,
  ArchiveStats,
  ArchivedConversation,
  HistoryPage,
  HistoryPrompt,
  HistorySearchScope,
  HistorySession,
  HistorySummary
} from '@helm/core'
// A value, so it comes from `@helm/core/types` - the entry point with no
// filesystem behind it (CLAUDE.md "Boundaries").
import { HISTORY_NAME_MAX, historyTitle } from '@helm/core/types'
import { cn } from '../lib/cn'
import { ROW_SELECTED } from '../lib/rows'
import { SEGMENT_ON } from '../lib/segmented'
import { formatAge, formatBytes, formatMoment } from '../lib/time'
import { Checkbox } from './Checkbox'
import { PaneBack } from './PaneBack'
import { CloseIcon, HistoryIcon, RefreshIcon, ResumeIcon, SearchIcon } from './icons'

export type HistoryGrouping = 'recent' | 'project'

export interface SessionHistoryProps {
  summary: HistorySummary | null
  page: HistoryPage | null
  loading: boolean
  error?: string | null | undefined

  search: string
  onSearchChange: (value: string) => void
  /**
   * What the box searches. Two scopes rather than one that quietly does both -
   * see `HistorySearchScope`, which is where the reasoning lives.
   */
  scope: HistorySearchScope
  onScopeChange: (value: HistorySearchScope) => void
  /** What the archive holds, so the scope switch can say what it would search. */
  archiveStats: ArchiveStats | null
  grouping: HistoryGrouping
  onGroupingChange: (value: HistoryGrouping) => void
  resumableOnly: boolean
  onResumableOnlyChange: (value: boolean) => void
  project: string | null
  onProjectChange: (value: string | null) => void

  selected: HistorySession | null
  onSelect: (session: HistorySession | null) => void
  prompts: HistoryPrompt[]
  promptsLoading: boolean
  /**
   * The archived conversation for the selected session, or null when there has
   * never been one. Read-only in the strongest sense available to a component:
   * there is no callback here that could write anything back.
   */
  conversation: ArchivedConversation | null
  conversationLoading: boolean

  onRefresh: () => void
  refreshing: boolean

  /**
   * Names a session by hand. Null restores the title derived from its prompts.
   *
   * A derived title cannot tell six check probes apart - their first
   * substantive prompt genuinely is the same sentence - and nothing Helm can
   * read will fix that. This is the half of the answer that is not derivation.
   */
  onRename: (sessionId: string, name: string | null) => void

  onResume: (session: HistorySession) => void
  /** Session id whose resume is in flight. */
  resuming: string | null
  resumeError?: string | null | undefined
  onDismissResumeError: () => void

  onReveal: (path: string) => void

  /**
   * Docked beside a session split, where the list and the detail cannot both be
   * readable. The pane then shows one at a time: the list until a session is
   * picked, then the detail with a way back.
   */
  compact?: boolean | undefined
}

/**
 * Why a session cannot be reopened, or null when it can.
 *
 * The same conditions the main process checks before it will spawn anything,
 * kept apart rather than collapsed into a boolean: a reaped transcript is
 * permanent and a missing folder is not, and telling the user which one they
 * are looking at is the difference between an explanation and a shrug.
 *
 * `archived` and `evicted` are the transcript archive's two answers, and they
 * are sub-kinds of `reaped` rather than a second vocabulary beside it: all
 * three mean `--resume` has nothing to open, and they differ in what is left.
 * Archived means Helm kept the conversation before Claude Code deleted it.
 * Evicted means Helm had it and dropped it to stay under the storage ceiling
 * the user set - which is a different sentence from "this was reaped before
 * Helm ever saw it", and the pane has to be able to say which.
 */
type Blocked = 'reaped' | 'archived' | 'evicted' | 'folder-gone' | null

function blockedBy(session: HistorySession): Blocked {
  if (!session.projectExists) return 'folder-gone'
  if (session.transcriptFile === null) {
    if (session.archive === 'archived') return 'archived'
    if (session.archive === 'evicted') return 'evicted'
    return 'reaped'
  }
  return null
}

const BADGE: Record<Exclude<Blocked, null>, string> = {
  reaped: 'history only',
  archived: 'archived',
  evicted: 'dropped',
  'folder-gone': 'folder gone'
}

/**
 * The three states a row's mark distinguishes.
 *
 * Deliberately not the same question as `blockedBy`. That one answers "can this
 * be reopened"; this one answers "is there anything here", which is what the
 * dot is scanned for - so a session whose folder has gone but whose
 * conversation Helm kept reads as archived rather than as empty, while its
 * badge still names the thing that would have to be fixed to resume it.
 */
type Mark = 'resumable' | 'archived' | 'gone'

function markOf(session: HistorySession): Mark {
  if (session.transcriptFile !== null && session.projectExists) return 'resumable'
  if (session.archive === 'archived') return 'archived'
  return 'gone'
}

/** Filled, ringed, hollow. Three shapes, not three shades of one. */
const MARK_CLASS: Record<Mark, string> = {
  resumable: 'bg-accent',
  archived: 'border-[1.5px] border-accent',
  gone: 'border border-fg-subtle opacity-60'
}

/** Neutral hairline pills, except the archive's own, which is a kind badge. */
const BADGE_CLASS: Record<Exclude<Blocked, null>, string> = {
  reaped: 'border border-border text-fg-subtle',
  archived: 'bg-accent-soft text-accent-text',
  evicted: 'border border-border text-fg-subtle',
  'folder-gone': 'border border-border text-fg-subtle'
}

/**
 * Every session on the machine, which `/resume` cannot show you.
 *
 * The CLI's picker reads the working directory it was started in. This reads
 * `~/.claude/history.jsonl`, which is every prompt ever submitted anywhere -
 * 799 sessions across 36 projects on the machine this was built against - and
 * cross-references the transcripts that survive.
 *
 * The load-bearing honesty is that only some of them can be reopened. Claude
 * Code reaps transcripts on its own schedule and keeps the prompts forever, so
 * most of this list is a record rather than a door. A row that offered a resume
 * and then dropped the user into a terminal printing "No conversation found"
 * would be worse than not listing it, so resumability is on the row, on the
 * badge and on the button, and the reaped ones show what is actually left.
 */
export function SessionHistory({
  summary,
  page,
  loading,
  error = null,
  search,
  onSearchChange,
  scope,
  onScopeChange,
  archiveStats,
  grouping,
  onGroupingChange,
  resumableOnly,
  onResumableOnlyChange,
  project,
  onProjectChange,
  selected,
  onSelect,
  prompts,
  promptsLoading,
  conversation,
  conversationLoading,
  onRename,
  onRefresh,
  refreshing,
  onResume,
  resuming,
  resumeError = null,
  onDismissResumeError,
  onReveal,
  compact = false
}: SessionHistoryProps): JSX.Element {
  const sessions = useMemo(() => page?.sessions ?? [], [page])
  // One at a time, and only when narrow: at full width both fit and swapping
  // them would cost a click for nothing.
  const showList = !compact || selected === null
  const showDetail = !compact || selected !== null

  /** Sessions in strip order, with a header before each project's first row. */
  const groups = useMemo(() => {
    if (grouping !== 'project') return null
    const byProject = new Map<string, { label: string; path: string; rows: HistorySession[] }>()
    for (const session of sessions) {
      const key = session.project.toLowerCase()
      const group = byProject.get(key) ?? {
        label: session.projectName,
        path: session.project,
        rows: []
      }
      group.rows.push(session)
      byProject.set(key, group)
    }
    // The map preserves insertion order, and `sessions` is already ordered by
    // recency - so the busiest-most-recent project leads without a second sort.
    return [...byProject.values()]
  }, [sessions, grouping])

  /** Arrow keys walk the list; the rows are buttons, so focus is the selection. */
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-session]')]
    const at = rows.findIndex((row) => row === document.activeElement)
    const next = rows[at < 0 ? 0 : at + step]
    if (!next) return
    event.preventDefault()
    next.focus()
    next.click()
  }

  return (
    // Islands with canvas gutters, like every other console (DESIGN.md).
    <div className="flex h-full min-h-0 flex-col gap-2">
      <header className="flex h-11 shrink-0 items-center gap-3 rounded-island border border-border bg-surface px-4">
        <HistoryIcon width={15} height={15} className="shrink-0 text-accent" />
        <h1 className="text-[13px] font-medium tracking-tight text-fg">Session history</h1>
        {summary && (
          <p className="min-w-0 truncate text-[11px] text-fg-subtle">
            <Count n={summary.sessions} one="session" /> · <Count n={summary.prompts} one="prompt" />{' '}
            · <Count n={summary.projects} one="project" /> ·{' '}
            <span className="text-fg-muted">{summary.resumable.toLocaleString()} resumable</span>
          </p>
        )}
        <span className="flex-1" />
        {summary?.error !== undefined && (
          <span className="truncate text-[11px] text-danger" title={summary.error}>
            {summary.error}
          </span>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          title={
            summary
              ? `Re-read ${summary.historyFile}`
              : 'Re-read the history file'
          }
          aria-label="Re-read the history file"
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded text-fg-subtle transition-colors',
            'hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-50'
          )}
        >
          <RefreshIcon className={cn(refreshing && 'animate-spin')} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 gap-2">
        {/* ------------------------------------------------------------- */}
        {/* The list                                                       */}
        {/* ------------------------------------------------------------- */}
        {/* Proportional rather than fixed: the rows carry prompt text, which is
            what the list is for, and a fixed 380px truncated most of it while
            leaving the detail pane two thirds empty. Bounded at both ends so a
            narrow window still leaves room for the detail and a wide one does
            not stretch a list of one-line rows across half a monitor. */}
        {showList && (
        <div
          className={cn(
            'flex flex-col overflow-hidden rounded-island border border-border bg-surface',
            compact ? 'min-w-0 flex-1' : 'w-[38%] max-w-[560px] min-w-[340px] shrink-0'
          )}
        >
          <div className="shrink-0 space-y-2 p-2">
            <div className="relative">
              <SearchIcon
                width={13}
                height={13}
                className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-subtle"
              />
              <input
                data-history-search
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder={
                  scope === 'messages'
                    ? 'Search archived conversations'
                    : 'Search prompts and projects'
                }
                spellCheck={false}
                aria-label={
                  scope === 'messages'
                    ? 'Search archived conversations'
                    : 'Search prompts and projects'
                }
                className={cn(
                  'h-7 w-full rounded-well border border-border bg-surface-sunken pr-7 pl-7',
                  'text-[12px] text-fg select-text placeholder:text-fg-subtle',
                  'focus:border-accent focus:outline-none'
                )}
              />
              {search !== '' && (
                <button
                  type="button"
                  onClick={() => onSearchChange('')}
                  aria-label="Clear the search"
                  title="Clear the search"
                  className="absolute top-1/2 right-1.5 grid size-4 -translate-y-1/2 place-items-center rounded text-fg-subtle hover:text-fg"
                >
                  <CloseIcon width={10} height={10} />
                </button>
              )}
            </div>

            {/* Directly under the box, because it is about the box. The
                caption on the right is what makes the row worth its height: it
                says what "Conversations" would actually be searching, which is
                the one thing a person cannot tell by reading the two words. */}
            <div className="flex items-center gap-2">
              <div
                role="group"
                aria-label="What to search"
                className="flex gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
              >
                <Segment
                  active={scope === 'prompts'}
                  onClick={() => onScopeChange('prompts')}
                  label="Prompts"
                  data-history-scope="prompts"
                />
                <Segment
                  active={scope === 'messages'}
                  onClick={() => onScopeChange('messages')}
                  label="Conversations"
                  data-history-scope="messages"
                />
              </div>
              <span className="flex-1" />
              <span
                data-history-archive-count
                className="shrink-0 truncate text-[10.5px] tabular-nums text-fg-subtle"
                title={
                  archiveStats
                    ? `${archiveStats.messages.toLocaleString()} archived messages, ${formatBytes(archiveStats.storedBytes)} stored`
                    : undefined
                }
              >
                {archiveStats === null
                  ? ''
                  : `${archiveStats.sessions.toLocaleString()} archived`}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <div
                role="group"
                aria-label="Grouping"
                className="flex gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
              >
                {/* Named, like the scope segments above them. Two segmented
                    groups now sit in this pane, and `aria-pressed` alone cannot
                    say which group a button belongs to - `pnpm history-check`
                    was clicking the first unpressed button it found, which
                    became the wrong one the moment the second group arrived. */}
                <Segment
                  active={grouping === 'recent'}
                  onClick={() => onGroupingChange('recent')}
                  label="Recent"
                  data-history-grouping="recent"
                />
                <Segment
                  active={grouping === 'project'}
                  onClick={() => onGroupingChange('project')}
                  label="By project"
                  data-history-grouping="project"
                />
              </div>
              <label className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                <Checkbox
                  checked={resumableOnly}
                  onChange={() => onResumableOnlyChange(!resumableOnly)}
                  label="Resumable only"
                />
                Resumable only
              </label>
            </div>

            {project !== null && (
              <button
                type="button"
                onClick={() => onProjectChange(null)}
                title={`Stop filtering by ${project}`}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded border border-accent/40 bg-accent-soft',
                  'px-2 py-1 text-left text-[11px] text-fg'
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono">{project}</span>
                <CloseIcon width={10} height={10} className="shrink-0 text-fg-subtle" />
              </button>
            )}

            <p className="flex items-baseline gap-1.5 text-[11px] text-fg-subtle">
              <span className="tabular-nums">
                {page ? `${page.total.toLocaleString()} shown` : 'Reading…'}
              </span>
              {page && page.total > page.sessions.length && (
                <span className="tabular-nums">
                  (first {page.sessions.length.toLocaleString()})
                </span>
              )}
              <span className="flex-1" />
              {page && (
                <span
                  className="tabular-nums"
                  title={`The index answered this query in ${page.tookMs.toFixed(2)} ms`}
                >
                  {page.tookMs < 1 ? '<1' : Math.round(page.tookMs)} ms
                </span>
              )}
            </p>
          </div>

          {error !== null && (
            <p className="m-2 rounded-raised border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
              {error}
            </p>
          )}

          {/* A plain group of buttons, not a listbox: the rows are activated
              rather than picked from, and the arrow keys below move focus,
              which is what a button group is expected to do. */}
          <div
            role="group"
            aria-label="Sessions"
            onKeyDown={onListKeyDown}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
          >
            {sessions.length === 0 ? (
              <EmptyList loading={loading} filtering={search !== '' || resumableOnly || project !== null} />
            ) : groups ? (
              groups.map((group) => (
                <Fragment key={group.path.toLowerCase()}>
                  <button
                    type="button"
                    onClick={() => onProjectChange(group.path)}
                    title={`Show only ${group.path}`}
                    className={cn(
                      'sticky top-0 z-10 mt-3 flex w-full items-baseline gap-2 bg-surface px-2 py-1',
                      'text-left text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase',
                      'first:mt-0 hover:text-fg'
                    )}
                  >
                    <span className="min-w-0 truncate">{group.label}</span>
                    <span className="tabular-nums">{group.rows.length}</span>
                  </button>
                  {group.rows.map((session) => (
                    <Row
                      key={session.sessionId}
                      session={session}
                      search={search}
                      selected={selected?.sessionId === session.sessionId}
                      onSelect={onSelect}
                      showProject={false}
                    />
                  ))}
                </Fragment>
              ))
            ) : (
              sessions.map((session) => (
                <Row
                  key={session.sessionId}
                  session={session}
                  search={search}
                  selected={selected?.sessionId === session.sessionId}
                  onSelect={onSelect}
                  showProject
                />
              ))
            )}
          </div>
        </div>
        )}

        {/* ------------------------------------------------------------- */}
        {/* The detail                                                     */}
        {/* ------------------------------------------------------------- */}
        {showDetail && (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-island border border-border bg-surface">
          {compact && selected !== null && (
            <PaneBack label="All sessions" onBack={() => onSelect(null)} />
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
          {selected === null ? (
            <NothingSelected summary={summary} archiveStats={archiveStats} />
          ) : (
            <Detail
              // Remounted per session, so a rename left open on one row is not
              // still open, holding that row's text, over the next one.
              key={selected.sessionId}
              session={selected}
              onRename={onRename}
              prompts={prompts}
              promptsLoading={promptsLoading}
              conversation={conversation}
              conversationLoading={conversationLoading}
              onResume={onResume}
              resuming={resuming === selected.sessionId}
              resumeError={resumeError}
              onDismissResumeError={onDismissResumeError}
              onReveal={onReveal}
              onProjectChange={onProjectChange}
              totalSessions={summary?.sessions ?? 0}
              totalResumable={summary?.resumable ?? 0}
            />
          )}
          </div>
        </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function Row({
  session,
  search,
  selected,
  onSelect,
  showProject
}: {
  session: HistorySession
  search: string
  selected: boolean
  onSelect: (session: HistorySession) => void
  showProject: boolean
}): JSX.Element {
  const blocked = blockedBy(session)
  const mark = markOf(session)
  const title = historyTitle(session)
  // The searched-for text if this row matched on something other than what it
  // is called, so a hit deep in a conversation is visible from the list.
  const headline = session.match ?? title
  const isMatch = session.match !== undefined && session.match !== title
  // Helm's own words for a session that recorded nothing readable are not a
  // sentence anybody wrote, and are not drawn as one. A name given by hand is
  // never a stand-in, whatever the prompts said.
  const standIn = session.label === null && session.titleFallback && session.match === undefined

  return (
    <button
      type="button"
      aria-current={selected}
      data-session={session.sessionId}
      data-resumable={blocked === null}
      data-archive={session.archive ?? 'none'}
      data-named={session.label !== null}
      onClick={() => onSelect(session)}
      // The full opening prompt, which the title is a truncation of and which
      // the derivation may have read past entirely.
      title={`${title}\n\n${session.projectName} · ${formatMoment(session.lastAt)}${
        session.firstPrompt.trim() === '' ? '' : `\n\nFirst prompt: ${session.firstPrompt}`
      }`}
      className={cn(
        'session-row relative flex w-full flex-col gap-0.5 rounded-well py-1.5 pr-2 pl-4 text-left',
        'transition-colors',
        selected ? ROW_SELECTED : 'hover:bg-hover'
      )}
    >
      {/* What is left of this session, drawn twice on purpose: a mark here for
          scanning the list - filled, ringed or hollow, three shapes rather than
          three shades - and the word on the badge for anyone who cannot use the
          difference between them. */}
      <span
        aria-hidden
        className={cn('absolute top-[9px] left-1.5 size-1.5 rounded-full', MARK_CLASS[mark])}
      />
      <span
        // Named so a driver can read the title without slicing it out of the
        // row's whole text, which runs the project and the age onto the end of
        // it with no separator.
        data-session-title
        className={cn(
          'block truncate text-[12px]',
          standIn ? 'text-fg-subtle italic' : blocked === null ? 'text-fg' : 'text-fg-muted'
        )}
      >
        <Highlight text={headline} needle={search} />
      </span>
      <span className="flex items-baseline gap-1.5 text-[10px] text-fg-subtle">
        {showProject && <span className="min-w-0 truncate">{session.projectName}</span>}
        <span className="shrink-0 tabular-nums">{formatAge(session.lastAt)}</span>
        <span className="shrink-0 tabular-nums">
          {session.promptCount} {session.promptCount === 1 ? 'prompt' : 'prompts'}
        </span>
        {isMatch && <span className="shrink-0 text-accent">matched</span>}
        <span className="flex-1" />
        {blocked !== null && (
          <span
            data-badge={blocked}
            className={cn(
              'shrink-0 rounded-sm px-1 text-[9px] tracking-wide uppercase',
              BADGE_CLASS[blocked]
            )}
          >
            {BADGE[blocked]}
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * The searched-for run, marked in place.
 *
 * Matched with `indexOf` on lowercased copies rather than a built regex: the
 * needle is whatever was typed, and `.` or `(` in a search box must not become
 * syntax.
 */
function Highlight({ text, needle }: { text: string; needle: string }): JSX.Element {
  const term = needle.trim()
  if (term === '') return <>{text}</>

  const haystack = text.toLowerCase()
  const lower = term.toLowerCase()
  const parts: ReactNode[] = []
  let at = 0
  let found = haystack.indexOf(lower, at)
  let key = 0
  while (found >= 0) {
    if (found > at) parts.push(text.slice(at, found))
    parts.push(
      <mark key={key++} className="rounded-[2px] bg-accent/25 px-px text-inherit">
        {text.slice(found, found + term.length)}
      </mark>
    )
    at = found + term.length
    found = haystack.indexOf(lower, at)
  }
  if (parts.length === 0) return <>{text}</>
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

/**
 * Takes further `data-*` attributes, the same shape `SettingsPane`'s `Verdict`
 * does and for the same reason: two segmented groups sit in this pane and
 * `aria-pressed` alone cannot tell a driver which group a button belongs to.
 */
function Segment({
  active,
  onClick,
  label,
  ...rest
}: {
  active: boolean
  onClick: () => void
  label: string
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      {...rest}
      aria-pressed={active}
      className={cn(
        'rounded-[5px] px-2.5 py-0.5 text-[11px] transition-colors',
        active
          ? SEGMENT_ON
          : 'text-fg-muted hover:text-fg'
      )}
    >
      {label}
    </button>
  )
}

function EmptyList({ loading, filtering }: { loading: boolean; filtering: boolean }): JSX.Element {
  if (loading) return <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">Reading&hellip;</p>
  return (
    <p className="px-3 py-6 text-center text-[12px] text-fg-subtle">
      {filtering ? 'No session matches that.' : 'No sessions recorded yet.'}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function NothingSelected({
  summary,
  archiveStats
}: {
  summary: HistorySummary | null
  archiveStats: ArchiveStats | null
}): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md text-center">
        <HistoryIcon width={22} height={22} className="mx-auto text-fg-subtle" />
        <p className="mt-3 text-[13px] text-fg-muted">
          Every Claude Code session on this machine, not just the ones started here.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
          {summary
            ? `${summary.sessions.toLocaleString()} sessions across ${String(summary.projects)} projects. ${summary.resumable.toLocaleString()} still have a transcript and can be reopened; the rest are a record of what was asked.`
            : 'Reading the history file…'}
        </p>
        {/* The archive's own sentence, and the empty one is written out rather
            than hidden: "Helm has not kept anything yet" is the state a fresh
            install is in, and a figure that only appears once it is non-zero is
            a figure nobody can tell from a broken one. */}
        <p data-archive-summary className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
          {archiveStats === null ? (
            ''
          ) : archiveStats.sessions === 0 ? (
            <>
              Helm has not archived a conversation yet. It keeps the ones it finds before Claude
              Code deletes them, up to {formatBytes(archiveStats.maxBytes)}.
            </>
          ) : (
            <>
              {archiveStats.sessions.toLocaleString()} conversations kept here -{' '}
              {archiveStats.messages.toLocaleString()} messages, {formatBytes(archiveStats.storedBytes)}{' '}
              of {formatBytes(archiveStats.maxBytes)}.
              {archiveStats.evictedSessions > 0 && (
                <>
                  {' '}
                  {archiveStats.evictedSessions.toLocaleString()} were dropped to stay under it.
                </>
              )}
            </>
          )}
        </p>
      </div>
    </div>
  )
}

function Detail({
  session,
  onRename,
  prompts,
  promptsLoading,
  conversation,
  conversationLoading,
  onResume,
  resuming,
  resumeError,
  onDismissResumeError,
  onReveal,
  onProjectChange,
  totalSessions,
  totalResumable
}: {
  session: HistorySession
  onRename: (sessionId: string, name: string | null) => void
  prompts: HistoryPrompt[]
  promptsLoading: boolean
  conversation: ArchivedConversation | null
  conversationLoading: boolean
  onResume: (session: HistorySession) => void
  resuming: boolean
  resumeError: string | null | undefined
  onDismissResumeError: () => void
  onReveal: (path: string) => void
  onProjectChange: (value: string | null) => void
  totalSessions: number
  totalResumable: number
}): JSX.Element {
  const blocked = blockedBy(session)
  const [renaming, setRenaming] = useState(false)
  const title = historyTitle(session)
  const standIn = session.label === null && session.titleFallback

  return (
    <div className="mx-auto max-w-3xl px-8 py-7">
      <header>
        {renaming ? (
          <HistoryRename
            initial={title}
            onDone={(name) => {
              setRenaming(false)
              if (name !== undefined) onRename(session.sessionId, name)
            }}
          />
        ) : (
          <h2
            data-history-title
            onDoubleClick={() => setRenaming(true)}
            title={
              session.label === null
                ? 'Double-click to name this session'
                : `Named by hand. Its prompts read “${session.title}”.`
            }
            className={cn(
              'text-[17px] leading-snug font-medium tracking-tight',
              standIn ? 'text-fg-subtle italic' : 'text-fg'
            )}
          >
            <span className="line-clamp-3 break-words">{title}</span>
          </h2>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-subtle">
          <button
            type="button"
            onClick={() => onProjectChange(session.project)}
            title={`Show only ${session.project}`}
            className="max-w-full truncate font-mono text-fg-muted transition-colors hover:text-accent-text"
          >
            {session.project}
          </button>
          {session.projectExists && (
            <button
              type="button"
              onClick={() => onReveal(session.project)}
              className="text-accent-text transition-colors hover:underline"
            >
              Show in Explorer
            </button>
          )}
          {/* A written-out control beside the double-click, not instead of it.
              The gesture is how a tab is renamed and belongs here too, but a
              gesture with nothing on screen to suggest it is a feature only its
              author knows about - and `affordance-check` walks buttons, not
              double-clicks. */}
          <button
            type="button"
            data-history-rename={session.sessionId}
            onClick={() => setRenaming(true)}
            className="text-accent-text transition-colors hover:underline"
          >
            {session.label === null ? 'Name this session' : 'Rename'}
          </button>
          {session.label !== null && (
            <button
              type="button"
              data-history-rename-clear
              onClick={() => onRename(session.sessionId, null)}
              title={`Go back to the title read from the prompts: “${session.title}”`}
              className="text-fg-muted transition-colors hover:text-accent-text hover:underline"
            >
              Use the derived title
            </button>
          )}
        </div>
      </header>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 text-[12px] sm:grid-cols-4">
        <Meta label="Started" value={formatMoment(session.firstAt)} />
        {/* The absolute moment on the value line and the age under it, rather
            than "Jul 8, 2026, 09:11 PM · 4w ago" as one string - in a quarter
            of the pane that wraps after the middle dot and reads as a broken
            sentence. */}
        <Meta
          label="Last prompt"
          value={formatMoment(session.lastAt)}
          hint={`${formatAge(session.lastAt)} ago`}
        />
        <Meta label="Prompts" value={session.promptCount.toLocaleString()} />
        {/* Two different facts, and the second only replaces the first once the
            first has run out. While Claude Code still has the transcript, its
            size is what the resume will read; once it has gone, the only
            question left is whether Helm kept the conversation. */}
        {session.transcriptFile !== null ? (
          <Meta label="Transcript" value={formatBytes(session.transcriptBytes ?? 0)} />
        ) : (
          <Meta
            label="Transcript"
            value={
              session.archive === 'archived'
                ? 'archived here'
                : session.archive === 'evicted'
                  ? 'dropped'
                  : 'removed'
            }
            hint={
              session.archive === 'archived'
                ? `${(session.archivedMessages ?? 0).toLocaleString()} messages`
                : undefined
            }
            muted={session.archive !== 'archived'}
          />
        )}
      </dl>

      <div className="mt-5">
        {blocked === null ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-resume={session.sessionId}
              onClick={() => onResume(session)}
              disabled={resuming}
              className={cn(
                'flex items-center gap-2 rounded-well border border-accent px-3.5 py-1.5',
                'text-[12px] font-medium text-accent-text transition-colors',
                resuming ? 'cursor-default opacity-60' : 'hover:bg-accent-soft active:bg-active'
              )}
            >
              <ResumeIcon width={14} height={14} />
              {resuming ? 'Reopening…' : 'Resume in a tab'}
            </button>
            <span className="text-[11px] text-fg-subtle">
              Runs <code className="font-mono">claude --resume</code> in{' '}
              <span className="font-mono">{session.projectName}</span>.
            </span>
          </div>
        ) : (
          <Unavailable
            reason={blocked}
            session={session}
            totalSessions={totalSessions}
            totalResumable={totalResumable}
          />
        )}
      </div>

      {resumeError !== null && resumeError !== undefined && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-3 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        >
          <span className="min-w-0 flex-1">{resumeError}</span>
          <button
            type="button"
            onClick={onDismissResumeError}
            aria-label="Dismiss"
            className="shrink-0 text-danger/70 hover:text-danger"
          >
            ×
          </button>
        </div>
      )}

      <Conversation conversation={conversation} loading={conversationLoading} />

      <section className="mt-7">
        <h3 className="mb-2 flex items-baseline gap-2 text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
          Prompts
          <span className="tabular-nums normal-case">{session.promptCount}</span>
        </h3>
        {promptsLoading && prompts.length === 0 ? (
          <p className="text-[12px] text-fg-subtle">Reading&hellip;</p>
        ) : (
          <ol className="overflow-hidden rounded-raised border border-border bg-surface-raised">
            {prompts.map((prompt, index) => (
              <li
                key={prompt.seq}
                className={cn(
                  'flex gap-3 px-3 py-2 text-[12px]',
                  index > 0 && 'border-t border-border'
                )}
              >
                <span
                  className="w-14 shrink-0 pt-px text-right text-[10px] tabular-nums text-fg-subtle"
                  title={formatMoment(prompt.at)}
                >
                  {formatAge(prompt.at)}
                </span>
                <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-fg-muted select-text">
                  {prompt.text.trim() === '' ? (
                    <span className="text-fg-subtle italic">empty</span>
                  ) : (
                    prompt.text
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

/**
 * The name field, open for as long as it has the caret.
 *
 * `TabRename`'s rules, and they are the same rules for the same reasons:
 * Escape abandons, Enter and blur commit, and an empty field commits null
 * rather than an empty string - clearing the field is the natural way to ask
 * for the derived title back, and a session with no title at all is not a state
 * to allow. What is different is only what is being named: a record of a
 * conversation that has already ended, so there is no terminal to keep the
 * keystrokes away from.
 */
function HistoryRename({
  initial,
  onDone
}: {
  initial: string
  /** `undefined` means cancelled and nothing should be written. */
  onDone: (name: string | null | undefined) => void
}): JSX.Element {
  const [value, setValue] = useState(initial)
  const field = useRef<HTMLInputElement>(null)

  /**
   * Focused **and selected** on mount, from a layout effect rather than from
   * `autoFocus` alone.
   *
   * The field opens holding the name this session already has, so whether its
   * contents are selected is the difference between typing a new name and
   * appending to the old one. `autoFocus` with `onFocus={select()}` was
   * supposed to do it and measurably did not: `history-check`'s HIST-10 read
   * the field the moment it opened and found zero characters selected, which is
   * a rename that silently produces `<old title><what you typed>`.
   *
   * Before the layout effect, `select()` had exactly one chance to run - the
   * focus event React fires during commit - and anything that consumed or
   * pre-empted that event left the caret at a collapsed position with no second
   * attempt. This asks for both explicitly, after the DOM node exists, and
   * `onFocus` stays for every later focus.
   */
  useLayoutEffect(() => {
    const el = field.current
    if (el === null) return
    el.focus()
    el.select()
  }, [])

  return (
    <input
      ref={field}
      data-history-name
      aria-label="Name this session"
      value={value}
      maxLength={HISTORY_NAME_MAX}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          onDone(undefined)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          onDone(value.trim() === '' ? null : value.trim())
        }
      }}
      onBlur={() => onDone(value.trim() === '' ? null : value.trim())}
      className={cn(
        'w-full rounded-well border border-accent bg-surface-sunken px-2 py-1',
        'text-[17px] leading-snug font-medium tracking-tight text-fg select-text outline-none'
      )}
    />
  )
}

const UNAVAILABLE_TITLE: Record<Exclude<Blocked, null>, string> = {
  reaped: 'This conversation cannot be reopened',
  archived: 'This conversation cannot be reopened, but Helm kept it',
  evicted: 'Helm had this conversation and dropped it',
  'folder-gone': 'The folder this ran in is gone'
}

/**
 * What is left of a session that cannot be reopened.
 *
 * Deliberately not an error. Nothing has gone wrong - Claude Code reaps
 * transcripts and keeps prompts, and that ratio is a fact about the machine
 * worth stating rather than a failure to apologise for.
 *
 * Four sentences, and the difference between the middle two is the one this
 * feature exists to make sayable: `archived` means Helm captured the
 * conversation before the CLI deleted it and it is on this page; `evicted`
 * means Helm captured it and then dropped it to stay under a ceiling the user
 * set, which is a decision they can revisit; `reaped` means it was gone before
 * Helm ever looked. Collapsing any two of those into "not available" would be
 * telling the user a number instead of a fact.
 */
function Unavailable({
  reason,
  session,
  totalSessions,
  totalResumable
}: {
  reason: Exclude<Blocked, null>
  session: HistorySession
  totalSessions: number
  totalResumable: number
}): JSX.Element {
  const kept = reason === 'archived'
  return (
    <div data-unavailable={reason} className="rounded-raised border border-border bg-surface-sunken p-4">
      <p className="flex items-center gap-2 text-[12px] font-medium text-fg">
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            kept ? 'border-[1.5px] border-accent' : 'border border-fg-subtle opacity-60'
          )}
        />
        {UNAVAILABLE_TITLE[reason]}
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-fg-muted">
        {reason === 'folder-gone' ? (
          <>
            The transcript is still on disk, but{' '}
            <code className="font-mono break-all">{session.project}</code> is not. Claude Code
            resolves a session id against the working directory, so this conversation can only be
            reopened from that folder - restoring it is enough to make this row resumable again.
          </>
        ) : kept ? (
          <>
            Claude Code has removed the transcript, so there is nothing for{' '}
            <code className="font-mono">--resume</code> to restore. Helm read the conversation
            before that happened and it is below, read-only - the messages, not the tool traffic.
          </>
        ) : reason === 'evicted' ? (
          <>
            Helm archived this conversation and later dropped it whole to stay under the storage
            limit set in Settings. Nothing partial was kept, because half a transcript is a
            transcript that lies about being complete. Raising the limit does not bring it back -
            the transcript it was read from is gone too - but it stops the next one going the same
            way.
          </>
        ) : (
          <>
            Claude Code had already removed the transcript before Helm saw this session, so there
            is nothing for <code className="font-mono">--resume</code> to restore and nothing in
            the archive either. It keeps prompts in{' '}
            <code className="font-mono">history.jsonl</code> indefinitely and reaps the
            conversations behind them
            {totalSessions > 0 && (
              <>
                {' '}
                - {totalResumable.toLocaleString()} of {totalSessions.toLocaleString()} sessions on
                this machine still have one
              </>
            )}
            . The prompts below are what is left of this session.
          </>
        )}
      </p>
    </div>
  )
}

/**
 * The archived conversation, rendered read-only.
 *
 * Read-only is the whole design. There is no editor, no re-send, no callback
 * that could write a byte back - this is a record of something that already
 * happened, and Helm's rule that it renders no session messages still holds
 * for every **live** session. What is on screen is a row out of Helm's own
 * database, read long after the process that produced it exited.
 *
 * Drawn as a conversation rather than as a table of rows: two speakers, each
 * on their own side, which is the shape a person reading a conversation back
 * already knows how to scan. The well is sunken and the bubbles are raised, so
 * the elevation says the same thing the alignment does - the messages sit *in*
 * a record rather than beside one.
 *
 * A `<ul>` rather than an `<ol>`, and that is not cosmetic: the prompts list
 * below is an `<ol>`, and `pnpm history-check`'s HIST-6 counts `ol li` to check
 * a reaped session still shows every prompt it had. A second ordered list in
 * the same pane would silently inflate that count.
 */
function Conversation({
  conversation,
  loading
}: {
  conversation: ArchivedConversation | null
  loading: boolean
}): JSX.Element | null {
  if (conversation === null || conversation.state !== 'archived') return null

  return (
    <section className="mt-7" data-transcript={conversation.sessionId}>
      <h3 className="mb-2 flex items-baseline gap-2 text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
        Conversation
        <span data-transcript-count className="tabular-nums normal-case">
          {conversation.messageCount}
        </span>
        <span className="flex-1" />
        <span className="tabular-nums normal-case" title={`Captured ${conversation.capturedAt}`}>
          {formatBytes(conversation.storedBytes)} stored
        </span>
      </h3>
      {loading && conversation.messages.length === 0 ? (
        <p className="text-[12px] text-fg-subtle">Reading&hellip;</p>
      ) : (
        <ul className="space-y-2.5 rounded-raised border border-border bg-surface-sunken px-3 py-3.5">
          {readAsTurns(conversation.messages).map((entry) =>
            entry.kind === 'tools' ? (
              <ToolRun key={entry.key} names={entry.names} />
            ) : (
              <Message key={entry.message.uuid} message={entry.message} />
            )
          )}
        </ul>
      )}
    </section>
  )
}

/**
 * A message that is nothing but tool calls, or null when it is anything else.
 *
 * The archive stores a tool call as `[tool: Name]` and drops its input and its
 * result - `core/archive/transcript.ts` has the reasoning - so a turn spent
 * entirely on tools arrives here as a message whose whole text is markers.
 */
const TOOL_MARKER = /^\[tool(?::\s*(.+))?\]$/

function toolNames(text: string): string[] | null {
  const names: string[] = []
  for (const part of text.split('\n\n')) {
    const matched = TOOL_MARKER.exec(part.trim())
    if (matched === null) return null
    names.push(matched[1] ?? 'tool')
  }
  return names.length > 0 ? names : null
}

type Turn =
  | { kind: 'message'; message: ArchiveMessage }
  | { kind: 'tools'; key: string; names: string[] }

/**
 * The messages, with runs of tool calls folded into one line each.
 *
 * A photograph of the first version of this view was nine consecutive
 * full-height rows reading CLAUDE / `[tool: PowerShell]`, with the answer they
 * were working towards pushed off the bottom of the pane. A tool call is part
 * of the record and is kept, but it is not something anybody said, and giving
 * each one the same weight as a paragraph of prose makes a conversation
 * unreadable in exactly the surface built to make it readable again.
 */
function readAsTurns(messages: readonly ArchiveMessage[]): Turn[] {
  const turns: Turn[] = []
  for (const message of messages) {
    const names = toolNames(message.text)
    if (names === null) {
      turns.push({ kind: 'message', message })
      continue
    }
    const previous = turns.at(-1)
    if (previous?.kind === 'tools') previous.names.push(...names)
    else turns.push({ kind: 'tools', key: message.uuid, names })
  }
  return turns
}

/** `Read ×3 · Bash` - consecutive repeats counted rather than listed. */
function summariseTools(names: readonly string[]): string {
  const runs: Array<{ name: string; n: number }> = []
  for (const name of names) {
    const last = runs.at(-1)
    if (last?.name === name) last.n++
    else runs.push({ name, n: 1 })
  }
  return runs.map((run) => (run.n === 1 ? run.name : `${run.name} ×${String(run.n)}`)).join(' · ')
}

/**
 * A stretch of tool work, as a rule across the column.
 *
 * Deliberately not a third bubble. A bubble is something somebody said, and a
 * tool call is neither speaker talking - it is the work that happened between
 * two things they said. Drawn as a divider it stays in the record, keeps the
 * conversation's order honest, and costs one line instead of a turn. Machine
 * data, so mono.
 */
function ToolRun({ names }: { names: string[] }): JSX.Element {
  return (
    <li data-transcript-tools={String(names.length)} className="flex items-center gap-2 py-0.5">
      <span aria-hidden className="island-rule min-w-4 flex-1" />
      <span className="max-w-[70%] shrink truncate font-mono text-[10.5px] text-fg-subtle select-text">
        {summariseTools(names)}
      </span>
      <span aria-hidden className="island-rule min-w-4 flex-1" />
    </li>
  )
}

/**
 * One message, on its speaker's own side.
 *
 * The user's is tinted and right-aligned, the assistant's is raised and left -
 * a DM read back, which is what this is. The tint is `accent-soft` and not a
 * solid accent (DESIGN.md 7): it is the same tint the app already uses for a
 * selected row, and it is as close to the blue bubble everyone expects as this
 * system allows. The timestamp sits under the bubble on that bubble's side, so
 * a glance down the column reads as a column of turns rather than a column of
 * times.
 *
 * The measure is capped at 80% of the column rather than left to the pane: a
 * long answer stretched to a 640px-wide detail pane is a paragraph nobody can
 * track back to the start of. The cap is on the bubble, so a code block inside
 * one wraps rather than pushing the bubble past it.
 */
function Message({ message }: { message: ArchiveMessage }): JSX.Element {
  const mine = message.role === 'user'
  return (
    <li
      data-transcript-message={message.role}
      className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}
    >
      <div
        className={cn(
          'max-w-[80%] min-w-0 rounded-raised border px-3 py-2 text-[12px] leading-relaxed',
          'break-words whitespace-pre-wrap text-fg select-text',
          // `border-strong` on the assistant's, not `border`: the raised step
          // over the sunken well is 18 levels per channel in light mode
          // (#F4F5FA on #E2E5EE, measured) against 27 in dark, so in light the
          // edge is the whole of what separates a bubble from its ground. The
          // user's is already carried by the accent outline.
          mine ? 'border-accent/40 bg-accent-soft' : 'border-border-strong bg-surface-raised'
        )}
      >
        {/* Read out, never drawn: the side and the tint say who spoke, and a
            label on every bubble would be the row header this layout exists to
            get rid of. A screen reader has neither. */}
        <span className="sr-only">{mine ? 'You said: ' : 'Claude said: '}</span>
        {message.text}
      </div>
      <span
        className="mt-0.5 px-1 text-[10px] tabular-nums text-fg-subtle"
        title={formatMoment(message.at)}
      >
        {formatAge(message.at)}
      </span>
    </li>
  )
}

function Meta({
  label,
  value,
  hint,
  muted = false
}: {
  label: string
  value: string
  hint?: string | undefined
  muted?: boolean | undefined
}): JSX.Element {
  return (
    <div>
      <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">{label}</dt>
      <dd className={cn('mt-0.5 tabular-nums', muted ? 'text-fg-subtle' : 'text-fg')}>
        {value}
        {hint !== undefined && (
          <span className="block text-[11px] text-fg-subtle">{hint}</span>
        )}
      </dd>
    </div>
  )
}

function Count({ n, one }: { n: number; one: string }): JSX.Element {
  return (
    <span className="tabular-nums">
      {n.toLocaleString()} {n === 1 ? one : `${one}s`}
    </span>
  )
}

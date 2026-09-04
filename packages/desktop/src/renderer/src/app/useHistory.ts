import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ArchiveStats,
  ArchivedConversation,
  HistoryPage,
  HistoryPrompt,
  HistorySearchScope,
  HistorySession,
  HistorySummary,
  SessionRecord
} from '@helm/core'
import { helm } from './bridge'
import { estimateGrid } from './terminals'

/**
 * The launcher's view of every session on the machine.
 *
 * The list is never filtered in the renderer. Every keystroke is a query
 * against the index in the main process - which measures around a millisecond
 * over 3,470 prompts - because the alternative is shipping the whole prompt
 * corpus across the IPC boundary to filter it in a component that then has to
 * be told when the file underneath it changed.
 */

export type HistoryGrouping = 'recent' | 'project'

export interface HistoryState {
  summary: HistorySummary | null
  page: HistoryPage | null
  loading: boolean
  error: string | null

  search: string
  setSearch: (value: string) => void
  /** Prompts or archived conversations. See `HistorySearchScope`. */
  scope: HistorySearchScope
  setScope: (value: HistorySearchScope) => void
  grouping: HistoryGrouping
  setGrouping: (value: HistoryGrouping) => void
  resumableOnly: boolean
  setResumableOnly: (value: boolean) => void
  project: string | null
  setProject: (value: string | null) => void

  /** The row whose detail is on screen, re-read from the current page. */
  selected: HistorySession | null
  select: (session: HistorySession | null) => void
  prompts: HistoryPrompt[]
  promptsLoading: boolean
  /** The archived conversation for the selected session, fetched on selection. */
  conversation: ArchivedConversation | null
  conversationLoading: boolean
  /** What the archive holds. Pushed from main; never polled. */
  archiveStats: ArchiveStats | null

  /** Names a session by hand, or clears the name with null. */
  rename: (sessionId: string, name: string | null) => Promise<void>

  refresh: () => void
  refreshing: boolean

  /** Reopens the conversation in a tab. Null when it could not be started. */
  resume: (session: HistorySession, paneSize: HTMLElement | null) => Promise<SessionRecord | null>
  resuming: string | null
  resumeError: string | null
  dismissResumeError: () => void
  /**
   * What the resume did anyway, having lost something doing it.
   *
   * Separate from `resumeError` because it is not one: the session started and
   * the pane has already navigated to its tab. A resume into a distro can come
   * up without Helm's own tools - an unreachable endpoint, a config path with
   * no spelling inside that distro - and the launch path has said so out loud
   * since profiles existed. This is that sentence for the other launch path.
   */
  resumeNotice: string | null
  dismissResumeNotice: () => void
}

/** Electron prefixes a renderer-side rejection with the channel it came from. */
function readable(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '')
}

/**
 * Long enough that a typed word is one query rather than seven, short enough
 * that the list feels attached to the keyboard. The query itself is ~1ms; this
 * is about not re-rendering 800 rows per keystroke.
 */
const SEARCH_DEBOUNCE_MS = 90

/**
 * A page and the query it answers.
 *
 * Kept together so "is this list still loading" is a comparison rather than a
 * second piece of state - which would have to be set synchronously inside the
 * effect that starts the query, and a `loading` flag that can disagree with
 * the rows beside it is the bug this shape makes unrepresentable.
 */
interface Answered<T> {
  key: string
  value: T
}

export function useHistory(): HistoryState {
  const [summary, setSummary] = useState<HistorySummary | null>(null)
  const [answer, setAnswer] = useState<Answered<HistoryPage> | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [scope, setScope] = useState<HistorySearchScope>('prompts')
  const [archiveStats, setArchiveStats] = useState<ArchiveStats | null>(null)
  const [conversationAnswer, setConversationAnswer] =
    useState<Answered<ArchivedConversation | null> | null>(null)
  const [grouping, setGrouping] = useState<HistoryGrouping>('recent')
  const [resumableOnly, setResumableOnly] = useState(false)
  const [project, setProject] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [promptAnswer, setPromptAnswer] = useState<Answered<HistoryPrompt[]> | null>(null)

  /** Bumped by a rename, so the listing is asked for again. See `rename`. */
  const [nameVersion, setNameVersion] = useState(0)

  const [refreshing, setRefreshing] = useState(false)
  const [resuming, setResuming] = useState<string | null>(null)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const [resumeNotice, setResumeNotice] = useState<string | null>(null)

  // An acknowledgement goes away on its own; an error waits to be dismissed.
  // The same split, and the same nine seconds, as `useProfiles`.
  useEffect(() => {
    if (resumeNotice === null) return
    const timer = setTimeout(() => setResumeNotice(null), 9000)
    return () => clearTimeout(timer)
  }, [resumeNotice])

  useEffect(() => {
    const off = helm.on('history:changed', setSummary)
    void helm.invoke('history:summary').then(setSummary)
    return off
  }, [])

  // Pushed, for the reason the summary is: a pass in the main process captures
  // a conversation without the window having asked for anything.
  useEffect(() => {
    const off = helm.on('archive:changed', setArchiveStats)
    void helm.invoke('archive:stats').then(setArchiveStats)
    return off
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  /**
   * Re-queried whenever the filters change *or* the index does - a session
   * started in a terminal has to appear in the list, not only in the count in
   * the corner. Keyed on `indexedBytes` and the session count rather than the
   * whole summary object, which is a new reference on every push.
   */
  const indexVersion = `${String(summary?.indexedBytes ?? -1)}:${String(summary?.sessions ?? -1)}`
  // The archive is part of what a listing shows - the third state on every row -
  // so a pass that captured something has to re-run the query, exactly as an
  // index pass does.
  const archiveVersion = `${String(archiveStats?.sessions ?? -1)}:${String(archiveStats?.messages ?? -1)}`
  const queryKey = JSON.stringify([
    debouncedSearch,
    scope,
    resumableOnly,
    project,
    indexVersion,
    archiveVersion,
    nameVersion
  ])
  const seq = useRef(0)

  useEffect(() => {
    const ticket = ++seq.current
    void helm
      .invoke('history:sessions', {
        search: debouncedSearch,
        scope,
        resumableOnly,
        ...(project === null ? {} : { project })
      })
      .then((result) => {
        // A slower earlier query must not overwrite a faster later one.
        if (ticket !== seq.current) return
        setAnswer({ key: queryKey, value: result })
        setError(null)
      })
      .catch((err: unknown) => {
        if (ticket !== seq.current) return
        setError(readable(err))
      })
  }, [debouncedSearch, scope, resumableOnly, project, queryKey])

  // Re-read on an index change too: a selected session that is still running
  // in a terminal gains prompts while its detail is on screen.
  const promptKey = selectedId === null ? null : `${selectedId}:${indexVersion}`

  useEffect(() => {
    if (promptKey === null || selectedId === null) return
    let live = true
    void helm.invoke('history:prompts', { sessionId: selectedId }).then((rows) => {
      if (live) setPromptAnswer({ key: promptKey, value: rows })
    })
    return () => {
      live = false
    }
  }, [promptKey, selectedId])

  /*
   * The conversation, fetched on selection rather than with the list.
   *
   * A page carries up to 2,000 rows and this is the one field that is measured
   * in kilobytes per row, so it does not travel with them. Keyed on the archive
   * version as well as the id, because a pass can capture more of a
   * conversation while its detail is on screen - and because the ceiling can
   * take one away while somebody is reading it, which the pane then has to be
   * able to say.
   */
  const conversationKey = selectedId === null ? null : `${selectedId}:${archiveVersion}`

  useEffect(() => {
    if (conversationKey === null || selectedId === null) return
    let live = true
    void helm
      .invoke('archive:conversation', { sessionId: selectedId })
      .then((value) => {
        if (live) setConversationAnswer({ key: conversationKey, value })
      })
      .catch(() => {
        if (live) setConversationAnswer({ key: conversationKey, value: null })
      })
    return () => {
      live = false
    }
  }, [conversationKey, selectedId])

  /*
   * The renamed row, put back into the page and then asked for again.
   *
   * Both halves are load-bearing. Patching the page in place is what repaints
   * the row without a round trip. The version bump is what stops that patch
   * being undone: a name is not part of the query key - `history_names` is not
   * the index - so writing one cancels nothing that is *already in flight*, and
   * this window re-queries whenever `history.jsonl` grows, which on a machine
   * hosting sessions is every few seconds. A listing that read the database
   * before the rename committed would then land after the patch and put the
   * derived title back, and `seq` would not stop it: that listing is still the
   * current ticket, because a patch is not a query.
   *
   * Bumping the version makes it one. The key changes, the effect runs, `seq`
   * moves, and the older listing's answer is dropped on arrival instead of
   * adopted - while the query the bump started reads the name back out of the
   * database, which is the same answer by a route that cannot be raced.
   */
  const rename = useCallback(async (sessionId: string, name: string | null) => {
    const updated = await helm.invoke('history:rename', { sessionId, name })
    if (updated === null) return
    setAnswer((current) =>
      current === null
        ? current
        : {
            ...current,
            value: {
              ...current.value,
              sessions: current.value.sessions.map((s) =>
                s.sessionId === updated.sessionId ? { ...s, ...updated } : s
              )
            }
          }
    )
    setNameVersion((version) => version + 1)
  }, [])

  const refresh = useCallback(() => {
    setRefreshing(true)
    void helm
      .invoke('history:refresh')
      .then(setSummary)
      .catch((err: unknown) => setError(readable(err)))
      .finally(() => setRefreshing(false))
  }, [])

  const resume = useCallback(
    async (session: HistorySession, paneSize: HTMLElement | null) => {
      setResumeError(null)
      setResumeNotice(null)
      setResuming(session.sessionId)
      try {
        const { cols, rows } = estimateGrid(paneSize)
        const result = await helm.invoke('history:resume', {
          sessionId: session.sessionId,
          cols,
          rows
        })
        if (result.warnings.length > 0) setResumeNotice(result.warnings.join(' '))
        return result.session
      } catch (err: unknown) {
        setResumeError(readable(err))
        return null
      } finally {
        setResuming(null)
      }
    },
    []
  )

  // The page is only the answer to the query that is current. A stale one is
  // still shown - a list that blanks between keystrokes is worse than one that
  // lags by a frame - but it is reported as loading rather than as the truth.
  const page = answer?.value ?? null
  const loading = answer === null || answer.key !== queryKey
  const prompts = promptAnswer?.key === promptKey ? promptAnswer.value : []
  const promptsLoading = selectedId !== null && promptAnswer?.key !== promptKey
  const conversation =
    conversationAnswer?.key === conversationKey ? conversationAnswer.value : null
  const conversationLoading = selectedId !== null && conversationAnswer?.key !== conversationKey

  // Resolved from the current page rather than held as state, so a row whose
  // resumability changed under it shows the new answer instead of the one it
  // was selected with.
  const selected = page?.sessions.find((s) => s.sessionId === selectedId) ?? null

  const select = useCallback((session: HistorySession | null) => {
    setSelectedId(session?.sessionId ?? null)
    setResumeError(null)
  }, [])

  return {
    summary,
    page,
    loading,
    error,
    search,
    setSearch,
    scope,
    setScope,
    grouping,
    setGrouping,
    resumableOnly,
    setResumableOnly,
    project,
    setProject,
    selected,
    select,
    prompts,
    promptsLoading,
    conversation,
    conversationLoading,
    archiveStats,
    rename,
    refresh,
    refreshing,
    resume,
    resuming,
    resumeError,
    dismissResumeError: useCallback(() => setResumeError(null), []),
    resumeNotice,
    dismissResumeNotice: useCallback(() => setResumeNotice(null), [])
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ConfigFile,
  ConfigFileContent,
  ConfigRendered,
  ConfigScope,
  ConfigSnapshotMeta,
  ConfigTree,
  DoctorReport,
  EffectiveMcpServer,
  EffectiveView,
  McpPreview,
  McpResult,
  McpScope
} from '@helm/core'
import type { CreatableKind } from '@helm/core/types'
// A value, so it comes from the entry point with no `node:` imports behind it.
import { isRedactedConfigFile } from '@helm/core/types'
import type { ConfigViewKind } from '@helm/ui'
import { helm } from './bridge'

/**
 * The config console's renderer state.
 *
 * Nothing here touches a file. Every read and every write is a request to the
 * main process, which is not merely the architecture - it is what makes the
 * snapshot rule enforceable. A renderer that could write would be a second path
 * into a `.claude` tree with no undo behind it.
 *
 * The one piece of state that matters is `external`: the file the editor has
 * open changed underneath it. It is set by a push from main's watcher and
 * cleared by reloading or by a save that wins - and it is deliberately *also*
 * settable from a failed save, because the watch is a courtesy and the write's
 * own hash check is the guarantee.
 */

export interface ConfigMcpDraft {
  name: string
  scope: McpScope
  json: string
}

/** Which of the three dialogs is open. `null` is none, which is the resting state. */
export type ConfigEntryDialog = 'new' | 'rename' | 'delete' | null

/**
 * A delete that has happened, held until it is undone or dismissed.
 *
 * The file is gone from the tree, so its version history has no row in the list
 * to be reached from - and the delete's own snapshots are that history. Holding
 * them here is what makes "restorable from the per-file history" reachable by
 * clicking rather than only by an IPC call somebody would have to write.
 */
export interface DeletedEntry {
  /** How it was addressed, for the strip's sentence. */
  label: string
  files: Array<{ path: string; snapshotId: number }>
}

export interface ConfigState {
  scopes: ConfigScope[]
  scopePath: string
  setScopePath: (path: string) => void
  scope: ConfigScope | null

  view: ConfigViewKind
  setView: (view: ConfigViewKind) => void

  tree: ConfigTree | null
  treeLoading: boolean
  refresh: () => void
  refreshing: boolean

  selected: ConfigFile | null
  select: (file: ConfigFile | null) => void
  /** Selects by absolute path, switching scope if the file is in another one. */
  openPath: (path: string) => void
  loaded: ConfigFileContent | null
  /** The open file as markdown or as highlighted source. Null while rendering. */
  rendered: ConfigRendered | null
  /** Helm will not read this file, so nothing asked for its bytes. */
  redacted: boolean
  snapshots: ConfigSnapshotMeta[]
  saving: boolean
  editorError: string | null
  external: { hash: string; content: string; exists: boolean } | null
  save: (content: string) => void
  reload: () => void
  restore: (snapshot: ConfigSnapshotMeta) => void
  /** The editor's text differs from the file. Marks the row in the list. */
  dirty: boolean
  setDirty: (dirty: boolean) => void

  /**
   * New, Rename and Delete. Which dialog is open, if any, plus the state the
   * three of them share: one busy flag and one error, because only one can be
   * open at a time and an error belongs to the dialog that caused it.
   */
  entryDialog: ConfigEntryDialog
  openEntryDialog: (dialog: ConfigEntryDialog) => void
  entryBusy: boolean
  entryError: string | null
  createFile: (kind: CreatableKind, name: string) => void
  /** The path the New dialog just wrote, which opens ready to type in. */
  createdPath: string | null
  renameFile: (name: string) => void
  deleteFile: () => void
  /** What a delete left behind: the rows that can bring it back. */
  deleted: DeletedEntry | null
  undoDelete: () => void
  dismissDeleted: () => void

  effectiveProfileId: number | null
  setEffectiveProfileId: (id: number | null) => void
  effectiveCwd: string
  setEffectiveCwd: (cwd: string) => void
  effective: EffectiveView | null
  effectiveLoading: boolean
  effectiveError: string | null
  /** The resolution the Files view reads live state from; null while it is stale. */
  live: EffectiveView | null

  mcpServers: EffectiveMcpServer[]
  mcpDraft: ConfigMcpDraft
  setMcpDraft: (draft: ConfigMcpDraft) => void
  mcpPreview: McpPreview | null
  requestMcpPreview: () => void
  cancelMcpPreview: () => void
  applyMcp: () => void
  mcpApplying: boolean
  mcpResult: McpResult | null
  dismissMcpResult: () => void
  removeMcp: (server: EffectiveMcpServer) => void
  approveMcp: (server: EffectiveMcpServer, approved: boolean) => void
  mcpListing: McpResult | null
  mcpListing_busy: boolean
  runMcpList: () => void

  doctor: DoctorReport | null
  doctorRunning: boolean
  runDoctor: () => void
}

/** Electron prefixes a renderer-side rejection with the channel it came from. */
function readable(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '')
}

const EMPTY_DRAFT: ConfigMcpDraft = { name: '', scope: 'project', json: '' }

/**
 * An answer and the question it answers.
 *
 * The same shape `useHistory` uses, for the same reason: "is this still
 * loading" becomes a comparison rather than a second piece of state that has to
 * be set inside the effect which starts the request - and a `loading` flag that
 * can disagree with the value beside it is the bug this makes unrepresentable.
 */
interface Answered<T> {
  key: string
  value: T
}

export function useConfig(): ConfigState {
  const [scopes, setScopes] = useState<ConfigScope[]>([])
  const [scopePath, setScopePathState] = useState('')
  const [view, setView] = useState<ConfigViewKind>('files')

  const [treeAnswer, setTreeAnswer] = useState<Answered<ConfigTree | null> | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [treeVersion, setTreeVersion] = useState(0)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [fileAnswer, setFileAnswer] = useState<Answered<ConfigFileContent> | null>(null)
  const [snapshotAnswer, setSnapshotAnswer] = useState<Answered<ConfigSnapshotMeta[]> | null>(null)
  const [saving, setSaving] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [external, setExternal] = useState<ConfigState['external']>(null)
  const [dirty, setDirty] = useState(false)

  const [effectiveProfileId, setEffectiveProfileId] = useState<number | null>(null)
  /** Null until the user types one, in which case the scope on screen is used. */
  const [cwdOverride, setCwdOverride] = useState<string | null>(null)
  const [effectiveAnswer, setEffectiveAnswer] = useState<Answered<EffectiveView> | null>(null)
  const [effectiveError, setEffectiveError] = useState<string | null>(null)

  const [mcpDraft, setMcpDraft] = useState<ConfigMcpDraft>(EMPTY_DRAFT)
  const [mcpPreview, setMcpPreview] = useState<McpPreview | null>(null)
  const [mcpApplying, setMcpApplying] = useState(false)
  const [mcpResult, setMcpResult] = useState<McpResult | null>(null)
  const [mcpListing, setMcpListing] = useState<McpResult | null>(null)
  const [mcpListingBusy, setMcpListingBusy] = useState(false)

  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [doctorRunning, setDoctorRunning] = useState(false)

  // -------------------------------------------------------------------------
  // Scopes
  // -------------------------------------------------------------------------
  const loadScopes = useCallback(() => {
    void helm.invoke('config:scopes').then((list) => {
      setScopes(list)
      // The user scope first: it is the layer under every other one, and the
      // only scope that is always there.
      setScopePathState((current) => (current === '' ? (list[0]?.path ?? '') : current))
    })
  }, [])

  useEffect(loadScopes, [loadScopes])

  /**
   * Discovery finishes after the first paint and a profile can be saved at any
   * time, and both change what the switcher can reach - a profile's root and
   * overlays are scopes whether or not a scanned root contains them.
   */
  useEffect(() => {
    const offDiscovery = helm.on('discovery:updated', loadScopes)
    const offProfiles = helm.on('profiles:changed', loadScopes)
    return () => {
      offDiscovery()
      offProfiles()
    }
  }, [loadScopes])

  const scope = useMemo(
    () => scopes.find((s) => s.path.toLowerCase() === scopePath.toLowerCase()) ?? null,
    [scopes, scopePath]
  )

  // -------------------------------------------------------------------------
  // The tree
  // -------------------------------------------------------------------------
  const treeKey = `${scopePath}:${String(treeVersion)}`
  const treeSeq = useRef(0)
  useEffect(() => {
    if (scopePath === '') return
    const ticket = ++treeSeq.current
    void helm
      .invoke('config:tree', { scopePath })
      .then((result) => {
        if (ticket !== treeSeq.current) return
        setTreeAnswer({ key: treeKey, value: result })
      })
      .catch(() => {
        if (ticket !== treeSeq.current) return
        setTreeAnswer({ key: treeKey, value: null })
      })
      .finally(() => {
        if (ticket === treeSeq.current) setRefreshing(false)
      })
  }, [scopePath, treeKey])

  // A stale tree is still shown while the next one loads - a list that blanks
  // between scopes is worse than one that lags by a frame.
  const tree = treeAnswer?.value ?? null
  const treeLoading = scopePath !== '' && treeAnswer?.key !== treeKey

  const setScopePath = useCallback((path: string) => {
    setScopePathState(path)
    setSelectedPath(null)
    setExternal(null)
    setEditorError(null)
    setMcpPreview(null)
    setMcpResult(null)
    setMcpListing(null)
  }, [])

  /**
   * Re-reads the scope list as well as the tree.
   *
   * Both can go stale for reasons Helm did not cause - a repo cloned into a
   * scanned root, a profile imported in another window - and a refresh that
   * only re-walked the directory already on screen would leave the switcher
   * offering yesterday's answer.
   */
  const refresh = useCallback(() => {
    setRefreshing(true)
    loadScopes()
    setTreeVersion((n) => n + 1)
  }, [loadScopes])

  const selected = useMemo(
    () => tree?.files.find((file) => file.path === selectedPath) ?? null,
    [tree, selectedPath]
  )

  // -------------------------------------------------------------------------
  // The open file
  // -------------------------------------------------------------------------
  /** Bumped to re-read the same file after a write, a restore, or a reload. */
  const [fileVersion, setFileVersion] = useState(0)
  const fileKey = `${selectedPath ?? ''}:${String(fileVersion)}`

  const readSelected = useCallback(
    (path: string, key: string) => {
      void helm
        .invoke('config:read', { path })
        .then((content) => setFileAnswer({ key, value: content }))
        .catch((err: unknown) => setEditorError(readable(err)))
      if (scopePath !== '') {
        void helm
          .invoke('config:snapshots', { scopePath, path })
          .then((rows) => setSnapshotAnswer({ key, value: rows }))
      }
    },
    [scopePath]
  )

  /**
   * The one file in a `.claude` tree Helm will not open.
   *
   * `.credentials.json` is a `.json` in a directory of `.json`s, so the console
   * is exactly the surface that would read it by accident - and CLAUDE.md's
   * credentials rule is that a sign-in is detected from an artefact's
   * *existence* and nothing opens one. The row stays, the pane says what the
   * file is, and no request for its bytes is ever made.
   */
  const redacted = selected !== null && isRedactedConfigFile(selected.relPath)

  useEffect(() => {
    // Releasing the watch matters on Windows, where a handle on a directory is
    // not free: an app that watches every file it has ever shown is an app that
    // eventually gets in another tool's way.
    void helm.invoke('config:watch', { path: redacted ? null : selectedPath })
    if (selectedPath === null || redacted) return
    readSelected(selectedPath, fileKey)
  }, [selectedPath, fileKey, readSelected, redacted])

  const loaded = fileAnswer?.key === fileKey ? fileAnswer.value : null
  const snapshots = snapshotAnswer?.key === fileKey ? snapshotAnswer.value : []

  /**
   * The bytes as something other than a textarea, rendered in main.
   *
   * Of the file rather than of the draft: the reading view shows what is on
   * disk, and a preview of unsaved text is a different feature with a different
   * cost (a render per keystroke). Re-runs when the file's hash changes, which
   * covers a save, a restore and an external edit alike.
   */
  const [renderAnswer, setRenderAnswer] = useState<Answered<ConfigRendered> | null>(null)
  const renderKey = `${selectedPath ?? ''}:${loaded?.hash ?? ''}`
  useEffect(() => {
    if (selectedPath === null || loaded === null || loaded.binary || !loaded.exists) return
    let live = true
    void helm
      .invoke('config:render', { path: selectedPath, source: loaded.content })
      .then((result) => {
        if (live) setRenderAnswer({ key: renderKey, value: result })
      })
      .catch(() => {
        // The source view still works, and a file that will not render is a
        // bug worth seeing rather than a reason to show nothing.
        if (live) setRenderAnswer({ key: renderKey, value: { markdown: null, code: null } })
      })
    return () => {
      live = false
    }
  }, [selectedPath, renderKey, loaded])

  const rendered = renderAnswer?.key === renderKey ? renderAnswer.value : null

  // Main's watcher, which fires while the user is still typing rather than when
  // they save. The bytes come with it so "reload" is a decision, not a leap.
  useEffect(
    () =>
      helm.on('config:externalChange', (change) => {
        if (selectedPath === null || change.path.toLowerCase() !== selectedPath.toLowerCase()) {
          return
        }
        void helm.invoke('config:read', { path: change.path }).then((content) => {
          // Not a change if it is what we already have - a save of our own that
          // raced the debounce, most plausibly.
          if (loaded !== null && content.hash === loaded.hash) return
          setExternal({ hash: content.hash, content: content.content, exists: content.exists })
        })
      }),
    [selectedPath, loaded]
  )

  const save = useCallback(
    (content: string) => {
      if (selectedPath === null || scope === null) return
      setSaving(true)
      setEditorError(null)
      void helm
        .invoke('config:write', {
          scopePath: scope.path,
          path: selectedPath,
          content,
          // The hash the editor's text was derived from. Null when it believes
          // the file does not exist - in which case a file that has appeared is
          // itself the conflict.
          expectedHash: loaded?.exists === true ? loaded.hash : null,
          reason: 'edit'
        })
        .then((result) => {
          if (result.conflict) {
            // The guarantee, as opposed to the watcher's courtesy: this runs on
            // every write whether or not `fs.watch` ever said anything.
            setExternal({
              hash: result.conflict.onDiskHash,
              content: result.conflict.onDiskContent,
              exists: true
            })
            return
          }
          if (!result.ok) {
            setEditorError(result.error ?? 'The write was refused.')
            return
          }
          setExternal(null)
          setFileVersion((n) => n + 1)
          setTreeVersion((n) => n + 1)
        })
        .catch((err: unknown) => setEditorError(readable(err)))
        .finally(() => setSaving(false))
    },
    [selectedPath, scope, loaded]
  )

  const reload = useCallback(() => {
    setExternal(null)
    setEditorError(null)
    setFileVersion((n) => n + 1)
  }, [])

  const restore = useCallback(
    (snapshot: ConfigSnapshotMeta) => {
      if (selectedPath === null) return
      setSaving(true)
      setEditorError(null)
      void helm
        .invoke('config:restore', { id: snapshot.id, path: selectedPath })
        .then((result) => {
          if (!result.ok) {
            setEditorError(result.error ?? 'The restore was refused.')
            return
          }
          setExternal(null)
          setFileVersion((n) => n + 1)
          setTreeVersion((n) => n + 1)
        })
        .catch((err: unknown) => setEditorError(readable(err)))
        .finally(() => setSaving(false))
    },
    [selectedPath]
  )

  const select = useCallback((file: ConfigFile | null) => {
    setSelectedPath(file?.path ?? null)
    setEditorError(null)
    setExternal(null)
  }, [])

  // -------------------------------------------------------------------------
  // New, rename, delete
  // -------------------------------------------------------------------------
  const [entryDialog, setEntryDialog] = useState<ConfigEntryDialog>(null)
  /**
   * The file the New dialog just wrote, so the editor can open it ready to type
   * in rather than rendered.
   *
   * The two halves of this console arrived on separate branches and disagreed
   * here: creating a file opened it in the editor, because every scaffold is a
   * placeholder whose text says what to replace, while the redesign opens a
   * markdown file rendered because that is the right default for reading one.
   * Both are right, and they are about different moments - so the rendered
   * default stands everywhere except the one click that just produced the file.
   */
  const [createdPath, setCreatedPath] = useState<string | null>(null)
  const [entryBusy, setEntryBusy] = useState(false)
  const [entryError, setEntryError] = useState<string | null>(null)
  const [deletedEntry, setDeletedEntry] = useState<
    (DeletedEntry & { scopePath: string }) | null
  >(null)

  /**
   * A delete belongs to the scope it happened in.
   *
   * Switching scope leaves the strip behind rather than offering an undo above
   * a list it is not about - and the rows stay in the history either way.
   * Derived from the scope on screen rather than cleared by an effect: the two
   * are the same outcome, and a `useState` that a `useEffect` resets is a state
   * that is briefly wrong on every scope change.
   */
  const deleted =
    deletedEntry !== null && deletedEntry.scopePath.toLowerCase() === scopePath.toLowerCase()
      ? deletedEntry
      : null

  const openEntryDialog = useCallback((dialog: ConfigEntryDialog) => {
    setEntryDialog(dialog)
    setEntryError(null)
  }, [])

  /** Selects a path the tree has not been re-read for yet, and forces the re-read. */
  const landOn = useCallback((path: string | null) => {
    setTreeVersion((n) => n + 1)
    setFileVersion((n) => n + 1)
    setSelectedPath(path)
    setEditorError(null)
    setExternal(null)
  }, [])

  const createFile = useCallback(
    (kind: CreatableKind, name: string) => {
      if (scope === null) return
      setEntryBusy(true)
      setEntryError(null)
      void helm
        .invoke('config:create', { scopePath: scope.path, kind, name })
        .then((result) => {
          if (!result.ok) {
            setEntryError(result.error ?? 'Nothing was created.')
            return
          }
          setEntryDialog(null)
          // Opened straight away: every scaffold below is a placeholder with a
          // sentence in it saying what to replace, and a New that left you
          // looking at the list would have written a file nobody read.
          setCreatedPath(result.path)
          landOn(result.path)
        })
        .catch((err: unknown) => setEntryError(readable(err)))
        .finally(() => setEntryBusy(false))
    },
    [scope, landOn]
  )

  const renameFile = useCallback(
    (name: string) => {
      if (scope === null || selectedPath === null) return
      setEntryBusy(true)
      setEntryError(null)
      void helm
        .invoke('config:rename', { scopePath: scope.path, path: selectedPath, name })
        .then((result) => {
          if (!result.ok) {
            setEntryError(result.error ?? 'Nothing was renamed.')
            return
          }
          setEntryDialog(null)
          landOn(result.path)
        })
        .catch((err: unknown) => setEntryError(readable(err)))
        .finally(() => setEntryBusy(false))
    },
    [scope, selectedPath, landOn]
  )

  const deleteFile = useCallback(() => {
    if (scope === null || selectedPath === null || selected === null) return
    const label = selected.name
    setEntryBusy(true)
    setEntryError(null)
    void helm
      .invoke('config:delete', { scopePath: scope.path, path: selectedPath })
      .then((result) => {
        if (!result.ok) {
          setEntryError(result.error ?? 'Nothing was deleted.')
          return
        }
        setEntryDialog(null)
        setDeletedEntry({
          scopePath: scope.path,
          label,
          files: result.removed.map((row) => ({ path: row.path, snapshotId: row.snapshotId }))
        })
        landOn(null)
      })
      .catch((err: unknown) => setEntryError(readable(err)))
      .finally(() => setEntryBusy(false))
  }, [scope, selectedPath, selected, landOn])

  /**
   * Puts a deleted entry back, one `config:restore` per file.
   *
   * The same channel the version list uses, over the same rows - a delete's
   * undo is not a fourth mechanism, it is the history the delete wrote. In
   * order, so a skill's `SKILL.md` is the file the console lands on.
   */
  const undoDelete = useCallback(() => {
    if (deleted === null) return
    setEntryBusy(true)
    const restoreAll = deleted.files.reduce<Promise<unknown>>(
      (chain, row) =>
        chain.then(() => helm.invoke('config:restore', { id: row.snapshotId, path: row.path })),
      Promise.resolve()
    )
    void restoreAll
      .then(() => {
        setDeletedEntry(null)
        landOn(deleted.files[0]?.path ?? null)
      })
      .catch((err: unknown) => setEditorError(readable(err)))
      .finally(() => setEntryBusy(false))
  }, [deleted, landOn])

  /**
   * Opens a file by path, from a link somewhere that is not the list - the
   * effective view's entries, or the file an MCP server was defined in.
   *
   * Switches scope when the file belongs to another one, because otherwise the
   * list beside the editor would be showing a different directory's contents.
   */
  const openPath = useCallback(
    (path: string) => {
      const owner = [...scopes]
        .filter((candidate) => path.toLowerCase().startsWith(candidate.path.toLowerCase()))
        // The longest matching prefix: a repo inside a harness matches both,
        // and the repo is the one the file belongs to.
        .sort((a, b) => b.path.length - a.path.length)[0]
      if (owner && owner.path.toLowerCase() !== scopePath.toLowerCase()) {
        setScopePathState(owner.path)
      }
      setView('files')
      setSelectedPath(path)
      setEditorError(null)
      setExternal(null)
    },
    [scopes, scopePath]
  )

  // -------------------------------------------------------------------------
  // Effective view
  // -------------------------------------------------------------------------
  /**
   * The directory the view is computed for.
   *
   * Derived from the scope on screen until the user types something else, so
   * switching to this tab answers the question about what they were just
   * looking at. The user scope has no working directory of its own - it is the
   * layer *under* one - so it falls through to the first real scope.
   */
  const effectiveCwd =
    cwdOverride ??
    (scope !== null && scope.kind !== 'user'
      ? scope.path
      : (scopes.find((candidate) => candidate.kind !== 'user')?.path ?? ''))

  const effectiveKey = `${String(effectiveProfileId)}:${effectiveCwd}:${String(treeVersion)}`
  const effectiveSeq = useRef(0)
  /**
   * Computed for the Files view as well, and deliberately the *same* answer.
   *
   * A row saying a skill resolves, or that a settings key is outranked, is
   * reading this view - so if Files computed its own, the two tabs could
   * disagree about one file while both were right about their own question.
   * One resolution per console, named on screen, is the whole point: the
   * Effective tab becomes the deep dive rather than the corrective.
   */
  const wantsEffective = view === 'effective' || view === 'files'
  useEffect(() => {
    if (!wantsEffective) return
    if (effectiveProfileId === null && effectiveCwd.trim() === '') return
    const ticket = ++effectiveSeq.current
    void helm
      .invoke('config:effective', {
        profileId: effectiveProfileId,
        cwd: effectiveProfileId === null ? effectiveCwd : null
      })
      .then((result) => {
        if (ticket !== effectiveSeq.current) return
        setEffectiveAnswer({ key: effectiveKey, value: result })
        setEffectiveError(null)
      })
      .catch((err: unknown) => {
        if (ticket !== effectiveSeq.current) return
        setEffectiveError(readable(err))
      })
  }, [wantsEffective, effectiveProfileId, effectiveCwd, effectiveKey])

  const effective = effectiveAnswer?.value ?? null
  const effectiveLoading = wantsEffective && effectiveAnswer?.key !== effectiveKey

  /**
   * The same view, withheld while it is the answer to a different question.
   *
   * The Effective tab shows a stale answer with a loading flag beside it, which
   * is right for a page of prose. A file row cannot do that: joined with a tree
   * that has already switched scope, last scope's resolution says "not resolved
   * here" about every file on screen. That is not a lag, it is a wrong claim,
   * so the rows go quiet instead.
   */
  const live = effectiveAnswer?.key === effectiveKey ? effectiveAnswer.value : null

  // -------------------------------------------------------------------------
  // MCP
  // -------------------------------------------------------------------------
  /**
   * The MCP panel resolves against the scope on screen, and the effective view
   * is what already knows which servers a directory would load - so it is
   * computed there rather than a second time here.
   */
  const [mcpAnswer, setMcpAnswer] = useState<Answered<EffectiveView | null> | null>(null)
  const mcpCwd = scope?.kind === 'user' ? (scopes.find((s) => s.kind !== 'user')?.path ?? '') : (scope?.path ?? '')
  const mcpSeq = useRef(0)
  const [mcpVersion, setMcpVersion] = useState(0)
  const mcpKey = `${mcpCwd}:${String(mcpVersion)}`
  useEffect(() => {
    if (view !== 'mcp' || mcpCwd === '') return
    const ticket = ++mcpSeq.current
    void helm
      .invoke('config:effective', { cwd: mcpCwd })
      .then((result) => {
        if (ticket === mcpSeq.current) setMcpAnswer({ key: mcpKey, value: result })
      })
      .catch(() => {
        if (ticket === mcpSeq.current) setMcpAnswer({ key: mcpKey, value: null })
      })
  }, [view, mcpCwd, mcpKey])

  const requestMcpPreview = useCallback(() => {
    if (mcpCwd === '') return
    void helm
      .invoke('config:mcpPreview', { ...mcpDraft, cwd: mcpCwd })
      .then(setMcpPreview)
      .catch((err: unknown) =>
        setMcpPreview({
          file: '',
          before: '',
          after: '',
          diff: [],
          replaces: null,
          error: readable(err)
        })
      )
  }, [mcpDraft, mcpCwd])

  const applyMcp = useCallback(() => {
    if (mcpCwd === '') return
    setMcpApplying(true)
    void helm
      .invoke('config:mcpAdd', { ...mcpDraft, cwd: mcpCwd })
      .then((result) => {
        setMcpResult(result)
        if (result.ok) {
          setMcpPreview(null)
          setMcpDraft(EMPTY_DRAFT)
        }
        setMcpVersion((n) => n + 1)
        setTreeVersion((n) => n + 1)
      })
      .catch((err: unknown) =>
        setMcpResult({ ok: false, output: readable(err), exitCode: null, after: '', snapshotId: null })
      )
      .finally(() => setMcpApplying(false))
  }, [mcpDraft, mcpCwd])

  const removeMcp = useCallback(
    (server: EffectiveMcpServer) => {
      if (mcpCwd === '') return
      void helm
        .invoke('config:mcpRemove', { name: server.name, scope: server.scope, cwd: mcpCwd })
        .then((result) => {
          setMcpResult(result)
          setMcpVersion((n) => n + 1)
          setTreeVersion((n) => n + 1)
        })
        .catch((err: unknown) =>
          setMcpResult({ ok: false, output: readable(err), exitCode: null, after: '', snapshotId: null })
        )
    },
    [mcpCwd]
  )

  const approveMcp = useCallback(
    (server: EffectiveMcpServer, approved: boolean) => {
      if (mcpCwd === '') return
      void helm
        .invoke('config:mcpApprove', { cwd: mcpCwd, name: server.name, approved })
        .then((result) => {
          setMcpResult({
            ok: result.ok,
            output: result.ok
              ? `${server.name} is now ${approved ? 'approved' : 'blocked'} for this project.`
              : (result.error ?? 'The write was refused.'),
            exitCode: null,
            after: '',
            snapshotId: result.snapshotId
          })
          setMcpVersion((n) => n + 1)
          setTreeVersion((n) => n + 1)
        })
        .catch((err: unknown) =>
          setMcpResult({ ok: false, output: readable(err), exitCode: null, after: '', snapshotId: null })
        )
    },
    [mcpCwd]
  )

  const runMcpList = useCallback(() => {
    if (mcpCwd === '') return
    setMcpListingBusy(true)
    void helm
      .invoke('config:mcpList', { cwd: mcpCwd })
      .then(setMcpListing)
      .catch((err: unknown) =>
        setMcpListing({ ok: false, output: readable(err), exitCode: null, after: '', snapshotId: null })
      )
      .finally(() => setMcpListingBusy(false))
  }, [mcpCwd])

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------
  /*
   * The scope's own path, not `mcpCwd`.
   *
   * `mcpCwd` deliberately steps *off* a user scope, because `claude mcp` needs
   * a project directory to register a server against. The doctor is the
   * opposite case: a distribution's user scope is precisely where the answer
   * differs, since `\\wsl$\<distro>\home\...` is what tells the launcher to run
   * that distribution's CLI. So the health panel asks about the scope on
   * screen, whatever kind it is.
   */
  const doctorCwd = scope?.path ?? ''

  const runDoctor = useCallback(() => {
    setDoctorRunning(true)
    void helm
      .invoke('config:doctor', { cwd: doctorCwd })
      .then(setDoctor)
      .catch((err: unknown) =>
        setDoctor({
          output: '',
          rows: [],
          exitCode: null,
          ranAt: new Date().toISOString(),
          durationMs: 0,
          error: readable(err)
        })
      )
      .finally(() => setDoctorRunning(false))
  }, [doctorCwd])

  return {
    scopes,
    scopePath,
    setScopePath,
    scope,
    view,
    setView,
    tree,
    treeLoading,
    refresh,
    refreshing,
    selected,
    select,
    openPath,
    loaded,
    rendered,
    redacted,
    snapshots,
    saving,
    editorError,
    external,
    save,
    reload,
    restore,
    dirty,
    setDirty,
    entryDialog,
    openEntryDialog,
    entryBusy,
    entryError,
    createFile,
    createdPath,
    renameFile,
    deleteFile,
    deleted,
    undoDelete,
    dismissDeleted: useCallback(() => setDeletedEntry(null), []),
    effectiveProfileId,
    setEffectiveProfileId,
    effectiveCwd,
    setEffectiveCwd: setCwdOverride,
    effective,
    effectiveLoading,
    effectiveError,
    live,
    mcpServers: mcpAnswer?.value?.mcpServers ?? [],
    mcpDraft,
    setMcpDraft,
    mcpPreview,
    requestMcpPreview,
    cancelMcpPreview: useCallback(() => setMcpPreview(null), []),
    applyMcp,
    mcpApplying,
    mcpResult,
    dismissMcpResult: useCallback(() => setMcpResult(null), []),
    removeMcp,
    approveMcp,
    mcpListing,
    mcpListing_busy: mcpListingBusy,
    runMcpList,
    doctor,
    doctorRunning,
    runDoctor
  }
}

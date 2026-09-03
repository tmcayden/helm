import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, TemplateChoice, TemplatePreview } from '@helm/core'
import type { ClaudeStatus } from '../../../shared/ipc'
import { helm } from './bridge'

/**
 * First run, and everything that stays true afterwards.
 *
 * The pane is on screen whenever `settings` says there is nothing to scan and
 * no completion stamp - a *state*, not a wizard the app remembers having shown.
 * That is why nothing here holds a "step": quitting halfway through leaves the
 * settings exactly as they were, so the next launch resumes rather than
 * dropping the user into an empty launcher with a small button in the corner.
 *
 * The CLI status is fetched here and used twice: by the setup pane, and by the
 * version banner that outlives it. One request, one answer, so the two surfaces
 * cannot disagree about what version is installed.
 */

export type HarnessDialogMode = 'new' | 'convert'

/**
 * The built-in scaffold's id, written out rather than imported.
 *
 * `MINIMAL_TEMPLATE` is a *value* in `@helm/core`, and a value import of the
 * package root from the renderer reaches `launch/` and `store/` and fails at
 * rollup rather than at typecheck (CLAUDE.md, "Boundaries"). It is one word and
 * it is also the string the main process would answer with, so the two cannot
 * drift without `template:list` disagreeing with the picker's default in a way
 * `pnpm template-check` sees.
 */
const MINIMAL = 'minimal'

export interface SetupState {
  status: ClaudeStatus | null
  checking: boolean
  suggestions: string[]
  /** Whether the setup pane owns the window. */
  needed: boolean
  recheck: () => void
  locateClaude: () => void
  acceptSuggestion: (path: string) => void
  finish: () => void

  /** The create-a-harness dialog, which is reachable long after first run. */
  dialog: HarnessDialogMode | null
  dialogDir: string
  dialogProblems: string[]
  creating: boolean
  openDialog: (mode: HarnessDialogMode) => void
  closeDialog: () => void
  /** Opens the folder picker. `startIn` opens it inside a distribution. */
  chooseDialogDir: (startIn?: string) => void
  /** The WSL distributions, for the picker shortcuts. Empty without WSL. */
  distros: Array<{ distro: string; home: string }>
  /** The dialog owns its mode once open; the preview has to follow it. */
  setDialogMode: (mode: HarnessDialogMode) => void
  createHarness: (request: {
    mode: HarnessDialogMode
    dir: string
    name: string
    template: string
  }) => void

  /** The picker: `minimal` first, then whatever is in the templates directory. */
  templates: TemplateChoice[]
  templatesDir: string
  templateProblems: string[]
  /** Re-reads them, for when the manager has been authoring over this dialog. */
  refreshTemplates: () => void
  /** Which one is chosen. Reset to `minimal` every time the dialog opens. */
  template: string
  chooseTemplate: (template: string) => void
  /** What "What gets written" lists. Null until the first answer lands. */
  templatePreview: TemplatePreview | null

  /** Set for the session once the version banner has been dismissed. */
  bannerDismissed: boolean
  dismissBanner: () => void
}

export function useSetup(
  settings: AppSettings | null,
  /** Called when the roots have changed and the tree should be rebuilt. */
  onRootsChanged: () => void
): SetupState {
  const [status, setStatus] = useState<ClaudeStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [dialog, setDialog] = useState<HarnessDialogMode | null>(null)
  const [dialogDir, setDialogDir] = useState('')
  const [dialogMode, setDialogMode] = useState<HarnessDialogMode>('new')
  const [dialogProblems, setDialogProblems] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [templates, setTemplates] = useState<TemplateChoice[]>([])
  const [templatesDir, setTemplatesDir] = useState('')
  const [templateProblems, setTemplateProblems] = useState<string[]>([])
  const [template, setTemplate] = useState(MINIMAL)
  const [templatePreview, setTemplatePreview] = useState<TemplatePreview | null>(null)
  const [distros, setDistros] = useState<Array<{ distro: string; home: string }>>([])

  /** The button. Shows a spinner, because the user asked and is waiting. */
  const recheck = useCallback(() => {
    setChecking(true)
    void helm
      .invoke('setup:status')
      .then(setStatus)
      .finally(() => setChecking(false))
  }, [])

  useEffect(() => {
    void helm.invoke('roots:suggest').then(setSuggestions)
  }, [])

  /**
   * Read on mount, and again whenever the chosen CLI changes - however it
   * changed. The picker is one way; a settings write is another, and a banner
   * that only updated for the first would describe a version that is no longer
   * the one Helm would launch.
   *
   * No spinner here: nobody asked for this one, and `checking` is about a
   * button someone is looking at.
   */
  useEffect(() => {
    let cancelled = false
    void helm.invoke('setup:status').then((next) => {
      if (!cancelled) setStatus(next)
    })
    return () => {
      cancelled = true
    }
  }, [settings?.claudePath])

  const locateClaude = useCallback(() => {
    setChecking(true)
    void helm
      .invoke('setup:locateClaude')
      .then((next) => {
        setStatus(next)
        // A newly picked CLI is a reason to look at the banner again, whether it
        // fixed the warning or introduced one.
        setBannerDismissed(false)
      })
      .finally(() => setChecking(false))
  }, [])

  const acceptSuggestion = useCallback(
    (path: string) => {
      void helm.invoke('roots:accept', { path }).then(() => onRootsChanged())
    },
    [onRootsChanged]
  )

  // No local state to update: the main process emits `settings:changed` from
  // the same handler, and the launcher's copy of the settings is the one the
  // pane's visibility is derived from.
  const finish = useCallback(() => {
    void helm.invoke('setup:complete')
  }, [])

  /**
   * Re-reads the picker's rows.
   *
   * Called when the dialog opens, and again when the template manager closes
   * over the top of it - those are the two moments the list can have changed
   * under a dialog somebody is still filling in, and the second one is the
   * whole reason this is a callback rather than three lines inside `openDialog`.
   */
  const refreshTemplates = useCallback(() => {
    void helm.invoke('template:list').then((listing) => {
      setTemplates(listing.templates)
      setTemplatesDir(listing.dir)
      setTemplateProblems(listing.problems)
    })
  }, [])

  const openDialog = useCallback(
    (mode: HarnessDialogMode) => {
      setDialogProblems([])
      // Seeded with somewhere plausible so the common case is two clicks: the
      // parent of an existing root for a new harness, and nothing at all for a
      // conversion, which has to be pointed at a specific folder.
      setDialogDir(mode === 'new' ? (settings?.scanRoots[0] ?? '') : '')
      setDialogMode(mode)
      // Back to `minimal` every time, deliberately. The picker is not a
      // preference: someone who used a template once has a harness from it, and
      // the next one is a fresh decision rather than a repeat of the last.
      setTemplate(MINIMAL)
      // Nothing from the last open: the effect below fills this in, and until
      // it does an empty list is the truthful thing to show.
      setTemplatePreview(null)
      setDialog(mode)
      // Read on open rather than at mount: a template is a directory somebody
      // can add while Helm is running, and a list fetched once at startup would
      // be stale for the rest of the session.
      refreshTemplates()
      /*
       * The distributions, for the picker shortcuts beside "Choose…".
       *
       * On open rather than at mount, the same rule the WSL settings group
       * learned the hard way: nothing about WSL is read until somebody opens a
       * surface that shows it. This one is free either way - the homes are
       * memoised and the app has already asked for them - but a channel called
       * on mount is a channel that gets asked on every launch, and the reason
       * it is cheap today is not a reason to depend on it staying cheap.
       *
       * An empty list on failure: no WSL is the ordinary answer, and a machine
       * without it simply gets the one button it had before.
       */
      void helm
        .invoke('wsl:homes')
        .catch(() => [])
        .then((homes) => {
          setDistros(homes.map((entry) => ({ distro: entry.distro, home: entry.home })))
        })
    },
    [settings, refreshTemplates]
  )

  /**
   * The file list, re-read whenever the answer would change.
   *
   * Only while the dialog is open, because it is the only thing that shows it.
   * Clearing is `openDialog`'s and `closeDialog`'s job rather than this
   * effect's - a `setState` in an effect body is a cascading render and the
   * lint rule that says so is right here, since "there is no preview" is
   * something those two *know* rather than something to be synchronised.
   */
  useEffect(() => {
    if (dialog === null) return
    let cancelled = false
    void helm
      .invoke('template:preview', { template, mode: dialogMode })
      .then((next) => {
        if (!cancelled) setTemplatePreview(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [dialog, dialogMode, template])

  const closeDialog = useCallback(() => {
    setDialog(null)
    setDialogProblems([])
    setTemplatePreview(null)
  }, [])

  const chooseDialogDir = useCallback((startIn?: string) => {
    void helm
      .invoke('path:chooseDirectory', {
        title: dialog === 'convert' ? 'Choose the folder to convert' : 'Create the harness inside',
        ...(startIn === undefined ? {} : { startIn })
      })
      .then(({ path }) => {
        if (path !== null) setDialogDir(path)
      })
  }, [dialog])

  const createHarness = useCallback(
    (request: { mode: HarnessDialogMode; dir: string; name: string; template: string }) => {
      setCreating(true)
      setDialogProblems([])
      void helm
        .invoke('harness:create', {
          mode: request.mode,
          dir: request.dir,
          ...(request.name !== '' ? { name: request.name } : {}),
          ...(request.mode === 'new' ? { template: request.template } : {})
        })
        .then((result) => {
          /*
           * Already a harness, and now a listed one.
           *
           * Treated as the success it is rather than as the refusal it reads
           * like: main added the root in the same call, so the folder is in the
           * tree behind this dialog. Closing is what makes that visible - the
           * old behaviour left an error on screen about a harness the launcher
           * genuinely did not show, which is the state a user cannot act on.
           */
          if (result.path === null && result.existing !== null) {
            onRootsChanged()
            closeDialog()
            return
          }
          if (result.path === null) {
            setDialogProblems(result.problems)
            return
          }
          // The root was added by the main process in the same call, so the
          // disk is worth another look either way.
          onRootsChanged()
          if (result.problems.length > 0) {
            /*
             * A template that applied only partly. The harness exists and is in
             * the tree behind this dialog, so closing would take the only
             * account of what did *not* get written off the screen with it -
             * there is no second place that list is kept. It stays up, saying
             * so, and Cancel is what dismisses it.
             *
             * The first line names what *did* happen, and it is not decoration:
             * this box is the same red one a refusal uses, and a list of
             * problems with no preamble over a harness that was in fact created
             * reads as "nothing happened". Honest about the partial write means
             * honest about both halves of it.
             */
            setDialogProblems([
              `${result.path} was created, but not everything in the template could be written:`,
              ...result.problems
            ])
            return
          }
          setDialog(null)
        })
        .catch((err: unknown) => {
          setDialogProblems([err instanceof Error ? err.message : String(err)])
        })
        .finally(() => setCreating(false))
    },
    [onRootsChanged]
  )

  // One question: has this profile been through setup. Deliberately not "does
  // it have roots" - the pane is where roots are acquired, and one that closed
  // itself when the first folder landed would close halfway through its own job.
  const needed = settings !== null && settings.firstRunCompletedAt === null

  return {
    status,
    checking,
    suggestions,
    needed,
    recheck,
    locateClaude,
    acceptSuggestion,
    finish,
    dialog,
    dialogDir,
    dialogProblems,
    creating,
    openDialog,
    closeDialog,
    chooseDialogDir,
    distros,
    setDialogMode,
    createHarness,
    templates,
    templatesDir,
    templateProblems,
    refreshTemplates,
    template,
    chooseTemplate: setTemplate,
    templatePreview,
    bannerDismissed,
    dismissBanner: () => setBannerDismissed(true)
  }
}

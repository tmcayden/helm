import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { TemplateChoice, TemplatePreview } from '@helm/core'
import { cn } from '../lib/cn'
import { ROW_SELECTED } from '../lib/rows'
import { SEGMENT_ON } from '../lib/segmented'
import { CloseIcon, HelmMarkIcon } from './icons'
import { Overlay } from './Overlay'

export interface NewHarnessDialogProps {
  /**
   * Which of the two the dialog opens on. Both are reachable from inside it -
   * they are the same decision seen from two directions ("I want a workspace"
   * versus "I already have one"), and someone who picks the wrong one should
   * not have to close the dialog to say so.
   *
   * 'new' scaffolds a directory that does not exist yet. 'convert' writes a
   * manifest into one that already holds repositories.
   */
  mode: 'new' | 'convert'
  /** For 'new', the folder it will be created inside; for 'convert', the folder itself. */
  dir: string
  /** `startIn` opens the picker there; see `distros` for the only caller of it. */
  onChooseDir: (startIn?: string) => void
  /**
   * The WSL distributions on this machine, each with the folder to open the
   * picker in - its `\\wsl$\...\home\<user>` - or empty where there are none.
   *
   * A row per distribution rather than one "Linux" button, because Windows'
   * file dialog cannot be given the Linux entry Explorer has: that entry is a
   * shell namespace extension, and the share root is not something the file
   * APIs can even list (`readdirSync('\\\\wsl$\\')` answers ENOENT, measured
   * 2026-09-03). What Helm *can* do is open the dialog already inside a
   * distribution, which is where that entry was only ever a route to - and it
   * knows every distro's home because four other readers already need it.
   */
  distros?: ReadonlyArray<{ distro: string; home: string }> | undefined
  /** The dialog owns the mode after it opens; this is how the owner keeps up. */
  onModeChange?: ((mode: 'new' | 'convert') => void) | undefined
  problems?: readonly string[] | undefined
  busy?: boolean | undefined
  /**
   * The picker's rows, `minimal` first. Empty before `template:list` answers,
   * which is a frame or two - the picker simply is not there yet rather than
   * showing a row that might be replaced.
   */
  templates?: readonly TemplateChoice[] | undefined
  /** The chosen template's id. `minimal` until someone says otherwise. */
  template?: string | undefined
  onTemplateChange?: ((template: string) => void) | undefined
  /** Where the user's templates live, said out loud so they can be written. */
  templatesDir?: string | undefined
  /**
   * Opens the template manager.
   *
   * One of its two entry points, and the other is Settings. Here because
   * "there is no template that does what I want" is a thought people have
   * while looking at this picker; there because templates are app-level and
   * nobody should have to start creating a harness to tidy them up.
   */
  onManageTemplates?: (() => void) | undefined
  /** A template that could not be read, as a sentence. Not fatal to the rest. */
  templateProblems?: readonly string[] | undefined
  /** What "What gets written" lists. Null while the answer is in flight. */
  preview?: TemplatePreview | null | undefined
  onCreate: (request: {
    mode: 'new' | 'convert'
    dir: string
    name: string
    template: string
  }) => void
  onCancel: () => void
}

/**
 * Creating a harness, which is a smaller thing than the word suggests: a
 * directory with a `harness.yaml` in it.
 *
 * The dialog says exactly what will be written, and since templates landed that
 * list is **read from the engine that writes it** (`template:preview`) rather
 * than typed out here. It used to be three hardcoded lines, which was true of
 * the only scaffold there was; with a user-authored tree behind the choice, a
 * list written in the component is a list that can describe a layout nobody
 * would get.
 *
 * The picker is `'new'` only. Converting writes a manifest and a `.claude/`
 * into a directory somebody already has, and a template applied to that would
 * be Helm writing a layout into their work.
 */
export function NewHarnessDialog({
  mode: initialMode,
  dir,
  onChooseDir,
  distros = [],
  onModeChange,
  problems = [],
  busy = false,
  templates = [],
  template = 'minimal',
  onTemplateChange,
  templatesDir,
  onManageTemplates,
  templateProblems = [],
  preview = null,
  onCreate,
  onCancel
}: NewHarnessDialogProps): JSX.Element {
  const [mode, setMode] = useState(initialMode)
  const [name, setName] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode === 'new') nameRef.current?.focus()
  }, [mode])

  const chooseMode = (next: 'new' | 'convert'): void => {
    setMode(next)
    onModeChange?.(next)
  }

  const trimmed = name.trim()
  const ready = dir !== '' && (mode === 'convert' || trimmed !== '')
  // Joined with whichever separator the chosen path already uses, so the
  // preview is the path the main process will build rather than a POSIX
  // rendering of a Windows one.
  const separator = dir.includes('\\') ? '\\' : '/'
  const target =
    mode === 'convert' || dir === ''
      ? dir
      : `${dir.replace(/[\\/]+$/, '')}${separator}${trimmed}`

  return (
    <Overlay
      aria-label={mode === 'new' ? 'Create a harness' : 'Turn a folder into a harness'}
      data-harness-dialog={mode}
      className="max-w-[520px]"
      onDismiss={onCancel}
    >
      <header className="flex shrink-0 items-center gap-[9px] px-[22px] pt-[18px]">
        <HelmMarkIcon width={13} height={13} className="shrink-0 text-accent" />
        <h2 className="text-[15px] font-medium tracking-tight text-fg">
          {mode === 'new' ? 'New harness' : 'Turn a folder into a harness'}
        </h2>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close"
          title="Close"
          className="grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          <CloseIcon width={12} height={12} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-2 pb-1">
        <p className="text-[11px] leading-[1.55] text-fg-muted">
          A harness is a working root with its own config, repos and sessions. Projects and Config
          always resolve inside one.
        </p>

        <div
          role="radiogroup"
          aria-label="What to create"
          className="mt-4 flex gap-1 rounded-well border border-border bg-surface-sunken p-0.5"
        >
          {(['new', 'convert'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={mode === candidate}
              data-harness-mode={candidate}
              onClick={() => chooseMode(candidate)}
              className={cn(
                'flex-1 rounded-[5px] px-2.5 py-1 text-[12px] transition-colors',
                mode === candidate
                  ? SEGMENT_ON
                  : 'text-fg-muted hover:text-fg'
              )}
            >
              {candidate === 'new' ? 'A new folder' : 'A folder I already have'}
            </button>
          ))}
        </div>

        {problems.length > 0 && (
          <ul
            role="alert"
            data-harness-problems
            className="mt-4 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          >
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}

        {mode === 'new' && (
          <label className="mt-4 block">
            <span className={cn(labelClass, 'mb-1.5')}>Name</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              data-harness-name
              aria-label="Harness name"
              placeholder="e.g. client-work"
              className={inputClass}
            />
          </label>
        )}

        <label className="mt-[14px] block">
          <span className={cn(labelClass, 'mb-1.5')}>
            {mode === 'new' ? 'Create it inside' : 'The folder'}
          </span>
          <span className="flex gap-2">
            <input
              readOnly
              value={dir}
              aria-label={mode === 'new' ? 'Parent folder' : 'Folder'}
              data-harness-dir
              placeholder="Choose a folder…"
              className={cn(inputClass, 'min-w-0 flex-1 font-mono text-[11px] text-fg-muted')}
            />
            <button
              type="button"
              data-harness-choose
              onClick={() => onChooseDir()}
              className="h-[30px] shrink-0 rounded-well border border-border-strong px-2.5 text-[12px] text-fg transition-colors hover:bg-hover"
            >
              Choose…
            </button>
            {distros.map((entry) => (
              <button
                key={entry.distro}
                type="button"
                data-harness-choose-distro={entry.distro}
                onClick={() => onChooseDir(entry.home)}
                title={`Open the folder picker in ${entry.home}`}
                className="h-[30px] shrink-0 rounded-well border border-border-strong px-2.5 text-[12px] text-fg transition-colors hover:bg-hover"
              >
                {entry.distro}…
              </button>
            ))}
          </span>
          <span className="mt-[5px] block text-[10px] text-fg-subtle">
            {mode === 'new'
              ? 'The harness is created as a folder of this name inside it.'
              : 'Nothing is moved or renamed.'}
          </span>
        </label>

        {mode === 'new' && templates.length > 0 && (
          <div className="mt-[14px]">
            <span className="mb-1.5 flex items-baseline gap-2">
              <span className={labelClass}>Template</span>
              {onManageTemplates !== undefined && (
                <>
                  <span className="flex-1" />
                  {/* A ghost, not an outlined button: it goes somewhere, where
                      the two controls in the footer do something. Same call the
                      project pane's Config and Content links make. */}
                  <button
                    type="button"
                    data-harness-manage-templates
                    onClick={onManageTemplates}
                    className="text-[11px] text-fg-muted transition-colors hover:text-accent-text"
                  >
                    Manage templates…
                  </button>
                </>
              )}
            </span>
            <div
              role="radiogroup"
              aria-label="Template"
              data-harness-templates
              className="flex flex-col gap-0.5 rounded-well border border-border bg-surface-sunken p-1"
            >
              {templates.map((choice) => {
                const on = choice.id === template
                return (
                  <button
                    key={choice.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    data-harness-template={choice.id}
                    onClick={() => onTemplateChange?.(choice.id)}
                    className={cn(
                      'relative flex w-full items-start gap-2 rounded-[5px] py-1.5 pr-2.5 pl-2.5 text-left transition-colors',
                      on ? ROW_SELECTED : 'hover:bg-hover'
                    )}
                  >
                    {on && (
                      <span
                        aria-hidden
                        className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent"
                      />
                    )}
                    <span
                      aria-hidden
                      className={cn(
                        'mt-[3px] grid size-[11px] shrink-0 place-items-center rounded-full border',
                        on ? 'border-accent' : 'border-fg-subtle'
                      )}
                    >
                      {on && <span className="size-[5px] rounded-full bg-accent" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        data-harness-template-label
                        className="block truncate text-[12px] leading-[15px] text-fg"
                      >
                        {choice.label}
                      </span>
                      {choice.description !== null && (
                        <span className="mt-px block text-[11px] leading-[1.45] text-fg-muted">
                          {choice.description}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
            {templatesDir !== undefined && templatesDir !== '' && (
              <span
                className="mt-[5px] block truncate font-mono text-[10px] text-fg-subtle"
                title={templatesDir}
                data-harness-templates-dir
              >
                {templatesDir}
              </span>
            )}
            {templateProblems.length > 0 && (
              <ul data-harness-template-problems className="mt-1.5 space-y-0.5 text-[10.5px] text-warn">
                {templateProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="mt-4">
          <span className={cn(labelClass, 'mb-1.5')}>What gets written</span>
          <div className="rounded-raised border border-border bg-surface-sunken px-3 py-2.5">
            <p
              className="truncate font-mono text-[11px] text-fg-muted"
              title={target}
              data-harness-target
            >
              {target === '' ? '…' : target}
            </p>
            {/* From `template:preview`, which is the walk that does the writing.
                Before it answers the list is simply absent - a placeholder
                three-line scaffold would be this component describing a layout
                it does not know it is getting. */}
            <ul data-harness-written className="mt-2 space-y-0.5 font-mono text-[11px] text-fg-subtle">
              {(preview?.entries ?? []).map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
            {preview !== null && preview.note !== '' && (
              <p className="mt-2 text-[11px] leading-[1.55] text-fg-subtle">{preview.note}</p>
            )}
            {(preview?.problems ?? []).length > 0 && (
              <ul className="mt-2 space-y-0.5 text-[11px] text-warn">
                {preview?.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <footer className="mx-[22px] flex shrink-0 items-center justify-end gap-2 border-t border-border py-3.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-well border border-border-strong px-3.5 py-1.5 text-[12px] text-fg transition-colors hover:bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          data-harness-create
          disabled={!ready || busy}
          onClick={() =>
            onCreate({ mode, dir, name: trimmed, template: mode === 'new' ? template : 'minimal' })
          }
          className={cn(
            'rounded-well border px-3.5 py-1.5 text-[12px] font-medium transition-colors',
            ready && !busy
              ? 'border-accent text-accent-text hover:bg-accent-soft'
              : 'cursor-default border-border text-fg-subtle opacity-60'
          )}
        >
          {busy ? 'Creating…' : mode === 'new' ? 'Create harness' : 'Convert'}
        </button>
      </footer>
    </Overlay>
  )
}

const inputClass = cn(
  'h-[30px] w-full rounded-well border border-border bg-surface-sunken px-2.5 text-[12.5px]',
  'text-fg placeholder:text-fg-subtle select-text',
  'focus:border-accent focus:outline-none'
)

const labelClass = 'block text-[9.5px] font-semibold tracking-[.08em] text-fg-subtle uppercase'

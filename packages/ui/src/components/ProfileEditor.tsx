import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
// Values, not just types - so this comes from `@helm/core/types`, which is the
// one entry point with no `node:` imports behind it. The package root reaches
// the filesystem through `launch/` and `store/`, and a value import of it from
// the renderer bundle fails at rollup.
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  formatLaunchTarget,
  parseLaunchTarget,
  wslDistroOf,
  type EffectiveEntry,
  type EffectiveMcpServer,
  type EffortLevel,
  type PermissionMode,
  type Profile,
  type ProfileDraft,
  type Project,
  type WslDistro
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { Checkbox } from './Checkbox'
import { CaretIcon, CloseIcon, HelmMarkIcon } from './icons'
import { Overlay } from './Overlay'

/**
 * The half of the effective view the two name pickers need.
 *
 * Both fields used to be free text, and both questions a person asked of them -
 * "is this agent going to resolve", "will this server be available" - already
 * had an answer Helm computes and was not showing. This is that answer, narrowed
 * to the two lists.
 */
export interface ProfilePrediction {
  /** Agents a session at this root, with these overlays, would resolve. */
  agents: EffectiveEntry[]
  /** MCP servers configured for this root, however they got there. */
  mcpServers: EffectiveMcpServer[]
}

export interface ProfileEditorProps {
  /** The profile being edited, or a draft to seed a new one. */
  initial: Profile | ProfileDraft
  /** Discovered projects, for the overlay and access pickers. */
  projects: Project[]
  /**
   * WSL distributions this machine has, for the target picker.
   *
   * Empty - the ordinary case on a machine with no WSL - leaves the picker
   * showing Windows alone rather than hiding it: a control that appears only on
   * some machines is a control nobody learns is there. A distro named by the
   * profile but missing from this list is still offered, because a target is
   * checked at launch and not here; see `validateProfile`.
   */
  distros?: readonly WslDistro[] | undefined
  /**
   * What a session at `root` with `overlays` would resolve.
   *
   * Asked again whenever either changes - both are edited in this form, so the
   * prediction is about the composition being typed rather than the one on
   * disk. The editor owns the debounce and discards answers to questions it has
   * stopped asking.
   */
  predict: (root: string, overlays: string[]) => Promise<ProfilePrediction>
  /** Problems from the last save attempt. */
  problems?: readonly string[] | undefined
  saving?: boolean | undefined
  onSave: (draft: ProfileDraft) => void
  onCancel: () => void
  /** Deleting an existing profile. Absent on a new one, which has nothing to delete. */
  onDelete?: (() => void) | undefined
}

/**
 * The prediction, and the three reasons there might not be one.
 *
 * "Nothing resolves here" and "nobody has asked yet" are different answers and
 * an empty picker says neither, so each state carries its own sentence.
 */
type Prediction =
  | { state: 'no-root' }
  | { state: 'predicting' }
  | { state: 'ready'; value: ProfilePrediction }
  | { state: 'failed'; message: string }

/** One prediction, tagged with the root-and-overlays it is an answer to. */
type Answer = { key: string } & (
  | { ok: true; value: ProfilePrediction }
  | { ok: false; message: string }
)

const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const

/**
 * The profile form.
 *
 * Overlays and access are the two lists that matter and they are presented as
 * one table over the discovered projects, with a checkbox each. They are
 * genuinely different questions - composing a repo's skills is not granting its
 * files - and putting them in two separate pickers would mean picking the same
 * eight repos twice, so they share a row and differ by column.
 *
 * A repo ticked as an overlay is ticked for access too, because composing a
 * project's skills and then denying the session its files produces skills that
 * cannot do anything. Unticking access afterwards is allowed; it is just not
 * the default anyone wants.
 *
 * **Agent and MCP are pickers over the effective view**, and they were both
 * text boxes. The questions a person asked of those boxes - is this agent going
 * to resolve, will this server be available - are exactly what
 * `EffectiveView.agents` and `EffectiveView.mcpServers` answer, and the form was
 * the one place holding that answer back. An overlay's agent settles it: it
 * resolves as `<overlay>:<agent>`, a prefix the shim builder chooses, so it is
 * not a name anybody could have typed correctly by guessing.
 *
 * The two fields still differ in what they *do*, and the form now says so
 * rather than looking alike. `agent` becomes `--agent` on the argv. `mcp` does
 * not reach the argv at all - it is persisted and exported and nothing more -
 * so its picker says that, and points at the console that does configure
 * servers. Making it apply at launch is a separate change to `launch/plan.ts`,
 * not a caption here.
 */
export function ProfileEditor({
  initial,
  projects,
  distros = [],
  predict,
  problems = [],
  saving = false,
  onSave,
  onCancel,
  onDelete
}: ProfileEditorProps): JSX.Element {
  const [name, setName] = useState(initial.name)
  const [root, setRoot] = useState(initial.root)
  const [overlays, setOverlays] = useState<string[]>(initial.overlays)
  const [access, setAccess] = useState<string[]>(initial.access)
  const [model, setModel] = useState(initial.model ?? '')
  const [effort, setEffort] = useState(initial.effort ?? '')
  const [permissionMode, setPermissionMode] = useState(initial.permissionMode ?? '')
  const [agent, setAgent] = useState(initial.agent ?? '')
  const [mcp, setMcp] = useState<string[]>(initial.mcp)
  const [openingPrompt, setOpeningPrompt] = useState(initial.openingPrompt ?? '')
  const [target, setTarget] = useState(formatLaunchTarget(initial.target))
  const [filter, setFilter] = useState('')

  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => nameRef.current?.focus(), [])

  // ---------------------------------------------------------------------
  // What this composition would resolve
  // ---------------------------------------------------------------------
  /**
   * The answer is stored against the question it answers, and the two
   * disagreeing is what "still waiting" *means*.
   *
   * The same shape `useConfig` keeps the config console's effective view in, and
   * for the same reason: a `loading` flag set beside the request is a second
   * copy of a fact the key already carries, and the two come apart the moment a
   * slow answer lands after the root has moved on.
   */
  const [answer, setAnswer] = useState<Answer | null>(null)
  const question = `${root.trim()} ${JSON.stringify(overlays)}`

  useEffect(() => {
    const trimmed = root.trim()
    if (trimmed === '') return
    let live = true
    // Debounced: the root is a path somebody types one character at a time, and
    // each answer walks three `.claude` trees plus every overlay's.
    const timer = setTimeout(() => {
      predict(trimmed, overlays)
        .then((value) => {
          if (live) setAnswer({ key: question, ok: true, value })
        })
        .catch((error: unknown) => {
          if (live) {
            setAnswer({
              key: question,
              ok: false,
              message: error instanceof Error ? error.message : String(error)
            })
          }
        })
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [root, overlays, question, predict])

  const prediction = useMemo<Prediction>(() => {
    if (root.trim() === '') return { state: 'no-root' }
    if (answer === null || answer.key !== question) return { state: 'predicting' }
    return answer.ok
      ? { state: 'ready', value: answer.value }
      : { state: 'failed', message: answer.message }
  }, [root, question, answer])

  const predictedAgents = prediction.state === 'ready' ? prediction.value.agents : []

  /**
   * One row per server name, since the picker saves names.
   *
   * Two scopes may define the same name and the effective view reports both -
   * which is the right answer to "what is configured" and the wrong shape for a
   * checkbox, so the row kept is the one that is not shadowed.
   */
  const predictedServers = useMemo(() => {
    const winners = new Map<string, EffectiveMcpServer>()
    for (const server of prediction.state === 'ready' ? prediction.value.mcpServers : []) {
      if (server.shadowedBy === null || !winners.has(server.name)) winners.set(server.name, server)
    }
    return [...winners.values()]
  }, [prediction])

  // A saved name the prediction does not carry. Kept selectable rather than
  // dropped: a profile may legitimately be written before the overlay that
  // supplies the agent, or the server, exists.
  const agentUnlisted = agent !== '' && !predictedAgents.some((e) => e.invocation === agent)
  const serversUnlisted = mcp.filter((server) => !predictedServers.some((s) => s.name === server))
  // Only once an answer is in is "not in the list" the same thing as "does not
  // resolve" - before that it is just a list nobody has filled in yet.
  const settled = prediction.state === 'ready'
  const agentNote = predictionNote(prediction, 'agents')
  const serverNote = predictionNote(prediction, 'servers')

  const has = (list: string[], path: string): boolean =>
    list.some((entry) => entry.toLowerCase() === path.toLowerCase())

  const toggleOverlay = (path: string): void => {
    if (has(overlays, path)) {
      setOverlays((current) => current.filter((entry) => entry.toLowerCase() !== path.toLowerCase()))
      return
    }
    setOverlays((current) => [...current, path])
    setAccess((current) => (has(current, path) ? current : [...current, path]))
  }

  const toggleAccess = (path: string): void => {
    setAccess((current) =>
      has(current, path)
        ? current.filter((entry) => entry.toLowerCase() !== path.toLowerCase())
        : [...current, path]
    )
  }

  // Exactly, not case-insensitively like the paths above: a server name is a
  // JSON key in `.mcp.json`, and the CLI addresses it as written.
  const toggleServer = (server: string): void => {
    setMcp((current) =>
      current.includes(server)
        ? current.filter((entry) => entry !== server)
        : [...current, server]
    )
  }

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const matching =
      needle === ''
        ? projects
        : projects.filter(
            (project) =>
              project.name.toLowerCase().includes(needle) ||
              project.path.toLowerCase().includes(needle)
          )
    // Anything already chosen stays on screen regardless of the filter, so a
    // narrowed list cannot hide a selection the user is about to save.
    const chosen = projects.filter(
      (project) =>
        (has(overlays, project.path) || has(access, project.path)) &&
        !matching.some((m) => m.path === project.path)
    )
    return [...chosen, ...matching]
  }, [projects, filter, overlays, access])

  /**
   * The distros to offer, plus the one this profile already names.
   *
   * A saved target whose distro is not installed here stays in the list rather
   * than silently reverting to Windows - a profile opened on a second machine
   * would otherwise be re-pointed by the act of looking at it, and the user
   * would have no way to tell it had happened. Existence is the launch's
   * question, and the launch has somewhere to put the sentence.
   */
  /**
   * The distro the root lives inside, when it lives inside one.
   *
   * Not a suggestion. A Windows process cannot be spawned with a UNC working
   * directory - `CreateProcess` answers ENOENT, measured - so a project under
   * `\\wsl$\Ubuntu\...` on the Windows target is not a degraded session but a
   * session that will not start. `prepareLaunch` therefore derives the target
   * from the path and overrides the profile, and this is the same call, so the
   * form shows what the launch will do rather than a choice it would discard.
   *
   * A root on a Windows drive stays a free choice, and deliberately: running a
   * `C:\` project inside a distro works - the junctions resolve, `/mnt/c` is
   * there - and is a thing somebody may want.
   */
  const resident = useMemo(() => wslDistroOf(root.trim()), [root])

  /**
   * What the form is actually going to save.
   *
   * Derived rather than synchronised into `target` by an effect: the path is
   * the authority whenever it is resident, so there is no second state to keep
   * level with it - and the chosen value is *remembered* underneath, so editing
   * a root from a distro path back to a Windows one restores what the user had
   * picked instead of silently leaving them in a distro they no longer name.
   */
  const effectiveTarget =
    resident === null ? target : formatLaunchTarget({ kind: 'wsl', distro: resident })

  const targetOptions = useMemo(() => {
    const options = distros.map((distro) => ({
      value: formatLaunchTarget({ kind: 'wsl', distro: distro.name }),
      label: distro.name
    }))
    if (effectiveTarget !== 'windows' && !options.some((option) => option.value === effectiveTarget)) {
      const named = parseLaunchTarget(effectiveTarget)
      if (named !== null && named.kind === 'wsl') {
        options.push({ value: effectiveTarget, label: `${named.distro} - not installed here` })
      }
    }
    return options
  }, [distros, effectiveTarget])

  const submit = (): void => {
    onSave({
      name: name.trim(),
      root: root.trim(),
      overlays,
      access,
      model: model.trim() || null,
      effort: (effort as EffortLevel) || null,
      permissionMode: (permissionMode as PermissionMode) || null,
      agent: agent.trim() || null,
      mcp,
      openingPrompt: openingPrompt.trim() || null,
      pinnedOrder: 'pinnedOrder' in initial ? initial.pinnedOrder : null,
      target: parseLaunchTarget(effectiveTarget)
    })
  }

  return (
    // This is mounted inside the pane, and `Overlay`'s scrim is `fixed` rather
    // than `absolute` for its sake: an absolute backdrop would dim the pane
    // while leaving the sidebar lit and clickable, which is not what
    // `aria-modal` promises.
    <Overlay
      aria-label={'id' in initial ? `Edit ${initial.name}` : 'New profile'}
      className="max-w-[620px]"
      onDismiss={onCancel}
    >
      <header className="flex shrink-0 items-center gap-[9px] px-[22px] pt-[18px]">
        <HelmMarkIcon width={13} height={13} className="shrink-0 text-accent" />
        <h2 className="text-[15px] font-medium tracking-tight text-fg">
          {'id' in initial ? 'Edit profile' : 'New profile'}
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

      <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-4 pb-1">
        {problems.length > 0 && (
          <ul
            role="alert"
            className="mb-4 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          >
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}

        <div className="grid gap-[14px] sm:grid-cols-2">
          <Field label="Name" hint="Shown in the launcher and used as the session name.">
            <input
              ref={nameRef}
              aria-label="Profile name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              className={inputClass}
            />
          </Field>
          <Field label="Root" hint="The working directory. Config resolves from here.">
            <input
              value={root}
              aria-label="Root directory"
              onChange={(e) => setRoot(e.target.value)}
              spellCheck={false}
              className={cn(inputClass, 'font-mono text-[11px] text-fg-muted')}
            />
          </Field>
        </div>

        {/* `min-w-0` is not decoration. A `<fieldset>` carries a UA
            `min-inline-size: min-content`, so it refuses to shrink below its
            widest content and pushes a horizontal scrollbar onto the dialog
            body instead - measured at 471px against a 408px body, which cut
            the Compose and Access columns off the right edge of this table
            at 1280x820. Both fieldsets here take it. */}
        <fieldset className="mt-4 min-w-0">
          <legend className={labelClass}>Composition</legend>
          <p className="mt-1.5 mb-2 text-[11px] leading-[1.55] text-fg-muted">
            <strong className="font-medium text-fg">Compose</strong> loads a project&rsquo;s
            skills, agents and commands under its own namespace.{' '}
            <strong className="font-medium text-fg">Access</strong> lets the session read and
            write its files.
          </p>

          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter projects"
            spellCheck={false}
            aria-label="Filter projects"
            className={cn(inputClass, 'h-[26px] text-[11.5px]')}
          />

          <div className="mt-2 overflow-hidden rounded-raised border border-border">
            <div className="flex items-center bg-surface-raised px-3 py-1.5">
              <span className={cn(labelClass, 'flex-1 text-[9px]')}>Project</span>
              <span className={cn(labelClass, 'w-[70px] text-center text-[9px]')}>Compose</span>
              <span className={cn(labelClass, 'w-[70px] text-center text-[9px]')}>Access</span>
            </div>
            <div className="max-h-56 overflow-y-auto">
              {visible.length === 0 ? (
                <p className="border-t border-border px-3 py-6 text-center text-[12px] text-fg-subtle">
                  No projects match.
                </p>
              ) : (
                visible.map((project) => (
                  <div
                    key={project.path}
                    className="flex items-center border-t border-border px-3 py-[7px] transition-colors hover:bg-hover"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-[7px]">
                        <span className="min-w-0 truncate text-[12px] text-fg">
                          {project.name}
                        </span>
                        {project.kind === 'harness' && (
                          <span className="shrink-0 rounded-full bg-accent-soft px-[7px] py-px text-[8.5px] tracking-[.05em] text-accent-text uppercase">
                            harness root
                          </span>
                        )}
                      </span>
                      <span className="block truncate font-mono text-[9.5px] text-fg-subtle">
                        {project.path}
                      </span>
                    </span>
                    <span className="flex w-[70px] justify-center">
                      <Checkbox
                        checked={has(overlays, project.path)}
                        onChange={() => toggleOverlay(project.path)}
                        label={`Compose ${project.name}`}
                      />
                    </span>
                    <span className="flex w-[70px] justify-center">
                      <Checkbox
                        checked={has(access, project.path)}
                        onChange={() => toggleAccess(project.path)}
                        label={`Grant access to ${project.name}`}
                      />
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </fieldset>

        <div className="mt-4 grid gap-[14px] sm:grid-cols-2">
          <Field label="Model">
            <Select value={model} onChange={setModel} label="Model">
              <option value="">Default</option>
              {MODELS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Effort">
            <Select value={effort} onChange={setEffort} label="Effort">
              <option value="">Default</option>
              {EFFORT_LEVELS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Permission mode">
            <Select value={permissionMode} onChange={setPermissionMode} label="Permission mode">
              <option value="">Default</option>
              {PERMISSION_MODES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Runs on"
            hint={
              resident !== null
                ? `The root is inside ${resident}, so the session runs there.`
                : effectiveTarget === 'windows'
                  ? 'The claude on this machine.'
                  : "That distribution's own claude, and its own ~/.claude."
            }
          >
            <Select
              value={effectiveTarget}
              onChange={setTarget}
              label="Runs on"
              disabled={resident !== null}
            >
              <option value="windows">Windows</option>
              {targetOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Agent"
            hint={
              <>
                Placed on the session&rsquo;s argv as <code className={codeClass}>--agent</code>,
                so it starts as that subagent.
                {agentNote !== null && (
                  <span className={cn('mt-[3px] block', agentNote.tone)}>{agentNote.text}</span>
                )}
                {settled && agentUnlisted && (
                  <span data-agent-unresolved={agent} className="mt-[3px] block text-warn">
                    Nothing at this root resolves <span className="font-mono">{agent}</span>. It
                    is still saved.
                  </span>
                )}
                {/* Not alongside the warning above, which already says the
                    list has nothing for this name in it. */}
                {settled && !agentUnlisted && predictedAgents.length === 0 && (
                  <span className="mt-[3px] block">
                    No agents resolve here - neither this root nor the composed projects define
                    one.
                  </span>
                )}
              </>
            }
          >
            <Select value={agent} onChange={setAgent} label="Agent">
              <option value="">Default</option>
              {/* A saved name the prediction does not carry still has to be
                  the select's value, or the control would silently move the
                  profile off it the moment anybody opened the form. */}
              {agentUnlisted && (
                <option value={agent}>{settled ? `${agent} - unresolved` : agent}</option>
              )}
              {predictedAgents.map((entry) => (
                <option key={entry.invocation} value={entry.invocation}>
                  {entry.invocation}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="mt-[14px]">
          <Field label="Opening prompt" hint="Submitted as the first message, e.g. /recap.">
            <input
              value={openingPrompt}
              aria-label="Opening prompt"
              onChange={(e) => setOpeningPrompt(e.target.value)}
              spellCheck={false}
              placeholder="e.g. /recap"
              className={inputClass}
            />
          </Field>
        </div>

        {/* ----------------------------------------------------------------
            MCP servers.

            A picker over what is configured, and a sentence saying the pick
            does not reach the session - because it does not. `Profile.mcp` is
            persisted and exported and never placed on the argv: no CLI flag
            selects an already-configured server by name, and resolving names
            into a `--mcp-config` document is the config console's job (SPEC
            4.2). This field was a comma-separated text box that said none of
            that, so the honest thing to show was a list of names that would
            not be used - not a box implying they would.
            ---------------------------------------------------------------- */}
        <fieldset className="mt-4 min-w-0">
          <legend className={labelClass}>MCP servers</legend>
          <p className="mt-1.5 mb-2 text-[11px] leading-[1.55] text-fg-muted">
            Saved with the profile and carried by its YAML export.{' '}
            <strong className="font-medium text-fg">Not applied at launch</strong> - a session
            loads whatever is configured for its root, which is the config console&rsquo;s MCP
            view, not this list.
          </p>

          <div className="overflow-hidden rounded-raised border border-border">
            {serversUnlisted.length + predictedServers.length === 0 ? (
              <p
                data-mcp-empty
                className="px-3 py-5 text-center text-[11.5px] text-fg-subtle"
              >
                {settled
                  ? 'No MCP servers are configured for this root.'
                  : (serverNote?.text ?? '')}
              </p>
            ) : (
              <div className="max-h-40 overflow-y-auto">
                {serversUnlisted.map((server) => (
                  <ServerRow
                    key={server}
                    name={server}
                    checked
                    onToggle={() => toggleServer(server)}
                  >
                    {settled && (
                      <span
                        data-mcp-unresolved={server}
                        className="shrink-0 rounded-sm border border-warn/40 px-1 text-[8.5px] tracking-[.05em] text-warn uppercase"
                      >
                        unresolved
                      </span>
                    )}
                  </ServerRow>
                ))}
                {predictedServers.map((server) => (
                  <ServerRow
                    key={`${server.scope}:${server.name}`}
                    name={server.name}
                    checked={mcp.includes(server.name)}
                    onToggle={() => toggleServer(server.name)}
                  >
                    <span className="shrink-0 rounded-full bg-accent-soft px-[7px] py-px text-[8.5px] tracking-[.05em] text-accent-text uppercase">
                      {server.scope}
                    </span>
                  </ServerRow>
                ))}
              </div>
            )}
          </div>
          {/* Only where the box has rows in it - the empty box carries the
              same sentence itself, and two of them is one too many. */}
          {serverNote !== null && serversUnlisted.length + predictedServers.length > 0 && (
            <p className={cn('mt-[5px] text-[10px]', serverNote.tone)}>{serverNote.text}</p>
          )}
        </fieldset>
      </div>

      <footer className="mx-[22px] flex shrink-0 items-center gap-2 border-t border-border py-3.5">
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="rounded-well border border-border-strong px-3 py-1.5 text-[12px] text-warn transition-colors hover:bg-hover"
          >
            Delete profile
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="rounded-well border border-border-strong px-3.5 py-1.5 text-[12px] text-fg transition-colors hover:bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className={cn(
            'rounded-well border border-accent px-3.5 py-1.5 text-[12px] font-medium text-accent-text transition-colors',
            saving ? 'cursor-default opacity-60' : 'hover:bg-accent-soft active:bg-active'
          )}
        >
          {saving ? 'Saving…' : 'id' in initial ? 'Save changes' : 'Save profile'}
        </button>
      </footer>
    </Overlay>
  )
}

const inputClass = cn(
  'h-[30px] w-full rounded-well border border-border bg-surface-sunken px-2.5 text-[12.5px]',
  'text-fg placeholder:text-fg-subtle select-text',
  'transition-colors hover:border-border-strong focus:border-accent focus:outline-none'
)

const labelClass =
  'block text-[9.5px] font-semibold tracking-[.08em] text-fg-subtle uppercase'

/** A flag quoted inside a hint. Mono, because it is machine data (DESIGN.md 2). */
const codeClass = 'rounded-sm bg-surface-sunken px-1 py-px font-mono text-[9.5px] text-fg-muted'

/**
 * Why a picker is empty, when the reason is not "nothing resolves here".
 *
 * Returns null once an answer is in, at which point an empty list means what it
 * looks like. Until then it does not: "nothing is configured" and "nobody has
 * asked yet" are different facts and a blank list states neither.
 */
function predictionNote(
  prediction: Prediction,
  plural: string
): { text: string; tone: string } | null {
  switch (prediction.state) {
    case 'no-root':
      return { text: `Set a root to see which ${plural} resolve here.`, tone: 'text-fg-subtle' }
    case 'predicting':
      return { text: 'Resolving what this root and its overlays offer…', tone: 'text-fg-subtle' }
    case 'failed':
      return { text: `This root could not be resolved: ${prediction.message}`, tone: 'text-warn' }
    case 'ready':
      return null
  }
}

/** One MCP server, ticked or not, with whatever badge the caller gives it. */
function ServerRow({
  name,
  checked,
  onToggle,
  children
}: {
  name: string
  checked: boolean
  onToggle: () => void
  children?: ReactNode | undefined
}): JSX.Element {
  // A label, so the whole row is the hit target. The pointer cursor comes from
  // `theme.css`'s `label:has(input[type=checkbox])`, not from here.
  return (
    <label className="flex items-center gap-[9px] border-b border-border px-3 py-[7px] transition-colors last:border-b-0 hover:bg-hover">
      <Checkbox checked={checked} onChange={onToggle} label={`MCP server ${name}`} />
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg">{name}</span>
      {children}
    </label>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  /** A node rather than a string: the two pickers say what state they are in
   * here, and that sentence is tinted when it is a failure. */
  hint?: ReactNode | undefined
  children: ReactNode
}): JSX.Element {
  return (
    <label className="block">
      <span className={cn(labelClass, 'mb-1.5')}>{label}</span>
      {children}
      {hint !== undefined && (
        <span className="mt-[5px] block text-[10px] text-fg-subtle">{hint}</span>
      )}
    </label>
  )
}

/**
 * A native `<select>` in the sunken-well shape, with the platform arrow
 * replaced by the system's own caret. Native and not a listbox of our own: the
 * drivers set it through `HTMLSelectElement.prototype.value`, and a div cannot
 * be set that way.
 */
function Select({
  value,
  onChange,
  label,
  disabled = false,
  children
}: {
  value: string
  onChange: (value: string) => void
  label: string
  /** For a field whose value is derived rather than chosen - see "Runs on". */
  disabled?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <span className="relative block">
      <select
        value={value}
        aria-label={label}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          inputClass,
          'appearance-none pr-7',
          disabled && 'cursor-not-allowed opacity-60'
        )}
      >
        {children}
      </select>
      <CaretIcon
        width={9}
        height={9}
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rotate-90 text-fg-subtle"
      />
    </span>
  )
}

/**
 * The one control the system allows a solid accent fill (DESIGN.md §4).
 *
 * A real `<input type="checkbox">` under an overlaid tick rather than a styled
 * button: it keeps the label association, the space key, and `el.checked` -
 * which is what profiles-check reads to prove composing a repo also granted it
 * access.
 */

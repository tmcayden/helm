import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import {
  offerableUsageModes,
  CONTENT_WRAP_INDENT,
  COST_MODE_UNAVAILABLE,
  DEFAULT_PR_REVIEW_PROMPT,
  EFFORT_LEVELS,
  PR_POLL_MINUTES,
  PR_PROMPT_PLACEHOLDERS,
  PR_REVIEW_PROMPT_MAX_LENGTH,
  PR_STALE_DAYS,
  PROJECT_SHELL_HEIGHT_PCT,
  SESSION_SPLIT_PCT,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_SIZE,
  TERMINAL_SCROLLBACK,
  USAGE_DISPLAY_MODES,
  type AppSettings,
  type ArchiveStats,
  type BrowserReach,
  type DetectedShell,
  withRepoIgnored,
  type EffortLevel,
  type GhStatus,
  type IgnoredRepo,
  type PrCheckoutMode,
  type PullRepo,
  type TerminalCursorStyle,
  type ThemePreference,
  type UsageDisplayMode,
  type WslDistro,
  type WslNetworkingMode,
  type WslNetworkingState,
  type WslProbe
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { SEGMENT_ON } from '../lib/segmented'
import { formatAge, formatBytes } from '../lib/time'
import { Checkbox } from './Checkbox'
import { CaretIcon, CheckIcon, CloseIcon, RefreshIcon, WarnIcon } from './icons'
import type { SetupClaudeStatus } from './SetupPane'
import { ThemeToggle } from './ThemeToggle'
import { WslShutdownDialog } from './WslShutdownDialog'

/**
 * Helm's own settings.
 *
 * Deliberately not the config console: that pane edits the `.claude` trees
 * Claude Code reads, which belong to Claude and are shared with every other
 * client on the machine. This one is the app's own configuration, and it is the
 * permanent home for it - every setting a later feature adds lands here as
 * another row in an existing group or another group at the end.
 *
 * One scrolling page of grouped cards rather than sub-views. Six groups and
 * two dozen controls; a segmented navigator over that many rows is furniture
 * standing in for content. When a group outgrows the page, it earns its own
 * view then.
 *
 * The Terminal group is the appearance of the panes, not the terminal's own
 * ground: the xterm palette is fixed in both themes and pixel-asserted by the
 * fidelity checks (DESIGN.md par. 6), so colour is deliberately not a row here.
 *
 * Two things on screen elsewhere write the same settings this pane does - the
 * title bar's theme toggle and the status bar's usage segment - and both stay.
 * A quick accessor beside the thing it changes is worth having; what was
 * missing was somewhere to find the setting when you are not already looking at
 * it. Both write through `settings:write` and this pane renders whatever
 * `settings:changed` carries back, so the two cannot disagree.
 *
 * Internal state is not shown. `windowBounds` and `firstRunCompletedAt` live in
 * the same table but they are things Helm remembers, not things anyone chose.
 */

export interface SettingsPaneProps {
  /** What Helm found out about the CLI. Null until the first read lands. */
  status: SetupClaudeStatus | null
  /** A status read the user asked for, so it gets a spinner. */
  checking: boolean
  onRecheck: () => void
  onLocateClaude: () => void
  /** Writes `claudePath: null` - back to whatever discovery finds. */
  onClearClaudeOverride: () => void

  roots: string[]
  /** What the current roots turned up, so "it worked" is visible here. */
  projectCount: number
  scanning: boolean
  onAddRoot: () => void
  onRemoveRoot: (path: string) => void
  /**
   * Folders Helm found that are not roots yet, and accepting one.
   *
   * The same list first run offers, surfaced where somebody past first run can
   * still act on it - which is the whole point: a distribution installed later,
   * or a harness made inside one, becomes suggestible long after the only pane
   * that showed suggestions has gone for good.
   */
  suggestedRoots?: readonly string[] | undefined
  onAcceptRoot?: ((path: string) => void) | undefined

  /**
   * `pinnedProjects`, as stored: absolute paths, in the order the setting holds
   * them rather than the order the sidebar shows them.
   *
   * Pins are *made* on the sidebar's own rows, where the project is, and this
   * pane is where the whole set is legible at once - including a path whose
   * folder has gone, which is the one a person comes here to clear. Paths and
   * not names, deliberately: the setting is a list of paths and it is a list of
   * paths that a re-clone invalidates, so the pane shows the value rather than
   * a friendlier rendering of it.
   */
  pinnedProjects: string[]
  onUnpinProject: (path: string) => void

  theme: ThemePreference
  onThemeChange: (theme: ThemePreference) => void

  usageDisplay: UsageDisplayMode
  updateCheck: boolean
  onUpdateCheckChange: (next: boolean) => void
  onUsageDisplayChange: (mode: UsageDisplayMode) => void

  /** This build's version, from `app:info`. Null until that read lands. */
  appVersion: string | null
  /**
   * The releases page, from `app:info` rather than from a check's result.
   *
   * The link has to be reachable in exactly the states no check produces - up
   * to date, offline, the setting off - so it cannot come from `update`.
   */
  releasesUrl: string | null
  /**
   * The last check attempted, complete or not. Null means nobody has asked
   * since launch, which is its own sentence and not an error.
   */
  update: UpdateCheckResult | null
  updateChecking: boolean
  onCheckForUpdate: () => void
  onOpenReleases: () => void
  /**
   * Whether the transcript index has an estimate yet. `cost` is offered only
   * when it has - the same rule the status bar's cycle follows, from the same
   * function, because a mode that would paint nothing is a broken setting.
   */
  hasCostEstimate: boolean

  terminal: TerminalSettings
  onTerminalChange: (patch: Partial<TerminalSettings>) => void
  /**
   * The font stack the terminals are actually running, so the preview is the
   * real thing rather than this pane's re-derivation of the prepend rule.
   */
  terminalFontStack: string
  /** Shells found on this machine. Empty until the probe lands. */
  shells: DetectedShell[]
  /** Native file picker, for a shell installed somewhere `where.exe` misses. */
  onLocateShell: () => void

  /**
   * What the transcript archive holds. Null until the first read lands.
   *
   * Passed in rather than derived from the settings, because the interesting
   * half of this group is not the ceiling - it is how much is actually stored
   * against it, which only the main process knows.
   */
  archiveStats: ArchiveStats | null
  transcriptArchiveMaxBytes: number
  onTranscriptArchiveMaxBytesChange: (bytes: number) => void

  /**
   * Harness templates: how many there are, where they live, and the way in to
   * managing them.
   *
   * A group here as well as a link in the New Harness dialog, because
   * templates are **app-level**: they belong to this Helm rather than to any
   * one harness, and having to start creating a harness in order to rename or
   * delete one would be the same mistake as putting "stop scanning this
   * folder" only in Settings - which is a bug this pane has already been on the
   * wrong end of once.
   */
  templateCount: number
  templatesDir: string
  onManageTemplates: () => void
  /** Opens the templates folder itself, for the editing this app does not do. */
  onRevealTemplates: () => void

  /** The content viewer's wrapping default, and the hang on a continuation. */
  contentWrap: boolean
  onContentWrapChange: (wrap: boolean) => void
  contentWrapIndent: number
  onContentWrapIndentChange: (columns: number) => void

  /**
   * How far the browser pane may reach.
   *
   * The one browser key that is a preference. The two beside it in the
   * database - the recent addresses and the per-project ones - are state, so
   * they sit with `workspaceTabs` and are deliberately not on this pane.
   */
  browserReach: BrowserReach
  onBrowserReachChange: (reach: BrowserReach) => void
  /**
   * The two browser-tool keys: whether Helm serves its browser tools to the
   * sessions it hosts, and whether those tools are held to this machine when
   * the pane is not. Both are preferences rather than state, so both are here.
   */
  browserMcp: boolean
  onBrowserMcpChange: (next: boolean) => void
  browserMcpLocalOnly: boolean
  onBrowserMcpLocalOnlyChange: (next: boolean) => void

  /**
   * Whether a session may ask Helm what the other sessions are doing.
   *
   * Its own row in its own group rather than a third tick under Browser: it is
   * served by the same endpoint but it is not the same capability, and a person
   * deciding about it is deciding about their other work rather than about a
   * browser.
   */
  sessionMcp: boolean
  onSessionMcpChange: (next: boolean) => void

  /**
   * WSL: what `%USERPROFILE%\.wslconfig` says, and what the distros answer.
   *
   * One object rather than eight props, the same shape `terminal` takes: these
   * are all readings of one machine-wide fact, and a caller that could pass
   * half of them is a caller that can show a mode with no file behind it.
   */
  wsl: WslSettingsState
  /** Writes `networkingMode` under `[wsl2]`. Never restarts WSL. */
  onWslNetworkingModeChange: (mode: WslNetworkingMode) => void
  /** Asks one distro whether it can reach the endpoint, starting it if need be. */
  onWslProbe: (distro: string) => void
  /**
   * `wsl --shutdown`. Called only after this pane's own confirmation, which is
   * why the prop is not named `onRestartWsl`: the button the user sees opens a
   * dialog, and only its accepting half reaches here.
   */
  onWslShutdown: () => void

  /**
   * What Helm found out about `gh`, out of the pull-request snapshot. Null
   * until the first pass has resolved it.
   */
  gh: GhStatus | null
  /** Native file picker, the same shape the Claude CLI row uses. */
  onLocateGh: () => void
  /** Writes `ghPath: null` - back to whatever discovery finds. */
  onClearGhOverride: () => void
  prPollMinutes: number
  onPrPollMinutesChange: (minutes: number) => void
  /**
   * Where the Pulls pane draws the line between ACTIVE and STALE, in days.
   * `0` is off - that pane goes back to one flat Open list.
   *
   * A row here rather than a control on the pane itself for the reason the
   * poll interval is here: settings for Helm live in one place, and the pane's
   * own controls - its filter and its grouping - are deliberately *not*
   * settings, so a strip inside it would mix the two kinds of state on one
   * line.
   */
  prStaleDays: number
  onPrStaleDaysChange: (days: number) => void
  /**
   * Every github.com repository Helm knows of and whether each is ignored, out
   * of the same snapshot the Pulls pane paints.
   *
   * Derived from the snapshot rather than from `prIgnoredRepos` alone, because
   * a list of slugs is not a list of choices: the repositories that can be
   * ignored are the ones discovery actually found, and they only exist in the
   * snapshot.
   */
  prRepos: PrRepoChoice[]
  /** Takes the whole list, because that is how the setting is written. */
  onPrIgnoredReposChange: (slugs: string[]) => void
  /** The template a "Review with Claude" launch composes its prompt from. */
  prReviewPrompt: string
  onPrReviewPromptChange: (template: string) => void
  prCheckout: PrCheckoutMode
  onPrCheckoutChange: (mode: PrCheckoutMode) => void
  /** Null for either of these is "pass no flag", not a model called null. */
  prReviewModel: string | null
  onPrReviewModelChange: (model: string | null) => void
  prReviewEffort: EffortLevel | null
  onPrReviewEffortChange: (effort: EffortLevel | null) => void
}

/**
 * The outcome of a check, as this package needs it.
 *
 * Structural rather than the desktop package's `UpdateCheck`, for the reason
 * `StatusBarProps.update` gives: the IPC contract belongs to the host. Unlike
 * the bar's version this keeps `error` and `checkedAt`, because the pane's job
 * is to say what happened - including that nothing did.
 */
export interface UpdateCheckResult {
  current: string
  latest: string | null
  newer: boolean
  error: string | null
  checkedAt: string
}

/**
 * Everything the WSL group paints, in one object.
 *
 * The two halves are held separately on purpose, and that is the whole design
 * of this group: `networking` is what a file on this machine *says*, and
 * `probes` is whether a distribution can *actually* open a socket to Helm's
 * endpoint right now. A `.wslconfig` reading `mirrored` while WSL has not
 * restarted yet is exactly the state a user needs to see, so nothing here
 * merges them into one verdict - the same rule the usage figures and the config
 * console's live state follow, one surface further out.
 */
export interface WslSettingsState {
  /** The file's reading. Null until the first read lands. */
  networking: WslNetworkingState | null
  /** The distributions on this machine, from the cheap listing. */
  distros: readonly WslDistro[]
  /**
   * Probe answers by distro name, for the ones somebody has asked about.
   *
   * Keyed rather than a single "last probe", because the answer belongs to the
   * distro it was asked of - and a user checking a second distro must not see
   * the first one's answer relabelled.
   */
  probes: Readonly<Record<string, WslProbe>>
  /** The distro being asked about, if any. Its answer is ~200ms-2s away. */
  probing: string | null
  /** A write is in flight, so the buttons are held. */
  busy: boolean
  /**
   * What the last write did, as a sentence - including where the copy of the
   * previous file went. Null before anything has been written.
   */
  notice: string | null
  /** Why the last attempt did nothing. Null when the last one worked. */
  error: string | null
}

/** One tickable repository in the GitHub group's list. */
export interface PrRepoChoice {
  /** `owner/name`. The identity, and what the setting stores. */
  slug: string
  /** A folder name to read it by, since a slug is not what anybody calls it. */
  name: string
  ignored: boolean
  /** Whether a scanned project maps to it. False ones are still removable. */
  present: boolean
}

/**
 * The snapshot's two repository lists, merged into one set of choices.
 *
 * Deduplicated **by slug**, because that is the granularity of the setting: two
 * checkouts of one repository are two rows in the Pulls pane and one tick here,
 * and offering two ticks for one value would let a user untick a box and watch
 * the other one stay ticked.
 *
 * `snapshot.ignored` carries entries no project maps to - a repository that has
 * been deleted or moved since it was ignored - and they are kept rather than
 * filtered, because an entry that vanished from this list would be a repository
 * ignored for ever with no way left to say otherwise.
 */
export function pullRepoChoices(
  repos: readonly PullRepo[],
  ignored: readonly IgnoredRepo[]
): PrRepoChoice[] {
  const choices = new Map<string, PrRepoChoice>()
  for (const repo of repos) {
    if (repo.slug === null) continue
    const key = repo.slug.toLowerCase()
    if (choices.has(key)) continue
    choices.set(key, { slug: repo.slug, name: repo.name, ignored: false, present: true })
  }
  for (const repo of ignored) {
    choices.set(repo.slug.toLowerCase(), {
      slug: repo.slug,
      name: repo.name,
      ignored: true,
      present: repo.present
    })
  }
  return [...choices.values()].sort((a, b) =>
    a.slug.toLowerCase().localeCompare(b.slug.toLowerCase())
  )
}

/**
 * The seven the Terminal group owns, named once so nothing has to list them
 * twice.
 *
 * `projectShellHeightPct` is the odd one: it is not a terminal preference and
 * never reaches `applyPrefs`, it is how tall a project page's shell is. It is
 * shown here because this is the group somebody looks in for the shell under a
 * project - the shell picker is already here - and a settings pane organised by
 * where a person would look for a thing beats one organised by which module
 * consumes it.
 *
 * `sessionSplitPct` is the second of those, and lands here by the same rule
 * rather than by being any more of a terminal preference than the first. The
 * two are one question asked about two axes - how much terminal do I want, and
 * where - and somebody who has come to change one has come to look at both.
 */
export type TerminalSettings = Pick<
  AppSettings,
  | 'terminalFontFamily'
  | 'terminalFontSize'
  | 'terminalCursorStyle'
  | 'terminalCursorBlink'
  | 'terminalScrollback'
  | 'terminalShell'
  | 'projectShellHeightPct'
  | 'sessionSplitPct'
>

/** What a fact reads when there is nothing to put in it. */
const NOTHING = '-'

const USAGE_LABEL: Record<UsageDisplayMode, string> = {
  percent: 'Percent',
  cost: 'Cost',
  off: 'Off'
}

export function SettingsPane({
  status,
  checking,
  onRecheck,
  onLocateClaude,
  onClearClaudeOverride,
  roots,
  projectCount,
  scanning,
  onAddRoot,
  onRemoveRoot,
  suggestedRoots = [],
  onAcceptRoot = () => undefined,
  pinnedProjects,
  onUnpinProject,
  theme,
  onThemeChange,
  usageDisplay,
  updateCheck,
  onUpdateCheckChange,
  onUsageDisplayChange,
  hasCostEstimate,
  appVersion,
  releasesUrl,
  update,
  updateChecking,
  onCheckForUpdate,
  onOpenReleases,
  terminal,
  onTerminalChange,
  terminalFontStack,
  shells,
  onLocateShell,
  archiveStats,
  transcriptArchiveMaxBytes,
  onTranscriptArchiveMaxBytesChange,
  templateCount,
  templatesDir,
  onManageTemplates,
  onRevealTemplates,
  contentWrap,
  onContentWrapChange,
  contentWrapIndent,
  onContentWrapIndentChange,
  browserReach,
  onBrowserReachChange,
  browserMcp,
  onBrowserMcpChange,
  browserMcpLocalOnly,
  onBrowserMcpLocalOnlyChange,
  sessionMcp,
  onSessionMcpChange,
  wsl,
  onWslNetworkingModeChange,
  onWslProbe,
  onWslShutdown,
  gh,
  onLocateGh,
  onClearGhOverride,
  prPollMinutes,
  onPrPollMinutesChange,
  prStaleDays,
  onPrStaleDaysChange,
  prRepos,
  onPrIgnoredReposChange,
  prReviewPrompt,
  onPrReviewPromptChange,
  prCheckout,
  onPrCheckoutChange,
  prReviewModel,
  onPrReviewModelChange,
  prReviewEffort,
  onPrReviewEffortChange
}: SettingsPaneProps): JSX.Element {
  const found = status !== null && status.path !== null && status.version !== null
  const overridden = status?.source === 'setting'
  const offerable = offerableUsageModes(hasCostEstimate)

  return (
    <div
      data-settings-pane
      className="h-full overflow-y-auto rounded-island border border-border bg-surface"
    >
      <div className="mx-auto w-full max-w-[720px] px-7 py-7">
        <h1 className="text-[17px] font-medium tracking-tight text-fg">Settings</h1>
        <p className="mt-1 text-[12.5px] leading-[1.55] text-fg-muted">
          Helm&rsquo;s own settings. Claude&rsquo;s <code className="font-mono text-[11px]">.claude</code>{' '}
          trees are the config console&rsquo;s, one tab over.
        </p>

        <Group
          name="claude"
          title="Claude CLI"
          hint="The executable Helm hands a pty to. Found on PATH unless you point it somewhere else."
        >
          <div className="pb-1">
            <Verdict
              tone={status === null ? 'todo' : found ? (status.tested ? 'ok' : 'warn') : 'warn'}
              text={
                status === null
                  ? 'Looking…'
                  : found
                    ? overridden
                      ? 'Set by you'
                      : 'Found on this machine'
                    : (status.error ?? 'Not found.')
              }
            />
            <dl className="mt-2.5 space-y-1.5">
              <Fact label="Path">
                <span data-settings-claude-path title={status?.path ?? ''}>
                  {status?.path ?? NOTHING}
                </span>
              </Fact>
              <Fact label="Version">
                <span data-settings-claude-version>{status?.version ?? NOTHING}</span>
              </Fact>
              <Fact label="Config">
                <span data-settings-claude-config title={status?.configDir ?? ''}>
                  {status?.configDir ?? NOTHING}
                </span>
              </Fact>
            </dl>

            {found && status !== null && !status.tested && (
              <p
                data-settings-version-warning
                className="mt-3 rounded-well border border-warn/30 bg-warn/10 px-3 py-2 text-[11.5px] leading-[1.55] text-warn"
              >
                Helm was tested against {status.testedRange.min} up to (not including){' '}
                {status.testedRange.max}. {status.semver ?? status.version} is outside that, so a
                flag may have moved. Nothing is blocked.
              </p>
            )}
          </div>

          <Actions>
            <Action data-settings-recheck onClick={onRecheck} disabled={checking}>
              <RefreshIcon className={cn('mr-1.5 inline', checking && 'animate-spin')} />
              Check again
            </Action>
            <Action data-settings-locate onClick={onLocateClaude}>
              Locate manually…
            </Action>
            <Action
              data-settings-clear-claude
              onClick={onClearClaudeOverride}
              disabled={!overridden}
              title={
                overridden
                  ? 'Forget the executable you picked and use whatever Helm finds'
                  : 'Nothing to clear - Helm found this one itself'
              }
            >
              Clear override
            </Action>
          </Actions>
        </Group>

        <Group
          name="workspace"
          title="Workspace"
          hint={
            scanning
              ? `${count(roots.length, 'folder')} · scanning…`
              : `${count(roots.length, 'folder')} · ${count(projectCount, 'project')}`
          }
        >
          {roots.length === 0 ? (
            <p className="pb-1 text-[12px] text-fg-subtle">
              Helm scans nothing until you say what to scan.
            </p>
          ) : (
            <ul className="overflow-hidden rounded-well border border-border bg-surface-sunken">
              {roots.map((root) => (
                <li
                  key={root}
                  data-settings-root={root}
                  className="flex items-center gap-2 border-b border-border px-3 py-1.5 last:border-b-0"
                >
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted"
                    title={root}
                  >
                    {root}
                  </span>
                  <button
                    type="button"
                    data-settings-remove-root={root}
                    onClick={() => onRemoveRoot(root)}
                    aria-label={`Stop scanning ${root}`}
                    title={`Stop scanning ${root}`}
                    className={cn(
                      'grid size-5 shrink-0 place-items-center rounded text-fg-subtle',
                      'transition-colors hover:bg-hover hover:text-danger'
                    )}
                  >
                    <CloseIcon width={11} height={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-2.5 text-[11px] leading-[1.55] text-fg-subtle">
            A folder of repositories works on its own. A <em>harness</em> is any folder with a{' '}
            <code className="font-mono">harness.yaml</code> in it - that is the whole definition,
            and it is what lets one session compose several repos&rsquo; skills at once. Removing a
            folder here only stops Helm scanning it; nothing on disk is touched.
          </p>

          {/* Folders Helm can see are worth scanning but is not scanning.
              Offered here as well as on first run, because the answer changes
              *after* first run and the pane was the only place it was ever
              shown: install WSL, or make a harness inside a distribution, and
              the suggestion becomes true for somebody who will never see that
              pane again. A distro's harness is the case that made this obvious
              - no scan root ever covers `\\wsl$\...`, so a harness in there is
              invisible until somebody adds it by hand, and nothing in the app
              said it was there. */}
          {suggestedRoots.length > 0 && (
            <div className="mt-3" data-settings-suggested>
              <p className="text-[12.5px] text-fg">Not scanned yet</p>
              <p className="mt-0.5 mb-2 text-[11px] leading-[1.55] text-fg-subtle">
                Helm found these and is not looking at them.
              </p>
              <ul className="overflow-hidden rounded-well border border-border bg-surface-sunken">
                {suggestedRoots.map((suggestion) => (
                  <li
                    key={suggestion}
                    data-settings-suggested-root={suggestion}
                    className="flex items-center gap-2 border-b border-border px-3 py-1.5 last:border-b-0"
                  >
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted"
                      title={suggestion}
                    >
                      {suggestion}
                    </span>
                    <button
                      type="button"
                      data-settings-accept-root={suggestion}
                      onClick={() => onAcceptRoot(suggestion)}
                      title={`Scan ${suggestion}`}
                      className="shrink-0 rounded-well border border-border-strong px-2 py-0.5 text-[11px] text-fg transition-colors hover:bg-hover"
                    >
                      Scan it
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Actions>
            <Action data-settings-add-root onClick={onAddRoot} primary={roots.length === 0}>
              Add a folder
            </Action>
          </Actions>

          <Divider />

          {/* Pins are made on the sidebar, on the row of the project being
              pinned - the star is there because that is where the decision is.
              This is where the set is legible all at once, which is what the
              sidebar cannot be: its Pinned section shows a vanished folder as
              one row saying so, and a list of the paths is what says *which*
              path, in a form that can be compared with what is on disk. */}
          <p className="text-[12.5px] text-fg">Pinned projects</p>
          <p className="mt-0.5 mb-2 text-[11px] leading-[1.55] text-fg-subtle">
            Lifted to the top of the sidebar, above the harnesses. Pinned by the star on a
            project&rsquo;s row; a pin remembers the folder&rsquo;s path, so a project moved or
            cloned somewhere else comes back unpinned.
          </p>

          {pinnedProjects.length === 0 ? (
            <p className="text-[12px] text-fg-subtle">Nothing is pinned.</p>
          ) : (
            <ul className="overflow-hidden rounded-well border border-border bg-surface-sunken">
              {pinnedProjects.map((path) => (
                <li
                  key={path}
                  data-settings-pinned={path}
                  className="flex items-center gap-2 border-b border-border px-3 py-1.5 last:border-b-0"
                >
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted"
                    title={path}
                  >
                    {path}
                  </span>
                  {/* The roots list above wears the same shape with a danger
                      hover on its ×, and this one deliberately does not:
                      un-scanning a folder takes projects out of the tree, and
                      un-pinning one moves a row back into its harness. */}
                  <button
                    type="button"
                    data-settings-unpin={path}
                    onClick={() => onUnpinProject(path)}
                    aria-label={`Unpin ${path}`}
                    title={`Unpin ${path}`}
                    className={cn(
                      'grid size-5 shrink-0 place-items-center rounded text-fg-subtle',
                      'transition-colors hover:bg-hover hover:text-fg'
                    )}
                  >
                    <CloseIcon width={11} height={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Group>

        {/* Beside Workspace rather than further down, because it is the same
            subject seen from the other end: that group is the folders Helm
            scans, this one is what a new one gets written from. */}
        <TemplatesGroup
          total={templateCount}
          dir={templatesDir}
          onManage={onManageTemplates}
          onReveal={onRevealTemplates}
        />

        <Group name="appearance" title="Appearance">
          <Row
            label="Theme"
            hint="System follows Windows. The same three-way switch sits in the title bar."
          >
            <span data-settings-theme={theme}>
              <ThemeToggle value={theme} onChange={onThemeChange} />
            </span>
          </Row>

          <Divider />

          <Row
            label="Usage in the status bar"
            hint={
              hasCostEstimate
                ? 'Percentages of your plan limits, an estimate of what the transcripts would have cost, or nothing.'
                : 'Percentages of your plan limits, or nothing. Cost joins the list once the transcript index has an estimate.'
            }
          >
            <div
              role="radiogroup"
              aria-label="Usage display"
              className="flex items-center gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
            >
              {USAGE_DISPLAY_MODES.map((mode) => {
                const available = offerable.includes(mode)
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    data-settings-usage={mode}
                    aria-checked={usageDisplay === mode}
                    disabled={!available}
                    title={available ? `Show ${USAGE_LABEL[mode].toLowerCase()}` : COST_MODE_UNAVAILABLE}
                    onClick={() => onUsageDisplayChange(mode)}
                    className={cn(
                      'rounded-[5px] px-2.5 py-1 text-[11.5px] transition-colors',
                      usageDisplay === mode
                        ? SEGMENT_ON
                        : 'text-fg-subtle hover:text-fg',
                      !available && 'cursor-default opacity-45 hover:text-fg-subtle'
                    )}
                  >
                    {USAGE_LABEL[mode]}
                  </button>
                )
              })}
            </div>
          </Row>
        </Group>

        <ContentGroup
          wrap={contentWrap}
          onWrapChange={onContentWrapChange}
          indent={contentWrapIndent}
          onIndentChange={onContentWrapIndentChange}
        />

        <BrowserGroup
          reach={browserReach}
          onReachChange={onBrowserReachChange}
          mcp={browserMcp}
          onMcpChange={onBrowserMcpChange}
          mcpLocalOnly={browserMcpLocalOnly}
          onMcpLocalOnlyChange={onBrowserMcpLocalOnlyChange}
        />

        <SessionsGroup mcp={sessionMcp} onMcpChange={onSessionMcpChange} />

        {/* Beside Browser and Sessions rather than further down, because the
            thing it changes is whether those two families of tools reach a
            session hosted in a distro at all. */}
        <WslGroup
          wsl={wsl}
          onModeChange={onWslNetworkingModeChange}
          onProbe={onWslProbe}
          onShutdown={onWslShutdown}
        />

        <UpdatesGroup
          appVersion={appVersion}
          releasesUrl={releasesUrl}
          update={update}
          checking={updateChecking}
          onCheckNow={onCheckForUpdate}
          onOpenReleases={onOpenReleases}
          updateCheck={updateCheck}
          onUpdateCheckChange={onUpdateCheckChange}
        />

        <TerminalGroup
          terminal={terminal}
          onChange={onTerminalChange}
          fontStack={terminalFontStack}
          shells={shells}
          onLocateShell={onLocateShell}
        />

        <ArchiveGroup
          stats={archiveStats}
          maxBytes={transcriptArchiveMaxBytes}
          onMaxBytesChange={onTranscriptArchiveMaxBytesChange}
        />

        <GitHubGroup
          gh={gh}
          onLocate={onLocateGh}
          onClearOverride={onClearGhOverride}
          pollMinutes={prPollMinutes}
          onPollMinutesChange={onPrPollMinutesChange}
          staleDays={prStaleDays}
          onStaleDaysChange={onPrStaleDaysChange}
          repos={prRepos}
          onIgnoredChange={onPrIgnoredReposChange}
          reviewPrompt={prReviewPrompt}
          onReviewPromptChange={onPrReviewPromptChange}
          checkout={prCheckout}
          onCheckoutChange={onPrCheckoutChange}
          reviewModel={prReviewModel}
          onReviewModelChange={onPrReviewModelChange}
          reviewEffort={prReviewEffort}
          onReviewEffortChange={onPrReviewEffortChange}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Harness templates
// ---------------------------------------------------------------------------

/**
 * The templates this Helm has, and the two ways to reach them.
 *
 * The path is a button rather than a line of text, and that is the group's
 * whole argument for existing beside the manager: **there is no file editor in
 * Helm for these**. A template is a folder, editing one is a job for the editor
 * somebody already has, and a settings group that named the folder without
 * opening it would be describing a destination it declined to take you to.
 *
 * The count is stated rather than the list drawn. Which template is which is
 * the manager's question and the picker's; what belongs here is the one fact
 * Settings is for - whether this Helm has any, and where they are.
 */
function TemplatesGroup({
  total,
  dir,
  onManage,
  onReveal
}: {
  total: number
  dir: string
  onManage: () => void
  onReveal: () => void
}): JSX.Element {
  return (
    <Group
      name="templates"
      title="Harness templates"
      hint={total === 0 ? 'none yet' : count(total, 'template')}
    >
      <p className="pb-1 text-[12px] leading-[1.55] text-fg-muted">
        A template is a folder here; creating a harness from one copies it in. The New Harness
        dialog picks between them, and the built-in <em>Minimal</em> scaffold is always the first
        row whatever is in this folder.
      </p>

      <button
        type="button"
        data-settings-templates-dir
        onClick={onReveal}
        title={`Show ${dir} in Explorer`}
        className="mt-1.5 block w-full truncate rounded-well border border-border bg-surface-sunken px-3 py-1.5 text-left font-mono text-[11px] text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        {dir === '' ? NOTHING : dir}
      </button>
      <p className="mt-1.5 text-[11px] leading-[1.55] text-fg-subtle">
        Edited in your own editor, not in Helm - these are plain files, and most people keep them
        in git. Deleting the folder puts the shipped README and example back at the next start,
        which is the whole of &ldquo;reset&rdquo;.
      </p>

      <Actions>
        <Action data-settings-manage-templates onClick={onManage} primary={total === 0}>
          Manage templates
        </Action>
      </Actions>
    </Group>
  )
}

// ---------------------------------------------------------------------------
// Transcript archive
// ---------------------------------------------------------------------------

/**
 * The ceilings this pane offers.
 *
 * Not the validator's range, which runs from a kilobyte so that a check can
 * drive eviction. These are the sizes a person would choose, and the smallest
 * of them is still four hundred times the whole archive on the machine this was
 * written against (1.47 MB for 21,952 messages out of 311 MB of transcripts).
 */
const ARCHIVE_CEILINGS = [
  { bytes: 256 * 1024 * 1024, label: '256 MB' },
  { bytes: 512 * 1024 * 1024, label: '512 MB' },
  { bytes: 1024 ** 3, label: '1 GB' },
  { bytes: 2 * 1024 ** 3, label: '2 GB' },
  { bytes: 4 * 1024 ** 3, label: '4 GB' },
  { bytes: 8 * 1024 ** 3, label: '8 GB' }
] as const

/**
 * What Helm has kept, and the one knob over it.
 *
 * The figures are stated rather than drawn. A bar with no number on it would
 * be exactly the wrong answer here: the whole reason this group exists is that
 * `helm.db` is the user's file and a feature that grows it silently is one they
 * find out about from their disk. So the sentence says how many conversations,
 * how many messages, how many bytes, and how many bytes out of how many - and,
 * when the ceiling has actually bitten, how many conversations it dropped.
 *
 * There is no on/off switch and that is deliberate; the field's comment in
 * `types.ts` has the argument. What can be turned down is the ceiling.
 */
function ArchiveGroup({
  stats,
  maxBytes,
  onMaxBytesChange
}: {
  stats: ArchiveStats | null
  maxBytes: number
  onMaxBytesChange: (bytes: number) => void
}): JSX.Element {
  const used = stats?.storedBytes ?? 0
  const percent = maxBytes > 0 ? (used / maxBytes) * 100 : 0
  // Two significant figures below 1%, so a real archive on a default ceiling
  // reads "0.00014%" rather than "0%" - which would say "nothing is stored"
  // about something that is.
  const percentText = percent === 0 ? '0%' : percent < 1 ? `${percent.toPrecision(2)}%` : `${percent.toFixed(1)}%`

  // A ceiling set outside the offered list - by a check, or by a build that
  // offered different sizes - is added to the list rather than silently
  // replaced by the nearest one, which would make the select lie about what is
  // in force the moment it painted.
  const choices = ARCHIVE_CEILINGS.some((choice) => choice.bytes === maxBytes)
    ? ARCHIVE_CEILINGS
    : [{ bytes: maxBytes, label: formatBytes(maxBytes) }, ...ARCHIVE_CEILINGS]

  return (
    <Group
      name="archive"
      title="Transcript archive"
      hint="Claude Code deletes conversation transcripts on its own schedule and keeps the prompts for ever. Helm reads each one before that happens and stores the messages here, compressed. It never writes to Claude's files."
    >
      <div className="pb-1">
        <Verdict
          data-settings-archive-state={stats === null ? 'reading' : stats.sessions === 0 ? 'empty' : 'holding'}
          tone={stats === null ? 'todo' : 'ok'}
          text={
            stats === null
              ? 'Reading…'
              : stats.sessions === 0
                ? 'Nothing archived yet'
                : `${stats.sessions.toLocaleString()} conversations kept`
          }
        />
        <dl className="mt-2.5 space-y-1.5">
          <Fact label="Kept">
            <span data-settings-archive-sessions={String(stats?.sessions ?? 0)}>
              {(stats?.sessions ?? 0).toLocaleString()} sessions ·{' '}
              {(stats?.messages ?? 0).toLocaleString()} messages
            </span>
          </Fact>
          <Fact label="Stored">
            <span data-settings-archive-stored={String(used)}>
              {formatBytes(used)} of {formatBytes(maxBytes)} ({percentText})
            </span>
          </Fact>
          <Fact label="Dropped">
            <span data-settings-archive-evicted={String(stats?.evictedSessions ?? 0)}>
              {(stats?.evictedSessions ?? 0).toLocaleString()} sessions
            </span>
          </Fact>
        </dl>
      </div>

      <Divider />

      <Row
        label="Keep at most"
        hint="Reached, Helm drops the oldest archived conversation whole and marks it dropped - never half of one. Lowering this can evict immediately."
      >
        <Select
          value={String(maxBytes)}
          label="How much of the database the archive may use"
          data-settings-archive-max={String(maxBytes)}
          onChange={(value) => onMaxBytesChange(Number(value))}
        >
          {choices.map((choice) => (
            <option key={choice.bytes} value={String(choice.bytes)}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Row>
    </Group>
  )
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/** The five things this group can be saying, named so a driver can read one. */
export type UpdateOutcomeState = 'checking' | 'unasked' | 'newer' | 'current' | 'unreachable'

export interface UpdateOutcome {
  state: UpdateOutcomeState
  tone: 'ok' | 'warn' | 'todo'
  text: string
}

/**
 * The whole of what this group says, as one pure function of what it was given.
 *
 * Separate from the component because the five states are the interesting part
 * and a component cannot be asked what it would say. Exported so a driver could
 * reach it - though `settings-check` deliberately writes its own expected
 * sentences rather than importing these, because a check that asked this
 * function what this function says would be asserting that the code agrees with
 * itself.
 *
 * `unreachable` is `todo` and not `warn`, which is the one judgement in here.
 * Offline is an expected answer, not a fault: nothing is broken, nothing is out
 * of date as far as anyone knows, and a machine on a train has done nothing
 * wrong. A warning triangle would be Helm blaming the user's network for a
 * question Helm asked on its own initiative. The sentence names the reason and
 * says what could not be *asked*, never what failed.
 */
export function updateOutcome(update: UpdateCheckResult | null, checking: boolean): UpdateOutcome {
  if (checking) return { state: 'checking', tone: 'todo', text: 'Asking GitHub…' }
  if (update === null) {
    return {
      state: 'unasked',
      tone: 'todo',
      text: 'Helm has not asked GitHub since it started.'
    }
  }
  if (update.error !== null) {
    return { state: 'unreachable', tone: 'todo', text: `Could not ask GitHub - ${update.error}.` }
  }
  if (update.newer && update.latest !== null) {
    return {
      state: 'newer',
      tone: 'todo',
      text: `${update.latest} is available. This build is ${update.current}.`
    }
  }
  return {
    state: 'current',
    tone: 'ok',
    text: `${update.current} is the newest release. Asked ${askedWhen(update.checkedAt)}.`
  }
}

/**
 * "just now" or "5m ago", from the instant the check carries.
 *
 * `formatAge` answers `now` under a minute, which does not take the word "ago",
 * and an unparseable instant answers nothing at all rather than `NaNm` - a row
 * or a payload from another build is a fact about the past, and the sentence
 * around this one is still true without its last clause.
 */
function askedWhen(checkedAt: string): string {
  const at = Date.parse(checkedAt)
  if (!Number.isFinite(at)) return 'this session'
  const age = formatAge(at)
  return age === 'now' ? 'just now' : `${age} ago`
}

/**
 * Releases: what this build is, what the newest one is, and how to ask.
 *
 * This was a single tick in the Appearance group, and the comment there argued
 * for keeping it there - "here rather than in a group of its own, because from
 * the user's side this is a line in the status bar", the same question the
 * usage row above it answered. That argument was right for as long as it was
 * one tick. It stops holding at six controls: two facts, a sentence, the tick
 * and two buttons, every one of them about releases and none of them about how
 * the app looks. The group outgrew the reason rather than contradicting it.
 *
 * What the old hint carried is kept rather than dropped: Helm downloads
 * nothing and installs nothing, and an update Helm told you about is still an
 * update you go and get.
 *
 * The two buttons are the point of the group and they are deliberately
 * independent of everything above them. Check now is live whatever the tick
 * says - the setting governs whether Helm asks by itself, not whether the user
 * may - and Release notes is live whatever the last check returned, because
 * "up to date", "could not ask" and "never asked" are exactly the three states
 * in which somebody wants to go and look for themselves.
 */
/**
 * The content viewer's source view.
 *
 * Two rows and only the first is a preference about Helm - the second is a
 * number the first one uses, shown beside it rather than in a dialog behind it,
 * and disabled-looking is deliberately *not* what it does when wrapping is off:
 * the default here is off, so a greyed row would be the state most people find
 * it in, and a control nobody can try is a control nobody discovers.
 */
function ContentGroup({
  wrap,
  onWrapChange,
  indent,
  onIndentChange
}: {
  wrap: boolean
  onWrapChange: (wrap: boolean) => void
  indent: number
  onIndentChange: (columns: number) => void
}): JSX.Element {
  return (
    <Group name="content" title="Content viewer">
      <Row
        label="Wrap long lines"
        hint="The default for a file opened as source. Every document keeps its own toggle in the header, so a minified payload can wrap without the next file wrapping too."
      >
        <span data-settings-content-wrap={String(wrap)}>
          <Checkbox
            checked={wrap}
            onChange={() => onWrapChange(!wrap)}
            label="Wrap long lines in the source view"
          />
        </span>
      </Row>

      <Divider />

      <Row
        label="Wrap indent"
        hint="Columns a wrapped line's continuation hangs by, so a row that is the rest of the line above cannot be mistaken for the next one. Zero lines them up, which is what a plain editor does."
      >
        <NumberField
          value={indent}
          min={CONTENT_WRAP_INDENT.min}
          max={CONTENT_WRAP_INDENT.max}
          label="Wrap indent in columns"
          data-settings-content-wrap-indent={String(indent)}
          onCommit={onIndentChange}
        />
      </Row>
    </Group>
  )
}

/**
 * The browser pane's posture, and what a Claude session may do with it.
 *
 * Three rows, because there are three decisions: where the pane may go at all,
 * whether the sessions Helm hosts can drive it, and whether they are held to
 * this machine when the pane is not. Everything else about the pane - downloads
 * denied, every permission denied, self-signed certificates accepted for
 * loopback and nowhere else, an address bar that never searches - is not a
 * setting and never will be. Those are the app's postures, and a posture with a
 * switch on it is a posture somebody turns off on the afternoon it gets in
 * their way.
 *
 * The two reach rows are deliberately adjacent and worded as a pair, because
 * the rule between them is an intersection and the failure to avoid is somebody
 * setting the second and believing it widened the first.
 */
function BrowserGroup({
  reach,
  onReachChange,
  mcp,
  onMcpChange,
  mcpLocalOnly,
  onMcpLocalOnlyChange
}: {
  reach: BrowserReach
  onReachChange: (reach: BrowserReach) => void
  mcp: boolean
  onMcpChange: (next: boolean) => void
  mcpLocalOnly: boolean
  onMcpLocalOnlyChange: (next: boolean) => void
}): JSX.Element {
  return (
    <Group
      name="browser"
      title="Browser"
      hint="A dev-server viewport, not a browser. Nothing is downloaded, every permission is refused, and the address bar never hands anything to a search engine - a page loads because you typed its address."
    >
      <Row
        label="Where the pane may go"
        hint={
          reach === 'local'
            ? 'This machine only. Anything that is not localhost, 127.0.0.1 or ::1 is refused with a sentence and nothing is fetched.'
            : 'Anywhere. Helm still opens no page you did not ask for - the pane fetches the address you navigate to and nothing else.'
        }
      >
        <Select
          value={reach}
          label="Where the browser pane may go"
          data-settings-browser-reach={reach}
          onChange={(value) => onReachChange(value as BrowserReach)}
        >
          <option value="web">Anywhere I navigate to</option>
          <option value="local">This machine only</option>
        </Select>
      </Row>

      <Row
        label="Let Claude drive the browser"
        hint={
          mcp
            ? 'Sessions Helm hosts can open pages, read them, click and type. Helm serves the tools on a loopback port with a token unique to each session, and its tabs are labelled with the session that opened them.'
            : 'Off. Helm opens no port at all and sessions are started without the tools, exactly as they were before.'
        }
      >
        <span data-settings-browser-mcp={String(mcp)}>
          <Checkbox
            checked={mcp}
            onChange={() => onMcpChange(!mcp)}
            label="Let Claude drive the browser"
          />
        </span>
      </Row>

      <Row
        label="…but only on this machine"
        hint={
          mcpLocalOnly
            ? 'Claude’s tools are held to localhost even where the pane may go further. You can still navigate the pane anywhere yourself.'
            : 'Claude’s tools reach as far as the pane does, and never further - the narrower of these two settings always wins.'
        }
      >
        {/* Not disabled when the tools are off, deliberately. The value is a
            standing preference: somebody who has confined the tools and then
            turns them off for an afternoon should find them still confined when
            they turn them back on, and a control that greys out is a control
            whose state people stop trusting. */}
        <span data-settings-browser-mcp-local={String(mcpLocalOnly)}>
          <Checkbox
            checked={mcpLocalOnly}
            onChange={() => onMcpLocalOnlyChange(!mcpLocalOnly)}
            label="Confine Claude’s browser tools to this machine"
          />
        </span>
      </Row>
    </Group>
  )
}

/**
 * What a session may learn about the other sessions.
 *
 * A group of its own beside Browser rather than a third tick inside it. The two
 * are served by one endpoint on one port, which is an implementation detail; a
 * person reading this pane is deciding two different things - whether an agent
 * may click things in a browser, and whether an agent may be told what their
 * other work is doing - and those have different answers for different people.
 */
function SessionsGroup({
  mcp,
  onMcpChange
}: {
  mcp: boolean
  onMcpChange: (next: boolean) => void
}): JSX.Element {
  return (
    <Group
      name="sessions"
      title="Sessions"
      hint="Helm can tell a session it hosts what the other Claude Code sessions on this machine are doing, so an agent can stay out of a working tree somebody else is in. It is read-only: there is no way for one session to send another anything, and no tool ever returns any part of another session’s conversation."
    >
      <Row
        label="Let Claude see the other sessions"
        hint={
          mcp
            ? 'Sessions Helm hosts can list every Claude Code session running here - its name, its directory, whether it is busy or waiting on you - and, for the ones Helm started, what they are holding: child processes and listening ports. Not their conversations, and not the arguments they were launched with.'
            : 'Off. Helm serves the tools to nobody and sessions are started without them, exactly as they were before.'
        }
      >
        <span data-settings-session-mcp={String(mcp)}>
          <Checkbox
            checked={mcp}
            onChange={() => onMcpChange(!mcp)}
            label="Let Claude see the other sessions"
          />
        </span>
      </Row>
    </Group>
  )
}

/**
 * WSL: the one machine-wide change Helm offers, and the two questions it is
 * about.
 *
 * Why the group exists at all. Measured 2026-09-02 (SPEC 4.8): a WSL2 distro on
 * the default NAT networking mode cannot reach Helm's loopback endpoint - not
 * on `127.0.0.1`, which only mirrors under `networkingMode=mirrored`, and not
 * on the gateway, because the endpoint binds loopback only and that rule is not
 * being loosened. So a session hosted in a distro launches with no tools and
 * Helm prints a sentence naming the fix. This is that sentence with a button on
 * it.
 *
 * Three decisions, and each is the reason a different simpler version is wrong.
 *
 * **It is here and not on a profile.** `networkingMode` lives in one file in
 * the user's profile directory and governs every distribution and every WSL
 * process on the machine. A per-profile control would say the scope was a
 * profile's, and somebody would set it on one and wonder why the other changed.
 * It is not an install step either: writing a file Helm does not own before the
 * user has any context for it is the opposite of the posture SPEC 7 pins.
 *
 * **The file's mode and the endpoint's reachability are two facts, never one
 * verdict.** The file says what it says; whether a distro can open a socket is
 * a connect, and the state between them - `mirrored` written, WSL not restarted
 * - is the state a user is most likely to be in while wondering why nothing
 * changed. One merged verdict would be a green tick over a session that still
 * has no tools.
 *
 * **The probe is on a button.** Asking a distribution anything *starts* it, so
 * a group that probed on open would boot every distribution on the machine to
 * paint a settings pane - the same reason `wsl:distros` and `wsl:probe` are two
 * channels.
 */
function WslGroup({
  wsl,
  onModeChange,
  onProbe,
  onShutdown
}: {
  wsl: WslSettingsState
  onModeChange: (mode: WslNetworkingMode) => void
  onProbe: (distro: string) => void
  onShutdown: () => void
}): JSX.Element {
  const [asking, setAsking] = useState(false)
  const [picked, setPicked] = useState('')

  const { networking } = wsl
  const mode = networking?.networkingMode ?? null
  const mirrored = mode !== null && mode.toLowerCase() === 'mirrored'
  const refused = networking !== null && networking.refusal !== null
  // The default distribution is what `wsl.exe` would use with no `-d`, so it is
  // what somebody means by "my distro" until they say otherwise.
  const fallback = wsl.distros.find((distro) => distro.isDefault) ?? wsl.distros[0]
  const chosen = picked !== '' ? picked : (fallback?.name ?? '')
  const probe = chosen === '' ? undefined : wsl.probes[chosen]

  return (
    <Group
      name="wsl"
      title="WSL"
      hint="A profile can host its sessions inside a WSL distribution. Helm’s browser and session tools reach one only where WSL shares this machine’s loopback, which it does not do by default - so this is the group for the one file that changes that."
    >
      <div className="pb-1">
        <Verdict
          tone={networking === null ? 'todo' : refused ? 'warn' : mirrored ? 'ok' : 'todo'}
          text={verdictText(networking, mirrored)}
          data-settings-wsl-state={
            networking === null
              ? 'reading'
              : refused
                ? 'refused'
                : mirrored
                  ? 'mirrored'
                  : 'not-mirrored'
          }
        />
        <dl className="mt-2.5 space-y-1.5">
          <Fact label="File">
            <span data-settings-wsl-file title={networking?.path ?? ''}>
              {networking?.path ?? NOTHING}
            </span>
          </Fact>
          <Fact label="Mode">
            {/* The value verbatim, and `-` for a file that sets none - never
                "nat". Which mode WSL defaults to is a fact about the WSL build
                rather than about this file, and printing the default as though
                the file said it would be Helm inventing a line nobody wrote. */}
            <span data-settings-wsl-mode={mode ?? ''}>{mode ?? NOTHING}</span>
          </Fact>
        </dl>
      </div>

      <Divider />

      <Row
        label="Mirrored networking"
        hint={
          mirrored
            ? 'Set in the file. Every distribution shares this machine’s loopback from the next time WSL starts, and Helm’s tools reach a session hosted in one.'
            : 'Not set, so WSL runs its default NAT stack and nothing inside a distribution can reach Helm’s endpoint on 127.0.0.1.'
        }
      >
        <Action
          data-settings-wsl-set={mirrored ? 'nat' : 'mirrored'}
          primary={!mirrored}
          disabled={wsl.busy || networking === null || refused}
          onClick={() => onModeChange(mirrored ? 'nat' : 'mirrored')}
        >
          {mirrored ? 'Set back to nat' : 'Turn on mirrored networking'}
        </Action>
      </Row>

      {/* The launch-disclosure rule (DESIGN.md par. 5) applied to a write
          rather than to a process: the file, the key and the copy are named on
          screen before the button is pressed, machine parts in mono. What must
          be legible here is the scope - this is not a Helm setting, it is a
          change to the machine - and that Helm stops short of restarting WSL. */}
      <p className="mt-1 text-[11px] leading-[1.55] text-fg-subtle">
        Sets <code className="font-mono">networkingMode</code> under{' '}
        <code className="font-mono">[wsl2]</code> in your own{' '}
        <code className="font-mono">.wslconfig</code>, keeping everything else in it and copying the
        file to a <code className="font-mono">.helm.bak</code> beside itself first. It is
        machine-wide: every distribution and every WSL process, not just Helm’s. Helm does not
        restart WSL, so the change applies the next time WSL starts.
      </p>

      {wsl.notice !== null && (
        <p data-settings-wsl-notice className="mt-1.5 font-mono text-[11px] text-fg-muted">
          {wsl.notice}
        </p>
      )}
      {wsl.error !== null && (
        <p data-settings-wsl-error className="mt-1.5 text-[11.5px] leading-[1.5] text-danger">
          {wsl.error}
        </p>
      )}

      <Divider />

      <Row
        label="Can a distribution reach Helm?"
        hint="Measured by opening a socket from inside the distribution, which starts it if it is stopped - so it is asked when you press this and never when this pane opens. This is the question the file above does not answer: until WSL restarts, a file saying mirrored and a distro that cannot connect are both true."
      >
        <div className="flex items-center gap-2">
          <Select
            value={chosen}
            label="Distribution to check"
            data-settings-wsl-distro={chosen}
            onChange={setPicked}
          >
            {wsl.distros.length === 0 && <option value="">No distributions</option>}
            {wsl.distros.map((distro) => (
              <option key={distro.name} value={distro.name}>
                {distro.name}
              </option>
            ))}
          </Select>
          <Action
            data-settings-wsl-check
            disabled={chosen === '' || wsl.probing !== null}
            onClick={() => onProbe(chosen)}
          >
            {wsl.probing === chosen ? 'Checking…' : 'Check'}
          </Action>
        </div>
      </Row>

      {probe !== undefined && (
        <div className="pt-1.5">
          <Verdict
            tone={probe.endpointReachable ? 'ok' : 'warn'}
            text={
              probe.endpointReachable
                ? `${probe.distro} reached Helm’s endpoint. A session hosted there gets the browser and session tools.`
                : `${probe.distro} could not reach Helm’s endpoint, so a session hosted there launches with no tools.`
            }
            data-settings-wsl-reachable={String(probe.endpointReachable)}
          />
        </div>
      )}

      <Divider />

      <Row
        label="Restart WSL"
        hint="The networking change applies at the next WSL start. Restarting it now is the only way to have it apply to a distribution that is already running - and it ends everything running in every distribution."
      >
        <Action data-settings-wsl-restart onClick={() => setAsking(true)}>
          Restart WSL…
        </Action>
      </Row>

      {/* The confirmation lives here rather than in the shell, because the
          question is only ever asked from this button. Its accepting half is
          the only caller of the shutdown channel. */}
      {asking && (
        <WslShutdownDialog
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false)
            onShutdown()
          }}
        />
      )}
    </Group>
  )
}

/**
 * The `.wslconfig` sentence, which has five honest states and no merged one.
 *
 * A refusal is printed verbatim: it is the reason Helm will not rewrite the
 * file, and the whole point of refusing is to say what is there so the user can
 * fix it in their own editor.
 */
function verdictText(networking: WslNetworkingState | null, mirrored: boolean): string {
  if (networking === null) return 'Reading .wslconfig…'
  if (networking.refusal !== null) return networking.refusal
  if (mirrored) {
    return 'Mirrored networking is set. It applies from the next time WSL starts, not to a distribution already running.'
  }
  if (networking.networkingMode !== null) {
    return `.wslconfig sets networkingMode=${networking.networkingMode}, so a distribution cannot reach Helm’s endpoint.`
  }
  return networking.exists
    ? '.wslconfig does not set a networking mode, so WSL uses its NAT default.'
    : 'There is no .wslconfig, so WSL uses its NAT default.'
}

function UpdatesGroup({
  appVersion,
  releasesUrl,
  update,
  checking,
  onCheckNow,
  onOpenReleases,
  updateCheck,
  onUpdateCheckChange
}: {
  appVersion: string | null
  releasesUrl: string | null
  update: UpdateCheckResult | null
  checking: boolean
  onCheckNow: () => void
  onOpenReleases: () => void
  updateCheck: boolean
  onUpdateCheckChange: (next: boolean) => void
}): JSX.Element {
  const outcome = updateOutcome(update, checking)

  return (
    // The posture belongs to the group rather than to the tick, the way the
    // Claude CLI and GitHub groups carry theirs: it is true of everything in
    // here, including the button, and it stayed true when the tick stopped
    // being the only thing that could ask.
    <Group
      name="updates"
      title="Updates"
      hint="The only request Helm's own process makes. It reads a version number and hands you a link - nothing is downloaded, replaced or restarted."
    >
      <div className="pb-1">
        <Verdict
          data-settings-update-outcome={outcome.state}
          tone={outcome.tone}
          text={outcome.text}
        />
        <dl className="mt-2.5 space-y-1.5">
          <Fact label="Version">
            <span data-settings-app-version>{appVersion ?? NOTHING}</span>
          </Fact>
          {/* Empty after a check that could not complete, and that is the
              intended reading rather than a gap: the last request came back
              with no version in it, so there is no number here anybody has
              been told. Painting the previous one would be the status bar's
              mistake in reverse - a figure on screen that nothing just
              measured. */}
          <Fact label="Latest">
            <span data-settings-latest-version>{update?.latest ?? NOTHING}</span>
          </Fact>
        </dl>

        {outcome.state === 'unreachable' && (
          <p
            data-settings-update-offline
            className="mt-2.5 text-[11px] leading-[1.55] text-fg-subtle"
          >
            Release notes below still opens the releases page - that is a link handed to your
            browser, not a request Helm makes, so it works from here either way.
          </p>
        )}
      </div>

      <Divider />

      <Row
        label="Tell me about new releases"
        hint="Asks on launch, at most once a day, and puts a line in the status bar if a newer Helm exists. Off stops only that - Check now still asks."
      >
        <span data-settings-update-check={String(updateCheck)}>
          <Checkbox
            checked={updateCheck}
            onChange={() => onUpdateCheckChange(!updateCheck)}
            label="Check for new releases on launch"
          />
        </span>
      </Row>

      <Actions>
        {/* Disabled only while a check is in flight - never because the tick
            above is off. A button that greyed itself out when the automatic
            check was turned off would make the setting mean something it does
            not say. */}
        <Action data-settings-update-now onClick={onCheckNow} disabled={checking}>
          <RefreshIcon className={cn('mr-1.5 inline', checking && 'animate-spin')} />
          Check now
        </Action>
        <Action
          data-settings-releases
          onClick={onOpenReleases}
          disabled={releasesUrl === null}
          title={releasesUrl ?? 'Not known until app:info lands'}
        >
          Release notes
        </Action>
      </Actions>
    </Group>
  )
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/**
 * The intervals offered, and what each one is for.
 *
 * A select rather than a stepper: the useful values are decades apart, and
 * nobody nudges a polling interval while watching the result. `0` is off and is
 * first, because turning it off is the one choice somebody comes here
 * specifically to make.
 */
const POLL_CHOICES: Array<{ minutes: number; label: string }> = [
  { minutes: 0, label: 'Off - only when I ask' },
  { minutes: 5, label: 'Every 5 minutes' },
  { minutes: 15, label: 'Every 15 minutes' },
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Hourly' },
  { minutes: 240, label: 'Every 4 hours' },
  { minutes: 1440, label: 'Daily' }
]

/**
 * The cutoffs this pane offers, which are not the validator's range.
 *
 * Six shortcuts over 1-90, exactly as the poll row offers seven over 5-1440:
 * the validator says what is *legal*, this list says what anybody would
 * actually pick, and a select with ninety options is a select nobody reads.
 * Off is first and is worded as what it does rather than as a number, because
 * it is not the small end of the scale - it is the split switched off.
 */
const STALE_CHOICES: Array<{ days: number; label: string }> = [
  { days: 0, label: 'Off - one Open list' },
  { days: 1, label: 'A day' },
  { days: 2, label: '2 days' },
  { days: 3, label: '3 days' },
  { days: 7, label: 'A week' },
  { days: 14, label: '2 weeks' }
]

/** "2 days", or "a day" - the cutoff as the hint below the row says it. */
function staleWording(days: number): string {
  if (days === 1) return 'a day'
  if (days === 7) return 'a week'
  if (days === 14) return 'two weeks'
  return `${String(days)} days`
}

/**
 * The GitHub CLI, and how often Helm asks it anything.
 *
 * Two rows and a status, and it is the *status* that carries the rule: Helm
 * holds no GitHub credential, so everything on this surface happens through the
 * `gh` on this machine, signed in by the user, in a terminal Helm has nothing to
 * do with. The remedy for "not signed in" is therefore a sentence rather than a
 * button - the same shape the Claude CLI group takes, for the same reason.
 *
 * The interval is here rather than in the Pulls pane's own header on purpose:
 * settings for Helm live in one place, and a disclosure strip inside a pane is
 * a second place for a setting to hide.
 */
function GitHubGroup({
  gh,
  onLocate,
  onClearOverride,
  pollMinutes,
  onPollMinutesChange,
  staleDays,
  onStaleDaysChange,
  repos,
  onIgnoredChange,
  reviewPrompt,
  onReviewPromptChange,
  checkout,
  onCheckoutChange,
  reviewModel,
  onReviewModelChange,
  reviewEffort,
  onReviewEffortChange
}: {
  gh: GhStatus | null
  onLocate: () => void
  onClearOverride: () => void
  pollMinutes: number
  onPollMinutesChange: (minutes: number) => void
  staleDays: number
  onStaleDaysChange: (days: number) => void
  repos: PrRepoChoice[]
  onIgnoredChange: (slugs: string[]) => void
  reviewPrompt: string
  onReviewPromptChange: (template: string) => void
  checkout: PrCheckoutMode
  onCheckoutChange: (mode: PrCheckoutMode) => void
  reviewModel: string | null
  onReviewModelChange: (model: string | null) => void
  reviewEffort: EffortLevel | null
  onReviewEffortChange: (effort: EffortLevel | null) => void
}): JSX.Element {
  const found = gh !== null && gh.path !== null
  const overridden = gh?.source === 'setting'
  // A value written by hand or by an older build still has to be selectable, or
  // the picker would silently show something other than what is in force.
  const choices = POLL_CHOICES.some((choice) => choice.minutes === pollMinutes)
    ? POLL_CHOICES
    : [...POLL_CHOICES, { minutes: pollMinutes, label: `Every ${String(pollMinutes)} minutes` }]
  // The same fallback, for the same reason: the validator takes any whole
  // number of days from `PR_STALE_DAYS.min` up, and a value this list does not
  // happen to hold would otherwise be a select showing something other than
  // what is in force.
  const staleChoices = STALE_CHOICES.some((choice) => choice.days === staleDays)
    ? STALE_CHOICES
    : [...STALE_CHOICES, { days: staleDays, label: `${String(staleDays)} days` }]

  return (
    <Group
      name="github"
      title="GitHub"
      hint="Pull requests are fetched by running your own gh CLI. Helm stores no GitHub credential and never sees your token."
    >
      <div className="pb-1">
        <Verdict
          tone={gh === null ? 'todo' : found && gh.authenticated ? 'ok' : 'warn'}
          text={
            gh === null
              ? 'Looking…'
              : (gh.problem?.message ?? (overridden ? 'Set by you' : 'Found and signed in'))
          }
        />
        <dl className="mt-2.5 space-y-1.5">
          <Fact label="Path">
            <span data-settings-gh-path title={gh?.path ?? ''}>
              {gh?.path ?? NOTHING}
            </span>
          </Fact>
          <Fact label="Version">
            <span data-settings-gh-version>{gh?.version ?? NOTHING}</span>
          </Fact>
        </dl>
      </div>

      <Actions>
        <Action data-settings-gh-locate onClick={onLocate}>
          Locate manually…
        </Action>
        <Action
          data-settings-clear-gh
          onClick={onClearOverride}
          disabled={!overridden}
          title={
            overridden
              ? 'Forget the executable you picked and use whatever Helm finds'
              : 'Nothing to clear - Helm found this one itself'
          }
        >
          Clear override
        </Action>
      </Actions>

      <Divider />

      <Row
        label="Check for pull requests"
        hint={
          pollMinutes === PR_POLL_MINUTES.off
            ? 'Off. The pane still refreshes when you ask it to and when Helm comes back to the front.'
            : 'A gh call per repository on this schedule, plus whenever you ask and when Helm comes back to the front.'
        }
      >
        <Select
          value={String(pollMinutes)}
          label="How often to check for pull requests"
          data-settings-pr-poll={String(pollMinutes)}
          onChange={(value) => onPollMinutesChange(Number(value))}
        >
          {choices.map((choice) => (
            <option key={choice.minutes} value={String(choice.minutes)}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Row>

      <Divider />

      {/* Beside the interval because they are the two knobs over the same
          list - one is how often it is re-read, the other is where that list
          stops being about now. Nothing outside the database reads this: it
          reaches the Pulls pane as a prop, so there is no `settings:write`
          branch for it (see the `procedures` skill). */}
      <Row
        label="Call a pull request stale after"
        hint={
          staleDays === PR_STALE_DAYS.off
            ? 'Off. The Pulls pane lists everything open in one section, most recently updated first.'
            : `The Pulls pane splits its Open section in two: anything untouched for ${staleWording(staleDays)} collapses to one line under STALE. Nothing is hidden, and a stale row keeps its state and its checks.`
        }
      >
        <Select
          value={String(staleDays)}
          label="When the Pulls pane calls a pull request stale"
          data-settings-pr-stale={String(staleDays)}
          onChange={(value) => onStaleDaysChange(Number(value))}
        >
          {staleChoices.map((choice) => (
            <option key={choice.days} value={String(choice.days)}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Row>

      <Divider />

      <RepositoriesRow repos={repos} onChange={onIgnoredChange} />

      <Divider />

      <ReviewPromptRow value={reviewPrompt} onChange={onReviewPromptChange} />

      <Divider />

      <Row
        label="Check the branch out first"
        hint={
          checkout === 'checkout'
            ? 'Runs gh pr checkout in the repository before the session starts, and refuses when the tree has uncommitted changes - Helm does not stash.'
            : 'Off. Reviews run against the pull request on GitHub, so nothing in your working tree moves.'
        }
      >
        <Select
          value={checkout}
          label="What a review does to the working tree"
          data-settings-pr-checkout={checkout}
          onChange={(value) => onCheckoutChange(value as PrCheckoutMode)}
        >
          <option value="none">Leave my tree alone</option>
          <option value="checkout">Check the pull request out</option>
        </Select>
      </Row>

      <Divider />

      {/* Two rows rather than one, because they are two flags and either can be
          set without the other: an effort with no model named is a perfectly
          ordinary thing to want, and a combined control would have to invent a
          meaning for half of itself. */}
      <Row
        label="Review model"
        hint={
          reviewModel === null
            ? 'Whatever claude starts with. Helm passes no --model at all.'
            : `Adds --model ${reviewModel} to the review launch, and to nothing else.`
        }
      >
        <Select
          value={reviewModel ?? ''}
          label="The model a review session runs on"
          data-settings-pr-model={reviewModel ?? ''}
          onChange={(value) => onReviewModelChange(value === '' ? null : value)}
        >
          <option value="">Claude Code&rsquo;s default</option>
          {/* A value written by hand or by an older build stays selectable, for
              the reason the poll interval's list does the same: a picker that
              silently shows something other than what is in force is worse than
              one with an unfamiliar row in it. */}
          {reviewModels(reviewModel).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
      </Row>

      <Divider />

      <Row
        label="Review effort"
        hint={
          reviewEffort === null
            ? 'Whatever claude starts with. Helm passes no --effort at all.'
            : `Adds --effort ${reviewEffort} to the review launch, and to nothing else.`
        }
      >
        <Select
          value={reviewEffort ?? ''}
          label="The reasoning effort a review session runs at"
          data-settings-pr-effort={reviewEffort ?? ''}
          onChange={(value) => onReviewEffortChange(value === '' ? null : (value as EffortLevel))}
        >
          <option value="">Claude Code&rsquo;s default</option>
          {EFFORT_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </Select>
      </Row>
    </Group>
  )
}

/**
 * The model names offered, plus whatever is already set.
 *
 * The shortlist is the CLI's aliases rather than full model ids, because those
 * are what a person types and they outlive any one release. The setting itself
 * is not validated against this list (see `SETTING_VALIDATORS.prReviewModel`) -
 * so a full id written into the database by hand is honoured, and appears here
 * so the picker can show it.
 */
function reviewModels(current: string | null): string[] {
  const known = ['opus', 'sonnet', 'haiku', 'fable']
  return current === null || known.includes(current) ? known : [...known, current]
}

/**
 * Which repositories the pull-request surface pays attention to.
 *
 * A tick per repository rather than a text field of slugs, because the useful
 * question is "which of the ones I have" and the answer is a set the app
 * already knows. Ticked is fetched: the list reads as what Helm is doing rather
 * than as what it is not, so the default state of everything is on and nobody
 * has to enrol a repository they just cloned.
 *
 * The full-width list rather than a `Row`, for the same reason the scan roots
 * are one: a control with an unbounded number of lines in it cannot sit in the
 * right-hand column of a label-and-control row.
 *
 * Unticking here is the only place a repository can be ignored. The Pulls pane
 * shows what is ignored and can tick one back on, which is disclosure and the
 * undo of it; the setting itself lives with the other settings.
 */
/**
 * The folder a repository is checked out into, when that is worth a word.
 *
 * Which is rarely: a clone is nearly always in a directory named after the
 * repository, so printing it beside every slug would be the same string twice
 * on most rows. Case is not a difference - `WidgetKit` cloned into `widgetkit`
 * is the same name - so only a genuinely different folder gets named.
 */
function folderNote(repo: PrRepoChoice): string | null {
  const name = repo.slug.split('/')[1] ?? ''
  return repo.name.toLowerCase() === name.toLowerCase() ? null : repo.name
}

function RepositoriesRow({
  repos,
  onChange
}: {
  repos: PrRepoChoice[]
  onChange: (slugs: string[]) => void
}): JSX.Element {
  const ignored = repos.filter((repo) => repo.ignored).map((repo) => repo.slug)
  const fetched = repos.length - ignored.length

  return (
    <div data-settings-pr-repos={String(repos.length)} className="py-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[12.5px] text-fg">Repositories</p>
        {repos.length > 0 && (
          <p data-settings-pr-repo-count className="text-[11px] tabular-nums text-fg-subtle">
            {String(fetched)} of {String(repos.length)} fetched
          </p>
        )}
      </div>
      <p className="mt-0.5 text-[11px] leading-[1.5] text-fg-subtle">
        Untick one and Helm stops checking it - no <code className="font-mono">gh</code> call, and
        no rows in the Pulls pane, which names it at the bottom so nothing goes missing quietly.
        Whatever it already fetched is kept for when you tick it back on.
      </p>

      {repos.length === 0 ? (
        <p className="mt-2 text-[12px] text-fg-subtle">
          Nothing with a github.com <code className="font-mono">origin</code> has been found yet.
        </p>
      ) : (
        <ul className="mt-2.5 overflow-hidden rounded-well border border-border bg-surface-sunken">
          {repos.map((repo) => (
            <li
              key={repo.slug}
              data-settings-pr-repo={repo.slug}
              data-settings-pr-repo-ignored={String(repo.ignored)}
              className="flex items-center gap-2.5 border-b border-border px-3 py-1.5 last:border-b-0"
            >
              <Checkbox
                checked={!repo.ignored}
                onChange={() => onChange(withRepoIgnored(ignored, repo.slug, !repo.ignored))}
                label={`Fetch pull requests from ${repo.slug}`}
              />
              {/* The slug leads, so the mono column has one left edge to read
                  down. The folder name would put a ragged word in front of
                  every one of them for a string that is usually the second
                  half of the slug again. */}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate font-mono text-[11px]',
                  repo.ignored ? 'text-fg-subtle' : 'text-fg-muted'
                )}
                title={repo.slug}
              >
                {repo.slug}
              </span>
              {folderNote(repo) !== null && (
                <span
                  className="min-w-0 max-w-[35%] shrink-0 truncate text-[11px] text-fg-subtle"
                  title={`The folder Helm scans is called ${String(folderNote(repo))}`}
                >
                  {folderNote(repo)}
                </span>
              )}
              {!repo.present && (
                <span
                  className="shrink-0 text-[10.5px] text-fg-subtle"
                  title="Ignored, but no folder Helm scans has this origin any more. Tick it to forget the entry."
                >
                  not scanned
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The review prompt template.
 *
 * A free text field rather than a picker, because what "review this" means is
 * the user's and not Helm's: the default runs Claude Code's built-in
 * `/code-review` skill, and a team with a review command of its own should be
 * able to name it without a build.
 *
 * Committed on blur or Enter, like the terminal font field and for the same
 * reason - typing `/code-review {number}` through a live write would save
 * fourteen intermediate templates, three of which are a bare `/`.
 *
 * The placeholder list under it is not a nicety. `{branch}` in particular is a
 * trap worth naming in the surface that offers it: it is GitHub's `headRefName`,
 * and on a pull request opened from a fork that branch does not exist in the
 * local checkout at all unless the checkout row below is on. The shipped default
 * uses `{number}` alone for exactly that reason.
 */
function ReviewPromptRow({
  value,
  onChange
}: {
  value: string
  onChange: (template: string) => void
}): JSX.Element {
  const [draft, setDraft, reset] = useDraft(value)

  const commit = (): void => {
    const next = draft.trim()
    // Empty is not "no prompt" - the validator refuses it, and a blank template
    // would silently make the review button start an ordinary session.
    if (next === '' || next === value) {
      reset()
      return
    }
    onChange(next)
  }

  return (
    <Row
      label="Review prompt"
      hint="The first message a “Review with Claude” session is started with. The pull request pane shows exactly what it will run before you press the button."
    >
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex items-center gap-2">
          <input
            type="text"
            data-settings-pr-prompt={value}
            aria-label="Review prompt template"
            placeholder={DEFAULT_PR_REVIEW_PROMPT}
            spellCheck={false}
            maxLength={PR_REVIEW_PROMPT_MAX_LENGTH}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') reset()
            }}
            className={cn(
              'h-[30px] w-[260px] rounded-well border border-border bg-surface-sunken px-2.5',
              'font-mono text-[11.5px] text-fg placeholder:text-fg-subtle select-text',
              'focus:border-accent focus:outline-none'
            )}
          />
          <Action
            data-settings-pr-prompt-reset
            onClick={() => onChange(DEFAULT_PR_REVIEW_PROMPT)}
            disabled={value === DEFAULT_PR_REVIEW_PROMPT}
            title={
              value === DEFAULT_PR_REVIEW_PROMPT
                ? 'Nothing to reset - this is the built-in prompt'
                : 'Back to the built-in code review'
            }
          >
            Reset
          </Action>
        </div>
        <p className="max-w-[320px] text-right text-[11px] leading-[1.55] text-fg-subtle">
          {PR_PROMPT_PLACEHOLDERS.map((name) => `{${name}}`).join(' ')} are substituted; anything
          else in braces is passed through as you wrote it.{' '}
          <span className="text-fg-muted">
            {'{branch}'} is the head branch on GitHub, which a fork&rsquo;s pull request does not
            have locally unless the checkout below is on.
          </span>
        </p>
      </div>
    </Row>
  )
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

const CURSOR_LABEL: Record<TerminalCursorStyle, string> = {
  block: 'Block',
  underline: 'Underline',
  bar: 'Bar'
}

/**
 * What the preview well renders.
 *
 * Box-drawing, block elements and the letters that are told apart only by their
 * shapes, because those are what a font chosen for its letterforms drops or
 * gets wrong - and Claude Code's whole interface is box-drawing.
 *
 * The rules are built from the body's own length rather than typed out: a
 * hand-counted box is exactly the kind of thing that goes one character out and
 * then looks like a rendering bug in the font someone is evaluating.
 */
const PREVIEW_BODY = '  0O1lI  {}[]  <=>  ~-  ░▒▓█  The quick brown fox  '
const PREVIEW_LINES = [
  `╭${'─'.repeat(PREVIEW_BODY.length)}╮`,
  `│${PREVIEW_BODY}│`,
  `╰${'─'.repeat(PREVIEW_BODY.length)}╯`
]

/**
 * Terminal appearance and the shell a project pane opens.
 *
 * Colour is deliberately absent. The xterm palette is fixed in both themes
 * (DESIGN.md par. 6, "foreign-ground islands") and asserted pixel-for-pixel by
 * the fidelity checks; making it settable is a design amendment, not a row.
 */
function TerminalGroup({
  terminal,
  onChange,
  fontStack,
  shells,
  onLocateShell
}: {
  terminal: TerminalSettings
  onChange: (patch: Partial<TerminalSettings>) => void
  fontStack: string
  shells: DetectedShell[]
  onLocateShell: () => void
}): JSX.Element {
  const chosenShell = terminal.terminalShell
  // A shell picked by hand may not be one of the detected ones, and dropping it
  // out of the list would make the picker show "Detect automatically" for a
  // setting that is doing no such thing.
  const shellOptions =
    chosenShell !== null && !shells.some((s) => sameFile(s.path, chosenShell))
      ? [...shells, { path: chosenShell, name: fileName(chosenShell), label: 'Chosen by you', args: [] }]
      : shells

  return (
    <Group
      name="terminal"
      title="Terminal"
      hint="Applies to every open terminal as you change it - session panes and project shells alike."
    >
      <FontRow terminal={terminal} onChange={onChange} />

      <Divider />

      <Row label="Size" hint={`Point size, ${String(TERMINAL_FONT_SIZE.min)} to ${String(TERMINAL_FONT_SIZE.max)}.`}>
        <Stepper
          value={terminal.terminalFontSize}
          min={TERMINAL_FONT_SIZE.min}
          max={TERMINAL_FONT_SIZE.max}
          label="Terminal font size"
          data-settings-terminal-size={String(terminal.terminalFontSize)}
          onChange={(terminalFontSize) => onChange({ terminalFontSize })}
        />
      </Row>

      <Divider />

      <Row label="Cursor">
        <div
          role="radiogroup"
          aria-label="Cursor style"
          className="flex items-center gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
        >
          {TERMINAL_CURSOR_STYLES.map((style) => (
            <button
              key={style}
              type="button"
              role="radio"
              data-settings-terminal-cursor={style}
              aria-checked={terminal.terminalCursorStyle === style}
              onClick={() => onChange({ terminalCursorStyle: style })}
              className={cn(
                'rounded-[5px] px-2.5 py-1 text-[11.5px] transition-colors',
                terminal.terminalCursorStyle === style
                  ? SEGMENT_ON
                  : 'text-fg-subtle hover:text-fg'
              )}
            >
              {CURSOR_LABEL[style]}
            </button>
          ))}
        </div>
      </Row>

      <Divider />

      <Row label="Blink the cursor">
        <span data-settings-terminal-blink={String(terminal.terminalCursorBlink)}>
          <Checkbox
            checked={terminal.terminalCursorBlink}
            onChange={() => onChange({ terminalCursorBlink: !terminal.terminalCursorBlink })}
            label="Blink the terminal cursor"
          />
        </span>
      </Row>

      <Divider />

      <Row
        label="Scrollback"
        hint="Lines of history each terminal keeps. Shrinking it discards what is already past that point."
      >
        <NumberField
          value={terminal.terminalScrollback}
          min={TERMINAL_SCROLLBACK.min}
          max={TERMINAL_SCROLLBACK.max}
          label="Scrollback lines"
          data-settings-terminal-scrollback={String(terminal.terminalScrollback)}
          onCommit={(terminalScrollback) => onChange({ terminalScrollback })}
        />
      </Row>

      <Divider />

      <Row
        label="Shell for project panes"
        hint="Claude sessions are unaffected - Helm hands the CLI its own terminal. A project pane can override this for itself."
      >
        <div className="flex items-center gap-2">
          <Select
            value={chosenShell ?? ''}
            label="Default shell"
            data-settings-terminal-shell={chosenShell ?? ''}
            onChange={(value) => onChange({ terminalShell: value === '' ? null : value })}
          >
            <option value="">Detect automatically</option>
            {shellOptions.map((shell) => (
              <option key={shell.path} value={shell.path}>
                {shell.name} - {shell.label}
              </option>
            ))}
          </Select>
          <Action data-settings-terminal-shell-locate onClick={onLocateShell}>
            Choose…
          </Action>
        </div>
      </Row>

      <Divider />

      {/* The drag handle above the shell is the control for this; the row is
          here so the value is findable and so a drag that landed somewhere
          silly can be typed back. Which is also why it is a field rather than a
          stepper: nobody nudges this while watching it, because the thing it
          moves is on a different tab. */}
      <Row
        label="Shell height"
        hint="Percent of a project page the shell takes. Drag the handle above it to change it there; a project page never gives the shell more than half."
      >
        <NumberField
          value={terminal.projectShellHeightPct}
          min={PROJECT_SHELL_HEIGHT_PCT.min}
          max={PROJECT_SHELL_HEIGHT_PCT.max}
          label="Project shell height"
          data-settings-shell-height={String(terminal.projectShellHeightPct)}
          onCommit={(projectShellHeightPct) => onChange({ projectShellHeightPct })}
        />
      </Row>

      {/* The other axis, and the same argument as the row above it: the divider
          between the two panes is the control, and this is where the number
          that divider landed on can be read and retyped. */}
      <Row
        label="Session split"
        hint="Percent of the window the sessions take when a project and a session are both open. Drag the divider between them to change it there."
      >
        <NumberField
          value={terminal.sessionSplitPct}
          min={SESSION_SPLIT_PCT.min}
          max={SESSION_SPLIT_PCT.max}
          label="Session split"
          data-settings-session-split={String(terminal.sessionSplitPct)}
          onCommit={(sessionSplitPct) => onChange({ sessionSplitPct })}
        />
      </Row>

      {/* Plain DOM at the chosen font, not an xterm instance: the point is to
          see the choice before any terminal repaints, and a second terminal in
          the settings pane would be a second pty to own. The ground and the
          foreground are the terminal's own fixed pair (DESIGN.md par. 6), which
          is why they are hex here - the same exception the session tab takes. */}
      <div
        data-settings-terminal-preview
        // `lineHeight: normal` rather than a ratio of the point size, because
        // that is what a terminal row actually is: xterm measures a span in the
        // configured font and takes its box, so 14px type sits on 19px rows.
        // Pinning the rows to the point size instead would squash the preview
        // and pull the box-drawing apart at exactly the size it is meant to
        // show off.
        style={{
          fontFamily: fontStack,
          fontSize: `${String(terminal.terminalFontSize)}px`,
          lineHeight: 'normal'
        }}
        className="mt-3 overflow-x-auto rounded-well border border-border bg-terminal px-3 py-2.5 text-[#c9d1d9] select-text"
      >
        {PREVIEW_LINES.map((line) => (
          <div key={line} className="whitespace-pre">
            {line}
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] leading-[1.5] text-fg-subtle">
        The terminal keeps its own ground in both themes, so this is what a pane will look like.
      </p>
    </Group>
  )
}

/**
 * The font family row, with the "you do not have that font" hint.
 *
 * The hint is a courtesy, not a guard. Whatever is typed here is put *in front
 * of* the built-in stack rather than replacing it, so a font this machine does
 * not have simply never wins a glyph - and a font that has letters but no
 * box-drawing loses only the box-drawing. That is what makes the field safe to
 * leave open rather than restricting it to a list.
 */
function FontRow({
  terminal,
  onChange
}: {
  terminal: TerminalSettings
  onChange: (patch: Partial<TerminalSettings>) => void
}): JSX.Element {
  const saved = terminal.terminalFontFamily ?? ''
  const [draft, setDraft, reset] = useDraft(saved)

  const commit = (): void => {
    const next = draft.trim()
    if (next === saved) return
    onChange({ terminalFontFamily: next === '' ? null : next })
  }

  return (
    <Row
      label="Font"
      hint="One family name. It goes in front of Cascadia Mono and Consolas rather than replacing them, so anything it lacks still draws."
    >
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex items-center gap-2">
          <input
            type="text"
            data-settings-terminal-font={saved}
            aria-label="Terminal font family"
            placeholder="Cascadia Mono (built in)"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') reset()
            }}
            className={cn(
              'h-[30px] w-[190px] rounded-well border border-border bg-surface-sunken px-2.5',
              'font-mono text-[11.5px] text-fg placeholder:text-fg-subtle select-text',
              'focus:border-accent focus:outline-none'
            )}
          />
          <Action
            data-settings-terminal-font-clear
            onClick={() => onChange({ terminalFontFamily: null })}
            disabled={terminal.terminalFontFamily === null}
            title={
              terminal.terminalFontFamily === null
                ? 'Nothing to clear - this is the built-in stack'
                : 'Back to the built-in stack'
            }
          >
            Clear
          </Action>
        </div>
        {terminal.terminalFontFamily !== null && !fontInstalled(terminal.terminalFontFamily) && (
          <p
            data-settings-terminal-font-missing={terminal.terminalFontFamily}
            className="max-w-[280px] text-right text-[11px] leading-[1.5] text-warn"
          >
            {terminal.terminalFontFamily} is not installed on this machine, so terminals fall back
            to Cascadia Mono and Consolas.
          </p>
        )}
      </div>
    </Row>
  )
}

/**
 * A field's own copy of a value it edits, committed on blur rather than on
 * every keystroke.
 *
 * Re-seeded when the value changes underneath it - a restart, a Clear button,
 * another surface writing the same setting - by adjusting state during render,
 * which is what React documents for this. An effect would paint one frame of a
 * stale draft first and would be a cascading render besides.
 */
function useDraft(value: string): [string, (next: string) => void, () => void] {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }
  return [draft, setDraft, () => setDraft(value)]
}

/**
 * Whether this machine can actually draw that family.
 *
 * Measured, not asked. `document.fonts.check('14px "Whatever"')` is the obvious
 * call and it does not answer this question: the font set it reports on is the
 * document's `@font-face` rules, so a family it has never heard of comes back
 * **true** - verified on Chromium 2026-08-11, where a deliberately nonsense
 * name passed. What does answer it is the oldest trick there is: render a probe
 * string with the family in front of a fallback and again with the fallback
 * alone. A family that resolves changes the width; one that does not cannot.
 *
 * Two fallbacks with very different metrics, because one comparison would call
 * a font missing if it happened to match that fallback's advance exactly. At
 * 72px a real difference is tens of pixels, so this is not a close call.
 *
 * Cached: the answer cannot change while the window is open, and this runs on
 * every render of the row.
 */
const installedFonts = new Map<string, boolean>()

function fontInstalled(family: string): boolean {
  const cached = installedFonts.get(family)
  if (cached !== undefined) return cached

  let answer = true
  const context = document.createElement('canvas').getContext('2d')
  if (context !== null) {
    const width = (font: string): number => {
      context.font = font
      return context.measureText('MWMWiill 0123').width
    }
    answer = ['monospace', 'serif', 'sans-serif'].some(
      (fallback) => width(`72px "${family}", ${fallback}`) !== width(`72px ${fallback}`)
    )
  }
  installedFonts.set(family, answer)
  return answer
}

const sameFile = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

// ---------------------------------------------------------------------------

const count = (n: number, noun: string): string =>
  `${String(n)} ${noun}${n === 1 ? '' : 's'}`

/**
 * One group of settings.
 *
 * A raised card inside the pane's island, titled with the caps label every
 * other section in the app uses. Future groups append; nothing here knows how
 * many there are.
 */
function Group({
  name,
  title,
  hint,
  children
}: {
  name: string
  title: string
  hint?: string | undefined
  children: ReactNode
}): JSX.Element {
  return (
    <section
      data-settings-group={name}
      className="mt-5 overflow-hidden rounded-raised border border-border bg-surface-raised"
    >
      <header className="px-4 pt-3 pb-2.5">
        <h2 className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
          {title}
        </h2>
        {hint !== undefined && (
          <p className="mt-1 text-[11.5px] leading-[1.5] text-fg-muted">{hint}</p>
        )}
      </header>
      <div className="border-t border-border px-4 py-3">{children}</div>
    </section>
  )
}

/** Label and hint on the left, control on the right - wrapping when narrow. */
function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string | undefined
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1.5">
      <div className="min-w-[220px] flex-1">
        <p className="text-[12.5px] text-fg">{label}</p>
        {hint !== undefined && (
          <p className="mt-0.5 text-[11px] leading-[1.5] text-fg-subtle">{hint}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** Between rows in a group. Fades at the ends - DESIGN.md, `.island-rule`. */
function Divider(): JSX.Element {
  return <div aria-hidden className="island-rule my-1.5" />
}

function Actions({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mt-3 flex flex-wrap gap-2">{children}</div>
}

/**
 * The resolved-status line: a tone dot and a sentence, not a paragraph.
 *
 * Takes further `data-*` attributes so a group with more than one thing to say
 * can name *which* of its states this sentence is - the tone alone cannot,
 * since two different outcomes can honestly share one. `data-settings-verdict`
 * stays the tone in every group, so a driver reads the two together.
 */
function Verdict({
  tone,
  text,
  ...rest
}: { tone: 'ok' | 'warn' | 'todo'; text: string } & Record<
  `data-${string}`,
  unknown
>): JSX.Element {
  return (
    <p
      data-settings-verdict={tone}
      {...rest}
      className="flex items-center gap-2 text-[12.5px] text-fg"
    >
      <span
        className={cn(
          'grid size-4 shrink-0 place-items-center rounded-full',
          tone === 'ok'
            ? 'bg-success/15 text-success'
            : tone === 'warn'
              ? 'bg-warn/15 text-warn'
              : 'bg-surface-sunken text-fg-subtle'
        )}
      >
        {tone === 'ok' ? (
          <CheckIcon width={9} height={9} />
        ) : tone === 'warn' ? (
          <WarnIcon width={9} height={9} />
        ) : null}
      </span>
      {text}
    </p>
  )
}

/** A machine fact: a caps label and a mono value that can be selected. */
function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-[52px] shrink-0 text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted select-text">
        {children}
      </dd>
    </div>
  )
}

/**
 * A bounded integer with two buttons.
 *
 * Buttons rather than a text field because the range is small and every value
 * in it is one the user might want to sit and look at: this is a setting people
 * nudge until the terminal looks right, and every nudge repaints every open
 * pane. It also means the control cannot produce a value the validator would
 * reject, so the two never have to disagree.
 */
function Stepper({
  value,
  min,
  max,
  label,
  onChange,
  ...rest
}: {
  value: number
  min: number
  max: number
  label: string
  onChange: (value: number) => void
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <div
      {...rest}
      className="flex items-center gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
    >
      <StepButton
        label={`Decrease ${label.toLowerCase()}`}
        glyph="−"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      />
      <span
        aria-live="polite"
        aria-label={label}
        className="w-9 text-center font-mono text-[11.5px] tabular-nums text-fg"
      >
        {value}
      </span>
      <StepButton
        label={`Increase ${label.toLowerCase()}`}
        glyph="+"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      />
    </div>
  )
}

function StepButton({
  label,
  glyph,
  disabled,
  onClick
}: {
  label: string
  glyph: string
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid size-6 place-items-center rounded-[5px] text-[13px] leading-none transition-colors',
        'text-fg-subtle hover:bg-hover hover:text-fg',
        'disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent'
      )}
    >
      {glyph}
    </button>
  )
}

/**
 * A number too large for a stepper, committed on blur or Enter rather than per
 * keystroke - typing "25000" through a live write would ask for 2, then 25,
 * then 250, and every one of those is a scrollback truncation.
 */
function NumberField({
  value,
  min,
  max,
  label,
  onCommit,
  ...rest
}: {
  value: number
  min: number
  max: number
  label: string
  onCommit: (value: number) => void
} & Record<`data-${string}`, unknown>): JSX.Element {
  const [draft, setDraft, reset] = useDraft(String(value))

  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10)
    if (!Number.isFinite(parsed)) {
      reset()
      return
    }
    const clamped = Math.min(max, Math.max(min, parsed))
    setDraft(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') reset()
      }}
      {...rest}
      className={cn(
        'h-[30px] w-[92px] rounded-well border border-border bg-surface-sunken px-2.5',
        'text-right font-mono text-[11.5px] tabular-nums text-fg select-text',
        'focus:border-accent focus:outline-none'
      )}
    />
  )
}

/**
 * A native `<select>` in the sunken-well shape, matching the one in
 * `ProfileEditor`. Native and not a listbox of our own for the same reason: a
 * driver sets it through `HTMLSelectElement.prototype.value`, and a div cannot
 * be set that way.
 */
function Select({
  value,
  onChange,
  label,
  children,
  ...rest
}: {
  value: string
  onChange: (value: string) => void
  label: string
  children: ReactNode
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <span className="relative block">
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
        className={cn(
          'h-[30px] w-[220px] appearance-none rounded-well border border-border bg-surface-sunken',
          'pr-7 pl-2.5 text-[12px] text-fg transition-colors',
          'hover:border-border-strong focus:border-accent focus:outline-none'
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

/** The one control the system allows a solid accent fill (DESIGN.md par. 4). */

function Action({
  children,
  onClick,
  disabled = false,
  primary = false,
  ...rest
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  title?: string
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...rest}
      className={cn(
        'rounded-well border px-3 py-1.5 text-[12px] transition-colors',
        'disabled:cursor-default disabled:opacity-50',
        primary
          ? 'border-accent text-accent-text hover:bg-accent-soft'
          : 'border-border-strong text-fg hover:bg-hover'
      )}
    >
      {children}
    </button>
  )
}

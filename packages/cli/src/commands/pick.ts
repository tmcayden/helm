import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CommandContext } from '../command.ts'
import { knownHarnesses, knownProfiles } from '../context.ts'
import { print, warn } from '../output.ts'
import { insideTmux, pick, tmux, type PickRow } from '../picker.ts'
import type { ProfileEntry } from '../profiles.ts'
import { colours, columns, type Painters } from '../theme.ts'

/** `name  model/effort  mode  prompt  overlays`, the name in text and the rest dim; the name and harness ride along hidden for the preview. */
export function profileRows(entries: readonly ProfileEntry[], paint: Painters = colours(true)): PickRow<ProfileEntry>[] {
  const usable = entries.filter((e) => e.draft !== null)
  const cells = usable.map((e) => {
    const d = e.draft
    return [
      e.name,
      paint.dim(`${d?.model ?? '-'}/${d?.effort ?? '-'}`),
      paint.dim(d?.permissionMode ?? 'default'),
      paint.dim(d?.openingPrompt === null || d?.openingPrompt === undefined ? '-' : d.openingPrompt.length > 32 ? `${d.openingPrompt.slice(0, 31)}…` : d.openingPrompt),
      paint.dim(`${String(d?.overlays.length ?? 0)} overlays`)
    ]
  })
  return columns(cells).map((label, i) => {
    const entry = usable[i] as ProfileEntry
    return { label, value: entry, keys: [entry.name, entry.harness] }
  })
}

/** The preview column: the profile card, painted although fzf's preview is a pipe. */
export const PROFILE_PREVIEW = 'helm profile show {2} --harness {3} --color'

/**
 * Meant for `tmux display-popup -E`. The popup inherits `$TMUX`, so
 * `new-window` lands in the session the popup was opened from; outside tmux
 * the launch runs in place. Cancel is exit 0 with nothing printed.
 */
export async function pickProfile(_ctx: CommandContext): Promise<number> {
  const entries = await knownProfiles()
  const chosen = pick(profileRows(entries), { name: 'profile', hint: 'Enter new window here', preview: PROFILE_PREVIEW })
  if (chosen === null || chosen.draft === null) return 0
  const command = ['helm', 'launch', chosen.name, '--harness', chosen.harness]
  if (insideTmux()) {
    tmux(['new-window', '-c', chosen.draft.root, '-n', chosen.name, '--', ...command])
    return 0
  }
  warn('Not inside tmux, so launching here.')
  const { launch } = await import('./launch.ts')
  return launch({
    args: { positionals: [chosen.name], flags: { harness: chosen.harness }, passthrough: [] },
    json: false
  })
}

const CONVENTION_DIRS = ['skills', 'agents', 'commands'] as const

/** `3 skills · 1 agent`, from one readdir per convention directory; nothing is opened. */
export function claudeSummary(dir: string): string {
  const parts: string[] = []
  for (const kind of CONVENTION_DIRS) {
    let n: number
    try {
      n = readdirSync(join(dir, '.claude', kind), { withFileTypes: true }).filter((d) => d.isDirectory() || d.name.endsWith('.md')).length
    } catch {
      continue
    }
    if (n > 0) parts.push(`${String(n)} ${n === 1 ? kind.slice(0, -1) : kind}`)
  }
  return parts.length === 0 ? 'no skills, agents or commands' : parts.join(' · ')
}

export function scopeRows(scopes: readonly Scope[], paint: Painters = colours(true)): PickRow<Scope>[] {
  const cells = scopes.map((s) => [s.kind, s.dir, paint.dim(claudeSummary(s.dir))])
  return columns(cells).map((label, i) => ({ label, value: scopes[i] as Scope }))
}

export interface Scope {
  kind: 'user' | 'harness' | 'repo'
  /** The directory whose `.claude` this is. `helm view config <dir>` takes it. */
  dir: string
}

/** User, every known harness, then each owned repository that has a `.claude`. */
export function configScopes(harnesses: readonly string[], home: string = homedir()): Scope[] {
  const scopes: Scope[] = [{ kind: 'user', dir: home }]
  for (const harness of harnesses) {
    scopes.push({ kind: 'harness', dir: harness })
    const repos = join(harness, 'repos')
    let names: string[]
    try {
      names = readdirSync(repos, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    } catch {
      continue
    }
    for (const name of names) {
      const dir = join(repos, name)
      if (existsSync(join(dir, '.claude'))) scopes.push({ kind: 'repo', dir })
    }
  }
  return scopes
}

/**
 * Prints the chosen scope's directory - the parent of its `.claude`, never the
 * `.claude` itself - on one line, and nothing on cancel. That is the contract
 * `helm view config "$(helm pick scope)"` relies on: an empty argument is "the
 * user cancelled", so `view config ""` must exit 0 quietly.
 */
export async function pickScope(ctx: CommandContext): Promise<number> {
  const scopes = configScopes(await knownHarnesses())
  const chosen = pick(scopeRows(scopes), { name: 'scope', hint: 'Enter → pane with nvim on that tree' })
  if (chosen === null) return 0
  // `--view` is the helm table's `c` row: pick in the popup, then open the pane
  // from inside it, because a shell one-liner in a tmux binding cannot quote
  // an empty result and an empty result is the cancel.
  if (ctx.args.flags['view'] === true && insideTmux()) {
    tmux(['split-window', '-h', '-c', chosen.dir, '--', 'helm', 'view', 'config', chosen.dir])
    return 0
  }
  print(chosen.dir)
  return 0
}

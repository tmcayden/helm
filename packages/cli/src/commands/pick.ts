import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CommandContext } from '../command.ts'
import { knownHarnesses, knownProfiles } from '../context.ts'
import { print, warn } from '../output.ts'
import { insideTmux, pick, tmux } from '../picker.ts'
import type { ProfileEntry } from '../profiles.ts'

export function profileRows(entries: readonly ProfileEntry[]) {
  return entries
    .filter((e) => e.draft !== null)
    .map((e) => ({
      label: `${e.name}\t${e.harness}\t${e.draft?.model ?? '-'}/${e.draft?.effort ?? '-'}`,
      value: e
    }))
}

/**
 * Meant for `tmux display-popup -E`. The popup inherits `$TMUX`, so
 * `new-window` lands in the session the popup was opened from; outside tmux
 * the launch runs in place. Cancel is exit 0 with nothing printed.
 */
export async function pickProfile(_ctx: CommandContext): Promise<number> {
  const entries = await knownProfiles()
  const chosen = pick(profileRows(entries), 'profile')
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
  const chosen = pick(
    scopes.map((s) => ({ label: `${s.kind.padEnd(7)}\t${s.dir}`, value: s })),
    'scope'
  )
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

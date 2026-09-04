import { spawnSync } from 'node:child_process'
import { findEnclosingHarness } from '@helm/core'
import { knownProfiles } from './context.ts'
import { CliError } from './output.ts'
import { insideTmux } from './picker.ts'
import { readHarnessProfiles, resolveProfile, type ProfileEntry } from './profiles.ts'

export type ProfileSource = 'flag' | 'tmux' | 'harness'

/** Window first, then session: `-w` does not inherit a session option, so it is two lookups (TERMINAL.md 9). */
export function tmuxProfileName(run: (args: string[]) => string | null = runTmux): string | null {
  if (!insideTmux()) return null
  for (const args of [['show-option', '-wqv', '@helm_profile'], ['show-option', '-qv', '@helm_profile']]) {
    const value = run(args)?.trim() ?? ''
    if (value !== '' && value !== 'n') return value
  }
  return null
}

function runTmux(args: string[]): string | null {
  const result = spawnSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return result.status === 0 ? result.stdout : null
}

/**
 * The profile a command with no explicit name is about: the flag, else what
 * the `claude` shell function would launch here (`@helm_profile`), else the
 * one profile of the harness enclosing the cwd. Anything less definite is an
 * error naming `--profile` rather than a guess.
 */
export async function resolveContextProfile(
  flag: string | null,
  cwd: string = process.cwd()
): Promise<{ entry: ProfileEntry; resolvedBy: ProfileSource }> {
  if (flag !== null) return { entry: await byName(flag), resolvedBy: 'flag' }

  const fromTmux = tmuxProfileName()
  if (fromTmux !== null) return { entry: await byName(fromTmux), resolvedBy: 'tmux' }

  const harness = await findEnclosingHarness(cwd)
  const entries = harness === null ? [] : readHarnessProfiles(harness)
  if (entries.length === 1) return { entry: entries[0] as ProfileEntry, resolvedBy: 'harness' }
  if (entries.length === 0) {
    throw new CliError('No profile is set on this tmux window or session and no harness with one profile encloses the cwd - pass --profile <name>.')
  }
  throw new CliError(`${harness ?? ''} has ${String(entries.length)} profiles - pass --profile <name>.`)
}

async function byName(name: string): Promise<ProfileEntry> {
  const found = resolveProfile(await knownProfiles(), name)
  if (found.kind === 'missing') throw new CliError(`No profile named "${name}" in any known harness - see helm profile list.`)
  if (found.kind === 'ambiguous') {
    throw new CliError(`"${name}" is a profile in more than one harness (${found.candidates.map((c) => c.harness).join(', ')}).`)
  }
  return found.entry
}

/** A usable draft, or the file's problems as the error. */
export function requireDraft(entry: ProfileEntry): NonNullable<ProfileEntry['draft']> {
  if (entry.draft === null || entry.problems.length > 0) throw new CliError(`${entry.file}: ${entry.problems.join(' ')}`)
  return entry.draft
}

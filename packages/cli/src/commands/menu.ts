import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { CommandContext } from '../command.ts'
import { knownHarnesses } from '../context.ts'
import { insideTmux, pick, tmux, waitForKey } from '../picker.ts'
import { PROFILES_DIR } from '../profiles.ts'
import { print, warn } from '../output.ts'
import { askHarnessNew } from './harness-new.ts'
import { colours, columns } from '../theme.ts'

type Row = { key: string; label: string; description: string; run: () => Promise<number> }

/** Short-lived things stay in the popup; long-lived ones get a window or pane (TERMINAL.md 5). */
function inPopup(args: string[]): Promise<number> {
  const result = spawnSync('helm', args, { stdio: 'inherit' })
  return Promise.resolve(result.status ?? 1)
}

function thenWait(args: string[]): () => Promise<number> {
  return async () => {
    const code = await inPopup(args)
    if (insideTmux()) waitForKey()
    return code
  }
}

/**
 * The prompts, then the command, in the popup itself: `helm harness new` in a
 * window of its own exited on its missing directory before anyone saw why.
 */
async function newHarness(): Promise<number> {
  const args = await askHarnessNew()
  if (args === null) return 0
  return thenWait(args)()
}

/** The label, then a dim description. The rows' letters are not shown: `k` is vim's up, so no letter can be an accelerator without the set being uneven. */
export function menuRows<R extends { label: string; description: string }>(rows: readonly R[], paint = colours(true)): { label: string; value: R }[] {
  return columns(rows.map((r) => [r.label, paint.dim(r.description)])).map((label, i) => ({ label, value: rows[i] as R }))
}

export async function menu(_ctx: CommandContext): Promise<number> {
  const rows: Row[] = [
    { key: 'l', label: 'launch', description: 'pick a profile and start a session', run: () => inPopup(['pick', 'profile']) },
    { key: 'n', label: 'new harness', description: 'create a harness from a template', run: newHarness },
    { key: 'p', label: 'new profile', description: 'create a profile interactively', run: () => inPopup(['profile', 'new']) },
    { key: 'e', label: 'edit profiles', description: "open a harness's profiles in $EDITOR", run: editProfiles },
    { key: 'h', label: 'history', description: 'the session index', run: thenWait(['history']) },
    { key: 's', label: 'sessions', description: 'live sessions on this machine', run: thenWait(['sessions']) },
    { key: 'c', label: 'config', description: 'a .claude tree in nvim', run: viewConfig },
    { key: 'd', label: 'doctor', description: "claude doctor plus Helm's checks", run: thenWait(['doctor']) },
    { key: 'k', label: 'keys', description: "Helm's keybinds", run: () => inPopup(['keys']) }
  ]
  const chosen = pick(menuRows(rows), { name: 'helm', hint: 'Enter' })
  if (chosen === null) return 0
  try {
    return await chosen.run()
  } catch (err) {
    // A popup is `-E`: an error that reached main.ts would close it unread.
    warn(err instanceof Error ? err.message : String(err))
    if (insideTmux()) waitForKey()
    return 1
  }
}

async function editProfiles(): Promise<number> {
  const harnesses = await knownHarnesses()
  const harness =
    harnesses.length === 1 ? harnesses[0] : pick(harnesses.map((h) => ({ label: h, value: h })), { name: 'harness', hint: 'Enter' })
  if (harness === undefined || harness === null) return 0
  const editor = process.env['EDITOR'] ?? 'nvim'
  const dir = join(harness, PROFILES_DIR)
  if (insideTmux()) {
    tmux(['new-window', '-c', harness, '-n', 'profiles', '--', editor, dir])
    return 0
  }
  return spawnSync(editor, [dir], { stdio: 'inherit' }).status ?? 1
}

async function viewConfig(): Promise<number> {
  const result = spawnSync('helm', ['pick', 'scope'], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' })
  const scope = result.stdout.trim()
  if (scope === '') return 0
  if (insideTmux()) {
    tmux(['split-window', '-h', '--', 'helm', 'view', 'config', scope])
    return 0
  }
  print(scope)
  return inPopup(['view', 'config', scope])
}

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { CommandContext } from '../command.ts'
import { knownHarnesses } from '../context.ts'
import { insideTmux, pick, tmux } from '../picker.ts'
import { PROFILES_DIR } from '../profiles.ts'
import { print } from '../output.ts'
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
    if (insideTmux()) spawnSync('sh', ['-c', 'printf "\\n[enter to close] "; read _'], { stdio: 'inherit' })
    return code
  }
}

function inWindow(name: string, args: string[]): () => Promise<number> {
  return async () => {
    if (!insideTmux()) return inPopup(args)
    tmux(['new-window', '-n', name, '--', 'helm', ...args])
    return 0
  }
}

/** The key letter in text, the label, then a dim description. */
export function menuRows<R extends { key: string; label: string; description: string }>(rows: readonly R[], paint = colours(true)): { label: string; value: R }[] {
  return columns(rows.map((r) => [paint.text(r.key), r.label, paint.dim(r.description)])).map((label, i) => ({ label, value: rows[i] as R }))
}

export async function menu(_ctx: CommandContext): Promise<number> {
  const rows: Row[] = [
    { key: 'l', label: 'launch', description: 'pick a profile and start a session', run: () => inPopup(['pick', 'profile']) },
    { key: 'n', label: 'new harness', description: 'create a harness from a template', run: inWindow('harness', ['harness', 'new']) },
    { key: 'p', label: 'new profile', description: 'create a profile interactively', run: () => inPopup(['profile', 'new']) },
    { key: 'e', label: 'edit profiles', description: "open a harness's profiles in $EDITOR", run: editProfiles },
    { key: 'h', label: 'history', description: 'the session index', run: thenWait(['history']) },
    { key: 's', label: 'sessions', description: 'live sessions on this machine', run: thenWait(['sessions']) },
    { key: 'c', label: 'config', description: 'a .claude tree in nvim', run: viewConfig },
    { key: 'd', label: 'doctor', description: "claude doctor plus Helm's checks", run: thenWait(['doctor']) },
    { key: 'k', label: 'keys', description: "Helm's keybinds", run: () => inPopup(['keys']) }
  ]
  const chosen = pick(menuRows(rows), { name: 'helm', hint: 'Enter · Esc' })
  return chosen === null ? 0 : chosen.run()
}

async function editProfiles(): Promise<number> {
  const harnesses = await knownHarnesses()
  const harness =
    harnesses.length === 1 ? harnesses[0] : pick(harnesses.map((h) => ({ label: h, value: h })), { name: 'harness', hint: 'Enter · Esc' })
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

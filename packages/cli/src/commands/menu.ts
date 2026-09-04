import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { CommandContext } from '../command.ts'
import { knownHarnesses } from '../context.ts'
import { insideTmux, pick, tmux } from '../picker.ts'
import { PROFILES_DIR } from '../profiles.ts'
import { print } from '../output.ts'

type Row = { label: string; run: () => Promise<number> }

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

export async function menu(_ctx: CommandContext): Promise<number> {
  const rows: Row[] = [
    { label: 'launch         pick a profile and start a session', run: () => inPopup(['pick', 'profile']) },
    { label: 'new harness    create a harness from a template', run: inWindow('harness', ['harness', 'new']) },
    { label: 'new profile    create a profile interactively', run: () => inPopup(['profile', 'new']) },
    { label: 'edit profiles  open a harness\'s profiles in $EDITOR', run: editProfiles },
    { label: 'history        the session index', run: thenWait(['history']) },
    { label: 'sessions       live sessions on this machine', run: thenWait(['sessions']) },
    { label: 'config         a .claude tree in nvim', run: viewConfig },
    { label: 'doctor         claude doctor plus Helm\'s checks', run: thenWait(['doctor']) }
  ]
  const chosen = pick(rows.map((row) => ({ label: row.label, value: row })), 'helm')
  return chosen === null ? 0 : chosen.run()
}

async function editProfiles(): Promise<number> {
  const harnesses = await knownHarnesses()
  const harness = harnesses.length === 1 ? harnesses[0] : pick(harnesses.map((h) => ({ label: h, value: h })), 'harness')
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

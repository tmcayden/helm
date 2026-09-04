import { closeSync, openSync, readSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { CommandContext } from '../command.ts'
import { print, printJson, table } from '../output.ts'
import { HELM_BINDINGS } from '../snippets.ts'

interface Chord {
  keys: string
  description: string
}

/** The other two leader places (TERMINAL.md 5); the letters match the tmux table. */
export const ZSH_CHORDS: readonly Chord[] = [{ keys: 'ctrl+a Space', description: 'the Helm menu, through the zsh chord table' }]

/** helm.nvim's buffer-local mappings, as `packages/nvim/lua/helm/init.lua` sets them. */
export const NVIM_KEYS: readonly Chord[] = [
  { keys: '<CR>', description: 'open the file the line is about' },
  { keys: 'q', description: 'close the buffer, or quit when it is the only one' },
  { keys: '<leader>hr', description: 'repaint' }
]

export function renderKeys(): string {
  const rows = (chords: readonly Chord[]) => table(chords.map((c) => [`  ${c.keys}`, c.description]))
  return [
    'prefix Space, then:',
    rows(HELM_BINDINGS.map((b) => ({ keys: b.key, description: b.description }))),
    '',
    'outside tmux:',
    rows(ZSH_CHORDS),
    '',
    'in a helm.nvim buffer:',
    rows(NVIM_KEYS)
  ].join('\n')
}

/** In a `display-popup -E` both ends are the tty; the popup would otherwise close as soon as it painted. */
function inPopup(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true
}

function waitForKey(): void {
  let fd: number
  try {
    fd = openSync('/dev/tty', 'r')
  } catch {
    return
  }
  spawnSync('stty', ['raw', '-echo'], { stdio: [fd, 'ignore', 'ignore'] })
  try {
    readSync(fd, Buffer.alloc(1), 0, 1, null)
  } finally {
    spawnSync('stty', ['sane'], { stdio: [fd, 'ignore', 'ignore'] })
    closeSync(fd)
  }
}

export function keys(ctx: CommandContext): Promise<number> {
  if (ctx.json) {
    printJson({ bindings: HELM_BINDINGS, nvim: NVIM_KEYS, zsh: ZSH_CHORDS })
    return Promise.resolve(0)
  }
  print(renderKeys())
  if (inPopup()) {
    print('\npress any key')
    waitForKey()
  }
  return Promise.resolve(0)
}

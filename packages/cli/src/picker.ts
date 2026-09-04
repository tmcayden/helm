import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readSync } from 'node:fs'
import { CliError } from './output.ts'

export interface PickRow<T> {
  label: string
  value: T
}

function hasFzf(): boolean {
  return spawnSync('fzf', ['--version'], { stdio: 'ignore' }).status === 0
}

/**
 * One choice from a list, for a `tmux display-popup -E`. `fzf` when it is on
 * PATH; otherwise a numbered prompt read from the controlling tty, so it works
 * even when stdin is not the terminal. Null is a cancel, never an error.
 */
export function pick<T>(rows: readonly PickRow<T>[], prompt: string): T | null {
  if (rows.length === 0) return null
  if (hasFzf()) return pickWithFzf(rows, prompt)
  return pickNumbered(rows, prompt)
}

function pickWithFzf<T>(rows: readonly PickRow<T>[], prompt: string): T | null {
  const result = spawnSync(
    'fzf',
    ['--prompt', `${prompt}> `, '--with-nth', '2..', '--delimiter', '\t', '--no-multi', '--layout=reverse'],
    { input: rows.map((row, i) => `${String(i)}\t${row.label}`).join('\n'), stdio: ['pipe', 'pipe', 'inherit'], encoding: 'utf8' }
  )
  if (result.status !== 0) return null
  const index = Number.parseInt(result.stdout.split('\t')[0] ?? '', 10)
  return rows[index]?.value ?? null
}

function pickNumbered<T>(rows: readonly PickRow<T>[], prompt: string): T | null {
  const lines = rows.map((row, i) => `${String(i + 1).padStart(3)}  ${row.label}`)
  process.stderr.write(`${lines.join('\n')}\n${prompt} (number, empty to cancel): `)
  const answer = readTtyLine()
  if (answer === null || answer.trim() === '') return null
  const n = Number.parseInt(answer, 10)
  if (!Number.isFinite(n) || n < 1 || n > rows.length) throw new CliError(`${answer.trim()} is not one of the choices.`)
  return rows[n - 1]?.value ?? null
}

export function readTtyLine(): string | null {
  let fd: number
  try {
    fd = openSync('/dev/tty', 'r')
  } catch {
    return null
  }
  const buf = Buffer.alloc(1)
  let out = ''
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, 1, null)
      if (n === 0) break
      const ch = buf.toString('utf8')
      if (ch === '\n') break
      out += ch
    }
  } finally {
    closeSync(fd)
  }
  return out
}

/** Whether this process is inside tmux, popup or pane alike. */
export function insideTmux(): boolean {
  return (process.env['TMUX'] ?? '') !== ''
}

/** Runs a tmux command, or fails in one sentence. */
export function tmux(args: readonly string[]): void {
  const result = spawnSync('tmux', [...args], { stdio: 'inherit' })
  if (result.status !== 0) throw new CliError(`tmux ${args[0] ?? ''} failed.`)
}

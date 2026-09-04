import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readSync } from 'node:fs'
import { CliError } from './output.ts'
import { fzfArgs, stripAnsi } from './theme.ts'

export interface PickRow<T> {
  /** What the row shows; may carry ANSI colour, fzf runs with `--ansi`. */
  label: string
  value: T
  /** Hidden fields a `PickLook.preview` command reaches as `{2}`, `{3}`, ... in row order. */
  keys?: readonly string[]
}

export interface PickLook {
  /** The word before `>` in the numbered fallback, e.g. `profile`. */
  name: string
  /** What Enter does, e.g. `Enter new window here`; the hint line adds the movement and search keys around it. */
  hint: string
  /** A shell command fzf runs for the current row, with `{N}` naming the row's hidden keys. */
  preview?: string
}

function hasFzf(): boolean {
  return spawnSync('fzf', ['--version'], { stdio: 'ignore' }).status === 0
}

/**
 * One choice from a list, for a `tmux display-popup -E`. `fzf` when it is on
 * PATH; otherwise a numbered prompt read from the controlling tty, so it works
 * even when stdin is not the terminal. Null is a cancel, never an error.
 */
export function pick<T>(rows: readonly PickRow<T>[], look: PickLook): T | null {
  if (rows.length === 0) return null
  if (hasFzf()) return pickWithFzf(rows, look)
  return pickNumbered(rows, look.name)
}

/**
 * Each fzf line is `index \t keys... \t label`; only the label is shown, and
 * `--nth` is left alone because with `--with-nth` fzf counts fields on the
 * shown line - `--nth=<hidden+1>..` named a field that no longer existed and
 * every query matched nothing.
 */
export function pickerFzfArgs(look: PickLook, hiddenFields: number): string[] {
  return [...fzfArgs({ hint: look.hint, preview: look.preview }), '--delimiter=\t', `--with-nth=${String(hiddenFields + 1)}..`]
}

function pickWithFzf<T>(rows: readonly PickRow<T>[], look: PickLook): T | null {
  const result = spawnSync(
    'fzf',
    pickerFzfArgs(look, 1 + (rows[0]?.keys?.length ?? 0)),
    {
      input: rows.map((row, i) => [String(i), ...(row.keys ?? []), row.label].join('\t')).join('\n'),
      stdio: ['pipe', 'pipe', 'inherit'],
      encoding: 'utf8'
    }
  )
  if (result.status !== 0) return null
  const index = Number.parseInt(result.stdout.split('\t')[0] ?? '', 10)
  return rows[index]?.value ?? null
}

function pickNumbered<T>(rows: readonly PickRow<T>[], prompt: string): T | null {
  const lines = rows.map((row, i) => `${String(i + 1).padStart(3)}  ${stripAnsi(row.label)}`)
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

/**
 * Holds a popup open until a key is pressed. `read` would want Enter, and the
 * popup is `-E`, so without this the last thing a command printed is gone
 * before anyone reads it.
 */
export function waitForKey(message = '[any key to close]'): void {
  process.stderr.write(`\n${message} `)
  spawnSync('sh', ['-c', 'stty raw -echo; dd bs=1 count=1 2>/dev/null; stty sane'], { stdio: ['inherit', 'ignore', 'ignore'] })
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

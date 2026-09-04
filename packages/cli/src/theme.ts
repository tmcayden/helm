/**
 * The one palette every popup paints from, mirrored from the owner's mockup
 * (TERMINAL.md 5). tmux draws the frame, fzf draws the list, and the commands
 * paint their own text; all three read these constants so the popups match.
 */
export const PALETTE = {
  panel: '#1A1C2B',
  text: '#DCDFE8',
  muted: '#7C819A',
  dim: '#4E526A',
  accent: '#9184D9',
  cursor: '#262940',
  edge: '#2A2D40',
  ok: '#8FBF7F',
  warn: '#D9B36C',
  bad: '#D97C76'
} as const

/** The `display-popup` flags that give a popup the palette's frame and its title. */
export function popupTmuxArgs(title: string): string {
  return `-b rounded -s 'bg=${PALETTE.panel},fg=${PALETTE.text}' -S 'fg=${PALETTE.accent}' -T ' ${title} '`
}

export interface FzfLook {
  /** The dim hint line under the prompt, e.g. `Enter new window here · Esc`. */
  header: string
  prompt?: string
  /** A shell command with fzf `{N}` placeholders; given, the list gets a preview column. */
  preview?: string | undefined
}

const FZF_COLOURS = [
  `bg:${PALETTE.panel}`,
  `bg+:${PALETTE.cursor}`,
  `fg:${PALETTE.text}`,
  `fg+:${PALETTE.text}`,
  `hl:${PALETTE.accent}`,
  `hl+:${PALETTE.accent}`,
  `pointer:${PALETTE.accent}`,
  `prompt:${PALETTE.muted}`,
  `header:${PALETTE.dim}`,
  `info:${PALETTE.dim}`,
  `border:${PALETTE.edge}`,
  `preview-bg:${PALETTE.panel}`,
  `preview-border:${PALETTE.edge}`,
  `gutter:${PALETTE.panel}`
].join(',')

/** fzf flags for a popup list: rows from the top with the prompt at the bottom, no chrome of its own, the palette, and `▸` on the current row. */
export function fzfArgs(look: FzfLook): string[] {
  const args = [
    '--ansi',
    '--layout=reverse-list',
    '--border=none',
    '--no-separator',
    '--info=hidden',
    '--no-multi',
    '--pointer=▸',
    `--prompt=${look.prompt ?? '> '}`,
    `--header=${look.header}`,
    `--color=${FZF_COLOURS}`
  ]
  if (look.preview !== undefined) args.push(`--preview=${look.preview}`, '--preview-window=right,45%,border-left')
  return args
}

export type Paint = (text: string) => string

export interface Painters {
  text: Paint
  muted: Paint
  dim: Paint
  accent: Paint
  ok: Paint
  warn: Paint
  bad: Paint
}

/**
 * `NO_COLOR` wins; otherwise a tty, or `FORCE_COLOR` for a pipe that renders
 * escapes anyway - fzf's preview is one, so `helm profile show` is run with it.
 */
export function colourEnabled(env: NodeJS.ProcessEnv = process.env, tty: boolean = process.stdout.isTTY === true): boolean {
  if ((env['NO_COLOR'] ?? '') !== '') return false
  return tty || (env['FORCE_COLOR'] ?? '') !== ''
}

function truecolour(hex: string): Paint {
  const n = Number.parseInt(hex.slice(1), 16)
  const open = `[38;2;${String((n >> 16) & 255)};${String((n >> 8) & 255)};${String(n & 255)}m`
  return (text) => `${open}${text}[39m`
}

const plain: Paint = (text) => text

export function colours(enabled: boolean = colourEnabled()): Painters {
  const paint = (hex: string) => (enabled ? truecolour(hex) : plain)
  return {
    text: paint(PALETTE.text),
    muted: paint(PALETTE.muted),
    dim: paint(PALETTE.dim),
    accent: paint(PALETTE.accent),
    ok: paint(PALETTE.ok),
    warn: paint(PALETTE.warn),
    bad: paint(PALETTE.bad)
  }
}

const ESC = String.fromCharCode(27)
export const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/** Fixed columns over painted cells: widths are measured on the visible text. */
export function columns(rows: readonly (readonly string[])[], gap = '  '): string[] {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length)
    })
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell + ' '.repeat((widths[i] ?? 0) - stripAnsi(cell).length)))
      .join(gap)
  )
}

import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { PALETTE, colourEnabled, colours, columns, fzfArgs, popupTmuxArgs, stripAnsi } from './theme.ts'

const present = (bin: string, args: string[]) => spawnSync(bin, args, { stdio: 'ignore' }).status === 0

describe('theme', () => {
  it('paints truecolour only when allowed, and strips what it painted', () => {
    expect(colourEnabled({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false)
    expect(colourEnabled({}, false)).toBe(false)
    expect(colourEnabled({ FORCE_COLOR: '1' }, false)).toBe(true)
    expect(colourEnabled({}, true)).toBe(true)
    const painted = colours(true).accent('x')
    expect(painted).toBe('[38;2;145;132;217mx[39m')
    expect(stripAnsi(painted)).toBe('x')
    expect(colours(false).bad('x')).toBe('x')
  })

  it('aligns columns on visible width', () => {
    const paint = colours(true)
    const rows = columns([[paint.dim('a'), 'end'], ['long', 'end']])
    expect(rows.map((r) => stripAnsi(r))).toEqual(['a     end', 'long  end'])
  })

  it('names the popup frame from the palette', () => {
    expect(popupTmuxArgs('helm')).toBe(`-b rounded -s 'bg=${PALETTE.panel},fg=${PALETTE.text}' -S 'fg=${PALETTE.accent}' -T ' helm '`)
  })

  it.skipIf(!present('fzf', ['--version']))('produces flags fzf accepts, with and without a preview', () => {
    for (const look of [{ header: 'h' }, { header: 'h', preview: 'echo {2}' }]) {
      const run = spawnSync('fzf', [...fzfArgs(look), '--filter=a'], { input: 'a\nb', encoding: 'utf8' })
      expect(run.stderr, JSON.stringify(look)).toBe('')
      expect(run.stdout).toBe('a\n')
    }
  })

  it.skipIf(!present('tmux', ['-V']))('produces display-popup flags tmux 3.4 accepts', () => {
    const socket = `helmtheme-${String(process.pid)}`
    const t = (...args: string[]) => spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' })
    try {
      expect(t('-f', '/dev/null', 'new-session', '-d').status).toBe(0)
      const bind = t('bind-key', '-T', 'helm', 'p', `display-popup -E ${popupTmuxArgs('helm launch · pick a profile')} true`)
      expect(bind.stderr).toBe('')
      const listed = t('list-keys', '-T', 'helm').stdout
      expect(listed).toContain('-b rounded')
      expect(listed).toContain(PALETTE.accent)
      expect(listed).toContain('pick a profile')
    } finally {
      t('kill-server')
    }
  })
})

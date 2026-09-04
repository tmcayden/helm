import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HELM_BINDINGS, TMUX_SNIPPET, ZSH_SNIPPET } from './snippets.ts'

const present = (bin: string, args: string[]) => spawnSync(bin, args, { stdio: 'ignore' }).status === 0

describe.skipIf(!present('tmux', ['-V']))('helm.tmux on a throwaway server', () => {
  it('binds every row of HELM_BINDINGS and appends the status segment once however often it is sourced', () => {
    const socket = `helmtest-${String(process.pid)}`
    const file = join(mkdtempSync(join(tmpdir(), 'helm-tmux-')), 'helm.tmux')
    writeFileSync(file, TMUX_SNIPPET)
    const t = (...args: string[]) => spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' })
    try {
      const start = t('-f', file, 'new-session', '-d')
      expect(start.status, start.stderr).toBe(0)
      t('source-file', file)
      t('source-file', file)
      const keys = t('list-keys', '-T', 'helm').stdout
      for (const { key } of HELM_BINDINGS) {
        const escaped = key.replace(/[?]/g, '\\$&')
        expect(keys.match(new RegExp(`-T helm\\s+${escaped}\\s`, 'g')), key).toHaveLength(1)
      }
      expect(t('list-keys', '-T', 'prefix').stdout).toMatch(/Space\s+switch-client -T helm/)
      expect(t('show-option', '-gv', 'status-right').stdout.match(/HELM/g)).toHaveLength(1)
    } finally {
      t('kill-server')
    }
  })
})

describe.skipIf(!present('zsh', ['-c', 'true']))('helm.zsh', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'helm-zsh-')), 'helm.zsh')
  writeFileSync(file, ZSH_SNIPPET)

  it('parses and defines the wrapper without a chord table', () => {
    expect(spawnSync('zsh', ['-n', file]).status).toBe(0)
    const run = spawnSync('zsh', ['-c', `source ${file}; whence -w claude; echo chords=\${+tmux_chords}`], { encoding: 'utf8' })
    expect(run.stdout).toBe('claude: function\nchords=0\n')
  })

  it('adds the Space chord only when the table exists', () => {
    const run = spawnSync(
      'zsh',
      ['-c', `typeset -A tmux_chords=(f x); source ${file}; k=' '; echo "[\${tmux_chords[$k]}]"`],
      { encoding: 'utf8' }
    )
    expect(run.stdout).toBe('[helm menu]\n')
  })
})

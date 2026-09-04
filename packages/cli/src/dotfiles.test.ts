import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendLine, backupName, withLine, writeSnippet } from './dotfiles.ts'
import { SNIPPET_HEADER, ZSH_SNIPPET } from './snippets.ts'

describe('dotfile lines', () => {
  it('appends once and names the backup with a timestamp', () => {
    expect(withLine('a\n', 'b')).toEqual({ text: 'a\nb\n', changed: true })
    expect(withLine('a\nb\n', 'b').changed).toBe(false)
    expect(withLine('a', 'b').text).toBe('a\nb\n')
    expect(backupName('/h/.zshrc', new Date(2026, 8, 4, 2, 5, 9))).toBe('/h/.zshrc.20260904-020509.bak')
  })

  it('backs up an existing file before the first append and leaves it alone after', () => {
    const d = mkdtempSync(join(tmpdir(), 'helm-dot-'))
    const rc = join(d, '.zshrc')
    expect(appendLine(rc, 'source x')).toEqual({ changed: true, backup: null })
    writeFileSync(rc, 'mine\n')
    const first = appendLine(rc, 'source x', new Date(2026, 0, 1))
    expect(first).toEqual({ changed: true, backup: `${rc}.20260101-000000.bak` })
    expect(readFileSync(first.changed ? first.backup ?? '' : '', 'utf8')).toBe('mine\n')
    expect(appendLine(rc, 'source x')).toEqual({ changed: false })
    expect(readFileSync(rc, 'utf8')).toBe('mine\nsource x\n')
  })
})

describe('snippet files', () => {
  it('writes, rewrites its own, and refuses a file without the header', () => {
    const d = mkdtempSync(join(tmpdir(), 'helm-snip-'))
    const file = join(d, 'sub', 'helm.zsh')
    expect(writeSnippet(file, ZSH_SNIPPET)).toBe('written')
    expect(writeSnippet(file, ZSH_SNIPPET)).toBe('unchanged')
    writeFileSync(file, `${SNIPPET_HEADER}\nold\n`)
    expect(writeSnippet(file, ZSH_SNIPPET)).toBe('written')
    writeFileSync(file, 'alias claude=x\n')
    expect(writeSnippet(file, ZSH_SNIPPET)).toBe('refused')
    expect(readFileSync(file, 'utf8')).toBe('alias claude=x\n')
    expect(existsSync(file)).toBe(true)
  })
})

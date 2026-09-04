import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SNIPPET_HEADER, TMUX_SNIPPET } from '../snippets.ts'
import { dotfileRow, nodeRow, reportOf, signInRow, snippetRow, symlinkRow } from './doctor.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'helm-doc-'))

describe('doctor rows', () => {
  it('reads node against the floor', () => {
    expect(nodeRow('v26.1.0').ok).toBe(true)
    expect(nodeRow('v20.0.0').ok).toBe(false)
  })

  it('keeps "could not look" apart from a finding for a snippet', () => {
    const d = dir()
    expect(snippetRow('t', join(d, 'none'), TMUX_SNIPPET)).toMatchObject({ ok: false, detail: expect.stringContaining('missing') })
    writeFileSync(join(d, 'same'), TMUX_SNIPPET)
    expect(snippetRow('t', join(d, 'same'), TMUX_SNIPPET).ok).toBe(true)
    writeFileSync(join(d, 'stale'), `${SNIPPET_HEADER}\nold\n`)
    expect(snippetRow('t', join(d, 'stale'), TMUX_SNIPPET).detail).toContain('stale')
    writeFileSync(join(d, 'foreign'), '# mine\n')
    expect(snippetRow('t', join(d, 'foreign'), TMUX_SNIPPET).detail).toContain('not written by helm install')
    mkdirSync(join(d, 'adir'))
    expect(snippetRow('t', join(d, 'adir'), TMUX_SNIPPET).ok).toBeNull()
  })

  it('checks a dotfile for its line and a symlink for its target', () => {
    const d = dir()
    writeFileSync(join(d, 'rc'), 'a\nsource-file x\n')
    expect(dotfileRow('rc', join(d, 'rc'), 'source-file x').ok).toBe(true)
    expect(dotfileRow('rc', join(d, 'rc'), 'source-file y').ok).toBe(false)
    expect(dotfileRow('rc', join(d, 'nope'), 'x').ok).toBe(false)
    writeFileSync(join(d, 'bundle.mjs'), '')
    symlinkSync(join(d, 'bundle.mjs'), join(d, 'helm'))
    expect(symlinkRow(join(d, 'helm'), join(d, 'bundle.mjs')).ok).toBe(true)
    expect(symlinkRow(join(d, 'helm'), join(d, 'other.mjs')).ok).toBe(false)
  })

  it('detects sign-in by existence only and answers null when nothing is there', () => {
    const home = join(dir(), '.claude')
    mkdirSync(home)
    expect(signInRow(home, {}).ok).toBeNull()
    expect(signInRow(home, { ANTHROPIC_API_KEY: 'k' }).ok).toBe(true)
    writeFileSync(join(home, '..', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, userID: 'u' }))
    expect(signInRow(home, {}).detail).toContain('.claude.json')
    writeFileSync(join(home, '.credentials.json'), 'x')
    expect(signInRow(home, {}).detail).toContain('.credentials.json')
  })

  it('fails the report on false and not on null', () => {
    expect(reportOf([{ name: 'a', ok: null, detail: '' }]).ok).toBe(true)
    expect(reportOf([{ name: 'a', ok: false, detail: '' }]).ok).toBe(false)
  })
})

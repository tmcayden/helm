import { describe, expect, it } from 'vitest'
import { snapshotTargetFor } from './config-files.ts'
import { viewUri } from './commands/view.ts'
import { tmuxProfileName } from './profile-context.ts'
import { planArgv } from './commands/config.ts'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = '/home/u/.claude'
const claudeJson = '/home/u/.claude.json'

describe('snapshotTargetFor', () => {
  it('keys a user file against ~/.claude itself, the way userConfigScope does', () => {
    const t = snapshotTargetFor('/home/u/.claude/settings.json', home, claudeJson)
    expect(t.scopePath).toBe(home)
    expect(() => t.guard(t.scopePath, t.path)).not.toThrow()
  })
  it('keys a project file against the directory holding its .claude', () => {
    const t = snapshotTargetFor('/w/repo/.claude/skills/x/SKILL.md', home, claudeJson)
    expect(t.scopePath).toBe('/w/repo')
    expect(() => t.guard(t.scopePath, t.path)).not.toThrow()
  })
  it('takes CLAUDE.md and .mcp.json beside a .claude, and ~/.claude.json against its own directory', () => {
    expect(snapshotTargetFor('/w/repo/CLAUDE.md', home, claudeJson).scopePath).toBe('/w/repo')
    expect(snapshotTargetFor('/w/repo/.mcp.json', home, claudeJson).scopePath).toBe('/w/repo')
    const t = snapshotTargetFor(claudeJson, home, claudeJson)
    expect(t.scopePath).toBe('/home/u')
    expect(() => t.guard(t.scopePath, t.path)).not.toThrow()
  })
  it('refuses anything that is not configuration', () => {
    expect(() => snapshotTargetFor('/w/repo/src/index.ts', home, claudeJson)).toThrow(/not configuration/)
    expect(() => snapshotTargetFor('relative/.claude/x', home, claudeJson)).toThrow(/absolute/)
  })
})

describe('viewUri', () => {
  it('names the four buffers and carries a config scope as its directory', () => {
    expect(viewUri(['effective'], false)).toBe('helm://effective')
    expect(viewUri(['history'], false)).toBe('helm://history')
    expect(viewUri(['config', '/w/repo'], false)).toBe('helm://config//w/repo')
  })
  it('treats an empty scope as the picker\'s cancel and an unknown word as usage', () => {
    expect(viewUri(['config', ''], false)).toBeNull()
    expect(() => viewUri(['config'], false)).toThrow(/scope/)
    expect(() => viewUri(['nothing'], false)).toThrow(/knows/)
  })
})

describe('tmuxProfileName', () => {
  it('asks the window before the session and treats n as unset', () => {
    process.env['TMUX'] = '/tmp/x,1,0'
    const asked: string[][] = []
    const answers = ['', 'harness']
    expect(tmuxProfileName((args) => { asked.push(args); return answers.shift() ?? null })).toBe('harness')
    expect(asked.map((a) => a[1])).toEqual(['-wqv', '-qv'])
    expect(tmuxProfileName(() => 'n\n')).toBeNull()
    delete process.env['TMUX']
    expect(tmuxProfileName(() => 'x')).toBeNull()
  })
})

describe('planArgv', () => {
  it('names the shim an overlay would get without creating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helm-cli-'))
    const overlay = join(dir, 'ov')
    mkdirSync(join(overlay, '.claude', 'skills'), { recursive: true })
    writeFileSync(join(overlay, 'CLAUDE.md'), '# ov\n')
    const shims = join(dir, 'shims')
    const { argv, composesMemory } = planArgv(
      { name: 'p', root: dir, overlays: [overlay], access: [overlay], model: 'opus', effort: 'high', permissionMode: null, agent: null, openingPrompt: null, mcp: [], target: null } as never,
      shims
    )
    expect(argv.slice(0, 4)).toEqual(['--add-dir', overlay, '-n', 'p'])
    expect(argv[argv.indexOf('--plugin-dir') + 1]?.startsWith(shims)).toBe(true)
    expect(argv).toContain('--model')
    expect(composesMemory).toBe(true)
    expect(() => mkdirSync(shims)).not.toThrow()
  })
})

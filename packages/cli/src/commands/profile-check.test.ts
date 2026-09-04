import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkProfileText, formatProblems, harnessOfProfileFile } from './profile-check.ts'

function harness(): string {
  const root = mkdtempSync(join(tmpdir(), 'helm-pc-'))
  writeFileSync(join(root, 'harness.yaml'), 'name: t\n')
  mkdirSync(join(root, 'repos', 'a'), { recursive: true })
  mkdirSync(join(root, '.helm', 'profiles'), { recursive: true })
  return root
}

describe('profile check', () => {
  it('warns, with field and line, for a value core silently drops', () => {
    const root = harness()
    const file = join(root, '.helm', 'profiles', 'p.yaml')
    const report = checkProfileText('overlays: [repos/a]\npermission_mode: default\neffort: xhigh\n', file, root)
    expect(report.ok).toBe(true)
    expect(report.problems).toEqual([
      {
        level: 'warning',
        field: 'permission_mode',
        line: 2,
        message: expect.stringContaining('acceptEdits, auto, bypassPermissions, manual, dontAsk, plan')
      }
    ])
    expect(formatProblems(report)).toBe(`${file}:2 warning ${report.problems[0]?.message ?? ''}`)
  })

  it('fails for a missing overlay, a root without harness.yaml, and unreadable YAML', () => {
    const root = harness()
    const file = join(root, '.helm', 'profiles', 'p.yaml')
    const missing = checkProfileText('overlays: [repos/none]\n', file, root)
    expect(missing.ok).toBe(false)
    expect(missing.problems.map((p) => [p.level, p.field])).toEqual([['error', 'overlays']])

    const bare = mkdtempSync(join(tmpdir(), 'helm-pc-bare-'))
    expect(checkProfileText('effort: high\n', join(bare, 'x.yaml'), bare).problems[0]).toMatchObject({
      level: 'error',
      field: 'root'
    })
    expect(checkProfileText('name: [\n', file, root)).toMatchObject({ ok: false, problems: [{ level: 'error' }] })
  })

  it('warns about a key that is not a profile key and a path outside the root', () => {
    const root = harness()
    const other = harness()
    const report = checkProfileText(`bogus: 1\naccess: [${JSON.stringify(join(other, 'repos', 'a'))}]\n`, join(root, 'p.yaml'), root)
    expect(report.ok).toBe(true)
    expect(report.problems.map((p) => p.field)).toEqual(['bogus', 'access'])
  })

  it('finds the harness above .helm/profiles', () => {
    expect(harnessOfProfileFile('/h/.helm/profiles/x.yaml')).toBe('/h')
    expect(harnessOfProfileFile('/h/x.yaml')).toBe('/h')
  })
})

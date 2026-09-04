import { describe, expect, it } from 'vitest'
import { parseProfileFile, resolveProfile, type ProfileEntry } from './profiles.ts'

const harness = '/h/wa'

describe('parseProfileFile', () => {
  it('defaults root to the harness and name to the file stem', () => {
    const entry = parseProfileFile('overlays: [repos/lams]\nmodel: opus\n', '/h/wa/.helm/profiles/wa.yaml', harness)
    expect(entry.name).toBe('wa')
    expect(entry.draft?.root).toBe(harness)
    expect(entry.draft?.overlays).toEqual(['/h/wa/repos/lams'])
    expect(entry.draft?.model).toBe('opus')
    expect(entry.problems).toEqual([])
  })

  it('lets the document override both', () => {
    const entry = parseProfileFile('name: other\nroot: /elsewhere\n', '/h/wa/.helm/profiles/wa.yaml', harness)
    expect(entry.name).toBe('other')
    expect(entry.draft?.root).toBe('/elsewhere')
  })

  it('reports an unreadable file without throwing', () => {
    const entry = parseProfileFile('- not\n- a mapping\n', '/h/wa/.helm/profiles/bad.yaml', harness)
    expect(entry.draft).toBeNull()
    expect(entry.problems[0]).toMatch(/mapping/)
  })

  it('reads snake_case keys through core', () => {
    const entry = parseProfileFile('permission_mode: plan\neffort: high\n', '/h/wa/.helm/profiles/p.yaml', harness)
    expect(entry.draft?.permissionMode).toBe('plan')
    expect(entry.draft?.effort).toBe('high')
  })
})

describe('resolveProfile', () => {
  const entry = (name: string, h: string): ProfileEntry => ({
    name,
    harness: h,
    file: `${h}/.helm/profiles/${name}.yaml`,
    draft: null,
    problems: []
  })
  const entries = [entry('wa', '/h/a'), entry('wa', '/h/b'), entry('solo', '/h/a')]

  it('finds a unique name', () => {
    expect(resolveProfile(entries, 'solo')).toMatchObject({ kind: 'found', entry: { harness: '/h/a' } })
  })
  it('names every candidate when ambiguous', () => {
    const r = resolveProfile(entries, 'wa')
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') expect(r.candidates.map((c) => c.harness)).toEqual(['/h/a', '/h/b'])
  })
  it('disambiguates by harness', () => {
    expect(resolveProfile(entries, 'wa', '/h/b/')).toMatchObject({ kind: 'found', entry: { harness: '/h/b' } })
  })
  it('is missing for an unknown name', () => {
    expect(resolveProfile(entries, 'zz')).toEqual({ kind: 'missing' })
  })
})

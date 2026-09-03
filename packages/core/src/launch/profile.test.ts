import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ProfileDraft } from '../types'
import { profileFromYaml, profileToYaml, validateProfile } from './profile'

const harness = join(homedir(), '.harness', 'dev')

const sample: ProfileDraft = {
  name: 'Acme cloud sync',
  root: harness,
  overlays: [join(harness, 'repos', 'acme'), join(harness, 'repos', 'acme-reporting')],
  access: [join(harness, 'repos', 'acme'), join(harness, 'repos', 'other-repo')],
  model: 'opus',
  effort: 'high',
  permissionMode: 'auto',
  agent: null,
  mcp: ['clickup'],
  openingPrompt: '/recap',
  pinnedOrder: null,
  target: null
}

describe('profileToYaml', () => {
  it('writes the shape the spec prints', () => {
    const yaml = profileToYaml(sample)
    expect(yaml).toContain('name: Acme cloud sync')
    expect(yaml).toContain('permission_mode: auto')
    expect(yaml).toContain('opening_prompt: /recap')
    // snake_case on the wire, camelCase in the object.
    expect(yaml).not.toContain('permissionMode')
  })

  /** An export that hardcodes this machine's paths does not travel with a
   * harness, which is the entire reason the format exists. */
  it('writes paths under the root relative to it, and the root against home', () => {
    const yaml = profileToYaml(sample)
    expect(yaml).toContain('repos/acme')
    expect(yaml).toContain('~/.harness/dev')
    expect(yaml).not.toContain(resolve(harness, 'repos', 'acme'))
  })

  it('keeps a path outside the root addressable', () => {
    const yaml = profileToYaml({ ...sample, access: ['C:/elsewhere/repo'] })
    expect(yaml).toContain('elsewhere')
  })

  it('lists the unset keys rather than dropping them', () => {
    const yaml = profileToYaml({ ...sample, agent: null, model: null })
    expect(yaml).toContain('agent: null')
    expect(yaml).toContain('model: null')
  })
})

describe('profileFromYaml', () => {
  it('round-trips a profile intact', () => {
    expect(profileFromYaml(profileToYaml(sample))).toEqual(sample)
  })

  it('round-trips one with everything unset', () => {
    const bare: ProfileDraft = {
      name: 'bare',
      root: harness,
      overlays: [],
      access: [],
      model: null,
      effort: null,
      permissionMode: null,
      agent: null,
      mcp: [],
      openingPrompt: null,
      pinnedOrder: null,
      target: null
    }
    expect(profileFromYaml(profileToYaml(bare))).toEqual(bare)
  })

  /** Deliberate: pin order is this launcher's list position, not the launch. */
  it('does not carry pin order, so imports arrive unpinned', () => {
    const yaml = profileToYaml({ ...sample, pinnedOrder: 3 })
    expect(yaml).not.toContain('pinned')
    expect(profileFromYaml(yaml).pinnedOrder).toBeNull()
  })

  it('resolves relative paths against the root, so a moved harness still works', () => {
    const imported = profileFromYaml(
      ['name: moved', 'root: C:/somewhere/else', 'overlays:', '  - repos/acme'].join('\n')
    )
    expect(imported.overlays).toEqual([resolve('C:/somewhere/else/repos/acme')])
  })

  it('drops a value the CLI would reject rather than refusing the file', () => {
    const imported = profileFromYaml(
      ['name: odd', `root: ${harness}`, 'effort: medium-high', 'permission_mode: whatever'].join(
        '\n'
      )
    )
    expect(imported.effort).toBeNull()
    expect(imported.permissionMode).toBeNull()
  })

  it('refuses a document that is not a profile', () => {
    expect(() => profileFromYaml('- a\n- b')).toThrow(/mapping/)
    expect(() => profileFromYaml(`root: ${harness}`)).toThrow(/name/)
    expect(() => profileFromYaml('name: x')).toThrow(/root/)
    expect(() => profileFromYaml('name: [unclosed')).toThrow(/YAML/)
  })
})

describe('validateProfile', () => {
  it('accepts a good one', () => {
    expect(validateProfile(sample)).toEqual([])
  })

  it('reports every problem at once', () => {
    const problems = validateProfile({
      ...sample,
      name: '  ',
      effort: 'medium-high' as ProfileDraft['effort']
    })
    expect(problems).toHaveLength(2)
  })
})

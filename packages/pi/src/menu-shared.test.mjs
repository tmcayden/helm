import { describe, expect, it } from 'vitest'
import { emptyState, profileToState, representableInMenu, stateToProfile } from './menu-shared.mjs'

const libraryEntryOf = (profile) => profile.packages.find((entry) => typeof entry === 'object' && entry.source === 'library')

describe('stateToProfile', () => {
  it('states all four filter keys even when nothing is selected', () => {
    const profile = stateToProfile({ ...emptyState(), name: 'blank' })
    expect(libraryEntryOf(profile)).toEqual({ source: 'library', skills: [], extensions: [], prompts: [], themes: [] })
  })

  it('writes the selections it has and [] for the rest', () => {
    const profile = stateToProfile({ ...emptyState(), name: 'x', skills: ['skills/herdr'] })
    expect(libraryEntryOf(profile)).toEqual({ source: 'library', skills: ['skills/herdr'], extensions: [], prompts: [], themes: [] })
  })
})

describe('a round trip through the menu', () => {
  it('keeps prompts and themes the menu has no UI for', () => {
    const source = {
      label: 'gse',
      extends: 'base',
      packages: [
        'npm:pi-claude-bridge',
        { source: 'library', skills: ['skills/helm'], extensions: [], prompts: ['prompts/recap.md'], themes: ['themes/night.json'] }
      ],
      location: 'anywhere'
    }
    const saved = stateToProfile(profileToState(source, 'gse'))
    expect(libraryEntryOf(saved)).toEqual(libraryEntryOf(source))
  })

  it('preserves the rest of the profile', () => {
    const source = {
      label: 'composer',
      agentsMd: 'agents/composer.md',
      mixins: ['delegation'],
      env: { PI_PATH_GUARD_ROOTS: '${cwd}' },
      location: { path: '~/personal/pi-library' },
      openingPrompt: '/recap',
      packages: ['npm:pi-claude-bridge', { source: 'library', skills: [], extensions: [], prompts: [], themes: [] }]
    }
    expect(stateToProfile(profileToState(source, 'composer'))).toEqual(source)
  })
})

describe('representableInMenu', () => {
  it('rejects a glob or an exclude in any of the four keys', () => {
    for (const key of ['skills', 'extensions', 'prompts', 'themes']) {
      expect(representableInMenu({ packages: [{ source: 'library', [key]: ['**'] }] })).toBe(false)
      expect(representableInMenu({ packages: [{ source: 'library', [key]: ['!a'] }] })).toBe(false)
    }
  })

  it('accepts explicit lists', () => {
    expect(representableInMenu({ packages: [{ source: 'library', skills: ['skills/helm'], themes: [] }] })).toBe(true)
  })
})

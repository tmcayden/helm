import { describe, expect, it } from 'vitest'
import { PROFILE_FIELDS, validateLibraryFile } from './validate.mjs'
import { emptyState, stateToProfile } from './menu-shared.mjs'

const FILE = '/lib/profiles/thing.json'
const check = (raw, kind = 'profile') => validateLibraryFile(raw, { file: FILE, kind })
const fullEntry = (fields = {}) => ({ source: 'library', skills: [], extensions: [], prompts: [], themes: [], ...fields })
const valid = (fields) => ({ label: 'thing', packages: ['npm:pi-claude-bridge', fullEntry()], location: 'anywhere', ...fields })

describe('a well-formed file', () => {
  it('passes a profile stating all four keys', () => {
    expect(check(valid())).toEqual([])
  })

  it('passes every field the composer reads', () => {
    expect(check(valid({
      description: 'a thing',
      extends: 'base',
      mixins: ['delegation'],
      agentsMd: 'agents/thing.md',
      settings: { defaultThinkingLevel: 'high' },
      env: { X: '${cwd}' },
      openingPrompt: '/recap'
    }))).toEqual([])
  })

  it('passes the legacy cwd field, which locationOf still reads as a pinned path', () => {
    expect(check({ label: 'thing', cwd: '~/personal' })).toEqual([])
    expect(PROFILE_FIELDS).toContain('cwd')
  })

  it('passes a mixin with neither extends nor mixins', () => {
    expect(check({ packages: [fullEntry({ skills: ['skills/herdr'] })] }, 'mixin')).toEqual([])
  })
})

describe('every object package entry states all four filter keys', () => {
  it('names the file, the source and exactly the missing keys', () => {
    const problems = check(valid({ packages: [fullEntry(), { source: 'library', skills: ['skills/a'] }] }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(FILE)
    expect(problems[0]).toContain('packages[1] (source "library")')
    expect(problems[0]).toContain('does not state extensions, prompts, themes')
    expect(problems[0]).toContain('"extensions": []')
    expect(problems[0]).not.toContain('does not state skills')
  })

  it('accepts an empty list as the way to say "none"', () => {
    expect(check(valid({ packages: [fullEntry({ skills: [] })] }))).toEqual([])
  })

  it('leaves a bare string entry alone, because unfiltered is declared rather than omitted', () => {
    expect(check(valid({ packages: ['npm:pi-claude-bridge', 'library'] }))).toEqual([])
  })

  it('rejects an entry with no source', () => {
    const problems = check(valid({ packages: [{ skills: [], extensions: [], prompts: [], themes: [] }] }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("has no 'source'")
  })

  it('rejects a filter key that is not a list of strings', () => {
    const problems = check(valid({ packages: [fullEntry({ skills: 'skills/a' })] }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("'skills' must be an array of paths")
  })

  it('rejects a non-boolean replace', () => {
    const problems = check(valid({ packages: [fullEntry({ replace: 'yes' })] }))
    expect(problems).toEqual([expect.stringContaining("'replace' must be true or false")])
  })

  it('rejects packages that are not an array', () => {
    expect(check(valid({ packages: { source: 'library' } }))).toEqual([expect.stringContaining("'packages' must be an array")])
  })

  it('reports every offending entry in one pass', () => {
    const problems = check(valid({ packages: [{ source: 'a' }, { source: 'b', skills: [] }] }))
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('source "a"')
    expect(problems[1]).toContain('source "b"')
  })
})

describe('unknown top-level fields', () => {
  it('rejects a misspelled field and suggests the real one', () => {
    const problems = check(valid({ agentsMD: 'agents/x.md' }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("unknown field 'agentsMD'")
    expect(problems[0]).toContain("did you mean 'agentsMd'?")
  })

  it('rejects a field with no near match and lists what is allowed', () => {
    const problems = check(valid({ frobnicate: 1 }))
    expect(problems[0]).toContain("unknown field 'frobnicate'")
    expect(problems[0]).toContain('label, description, extends, mixins, agentsMd')
  })

  it('rejects the singular mixin typo', () => {
    expect(check(valid({ mixin: ['delegation'] }))).toEqual([expect.stringContaining("did you mean 'mixins'?")])
  })

  it('rejects a file that is not a JSON object', () => {
    expect(validateLibraryFile([], { file: FILE })).toEqual([expect.stringContaining('must hold a JSON object')])
  })

  it('rejects a field of the wrong type', () => {
    expect(check(valid({ label: 7 }))).toEqual([expect.stringContaining("'label' must be a string")])
    expect(check(valid({ mixins: 'delegation' }))).toEqual([expect.stringContaining("'mixins' must be an array")])
    expect(check(valid({ env: ['X=1'] }))).toEqual([expect.stringContaining("'env' must be an object")])
  })
})

describe('location, at read time', () => {
  it('accepts the three shapes', () => {
    expect(check(valid({ location: 'anywhere' }))).toEqual([])
    expect(check(valid({ location: { path: '~/personal' } }))).toEqual([])
    expect(check(valid({ location: { requires: 'parent-of-repos' } }))).toEqual([])
    expect(check(valid({ location: { requires: 'inside-git-repo' } }))).toEqual([])
  })

  it('names the known rules when the rule is unknown', () => {
    const problems = check(valid({ location: { requires: 'parent-of-repo' } }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('unknown location rule "parent-of-repo"')
    expect(problems[0]).toContain('parent-of-repos, inside-git-repo')
  })

  it('rejects a location that is neither shape', () => {
    expect(check(valid({ location: 'somewhere' }))).toEqual([expect.stringContaining('must be "anywhere"')])
    expect(check(valid({ location: {} }))).toEqual([expect.stringContaining('must be "anywhere"')])
    expect(check(valid({ location: { path: 3 } }))).toEqual([expect.stringContaining("'location.path' must be a directory string")])
  })

  it('rejects a location claiming both a path and a rule', () => {
    expect(check(valid({ location: { path: '~/x', requires: 'inside-git-repo' } })))
      .toEqual([expect.stringContaining("states both 'path' and 'requires'")])
  })
})

describe('mixin restrictions', () => {
  it('rejects extends on a mixin and says where it belongs', () => {
    const problems = check({ extends: 'base' }, 'mixin')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(FILE)
    expect(problems[0]).toContain("a mixin cannot 'extends'")
  })

  it('rejects mixins on a mixin', () => {
    expect(check({ mixins: ['other'] }, 'mixin')).toEqual([expect.stringContaining("a mixin cannot list 'mixins'")])
  })

  it('does not offer extends or mixins in a mixin\'s field list', () => {
    const problems = check({ frobnicate: 1 }, 'mixin')
    expect(problems[0]).toContain('A mixin may have:')
    expect(problems[0]).not.toContain('extends')
  })
})

describe('what the menu writes', () => {
  const state = (fields) => ({ ...emptyState(), name: 'thing', ...fields })

  it('validates clean for an empty selection', () => {
    expect(check(stateToProfile(state()))).toEqual([])
  })

  it('validates clean with everything the menu can set', () => {
    const profile = stateToProfile(state({
      extends: 'base',
      mixins: ['delegation'],
      skills: ['skills/helm'],
      extensions: ['extensions/path-guard.ts'],
      prompts: ['prompts/p.md'],
      themes: ['themes/t.json'],
      agentsMd: 'agents/thing.md',
      openingPrompt: '/recap',
      env: { X: '${cwd}' },
      location: { requires: 'parent-of-repos' }
    }))
    expect(check(profile)).toEqual([])
  })

  it('validates clean for each location the menu offers', () => {
    for (const location of ['anywhere', { requires: 'parent-of-repos' }, { requires: 'inside-git-repo' }, { path: '/tmp' }]) {
      expect(check(stateToProfile(state({ location })))).toEqual([])
    }
  })
})

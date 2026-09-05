import { describe, expect, it } from 'vitest'
import { mergePackageEntry, mergePackages, mergeProfiles, stripHelmKeys } from './merge.mjs'

const lib = (fields) => ({ source: 'library', ...fields })
const mergeOne = (parent, child) => {
  const warnings = []
  return { entry: mergePackageEntry(parent, child, warnings), warnings }
}

describe('mergePackageEntry, key by key', () => {
  it('leaves a key both sides omit omitted', () => {
    const { entry, warnings } = mergeOne(lib({}), lib({}))
    expect(entry).toEqual(lib({}))
    expect(warnings).toEqual([])
  })

  it('keeps an omitted parent key omitted and warns that the child narrowed nothing', () => {
    const { entry, warnings } = mergeOne(lib({}), lib({ skills: ['a'] }))
    expect(entry).toEqual(lib({}))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('skills')
  })

  it('widens to everything when the child omits a key the parent listed', () => {
    const { entry, warnings } = mergeOne(lib({ skills: ['a'] }), lib({ extensions: ['x'] }))
    expect(entry.skills).toBeUndefined()
    expect(entry.extensions).toBeUndefined()
    expect(warnings).toHaveLength(1)
  })

  it('unions when both sides list', () => {
    const { entry } = mergeOne(lib({ skills: ['a'] }), lib({ skills: ['b'] }))
    expect(entry.skills).toEqual(['a', 'b'])
  })

  it('reads an empty child list as "I contribute none", not as a block', () => {
    const { entry, warnings } = mergeOne(lib({ skills: ['a'] }), lib({ skills: [] }))
    expect(entry.skills).toEqual(['a'])
    expect(warnings).toEqual([])
  })

  it('leaves an omitted parent key omitted for an empty child list, without warning', () => {
    const { entry, warnings } = mergeOne(lib({}), lib({ skills: [] }))
    expect(entry.skills).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('takes a replace:true child verbatim', () => {
    const { entry } = mergeOne(lib({ skills: ['a'], themes: ['t'] }), lib({ skills: ['b'], replace: true }))
    expect(entry).toEqual(lib({ skills: ['b'], replace: true }))
  })

  it('dedupes and keeps the parent first', () => {
    const { entry } = mergeOne(lib({ skills: ['a', 'b'] }), lib({ skills: ['b', 'c'] }))
    expect(entry.skills).toEqual(['a', 'b', 'c'])
  })

  it('merges the four filter keys independently', () => {
    const { entry } = mergeOne(
      lib({ skills: ['a'], extensions: ['x'], prompts: ['p'], themes: [] }),
      lib({ skills: ['b'], extensions: [], prompts: ['q'], themes: ['t'] })
    )
    expect(entry).toEqual(lib({ skills: ['a', 'b'], extensions: ['x'], prompts: ['p', 'q'], themes: ['t'] }))
  })

  it('lets the widest side win when one of them is a bare string', () => {
    expect(mergeOne('npm:thing', lib({ skills: ['a'] })).entry).toBe('npm:thing')
    expect(mergeOne(lib({ skills: ['a'] }), 'library').entry).toBe('library')
  })

  it('warns when a child object narrows an unfiltered string parent', () => {
    const { warnings } = mergeOne('library', lib({ skills: ['a'], prompts: [] }))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('skills')
  })

  it('carries non-filter keys through with the child winning', () => {
    const { entry } = mergeOne(lib({ version: '1', skills: ['a'] }), lib({ version: '2', skills: ['b'] }))
    expect(entry).toEqual(lib({ version: '2', skills: ['a', 'b'] }))
  })
})

describe('mergePackages', () => {
  it('appends an entry with a new source and keeps order', () => {
    const merged = mergePackages(['npm:bridge', lib({ skills: ['a'] })], [lib({ skills: ['b'] }), 'npm:other'])
    expect(merged).toEqual(['npm:bridge', lib({ skills: ['a', 'b'] }), 'npm:other'])
  })
})

describe('mergeProfiles', () => {
  const withMixins = (parent, ...mixins) => {
    const warnings = []
    const profile = mixins.reduce((acc, mixin) => mergeProfiles(acc, mixin, warnings), parent)
    return { profile, warnings }
  }

  it('unions a leaf entry onto its parent instead of replacing it', () => {
    const { profile } = withMixins(
      { packages: ['npm:bridge', lib({ skills: ['skills/herdr'], extensions: [], prompts: [], themes: [] })] },
      { packages: ['npm:bridge', lib({ skills: ['skills/helm'], extensions: [], prompts: [], themes: [] })] }
    )
    expect(profile.packages[1].skills).toEqual(['skills/herdr', 'skills/helm'])
  })

  it('unions mixins that collide with each other, not only with the leaf', () => {
    const { profile } = withMixins(
      { packages: [lib({ skills: ['parent'], themes: [] })] },
      { packages: [lib({ skills: ['mixin-one'], themes: ['t'] })] },
      { packages: [lib({ skills: ['mixin-two'], themes: [] })] },
      { packages: [lib({ skills: ['leaf'], themes: [] })] }
    )
    expect(profile.packages[0].skills).toEqual(['parent', 'mixin-one', 'mixin-two', 'leaf'])
    expect(profile.packages[0].themes).toEqual(['t'])
  })

  it('collects a warning from a mixin colliding with a mixin', () => {
    const { warnings } = withMixins(
      {},
      { packages: [lib({})] },
      { packages: [lib({ skills: ['late'] })] }
    )
    expect(warnings).toHaveLength(1)
  })

  it('still merges settings and env shallowly with the child winning', () => {
    const { profile } = withMixins(
      { settings: { a: 1, b: 2 }, env: { X: '1' }, label: 'parent' },
      { settings: { b: 3 }, env: { Y: '2' }, label: 'child' }
    )
    expect(profile).toEqual({ settings: { a: 1, b: 3 }, env: { X: '1', Y: '2' }, label: 'child', packages: [] })
  })
})

describe('stripHelmKeys', () => {
  it('removes replace and nothing else', () => {
    expect(stripHelmKeys(lib({ skills: ['a'], replace: true }))).toEqual(lib({ skills: ['a'] }))
  })

  it('leaves a bare string alone', () => {
    expect(stripHelmKeys('npm:bridge')).toBe('npm:bridge')
  })
})

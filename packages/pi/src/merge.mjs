// Pi loads every resource of a type whose key is OMITTED from a package
// filter, so an absent key is "all of them" and merging has to happen per key
// rather than per entry: a child that restates one key must not silently drop
// what a parent or a mixin put in the others.
export const FILTER_KEYS = ['skills', 'extensions', 'prompts', 'themes']

const HELM_ONLY_KEYS = ['replace']

export const sourceOf = (entry) => (typeof entry === 'string' ? entry : entry.source)

/** `replace` is helm's word for the fold; pi has never heard of it. */
export function stripHelmKeys(entry) {
  if (typeof entry === 'string') return entry
  const copy = { ...entry }
  for (const key of HELM_ONLY_KEYS) delete copy[key]
  return copy
}

function union(parent, child) {
  const out = [...parent]
  for (const item of child) if (!out.includes(item)) out.push(item)
  return out
}

/**
 * Entries sharing a source merge key by key. A bare string is an unfiltered
 * entry, so when a string meets an object the string wins: the widest reach
 * already granted cannot be taken back by restating a narrower one.
 */
export function mergePackageEntry(parent, child, warnings = []) {
  if (typeof child === 'object' && child.replace === true) return child

  const source = sourceOf(parent)
  const noop = (key, values) => {
    if (values.length > 0) {
      warnings.push(
        `packages: an inherited '${source}' entry states no ${key} filter, so it loads all of them; ` +
        `listing ${JSON.stringify(values)} here narrows nothing. ` +
        `State ${key} on the inherited entry too, or add "replace": true here.`
      )
    }
  }

  if (typeof child === 'string') return child
  if (typeof parent === 'string') {
    for (const key of FILTER_KEYS) if (child[key]) noop(key, child[key])
    return parent
  }

  const merged = { ...parent, ...child }
  for (const key of FILTER_KEYS) {
    const inParent = Array.isArray(parent[key])
    const inChild = Array.isArray(child[key])
    if (inParent && inChild) merged[key] = union(parent[key], child[key])
    else {
      // Either side leaving the key out means "all of them", and all of them
      // wins; a child listing under an unfiltered parent narrows nothing.
      if (inChild) noop(key, child[key])
      delete merged[key]
    }
  }
  return merged
}

export function mergePackages(parentEntries = [], childEntries = [], warnings = []) {
  const packages = [...parentEntries]
  for (const entry of childEntries) {
    const at = packages.findIndex((existing) => sourceOf(existing) === sourceOf(entry))
    if (at >= 0) packages[at] = mergePackageEntry(packages[at], entry, warnings)
    else packages.push(entry)
  }
  return packages
}

// Child wins field by field; settings and env merge shallowly; package entries
// sharing a source union per key, so a leaf adding one skill of its own keeps
// everything its parent and its mixins contributed.
export function mergeProfiles(parent, child, warnings = []) {
  return {
    ...parent,
    ...child,
    settings: { ...parent.settings, ...child.settings },
    env: { ...parent.env, ...child.env },
    packages: mergePackages(parent.packages, child.packages, warnings)
  }
}

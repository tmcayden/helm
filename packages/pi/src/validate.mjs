import { FILTER_KEYS } from './merge.mjs'
import { RULES } from './location.mjs'

// `cwd` predates `location` and locationOf still reads it as { path }, so it is
// known rather than deprecated-away; everything else here is a field some part
// of the composer reads, and a field nothing reads is a typo that would
// otherwise be silently ignored.
export const PROFILE_FIELDS = [
  'label', 'description', 'extends', 'mixins', 'agentsMd',
  'packages', 'settings', 'env', 'location', 'openingPrompt', 'cwd'
]

// A mixin is additive. The two fields describing an inheritance chain are the
// profile's alone, and so is `location`: listing a mixin to pick up a skill
// must never move or pin where the profile launches.
const MIXIN_REFUSES = {
  extends: `a mixin cannot 'extends'. Mixins are additive, not inherited - put the extends on the profile that lists this mixin.`,
  mixins: `a mixin cannot list 'mixins'. Only a profile composes a chain; a mixin that needs another mixin's contents must state them itself.`,
  location: `a mixin cannot set 'location'. Where a profile runs is the profile's own call - a mixin that pinned it would move the launch directory of everything that lists it.`
}

const list = (items) => items.join(', ')

function nearest(word, candidates) {
  const scored = candidates
    .map((candidate) => ({ candidate, distance: distance(word.toLowerCase(), candidate.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance)[0]
  return scored && scored.distance <= 2 ? scored.candidate : null
}

function distance(a, b) {
  const rows = [Array.from({ length: b.length + 1 }, (_, i) => i)]
  for (let i = 1; i <= a.length; i++) {
    rows[i] = [i]
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
  }
  return rows[a.length][b.length]
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string')

/**
 * Every problem in one file, so a fix is one pass rather than one error at a
 * time. Each message names the file, the field, what was wrong and what to
 * write instead - the file is read far more often than this source is.
 */
export function validateLibraryFile(raw, { file, kind = 'profile' } = {}) {
  const problems = []
  const at = (message) => problems.push(`${file}: ${message}`)

  if (!isPlainObject(raw)) {
    at(`the file must hold a JSON object, got ${Array.isArray(raw) ? 'an array' : JSON.stringify(raw)}`)
    return problems
  }

  const known = kind === 'mixin' ? PROFILE_FIELDS.filter((f) => !(f in MIXIN_REFUSES)) : PROFILE_FIELDS
  for (const field of Object.keys(raw)) {
    if (known.includes(field)) continue
    if (kind === 'mixin' && field in MIXIN_REFUSES) {
      at(MIXIN_REFUSES[field])
      continue
    }
    const suggestion = nearest(field, known)
    at(`unknown field '${field}'${suggestion ? `; did you mean '${suggestion}'?` : ''} A ${kind} may have: ${list(known)}.`)
  }

  for (const field of ['label', 'description', 'extends', 'agentsMd', 'openingPrompt', 'cwd']) {
    if (field in raw && typeof raw[field] !== 'string') {
      at(`'${field}' must be a string, got ${JSON.stringify(raw[field])}.`)
    }
  }
  if ('mixins' in raw && !isStringList(raw.mixins)) {
    at(`'mixins' must be an array of mixin names, got ${JSON.stringify(raw.mixins)}.`)
  }
  for (const field of ['settings', 'env']) {
    if (field in raw && !isPlainObject(raw[field])) {
      at(`'${field}' must be an object, got ${JSON.stringify(raw[field])}.`)
    }
  }

  if ('location' in raw && kind !== 'mixin') problems.push(...locationProblems(raw.location, file))
  if ('packages' in raw) problems.push(...packageProblems(raw.packages, file))
  return problems
}

function locationProblems(location, file) {
  const shape = `'location' must be "anywhere", { "requires": <rule> } or { "path": <dir> }`
  if (location === 'anywhere') return []
  if (!isPlainObject(location)) return [`${file}: ${shape}; got ${JSON.stringify(location)}.`]
  if ('path' in location && 'requires' in location) {
    return [`${file}: 'location' states both 'path' and 'requires'; a pinned location already answers where it runs, so drop one.`]
  }
  if ('path' in location) {
    return typeof location.path === 'string'
      ? []
      : [`${file}: 'location.path' must be a directory string, got ${JSON.stringify(location.path)}.`]
  }
  if ('requires' in location) {
    return RULES[location.requires]
      ? []
      : [`${file}: unknown location rule ${JSON.stringify(location.requires)}. Known rules: ${list(Object.keys(RULES))}.`]
  }
  return [`${file}: ${shape}; got ${JSON.stringify(location)}.`]
}

function packageProblems(packages, file) {
  const problems = []
  const at = (message) => problems.push(`${file}: ${message}`)
  if (!Array.isArray(packages)) {
    at(`'packages' must be an array of package entries, got ${JSON.stringify(packages)}.`)
    return problems
  }

  packages.forEach((entry, index) => {
    const where = `packages[${index}]`
    if (typeof entry === 'string') return
    if (!isPlainObject(entry)) {
      at(`${where} must be a package source string or an object with a 'source', got ${JSON.stringify(entry)}.`)
      return
    }
    if (typeof entry.source !== 'string') {
      at(`${where} has no 'source'. A package entry names where its resources come from - "library", or an "npm:" specifier.`)
      return
    }
    const named = `${where} (source ${JSON.stringify(entry.source)})`
    for (const key of FILTER_KEYS) {
      if (key in entry && !isStringList(entry[key])) {
        at(`${named}: '${key}' must be an array of paths, got ${JSON.stringify(entry[key])}.`)
      }
    }
    if ('replace' in entry && typeof entry.replace !== 'boolean') {
      at(`${named}: 'replace' must be true or false, got ${JSON.stringify(entry.replace)}.`)
    }
    // Pi loads every resource of a type whose key is missing, and per-key
    // merging spreads that up the whole inheritance chain, so an omission here
    // is never local. The bare string stays legal because it says "all of
    // everything" out loud.
    const missing = FILTER_KEYS.filter((key) => !(key in entry))
    if (missing.length > 0) {
      at(
        `${named} does not state ${list(missing)}. Pi loads every resource of a type ` +
        `whose key is missing, so an object entry must state all four of ${list(FILTER_KEYS)} - write ${missing.map((key) => `"${key}": []`).join(', ')} for none. ` +
        `To take everything of every type on purpose, write the bare string ${JSON.stringify(entry.source)} instead of an object.`
      )
    }
  })
  return problems
}

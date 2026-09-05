import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export function readSkills(library) {
  const root = join(library, 'skills')
  if (!existsSync(root)) return []
  const skills = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillFile = join(root, entry.name, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    skills.push({
      id: `skills/${entry.name}`,
      description: describeSkill(skillFile)
    })
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id))
}

export function readExtensions(library) {
  const root = join(library, 'extensions')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => name.endsWith('.ts') || name.endsWith('.js'))
    .map((name) => ({
      id: `extensions/${name}`,
      description: describeExtension(join(root, name))
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function readMixins(library) {
  const root = join(library, 'mixins')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const path = join(root, name)
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      return { id: name.replace(/\.json$/, ''), description: raw.description ?? raw.label ?? '' }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function readAgentsMdFiles(library) {
  const root = join(library, 'agents')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ id: `agents/${name}`, description: firstMarkdownLine(join(root, name)) }))
}

function describeSkill(file) {
  const text = readFileSync(file, 'utf8')
  const match = text.match(/^---[\s\S]*?description:\s*"?([^"\n]+)"?\s*(?:\n|---)/m)
  if (match) return match[1].trim().replace(/\s+/g, ' ')
  const firstLine = text.split('\n').find((line) => line.trim() && !line.startsWith('#') && !line.startsWith('---'))
  return (firstLine ?? '').trim()
}

function describeExtension(file) {
  const text = readFileSync(file, 'utf8')
  const commentLines = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('//')) commentLines.push(trimmed.replace(/^\/\/\s?/, ''))
    else if (commentLines.length > 0) break
    else if (trimmed === '' || trimmed.startsWith('import')) continue
  }
  return commentLines.join(' ').trim()
}

function firstMarkdownLine(file) {
  return (readFileSync(file, 'utf8').split('\n').find((line) => line.trim() && !line.startsWith('#')) ?? '').trim()
}

/** The visible summary of a proposed profile - not JSON. */
export function renderPreview(state, discovery) {
  const lines = []
  lines.push(colour('bold', `── ${state.name || '(unnamed)'} ──`))
  lines.push('')
  lines.push(`${colour('dim', 'extends')}      ${state.extends || colour('dim', '(none)')}`)
  lines.push(`${colour('dim', 'mixins')}       ${state.mixins.length > 0 ? state.mixins.join(', ') : colour('dim', '(none)')}`)
  lines.push(`${colour('dim', 'location')}     ${describeLocation(state.location)}`)
  if (state.agentsMd) lines.push(`${colour('dim', 'AGENTS.md')}    ${state.agentsMd}`)
  if (state.openingPrompt) lines.push(`${colour('dim', 'opens with')}   ${JSON.stringify(state.openingPrompt)}`)
  lines.push('')

  lines.push(colour('bold', `Skills (${state.skills.length})`))
  if (state.skills.length === 0) lines.push(`  ${colour('dim', 'none selected')}`)
  for (const id of state.skills) {
    const skill = discovery.skills.find((s) => s.id === id)
    lines.push(`  ${colour('green', '●')} ${id}`)
    if (skill?.description) lines.push(`    ${colour('dim', wrap(skill.description, 60))}`)
  }
  lines.push('')

  lines.push(colour('bold', `Extensions (${state.extensions.length})`))
  if (state.extensions.length === 0) lines.push(`  ${colour('dim', 'none selected')}`)
  for (const id of state.extensions) {
    const ext = discovery.extensions.find((e) => e.id === id)
    lines.push(`  ${colour('yellow', '●')} ${id}`)
    if (ext?.description) lines.push(`    ${colour('dim', wrap(ext.description, 60))}`)
  }
  lines.push('')

  if (Object.keys(state.env).length > 0) {
    lines.push(colour('bold', 'Env'))
    for (const [k, v] of Object.entries(state.env)) lines.push(`  ${k}=${v}`)
    lines.push('')
  }

  return lines.join('\n')
}

function describeLocation(location) {
  if (!location || location === 'anywhere') return 'anywhere'
  if (location.path) return `pinned to ${location.path}`
  if (location.requires === 'parent-of-repos') return 'any parent-of-repos folder'
  if (location.requires === 'inside-git-repo') return 'any dir inside a git repo'
  return JSON.stringify(location)
}

function wrap(text, width) {
  const words = text.split(/\s+/)
  const lines = []
  let line = ''
  for (const word of words) {
    if ((line + ' ' + word).trim().length > width) {
      lines.push(line.trim())
      line = word
    } else {
      line += ' ' + word
    }
  }
  if (line.trim()) lines.push(line.trim())
  return lines.join('\n    ')
}

const CODES = { bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', reset: '\x1b[0m' }
function colour(name, text) {
  return `${CODES[name]}${text}${CODES.reset}`
}

export function emptyState() {
  return {
    name: '',
    originalName: '',
    extends: '',
    mixins: [],
    skills: [],
    extensions: [],
    location: 'anywhere',
    agentsMd: '',
    openingPrompt: '',
    env: {}
  }
}

// Reverse of stateToProfile, best-effort: only round-trips profiles the menu
// itself wrote. If the source uses exclude patterns or globs in its library
// package entry, they show up as checked items - which is not right for globs
// - and saving rewrites them as explicit lists. That is called out at load.
export function profileToState(profile, name) {
  const libraryEntry = (profile.packages ?? []).find((entry) => typeof entry === 'object' && entry.source === 'library')
  return {
    name,
    originalName: name,
    extends: profile.extends ?? '',
    mixins: profile.mixins ?? [],
    skills: libraryEntry?.skills ?? [],
    extensions: libraryEntry?.extensions ?? [],
    location: profile.location ?? 'anywhere',
    agentsMd: profile.agentsMd ?? '',
    openingPrompt: profile.openingPrompt ?? '',
    env: profile.env ?? {}
  }
}

export function representableInMenu(profile) {
  const libraryEntry = (profile.packages ?? []).find((entry) => typeof entry === 'object' && entry.source === 'library')
  if (!libraryEntry) return true
  const complex = (arr) => (arr ?? []).some((glob) => glob.startsWith('!') || glob.includes('*'))
  return !complex(libraryEntry.skills) && !complex(libraryEntry.extensions)
}

export function stateToProfile(state) {
  const profile = { label: state.name }
  if (state.extends) profile.extends = state.extends
  if (state.mixins.length > 0) profile.mixins = state.mixins
  if (state.agentsMd) profile.agentsMd = state.agentsMd
  profile.packages = ['npm:pi-claude-bridge']
  if (state.skills.length > 0 || state.extensions.length > 0) {
    const entry = { source: 'library' }
    if (state.skills.length > 0) entry.skills = state.skills
    if (state.extensions.length > 0) entry.extensions = state.extensions
    profile.packages.push(entry)
  }
  if (Object.keys(state.env).length > 0) profile.env = state.env
  profile.location = state.location
  if (state.openingPrompt) profile.openingPrompt = state.openingPrompt
  return profile
}

// v2: single-screen. One fzf shows every togglable option, grouped. Space
// toggles the row and reloads the list; the preview repaints the profile
// every time. Nothing is hidden behind a step.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { emptyState, profileToState, readAgentsMdFiles, readExtensions, readMixins, readSkills, renderPreview, representableInMenu, stateToProfile } from './menu-shared.mjs'

const STATE_FILE = '/tmp/helm-pi-menu-state.json'
const LIBRARY_FILE = '/tmp/helm-pi-menu-library'
const PROFILE_BASES = ['base', 'default', 'herdr', 'harness']
const SELF = fileURLToPath(import.meta.url)

export function runMenu(library, editName) {
  writeFileSync(LIBRARY_FILE, library)
  const discovery = { skills: readSkills(library), extensions: readExtensions(library), mixins: readMixins(library), agents: readAgentsMdFiles(library) }
  if (editName) {
    const file = join(library, 'profiles', `${editName}.json`)
    if (!existsSync(file)) { process.stderr.write(`no profile '${editName}' at ${file}\n`); process.exit(1) }
    const profile = JSON.parse(readFileSync(file, 'utf8'))
    if (!representableInMenu(profile)) {
      process.stderr.write(`heads up: '${editName}' uses glob or exclude filters the menu cannot round-trip; saving will rewrite them as explicit lists.\n`)
    }
    writeState(profileToState(profile, editName))
  } else {
    writeState(emptyState())
  }

  const preview = `node ${SELF} --preview`
  const render = `node ${SELF} --render`
  const toggle = `node ${SELF} --toggle {}`

  const result = spawnSync('fzf', [
    '--ansi',
    '--reverse',
    '--height', '95%',
    '--disabled',
    '--prompt', 'compose> ',
    '--preview', preview,
    '--preview-window', 'right:55%:wrap',
    '--bind', `start:reload(${render})`,
    '--bind', `space:reload(${toggle} && ${render})+refresh-preview`,
    '--bind', `enter:reload(${toggle} && ${render})+refresh-preview`,
    '--bind', 'j:down',
    '--bind', 'k:up',
    '--bind', 'g:first',
    '--bind', 'G:last',
    '--bind', 'ctrl-d:half-page-down',
    '--bind', 'ctrl-u:half-page-up',
    '--bind', '/:enable-search+show-input',
    '--bind', 'esc:transform:[[ $FZF_INPUT_STATE = enabled ]] && echo "disable-search+hide-input+clear-query" || echo "abort"',
    '--bind', 'q:abort',
    '--bind', `ctrl-s:execute(node ${SELF} --save </dev/tty >/dev/tty)+abort`,
    '--bind', `O:execute(node ${SELF} --open-in-nvim </dev/tty >/dev/tty)+abort`,
    '--header', 'j/k move · space toggle · / search · Ctrl-S save · O open in nvim · q quit',
    '--no-info'
  ], { stdio: 'inherit' })

  if (result.status !== 0) process.stderr.write('\nhelm-pi menu: cancelled\n')
}

function readState() {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
}
function writeState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state))
}
function readLibrary() {
  return readFileSync(LIBRARY_FILE, 'utf8').trim()
}

const CHECK_ON = '\x1b[32m[x]\x1b[0m'
const CHECK_OFF = '\x1b[2m[ ]\x1b[0m'
const RADIO_ON = '\x1b[32m(o)\x1b[0m'
const RADIO_OFF = '\x1b[2m( )\x1b[0m'
const SECTION = (text) => `\x1b[1;35m── ${text} ──\x1b[0m`

// Every row is prefixed with a short tag the toggle handler parses. Section
// headers are prefixed with a non-selectable marker so a stray Enter does not
// mutate anything.
export function renderList() {
  const state = readState()
  const library = readLibrary()
  const discovery = { skills: readSkills(library), extensions: readExtensions(library), mixins: readMixins(library), agents: readAgentsMdFiles(library) }
  const out = []

  out.push(`hdr\t${SECTION('Extends')}`)
  for (const base of PROFILE_BASES) {
    const mark = state.extends === base ? RADIO_ON : RADIO_OFF
    out.push(`ext\t${base}\t${mark} ${base}`)
  }
  out.push(`ext\t\t${state.extends === '' ? RADIO_ON : RADIO_OFF} (none)`)

  out.push(`hdr\t${SECTION('Mixins')}`)
  if (discovery.mixins.length === 0) out.push(`hdr\t  \x1b[2m(no mixins in the library yet)\x1b[0m`)
  for (const mixin of discovery.mixins) {
    const mark = state.mixins.includes(mixin.id) ? CHECK_ON : CHECK_OFF
    out.push(`mix\t${mixin.id}\t${mark} ${mixin.id.padEnd(24)} \x1b[2m${truncate(mixin.description, 60)}\x1b[0m`)
  }

  out.push(`hdr\t${SECTION('Skills')}`)
  for (const skill of discovery.skills) {
    const mark = state.skills.includes(skill.id) ? CHECK_ON : CHECK_OFF
    out.push(`skl\t${skill.id}\t${mark} ${skill.id.padEnd(24)} \x1b[2m${truncate(skill.description, 60)}\x1b[0m`)
  }

  out.push(`hdr\t${SECTION('Extensions')}`)
  for (const ext of discovery.extensions) {
    const mark = state.extensions.includes(ext.id) ? CHECK_ON : CHECK_OFF
    out.push(`xtn\t${ext.id}\t${mark} ${ext.id.padEnd(24)} \x1b[2m${truncate(ext.description, 60)}\x1b[0m`)
  }

  out.push(`hdr\t${SECTION('Location')}`)
  const rows = [
    ['anywhere', 'anywhere'],
    ['requires:parent-of-repos', 'any parent-of-repos folder'],
    ['requires:inside-git-repo', 'any dir inside a git repo']
  ]
  const paneCwd = paneCwdForPopup()
  if (paneCwd) rows.push([`pin:${paneCwd}`, `pin here (${paneCwd})`])
  rows.push(['pin-prompt', 'pin to another path\u2026'])
  for (const [id, label] of rows) {
    const mark = matchesLocation(state.location, id) ? RADIO_ON : RADIO_OFF
    out.push(`loc\t${id}\t${mark} ${label}`)
  }

  out.push(`hdr\t${SECTION('AGENTS.md')}`)
  for (const agent of discovery.agents) {
    const mark = state.agentsMd === agent.id ? RADIO_ON : RADIO_OFF
    out.push(`agn\t${agent.id}\t${mark} ${agent.id}`)
  }
  out.push(`agn\t\t${state.agentsMd === '' ? RADIO_ON : RADIO_OFF} (none)`)

  process.stdout.write(out.join('\n') + '\n')
}

function matchesLocation(location, id) {
  if (id === 'anywhere') return location === 'anywhere'
  if (id.startsWith('requires:')) return typeof location === 'object' && location.requires === id.slice('requires:'.length)
  if (id.startsWith('pin:')) return typeof location === 'object' && location.path === id.slice('pin:'.length)
  return false
}

function paneCwdForPopup() {
  const paneId = process.env.HERDR_ACTIVE_PANE_ID
  if (!paneId) return null
  const result = spawnSync('herdr', ['pane', 'get', paneId], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (result.status !== 0) return null
  try { return JSON.parse(result.stdout).result.pane.cwd } catch { return null }
}

function truncate(text, width) {
  const clean = (text ?? '').replace(/\s+/g, ' ')
  return clean.length <= width ? clean : clean.slice(0, width - 1) + '…'
}

export function handleToggle(row) {
  const state = readState()
  const parts = row.split('\t')
  const kind = parts[0]
  const id = parts[1] ?? ''
  if (kind === 'hdr') { writeState(state); return }
  if (kind === 'ext') state.extends = id
  else if (kind === 'skl') toggleIn(state.skills, id)
  else if (kind === 'xtn') toggleIn(state.extensions, id)
  else if (kind === 'mix') toggleIn(state.mixins, id)
  else if (kind === 'loc') state.location = resolveLocationId(id)
  else if (kind === 'agn') state.agentsMd = id
  writeState(state)
}

function resolveLocationId(id) {
  if (id === 'anywhere') return 'anywhere'
  if (id.startsWith('requires:')) return { requires: id.slice('requires:'.length) }
  if (id.startsWith('pin:')) return { path: id.slice('pin:'.length) }
  if (id === 'pin-prompt') {
    const path = readLinePrompt('Pin to path: ').trim()
    return path ? { path } : 'anywhere'
  }
  return 'anywhere'
}

function toggleIn(list, id) {
  const at = list.indexOf(id)
  if (at >= 0) list.splice(at, 1)
  else list.push(id)
}

export function renderPreviewToStdout() {
  const state = readState()
  const library = readLibrary()
  const discovery = { skills: readSkills(library), extensions: readExtensions(library), mixins: readMixins(library), agents: readAgentsMdFiles(library) }
  process.stdout.write(renderPreview(state, discovery))
}

export function save() {
  const state = readState()
  const library = readLibrary()
  const prompt = state.originalName ? `Save as [${state.originalName}]: ` : 'Save as: '
  const typed = readLinePrompt(prompt).trim()
  const name = typed || state.originalName
  if (!name) { process.stderr.write('no name given\n'); return }
  state.name = name
  const target = join(library, 'profiles', `${name}.json`)
  const contents = JSON.stringify(stateToProfile(state), null, 2) + '\n'

  if (state.originalName && name === state.originalName) {
    writeFileSync(target, contents)
    process.stdout.write(`updated ${target}\n`)
    return
  }
  if (state.originalName && name !== state.originalName) {
    if (existsSync(target)) { process.stderr.write(`refusing to rename onto existing profile '${name}'\n`); return }
    const source = join(library, 'profiles', `${state.originalName}.json`)
    writeFileSync(target, contents)
    rmSync(source)
    process.stdout.write(`renamed ${state.originalName} -> ${name}\n`)
    return
  }
  if (existsSync(target)) { process.stderr.write(`profile '${name}' already exists\n`); return }
  mkdirSync(join(library, 'profiles'), { recursive: true })
  writeFileSync(target, contents)
  process.stdout.write(`wrote ${target}\n`)
}

function readLinePrompt(prompt) {
  process.stdout.write(prompt)
  const result = spawnSync('sh', ['-c', 'read -r line && printf %s "$line"'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] })
  return result.stdout ?? ''
}

export function openInNvim() {
  const state = readState()
  const library = readLibrary()

  let target
  if (state.originalName) {
    target = join(library, 'profiles', `${state.originalName}.json`)
  } else {
    const typed = readLinePrompt('Save as (needed before opening in nvim): ').trim()
    if (!typed) { process.stderr.write('no name given\n'); return }
    state.name = typed
    target = join(library, 'profiles', `${typed}.json`)
    if (existsSync(target)) { process.stderr.write(`profile '${typed}' already exists\n`); return }
    mkdirSync(join(library, 'profiles'), { recursive: true })
    writeFileSync(target, JSON.stringify(stateToProfile(state), null, 2) + '\n')
  }

  const paneId = process.env.HERDR_ACTIVE_PANE_ID
  if (!paneId) { process.stderr.write('no HERDR_ACTIVE_PANE_ID; the menu must be launched from a herdr keybinding\n'); return }
  const split = spawnSync('herdr', ['pane', 'split', '--pane', paneId, '--direction', 'right', '--cwd', library, '--focus'], { encoding: 'utf8' })
  if (split.status !== 0) { process.stderr.write(`herdr pane split failed: ${(split.stderr || split.stdout || '').trim()}\n`); return }
  const newPane = JSON.parse(split.stdout).result.pane.pane_id
  const ran = spawnSync('herdr', ['pane', 'run', newPane, `nvim ${JSON.stringify(target)}`], { encoding: 'utf8' })
  if (ran.status !== 0) process.stderr.write(`herdr pane run failed: ${(ran.stderr || ran.stdout || '').trim()}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , flag, ...rest] = process.argv
  if (flag === '--render') renderList()
  else if (flag === '--toggle') handleToggle(rest.join(' '))
  else if (flag === '--preview') renderPreviewToStdout()
  else if (flag === '--save') save()
  else if (flag === '--open-in-nvim') openInNvim()
}

#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { mergeProfiles, stripHelmKeys } from './merge.mjs'
import { RULES, locationProblem } from './location.mjs'
import { validateLibraryFile } from './validate.mjs'

const HOME = homedir()
const CONFIG_FILE = join(HOME, '.config', 'helm', 'pi.json')
const BUILT_ROOT = join(HOME, '.local', 'share', 'helm', 'pi')
const REAL_AGENT = join(HOME, '.pi', 'agent')

const expandHome = (p) => p.replace(/^~(?=$|\/)/, HOME)

function readConfig() {
  if (!existsSync(CONFIG_FILE)) {
    mkdirSync(join(HOME, '.config', 'helm'), { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify({ library: '~/personal/pi-library' }, null, 2) + '\n')
  }
  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  const library = resolve(expandHome(config.library))
  if (!existsSync(join(library, 'profiles'))) {
    fail(`no profiles directory under the library at ${library}; point ${CONFIG_FILE} at a pi-library checkout`)
  }
  return { library }
}

function fail(message) {
  process.stderr.write(`helm-pi: ${message}\n`)
  process.exit(1)
}

function listProfiles(library) {
  return readdirSync(join(library, 'profiles'))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => basename(name, '.json'))
}

export function listMixins(library) {
  const dir = join(library, 'mixins')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => basename(name, '.json'))
}

function readMixin(library, name) {
  const file = join(library, 'mixins', `${name}.json`)
  if (!existsSync(file)) fail(`no mixin '${name}' (${file}); have: ${listMixins(library).join(', ')}`)
  return readLibraryFile(file, 'mixin')
}

// Every route into the library goes through here, so show, build, launch and
// pick all gate on the same answer to "is this file well-formed".
function readLibraryFile(file, kind) {
  const raw = parseJson(file)
  const problems = validateLibraryFile(raw, { file, kind })
  if (problems.length > 0) fail(problems.join('\nhelm-pi: '))
  return raw
}

function parseJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`${file}: not valid JSON (${error.message})`)
  }
}

function readProfile(library, name, seen = [], warnings = []) {
  if (seen.includes(name)) fail(`profile extends cycle: ${[...seen, name].join(' -> ')}`)
  const file = join(library, 'profiles', `${name}.json`)
  if (!existsSync(file)) {
    fail(`no profile '${name}' (${file}); have: ${listProfiles(library).join(', ')}`)
  }
  const profile = readLibraryFile(file, 'profile')
  // Fold order is parent -> mixins -> this profile, so the leaf still wins
  // over its own mixins and you can pick a mixin and then tweak one field.
  const parent = profile.extends ? readProfile(library, profile.extends, [...seen, name], warnings) : {}
  const withMixins = (profile.mixins ?? []).reduce(
    (acc, mixin) => mergeProfiles(acc, readMixin(library, mixin), warnings),
    parent
  )
  return mergeProfiles(withMixins, stripInheritanceFields(profile), warnings)
}

function printWarnings(warnings) {
  for (const warning of warnings) process.stderr.write(`helm-pi: ${warning}\n`)
}

// The child overrides its parents' non-inheritance fields, but the child's own
// `mixins` and `extends` do not carry through to the merged result - they are
// the recipe for the merge, not fields that survive it.
function stripInheritanceFields(profile) {
  const { extends: _e, mixins: _m, ...rest } = profile
  return rest
}

// The single funnel from a resolved profile to settings.json, and so the one
// place helm's own keys are guaranteed not to reach pi.
function resolvePackages(profile, library) {
  return (profile.packages ?? []).map((entry) => {
    if (typeof entry === 'string') return entry === 'library' ? library : entry
    const clean = stripHelmKeys(entry)
    return clean.source === 'library' ? { ...clean, source: library } : clean
  })
}

function forceSymlink(target, linkPath) {
  if (existsSync(linkPath) || isLink(linkPath)) {
    if (!isLink(linkPath)) return false
    rmSync(linkPath)
  }
  symlinkSync(target, linkPath)
  return true
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function build(library, name) {
  const warnings = []
  const profile = readProfile(library, name, [], warnings)
  printWarnings(warnings)
  const dir = join(BUILT_ROOT, name)
  mkdirSync(dir, { recursive: true })

  const base = existsSync(join(REAL_AGENT, 'settings.json'))
    ? JSON.parse(readFileSync(join(REAL_AGENT, 'settings.json'), 'utf8'))
    : {}
  delete base.packages
  const settings = { ...base, ...(profile.settings ?? {}), packages: resolvePackages(profile, library) }
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n')

  if (profile.agentsMd) {
    copyFileSync(join(library, expandHome(profile.agentsMd)), join(dir, 'AGENTS.md'))
  } else if (isLink(join(dir, 'AGENTS.md')) || existsSync(join(dir, 'AGENTS.md'))) {
    rmSync(join(dir, 'AGENTS.md'))
  }

  // The real agent dir's sidecar files are the session's identity and caches:
  // auth.json is the credential (never copied, never read), extension configs
  // ride beside it, and npm/ + git/ are the package stores pi would otherwise
  // re-download per profile. Symlinked so every built dir shares them; only
  // settings.json is the composer's own.
  const skipped = []
  for (const entry of readdirSync(REAL_AGENT)) {
    if (entry === 'settings.json' || entry === 'sessions') continue
    const target = join(REAL_AGENT, entry)
    if (entry.endsWith('.json') || entry === 'extensions' || entry === 'npm' || entry === 'git') {
      if (!forceSymlink(target, join(dir, entry))) skipped.push(entry)
    }
  }
  return { profile, dir, skipped }
}

function herdr(args, { json = false } = {}) {
  const result = spawnSync('herdr', args, { encoding: 'utf8' })
  if (result.error) fail(`could not run herdr (${result.error.message}); is it on PATH?`)
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || '').trim() }
  }
  return { ok: true, out: json ? JSON.parse(result.stdout) : result.stdout }
}

function paneInfo(paneId) {
  const got = herdr(['pane', 'process-info', '--pane', paneId], { json: true })
  if (!got.ok) fail(`could not read pane ${paneId}: ${got.error}`)
  return got.out.result.process_info
}

function paneCwd(paneId) {
  const got = herdr(['pane', 'get', paneId], { json: true })
  if (!got.ok) fail(`could not read pane ${paneId}: ${got.error}`)
  return got.out.result.pane.cwd
}

/** A pane whose only foreground process is its own shell has nothing to lose. */
function isEmptyShell(info) {
  return info.foreground_processes.length === 1 && info.foreground_processes[0].pid === info.shell_pid
}

function agentName(profile, name, override) {
  const raw = (override ?? profile.label ?? name).toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  const trimmed = raw.replace(/^[^a-z]+/, '')
  return (trimmed || 'pi').slice(0, 32)
}

// Three levels, one field: absent or "anywhere" launches wherever you are,
// { requires } accepts any directory the named rule matches, { path } pins.
function locationOf(profile) {
  const location = profile.location ?? (profile.cwd ? { path: profile.cwd } : 'anywhere')
  if (location === 'anywhere') return { kind: 'anywhere' }
  if (location.path) return { kind: 'pinned', path: resolve(expandHome(location.path)) }
  if (location.requires) {
    if (!RULES[location.requires]) fail(`unknown location rule '${location.requires}'; have: ${Object.keys(RULES).join(', ')}`)
    return { kind: 'requires', rule: location.requires }
  }
  fail(`location must be "anywhere", { "requires": <rule> } or { "path": <dir> }`)
}

function launch(library, name, flags) {
  const { profile, dir, skipped } = build(library, name)
  const location = locationOf(profile)
  // A pane already has a working directory; pi will start in it, so that is
  // the directory the profile's location has to answer for.
  const fallback = flags.pane ? paneCwd(flags.pane) : location.kind === 'pinned' ? location.path : '~'
  const cwd = resolve(expandHome(flags.cwd ?? fallback))
  if (!existsSync(cwd)) fail(`workspace cwd does not exist: ${cwd}`)

  const problem = locationProblem(location, cwd)
  if (problem) fail(`profile '${name}' cannot run in ${cwd}: ${problem}`)

  const env = {
    PI_CODING_AGENT_DIR: dir,
    PI_CODING_AGENT_SESSION_DIR: join(REAL_AGENT, 'sessions'),
    ...Object.fromEntries(Object.entries(profile.env ?? {}).map(([k, v]) => [k, expandHome(String(v)).replaceAll('${cwd}', cwd)]))
  }

  // An existing pane's environment is fixed at its creation, so a profile
  // launched into one carries its env inline on the pi command instead.
  if (flags.pane) {
    const quote = (part) => `'${String(part).replace(/'/g, `'\\''`)}'`
    const command = [
      ...Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`),
      'pi',
      ...flags.rest.map(quote)
    ].join(' ')
    if (flags.dryRun) {
      process.stdout.write(`herdr pane run ${flags.pane} "${command}"\n`)
      return
    }
    const ran = herdr(['pane', 'run', flags.pane, command])
    if (!ran.ok) fail(`pane run failed in ${flags.pane}: ${ran.error}`)
    process.stdout.write(JSON.stringify({ profile: name, pane: flags.pane, agentDir: dir, detached: true }, null, 2) + '\n')
    return
  }

  const createArgs = ['workspace', 'create', '--cwd', cwd, '--label', profile.label ?? name, flags.focus ? '--focus' : '--no-focus']
  for (const [key, value] of Object.entries(env)) createArgs.push('--env', `${key}=${value}`)

  if (flags.dryRun) {
    process.stdout.write(`herdr ${createArgs.join(' ')}\nherdr agent start <name> --kind pi --pane <root>\n`)
    return
  }

  process.stderr.write(`helm-pi: starting pi (${name}) in ${cwd}...\n`)
  const created = herdr(createArgs, { json: true })
  if (!created.ok) fail(`workspace create failed: ${created.error}`)
  const pane = created.out.result.root_pane.pane_id

  if (flags.detach && !profile.openingPrompt) {
    const command = ['pi', ...flags.rest].map((part) => `'${part.replace(/'/g, `'\''`)}'`).join(' ')
    const ran = herdr(['pane', 'run', pane, command])
    if (!ran.ok) fail(`pane run failed in ${pane}: ${ran.error}`)
    process.stdout.write(JSON.stringify({ profile: name, pane, cwd, agentDir: dir, detached: true }, null, 2) + '\n')
    return
  }

  let agent = null
  const wanted = agentName(profile, name, flags.name)
  for (const candidate of [wanted, ...[2, 3, 4, 5].map((n) => `${wanted}-${n}`)]) {
    const started = herdr(['agent', 'start', candidate, '--kind', 'pi', '--pane', pane, ...(flags.rest.length ? ['--', ...flags.rest] : [])], { json: true })
    if (started.ok) {
      agent = candidate
      break
    }
    if (!/name/i.test(started.error)) fail(`agent start failed in pane ${pane}: ${started.error}`)
  }
  if (!agent) fail(`could not find a free agent name near '${wanted}'; the pane ${pane} is waiting`)

  if (profile.openingPrompt) {
    const prompted = herdr(['agent', 'prompt', agent, profile.openingPrompt])
    if (!prompted.ok) process.stderr.write(`helm-pi: opening prompt not delivered: ${prompted.error}\n`)
  }

  for (const entry of skipped) {
    process.stderr.write(`helm-pi: left ${join(dir, entry)} alone (a real file where a symlink would go)\n`)
  }
  process.stdout.write(JSON.stringify({ profile: name, agent, pane, cwd, agentDir: dir }, null, 2) + '\n')
}

/**
 * The keybinding: choose a profile and put it where it belongs. An idle shell
 * is replaced rather than split, because that pane is what you opened the
 * folder in; a pinned profile chosen from anywhere else opens at its own path.
 */
function pick(library, flags) {
  const paneId = flags.pane ?? process.env.HERDR_ACTIVE_PANE_ID
  if (!paneId) fail('no pane: pass --pane or run this from a herdr keybinding')

  const names = listProfiles(library)
  if (names.length === 0) fail(`no profiles in ${join(library, 'profiles')}`)
  const chosen = spawnSync('fzf', ['--prompt', 'profile> '], { input: names.join('\n'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] })
  const name = (chosen.stdout ?? '').trim()
  if (name === '') return

  const cwd = paneCwd(paneId)
  const location = locationOf(readProfile(library, name))

  if (location.kind === 'pinned' && location.path !== cwd) {
    process.stderr.write(`helm-pi: ${name} is pinned to ${location.path}; opening it there.\n`)
    launch(library, name, { ...flags, cwd: location.path, pane: undefined, focus: true })
    return
  }

  const problem = locationProblem(location, cwd)
  if (problem) fail(`profile '${name}' cannot run in ${cwd}: ${problem}`)

  const target = isEmptyShell(paneInfo(paneId))
    ? paneId
    : herdr(['pane', 'split', '--pane', paneId, '--direction', 'right', '--focus'], { json: true }).out?.result?.pane?.pane_id
  if (!target) fail(`could not split pane ${paneId}`)
  launch(library, name, { ...flags, pane: target })
}

function pickProfileName(library, prompt) {
  const names = listProfiles(library)
  if (names.length === 0) fail('no profiles to pick')
  const chosen = spawnSync('fzf', ['--prompt', prompt, '--reverse', '--height', '40%'], { input: names.join('\n'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] })
  return (chosen.stdout ?? '').trim() || null
}

// A whole-library lint: every file is read and reported on, so one pass names
// every problem instead of the first one a launch happened to hit.
function checkLibrary(library) {
  const profiles = listProfiles(library)
  const mixins = listMixins(library)
  const problems = []

  const inspect = (file, kind, name) => {
    let raw
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      problems.push(`${file}: not valid JSON (${error.message})`)
      return
    }
    problems.push(...validateLibraryFile(raw, { file, kind }))
    if (kind !== 'profile') return
    if (typeof raw.extends === 'string' && !profiles.includes(raw.extends)) {
      problems.push(`${file}: extends '${raw.extends}', which is not a profile in the library. Have: ${profiles.join(', ')}.`)
    }
    for (const mixin of Array.isArray(raw.mixins) ? raw.mixins : []) {
      if (typeof mixin === 'string' && !mixins.includes(mixin)) {
        problems.push(`${file}: lists mixin '${mixin}', which is not in the library. Have: ${mixins.join(', ') || '(none)'}.`)
      }
    }
    if (name === raw.extends) problems.push(`${file}: extends itself.`)
  }

  for (const name of profiles) inspect(join(library, 'profiles', `${name}.json`), 'profile', name)
  for (const name of mixins) inspect(join(library, 'mixins', `${name}.json`), 'mixin', name)

  for (const problem of problems) process.stderr.write(`helm-pi: ${problem}\n`)
  const counted = `${profiles.length} profile${profiles.length === 1 ? '' : 's'}, ${mixins.length} mixin${mixins.length === 1 ? '' : 's'}`
  if (problems.length > 0) {
    process.stderr.write(`helm-pi: ${problems.length} problem${problems.length === 1 ? '' : 's'} across ${counted}\n`)
    process.exit(1)
  }
  process.stdout.write(`${counted}: all valid\n`)
}

function main() {
  const [command, ...argv] = process.argv.slice(2)
  const flags = { rest: [], dryRun: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      flags.rest = argv.slice(i + 1)
      break
    } else if (arg === '--dry-run') flags.dryRun = true
    else if (arg === '--focus') flags.focus = true
    else if (arg === '--detach') flags.detach = true
    else if (arg === '--pane') flags.pane = argv[++i]
    else if (arg === '--cwd') flags.cwd = argv[++i]
    else if (arg === '--name') flags.name = argv[++i]
    else positional.push(arg)
  }

  const { library } = readConfig()
  switch (command) {
    case 'list': {
      for (const name of listProfiles(library)) {
        const location = locationOf(readProfile(library, name))
        const where = location.kind === 'anywhere' ? 'anywhere' : location.kind === 'pinned' ? location.path : location.rule
        process.stdout.write(`${name.padEnd(16)} ${where}\n`)
      }
      return
    }
    case 'show': {
      const warnings = []
      const profile = readProfile(library, positional[0] ?? fail('show needs a profile name'), [], warnings)
      printWarnings(warnings)
      process.stdout.write(JSON.stringify({ ...profile, builtDir: join(BUILT_ROOT, positional[0]) }, null, 2) + '\n')
      return
    }
    case 'build': {
      const { dir } = build(library, positional[0] ?? fail('build needs a profile name'))
      process.stdout.write(dir + '\n')
      return
    }
    case 'launch':
      launch(library, positional[0] ?? fail('launch needs a profile name'), flags)
      return
    case 'pick':
      pick(library, flags)
      return
    case 'menu':
      return import('./menu.mjs').then((m) => m.runMenu(library, positional[0]))
    case 'edit': {
      const target = positional[0] ?? pickProfileName(library, 'edit which profile? ')
      if (!target) return
      return import('./menu.mjs').then((m) => m.runMenu(library, target))
    }
    case 'mixins':
      for (const name of listMixins(library)) process.stdout.write(`${name}\n`)
      return
    case 'check':
      checkLibrary(library)
      return
    default:
      process.stdout.write(
        'usage: helm-pi <command>\n' +
        '  list                                  profiles in the library\n' +
        '  show <profile>                        one profile, resolved\n' +
        '  build <profile>                       materialize its agent dir\n' +
        '  launch <profile> [--cwd d] [--name n] [--focus] [--detach] [--pane id] [--dry-run] [-- pi args]\n' +
        '  pick [--pane id]                      choose a profile and place it for the current pane\n' +
        '  menu [profile]                        compose a new profile, or edit an existing one\n' +
        '  edit [profile]                        pick a profile to edit (or pass a name)\n' +
        '  mixins                                mixins in the library\n' +
        '  check                                 validate every profile and mixin; exits non-zero on any problem\n'
      )
      if (command) process.exit(2)
  }
}

main()

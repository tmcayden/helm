import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, win32 } from 'node:path'
import { pathKey } from '../paths/key'
import { claudeHome } from '../discovery/history'
import { overlayPluginNames } from '../launch/overlay'
import type {
  EffectiveEntry,
  EffectiveMcpServer,
  EffectiveSetting,
  EffectiveSource,
  EffectiveView,
  SettingsLayer,
  SettingsLayerKind
} from '../types'
import { readConfigTree, projectConfigScope, userConfigScope } from './tree'

/**
 * What a session would actually see, computed before one is launched.
 *
 * This is the thing no file explorer can tell you (SPEC 4.2). A `.claude`
 * directory is a set of files; a *session* is those files resolved against a
 * working directory, a set of composed overlays, and three layers of settings
 * that override each other. The gap between the two is where the whole
 * composition model either pays off or quietly does not, and it is invisible
 * until something fails to resolve.
 *
 * Two things make it predictable rather than guesswork:
 *
 *   Namespacing is deterministic. The platform prefixes everything an overlay
 *   contributes with the plugin's manifest name (Spike A), and Helm chooses
 *   that name - so `<overlay>:think` is decidable from the profile alone.
 *   Cross-overlay collisions cannot occur, which is why this predicts names
 *   instead of detecting clashes.
 *
 *   Settings merge per leaf, not per top-level key. Measured on 2.1.225: a
 *   project `settings.json` setting `env.A` and a `settings.local.json` setting
 *   `env.B` produce a session with both, and where the two name the same leaf
 *   the local one wins. So the winner is computed at `env.A` granularity.
 */

export interface EffectiveInput {
  /** The session's working directory. */
  cwd: string
  /** Project paths composed via `--plugin-dir`. */
  overlays?: readonly string[] | undefined
  profileId?: number | null | undefined
  profileName?: string | null | undefined
  /** Overridden only by the checks, which point at a fixture tree. */
  userHome?: string | undefined
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function fileBytes(path: string): number | null {
  try {
    const stat = statSync(path)
    return stat.isFile() ? stat.size : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Skills, commands, agents
// ---------------------------------------------------------------------------

/**
 * One source's contributions, addressed the way a session would address them.
 *
 * The namespace is applied here rather than at the call site because it is the
 * only difference between the three sources: the cwd's own `.claude` and the
 * user's resolve bare, and everything an overlay carries is prefixed.
 */
function entriesFrom(
  basePath: string,
  source: EffectiveSource,
  namespace: string | null
): { skills: EffectiveEntry[]; commands: EffectiveEntry[]; agents: EffectiveEntry[] } {
  const scope =
    source === 'user' ? userConfigScope(basePath) : projectConfigScope(basePath)
  const tree = readConfigTree(scope)

  const skills: EffectiveEntry[] = []
  const commands: EffectiveEntry[] = []
  const agents: EffectiveEntry[] = []

  for (const file of tree.files) {
    const bucket =
      file.kind === 'skill' ? skills : file.kind === 'command' ? commands : file.kind === 'agent' ? agents : null
    if (!bucket) continue
    bucket.push({
      invocation: namespace === null ? file.name : `${namespace}:${file.name}`,
      name: file.name,
      source,
      namespace,
      origin: scope.path,
      path: file.path,
      description: file.description
    })
  }

  return { skills, commands, agents }
}

const byInvocation = (a: EffectiveEntry, b: EffectiveEntry): number =>
  a.invocation.localeCompare(b.invocation)

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * A settings document flattened to leaf paths.
 *
 * Plain objects are descended into; arrays are leaves. An array in this file is
 * a list the CLI consumes whole - `permissions.allow`, `enabledMcpjsonServers` -
 * so splitting one into indexed leaves would claim that layers merge element by
 * element, which is a stronger claim than anything measured here supports.
 */
function flatten(value: unknown, prefix: string, into: Map<string, string>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) {
      into.set(prefix, '{}')
      return
    }
    for (const [key, child] of entries) {
      flatten(child, prefix === '' ? key : `${prefix}.${key}`, into)
    }
    return
  }
  if (prefix !== '') into.set(prefix, JSON.stringify(value))
}

interface LoadedLayer {
  kind: SettingsLayerKind
  file: string
  exists: boolean
  values: Map<string, string>
  error: string | null
}

function loadLayer(kind: SettingsLayerKind, file: string): LoadedLayer {
  const values = new Map<string, string>()
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { kind, file, exists: false, values, error: null }
  }
  try {
    flatten(JSON.parse(raw), '', values)
    return { kind, file, exists: true, values, error: null }
  } catch (err) {
    return {
      kind,
      file,
      exists: true,
      values,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * The precedence chain, highest first.
 *
 * Local over project over user, which is the CLI's documented order and was
 * re-measured here on 2.1.225 for the local/project pair: a session in a
 * directory whose `settings.json` and `settings.local.json` both set the same
 * `env` name reported the local one. Enterprise managed policy sits above all
 * three and command-line flags above that; neither is a file this console
 * edits, so neither is a layer it shows.
 */
function settingsChain(cwd: string, userDir: string): LoadedLayer[] {
  return [
    loadLayer('local', join(cwd, '.claude', 'settings.local.json')),
    loadLayer('project', join(cwd, '.claude', 'settings.json')),
    loadLayer('user', join(userDir, 'settings.json'))
  ]
}

function resolveSettings(chain: LoadedLayer[]): EffectiveSetting[] {
  const keys = new Set<string>()
  for (const layer of chain) for (const key of layer.values.keys()) keys.add(key)

  const out: EffectiveSetting[] = []
  for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
    const candidates = chain
      .filter((layer) => layer.values.has(key))
      .map((layer) => ({
        layer: layer.kind,
        file: layer.file,
        value: layer.values.get(key) ?? ''
      }))
    const winner = candidates[0]
    if (!winner) continue
    out.push({
      key,
      value: winner.value,
      winner: winner.layer,
      winnerFile: winner.file,
      candidates,
      // Only an override when a lower layer says something *different*: two
      // layers agreeing on a value is not a decision anybody made.
      overridden: candidates.some((candidate) => candidate.value !== winner.value)
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** `~/.claude.json`, which is not inside `~/.claude` and is not a settings file. */
export function claudeJsonPath(home: string = homedir()): string {
  return join(home, '.claude.json')
}

function serversIn(doc: Record<string, unknown> | null): Record<string, unknown> {
  const servers = doc?.['mcpServers']
  return servers !== null && typeof servers === 'object' && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : {}
}

function transportOf(config: unknown): string {
  if (config === null || typeof config !== 'object') return 'unknown'
  const record = config as Record<string, unknown>
  const declared = record['type'] ?? record['transport']
  if (typeof declared === 'string') return declared
  return typeof record['url'] === 'string' ? 'http' : 'stdio'
}

/**
 * `~/.claude.json`'s `projects` entry for a directory, found by what the key
 * *means* rather than by what it says.
 *
 * The keys are whatever string the CLI was started with, and on Windows that is
 * not one string per directory. Counted on one machine: 75 keys, 72 written
 * with forward slashes and 3 with backslashes, and one home directory present
 * under **both** forms as two separate entries. An exact match against
 * `resolve(cwd)` - which always produces backslashes - therefore missed the
 * local-scope MCP servers of essentially every project on disk, and the config
 * console reported "no servers configured" for a directory whose session had
 * one loaded.
 *
 * Both separators are folded and, on Windows, the comparison is
 * case-insensitive, because there these are Windows paths - and the platform is
 * a parameter so that branch is tested from any host. Where a directory really
 * is present twice, the entry
 * that actually defines servers is the one returned - two entries are one
 * directory, and picking whichever came first in the file would answer "no
 * servers" for a directory that has them.
 *
 * Exported for its own unit tests: the document it reads is the real
 * `~/.claude.json` wherever `computeEffectiveView` is called, so this is the
 * only level at which the key-shape rule can be stated hermetically.
 */
export function projectEntry(
  projects: unknown,
  cwd: string,
  platform: NodeJS.Platform = process.platform
): Record<string, unknown> | undefined {
  if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) return undefined
  const windows = platform === 'win32'
  const fold = (path: string): string =>
    windows
      ? pathKey(path.replace(/[\\/]+/g, '\\').replace(/\\$/, ''), platform)
      : path.replace(/\/+$/, '')
  const wanted = fold(windows ? win32.resolve(cwd) : resolve(cwd))

  let fallback: Record<string, unknown> | undefined
  for (const [name, value] of Object.entries(projects as Record<string, unknown>)) {
    if (fold(name) !== wanted) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    if (Object.keys(serversIn(entry)).length > 0) return entry
    fallback ??= entry
  }
  return fallback
}

/**
 * Every MCP server a session in `cwd` could load, and whether it would.
 *
 * Three places, which is not obvious from anywhere: `.mcp.json` in the project
 * (shared, and gated behind approval), `~/.claude.json` under
 * `projects[<cwd>].mcpServers` (the CLI's `local` scope, which is per
 * directory), and `~/.claude.json` at the top level (`user`). Precedence is
 * local over project over user, which is the order `claude mcp add --scope`
 * documents.
 */
function effectiveMcp(cwd: string, chain: LoadedLayer[]): EffectiveMcpServer[] {
  const projectFile = join(cwd, '.mcp.json')
  const claudeJson = claudeJsonPath()
  const globalDoc = readJsonObject(claudeJson)

  const perProject = projectEntry(globalDoc?.['projects'], cwd)

  // Approval is a settings question, and the settings chain has already been
  // resolved - so it is read from there rather than from the files again.
  const winning = (key: string): string | undefined =>
    chain.find((layer) => layer.values.has(key))?.values.get(key)
  const approvalLayer = (key: string): string | null =>
    chain.find((layer) => layer.values.has(key))?.file ?? null

  const parseList = (raw: string | undefined): string[] => {
    if (raw === undefined) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    } catch {
      return []
    }
  }
  const enabled = parseList(winning('enabledMcpjsonServers'))
  const disabled = parseList(winning('disabledMcpjsonServers'))
  const enableAll = winning('enableAllProjectMcpServers') === 'true'

  const rows: EffectiveMcpServer[] = []
  const seen = new Map<string, string>()

  const add = (
    name: string,
    scope: EffectiveMcpServer['scope'],
    file: string,
    config: unknown
  ): void => {
    const shadowedBy = seen.has(name) ? (seen.get(name) ?? null) : null
    if (!seen.has(name)) seen.set(name, scope)

    let approved: boolean | null = null
    let approvedBy: string | null = null
    if (scope === 'project') {
      if (disabled.includes(name)) {
        approved = false
        approvedBy = approvalLayer('disabledMcpjsonServers')
      } else if (enabled.includes(name)) {
        approved = true
        approvedBy = approvalLayer('enabledMcpjsonServers')
      } else if (enableAll) {
        approved = true
        approvedBy = approvalLayer('enableAllProjectMcpServers')
      } else {
        approved = false
        approvedBy = null
      }
    }

    rows.push({
      name,
      scope,
      file,
      config: JSON.stringify(config, null, 2),
      transport: transportOf(config),
      approved,
      approvedBy,
      shadowedBy
    })
  }

  // Highest precedence first, so `shadowedBy` names the scope that wins.
  for (const [name, config] of Object.entries(serversIn(perProject ?? null))) {
    add(name, 'local', claudeJson, config)
  }
  for (const [name, config] of Object.entries(serversIn(readJsonObject(projectFile)))) {
    add(name, 'project', projectFile, config)
  }
  for (const [name, config] of Object.entries(serversIn(globalDoc))) {
    add(name, 'user', claudeJson, config)
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope))
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export function computeEffectiveView(input: EffectiveInput): EffectiveView {
  const cwd = resolve(input.cwd)
  const userDir = input.userHome ?? claudeHome()
  const warnings: string[] = []

  const overlayPaths = [...new Set((input.overlays ?? []).map((path) => resolve(path)))]
  // The same function the launcher uses to name a shim, so the prediction is
  // the launcher's own answer rather than a second guess at it. Two projects
  // with the same directory name get suffixed here exactly as they would there.
  const names = overlayPluginNames(overlayPaths)

  const skills: EffectiveEntry[] = []
  const commands: EffectiveEntry[] = []
  const agents: EffectiveEntry[] = []

  const push = (from: ReturnType<typeof entriesFrom>): void => {
    skills.push(...from.skills)
    commands.push(...from.commands)
    agents.push(...from.agents)
  }

  push(entriesFrom(userDir, 'user', null))
  push(entriesFrom(cwd, 'cwd', null))

  const overlays: EffectiveView['overlays'] = []
  overlayPaths.forEach((path, index) => {
    const name = names[index] ?? basename(path).toLowerCase()
    const exists = isDir(path)
    if (!exists) {
      warnings.push(`${path} is not on disk, so nothing would be composed from it.`)
      overlays.push({ name, projectPath: path, exists: false, skills: 0, commands: 0, agents: 0 })
      return
    }
    const from = entriesFrom(path, 'overlay', name)
    push(from)
    overlays.push({
      name,
      projectPath: path,
      exists: true,
      skills: from.skills.length,
      commands: from.commands.length,
      agents: from.agents.length
    })
    if (from.skills.length + from.commands.length + from.agents.length === 0) {
      warnings.push(
        `${path} has no skills, commands or agents to compose - only its CLAUDE.md would arrive.`
      )
    }
  })

  skills.sort(byInvocation)
  commands.sort(byInvocation)
  agents.sort(byInvocation)

  // A name carried by more than one source. Every copy resolves - the platform
  // gives each its own prefix - so this is a map, not a warning.
  const shared = new Map<string, string[]>()
  for (const entry of [...skills, ...commands, ...agents]) {
    shared.set(entry.name, [...(shared.get(entry.name) ?? []), entry.invocation])
  }
  const sharedNames = [...shared.entries()]
    .filter(([, invocations]) => invocations.length > 1)
    .map(([name, invocations]) => ({ name, invocations: [...invocations].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const chain = settingsChain(cwd, userDir)
  const settingsLayers: SettingsLayer[] = chain.map((layer) => ({
    kind: layer.kind,
    file: layer.file,
    exists: layer.exists,
    keys: layer.values.size,
    error: layer.error
  }))
  for (const layer of chain) {
    if (layer.error !== null) {
      warnings.push(`${layer.file} is not valid JSON, so the CLI ignores it: ${layer.error}`)
    }
  }

  // The order a session receives them: the user's, then the working
  // directory's, then whatever the overlays contributed through
  // `--append-system-prompt-file` - which is the only way an overlay's
  // instructions arrive at all (measured when profiles were built).
  const instructions: EffectiveView['instructions'] = []
  const addInstruction = (path: string, source: EffectiveSource, origin: string): void => {
    const bytes = fileBytes(path)
    if (bytes === null) return
    instructions.push({ path, source, bytes, origin })
  }
  addInstruction(join(userDir, 'CLAUDE.md'), 'user', userDir)
  addInstruction(join(cwd, 'CLAUDE.md'), 'cwd', cwd)
  for (const overlay of overlays) {
    if (!overlay.exists) continue
    addInstruction(join(overlay.projectPath, 'CLAUDE.md'), 'overlay', overlay.projectPath)
  }

  return {
    cwd,
    profileId: input.profileId ?? null,
    profileName: input.profileName ?? null,
    overlays,
    skills,
    commands,
    agents,
    sharedNames,
    settingsLayers,
    settings: resolveSettings(chain),
    instructions,
    mcpServers: effectiveMcp(cwd, chain),
    warnings,
    computedAt: new Date().toISOString()
  }
}

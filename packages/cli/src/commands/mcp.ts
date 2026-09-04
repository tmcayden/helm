import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { flagString } from '../args.ts'
import type { CommandContext } from '../command.ts'
import { CliError, print, printJson, warn } from '../output.ts'

type Scope = 'local' | 'user' | 'project'
const SCOPES: readonly Scope[] = ['local', 'user', 'project']

function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function serversIn(value: unknown): Record<string, unknown> {
  const servers = (value as { mcpServers?: unknown } | null)?.mcpServers
  return typeof servers === 'object' && servers !== null ? (servers as Record<string, unknown>) : {}
}

/**
 * Where `claude mcp` keeps each scope, read only to say what is about to
 * change: `user` and `local` both live in `~/.claude.json` (local under the
 * project's key), `project` in `.mcp.json` beside the code. The file is
 * Claude Code's and `claude mcp` is the only thing here that writes it.
 */
export function scopeFile(scope: Scope, cwd: string = process.cwd(), home: string = homedir()): string {
  return scope === 'project' ? join(cwd, '.mcp.json') : join(home, '.claude.json')
}

export function serversAt(scope: Scope, cwd: string = process.cwd(), home: string = homedir()): Record<string, unknown> {
  const doc = readJson(scopeFile(scope, cwd, home))
  if (doc === null) return {}
  if (scope !== 'local') return serversIn(doc)
  const projects = doc['projects'] as Record<string, unknown> | undefined
  return serversIn(projects?.[resolve(cwd)] ?? null)
}

function claudeMcp(args: string[]): number {
  const result = spawnSync('claude', ['mcp', ...args], { stdio: 'inherit' })
  if (result.error) throw new CliError('claude is not on PATH.', 127)
  return result.status ?? 1
}

const REDACTED = '<redacted>'

/**
 * A server entry can carry a token - in `env`, in `headers`, or as a
 * `--header "Authorization: Bearer ..."` argument. `claude mcp list` prints
 * those on its own streams; Helm, having read the file, does not repeat them.
 */
export function redactServer(value: unknown): unknown {
  if (typeof value === 'string') return /bearer\s+\S/i.test(value) ? value.replace(/(bearer\s+)\S+/i, `$1${REDACTED}`) : value
  if (Array.isArray(value)) return value.map(redactServer)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) =>
      key === 'env' || key === 'headers'
        ? [key, typeof inner === 'object' && inner !== null ? Object.fromEntries(Object.keys(inner).map((k) => [k, REDACTED])) : inner]
        : [key, redactServer(inner)]
    )
  )
}

function describe(value: unknown): string {
  return value === undefined ? '(absent)' : JSON.stringify(redactServer(value), null, 2)
}

export async function mcp(ctx: CommandContext): Promise<number> {
  const [verb, name, json] = ctx.args.positionals
  const scopeFlag = flagString(ctx.args.flags, 'scope')
  if (scopeFlag !== null && !SCOPES.includes(scopeFlag as Scope)) {
    throw new CliError(`--scope must be one of ${SCOPES.join(', ')}.`, 2)
  }
  const scope = scopeFlag as Scope | null

  if (verb === 'list' || verb === undefined) {
    if (!ctx.json) return claudeMcp(['list'])
    // `claude mcp list` has no --json on 2.1.260, so the JSON is the three
    // scopes' entries read from the files the CLI keeps them in.
    printJson(Object.fromEntries(SCOPES.map((s) => [s, { file: scopeFile(s), servers: redactServer(serversAt(s)) }])))
    return 0
  }

  if (verb === 'add') {
    if (name === undefined || json === undefined) throw new CliError('helm mcp add needs <name> <json>.', 2)
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      throw new CliError('The server definition is not valid JSON.', 2)
    }
    const target = scope ?? 'local'
    const before = serversAt(target)[name]
    print(`${scopeFile(target)} (${target} scope), "${name}":\n  before: ${describe(before)}\n  after:  ${describe(parsed)}`)
    if (ctx.json) {
      printJson({ scope: target, file: scopeFile(target), name, before: redactServer(before) ?? null, after: redactServer(parsed) })
    }
    return claudeMcp(['add-json', '--scope', target, name, json])
  }

  if (verb === 'remove') {
    if (name === undefined) throw new CliError('helm mcp remove needs <name>.', 2)
    const held = (scope ? [scope] : SCOPES).filter((s) => serversAt(s)[name] !== undefined)
    if (held.length === 0) warn(`"${name}" is not in ${scope ?? 'any'} scope; claude mcp remove will say so.`)
    for (const s of held) print(`${scopeFile(s)} (${s} scope), "${name}":\n  before: ${describe(serversAt(s)[name])}\n  after:  (absent)`)
    if (ctx.json) printJson(held.map((s) => ({ scope: s, file: scopeFile(s), name, before: redactServer(serversAt(s)[name]), after: null })))
    return claudeMcp(['remove', ...(scope ? ['--scope', scope] : []), name])
  }

  throw new CliError(`helm mcp takes list, add or remove, not "${verb}".`, 2)
}

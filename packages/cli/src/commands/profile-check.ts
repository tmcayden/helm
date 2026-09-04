import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { isMap, isScalar, parseDocument } from 'yaml'
import { EFFORT_LEVELS, PERMISSION_MODES } from '@helm/core/types'
import type { CommandContext } from '../command.ts'
import { knownProfiles } from '../context.ts'
import { isHarnessDir } from '../harnesses.ts'
import type { ProblemLevel, ProfileCheckReport, ProfileProblem } from '../json.ts'
import { CliError, print, printJson } from '../output.ts'
import { parseProfileFile, PROFILES_DIR } from '../profiles.ts'
import { resolveProfile } from '../profiles.ts'

const KNOWN_KEYS = new Set([
  'name',
  'root',
  'overlays',
  'access',
  'model',
  'effort',
  'permission_mode',
  'agent',
  'mcp',
  'opening_prompt',
  'target'
])

/** The harness a profile file belongs to: the directory above its `.helm/profiles`. */
export function harnessOfProfileFile(file: string): string {
  const abs = resolve(file)
  const dir = dirname(abs)
  return dir.endsWith(resolve('/', PROFILES_DIR).slice(1)) ? dirname(dirname(dir)) : dir
}

/**
 * Core's reading plus what only a file check can say. `profileFromYaml` drops a
 * value it does not accept rather than failing, which is right for an import
 * and wrong for an editor: a `permission_mode: default` silently becomes a
 * profile with no permission mode, so the dropped values come back here as
 * warnings naming what would have been accepted.
 */
export function checkProfileText(text: string, file: string, harness: string): ProfileCheckReport {
  const problems: ProfileProblem[] = []
  const doc = parseDocument(text)
  const lineOf = (key: string): number | undefined => {
    if (!isMap(doc.contents)) return undefined
    const pair = doc.contents.items.find((item) => isScalar(item.key) && item.key.value === key)
    const offset = pair && isScalar(pair.key) ? pair.key.range?.[0] : undefined
    return offset === undefined ? undefined : text.slice(0, offset).split('\n').length
  }
  const add = (level: ProblemLevel, message: string, field?: string) => {
    const problem: ProfileProblem = { level, message }
    if (field !== undefined) {
      problem.field = field
      const line = lineOf(field)
      if (line !== undefined) problem.line = line
    }
    problems.push(problem)
  }
  const warn = (message: string, field?: string) => add('warning', message, field)
  const fail = (message: string, field?: string) => add('error', message, field)

  const entry = parseProfileFile(text, file, harness)
  for (const message of entry.problems) fail(message)

  if (isMap(doc.contents)) {
    const raw = doc.contents.toJSON() as Record<string, unknown>
    for (const key of Object.keys(raw)) {
      if (!KNOWN_KEYS.has(key)) warn(`"${key}" is not a profile key and is ignored.`, key)
    }
    if (raw['effort'] != null && !EFFORT_LEVELS.includes(raw['effort'] as never)) {
      warn(`effort "${String(raw['effort'])}" is not accepted and is dropped; one of ${EFFORT_LEVELS.join(', ')}.`, 'effort')
    }
    if (raw['permission_mode'] != null && !PERMISSION_MODES.includes(raw['permission_mode'] as never)) {
      warn(
        `permission_mode "${String(raw['permission_mode'])}" is not accepted and is dropped; one of ${PERMISSION_MODES.join(', ')}.`,
        'permission_mode'
      )
    }
    if (raw['model'] != null && (typeof raw['model'] !== 'string' || raw['model'].trim() === '')) {
      warn('model must be a non-empty string and is dropped.', 'model')
    }
    for (const key of ['overlays', 'access', 'mcp'] as const) {
      const value = raw[key]
      if (value != null && !Array.isArray(value)) warn(`${key} must be a list and is dropped.`, key)
    }
  }

  const draft = entry.draft
  if (draft !== null) {
    if (!existsSync(draft.root)) fail(`root ${draft.root} does not exist.`, 'root')
    else if (!isHarnessDir(draft.root)) fail(`root ${draft.root} has no harness.yaml.`, 'root')
    for (const key of ['overlays', 'access'] as const) {
      for (const path of draft[key]) {
        const rel = relative(draft.root, path)
        if (rel.startsWith('..') || isAbsolute(rel)) warn(`${key} path ${path} is outside the root.`, key)
        if (!existsSync(path)) fail(`${key} path ${path} does not exist.`, key)
        else if (!statSync(path).isDirectory()) fail(`${key} path ${path} is not a directory.`, key)
      }
    }
  }

  return { file: resolve(file), ok: !problems.some((p) => p.level === 'error'), problems }
}

export function formatProblems(report: ProfileCheckReport): string {
  if (report.problems.length === 0) return `${report.file}: ok`
  return report.problems
    .map((p) => `${report.file}${p.line === undefined ? '' : `:${String(p.line)}`} ${p.level} ${p.message}`)
    .join('\n')
}

export async function profileCheck(ctx: CommandContext): Promise<number> {
  const target = ctx.args.positionals[0]
  if (target === undefined) throw new CliError('helm profile check needs a file or a profile name.', 2)
  let file: string
  if (existsSync(target) && statSync(target).isFile()) file = resolve(target)
  else {
    const found = resolveProfile(await knownProfiles(), basename(target, '.yaml'))
    if (found.kind !== 'found') throw new CliError(`${target} is neither a file nor a known profile name.`)
    file = found.entry.file
  }
  const report = checkProfileText(readFileSync(file, 'utf8'), file, harnessOfProfileFile(file))
  if (ctx.json) printJson(report)
  else print(formatProblems(report))
  return report.ok ? 0 : 1
}

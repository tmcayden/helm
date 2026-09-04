import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { profileToYaml } from '@helm/core'
import { EFFORT_LEVELS, PERMISSION_MODES, type EffortLevel, type PermissionMode, type ProfileDraft } from '@helm/core/types'
import { flagString } from '../args.ts'
import type { CommandContext } from '../command.ts'
import { knownHarnesses } from '../context.ts'
import { isHarnessDir } from '../harnesses.ts'
import { CliError, print, printJson } from '../output.ts'
import { PROFILES_DIR } from '../profiles.ts'
import { ask, pickMany, pickOne } from '../prompt.ts'
import { checkProfileText, formatProblems } from './profile-check.ts'

export interface RepoRow {
  name: string
  dir: string
  /** Has a `.claude` or a CLAUDE.md, so it is worth overlaying. */
  configured: boolean
}

export function listRepos(harness: string): RepoRow[] {
  const repos = join(harness, 'repos')
  try {
    return readdirSync(repos, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .map((name) => {
        const dir = join(repos, name)
        return { name, dir, configured: existsSync(join(dir, '.claude')) || existsSync(join(dir, 'CLAUDE.md')) }
      })
  } catch {
    return []
  }
}

const MODELS = ['opus', 'sonnet', 'haiku'] as const

function oneOf<T extends string>(flag: string | null, accepted: readonly T[], name: string): T | null {
  if (flag === null) return null
  if (!accepted.includes(flag as T)) throw new CliError(`--${name} must be one of ${accepted.join(', ')}.`, 2)
  return flag as T
}

/**
 * Flags when given, prompts for the rest. `--yes` or `--json` makes a missing
 * answer a refusal rather than a prompt, which is what a script needs.
 */
export async function profileNew(ctx: CommandContext): Promise<number> {
  const flags = ctx.args.flags
  const interactive = flags['yes'] !== true && !ctx.json
  const harnesses = await knownHarnesses()
  let harness = flagString(flags, 'harness')
  if (harness === null) {
    if (harnesses.length === 1) harness = harnesses[0] as string
    else if (interactive) harness = pickOne(harnesses.map((h) => ({ label: h, value: h })), 'harness')
    if (harness === null) throw new CliError('helm profile new needs --harness <dir>.', 2)
  }
  harness = resolve(harness)
  if (!isHarnessDir(harness)) throw new CliError(`${harness} has no harness.yaml, so it is not a harness.`)

  const name = flagString(flags, 'name') ?? (interactive ? ask('Profile name') : null)
  if (name === null || !/^[\w.-]+$/.test(name)) throw new CliError('A profile name is letters, digits, dot, dash or underscore.', 2)

  const repos = listRepos(harness)
  let overlays: string[]
  const overlayFlag = flagString(flags, 'overlays')
  if (overlayFlag !== null) {
    overlays = overlayFlag
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map((s) => (repos.some((r) => r.name === s) ? join(harness as string, 'repos', s) : resolve(harness as string, s)))
  } else if (interactive) {
    overlays = pickMany(
      repos.map((r) => ({ label: `${r.configured ? '*' : ' '} ${r.name}`, value: r.dir })),
      'overlays'
    )
  } else overlays = []

  const model = interactive
    ? flagString(flags, 'model') ?? pickOne(MODELS.map((m) => ({ label: m, value: m as string })), 'model')
    : flagString(flags, 'model')
  const effort = interactive
    ? oneOf(flagString(flags, 'effort'), EFFORT_LEVELS, 'effort') ??
      pickOne(EFFORT_LEVELS.map((e) => ({ label: e, value: e as EffortLevel })), 'effort')
    : oneOf(flagString(flags, 'effort'), EFFORT_LEVELS, 'effort')
  const permissionMode = interactive
    ? oneOf(flagString(flags, 'permission-mode'), PERMISSION_MODES, 'permission-mode') ??
      pickOne(PERMISSION_MODES.map((m) => ({ label: m, value: m as PermissionMode })), 'permission mode')
    : oneOf(flagString(flags, 'permission-mode'), PERMISSION_MODES, 'permission-mode')
  const openingPrompt = flagString(flags, 'opening-prompt') ?? (interactive ? ask('Opening prompt (optional)') : null)

  const draft: ProfileDraft = {
    name,
    root: harness,
    overlays,
    access: overlays,
    model,
    effort,
    permissionMode,
    agent: null,
    mcp: [],
    openingPrompt,
    pinnedOrder: null,
    target: null
  }

  const dir = join(harness, PROFILES_DIR)
  const file = join(dir, `${name}.yaml`)
  if (existsSync(file) && flags['force'] !== true) throw new CliError(`${file} exists; pass --force to overwrite it.`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, profileToYaml(draft))

  const report = checkProfileText(readFileSync(file, 'utf8'), file, harness)
  if (ctx.json) printJson(report)
  else print(`Wrote ${file}\n${formatProblems(report)}`)
  return report.ok ? 0 : 1
}


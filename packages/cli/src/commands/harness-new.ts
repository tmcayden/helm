import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createHarness, listTemplates, seedTemplates, type CreateHarnessResult, type TemplateChoice } from '@helm/core'
import { flagString } from '../args.ts'
import type { CommandContext } from '../command.ts'
import { usageOf } from '../commands.ts'
import { readHarnessIndex, writeHarnessIndex } from '../harnesses.ts'
import { CliError, print, printJson, warn } from '../output.ts'
import { harnessIndexFile, templatesDir } from '../paths.ts'
import { pick } from '../picker.ts'
import { ask } from '../prompt.ts'
import { colours, columns } from '../theme.ts'

function register(root: string): void {
  const file = harnessIndexFile()
  writeHarnessIndex(file, [...readHarnessIndex(file), root])
}

/** What the human report says: the lines for stdout and the problems for stderr. */
export function formatHarnessResult(result: CreateHarnessResult): { lines: string[]; problems: string[] } {
  const lines: string[] = []
  if (result.path !== null) {
    lines.push(result.path, ...result.created.map((c) => `  created ${c}`), `Registered ${result.path}.`)
  }
  return { lines, problems: result.problems.map((p) => `problem: ${p}`) }
}

function report(ctx: CommandContext, result: CreateHarnessResult, seeded: boolean): number {
  if (result.path !== null) register(result.path)
  if (ctx.json) printJson({ path: result.path, created: result.created, problems: result.problems, templatesSeeded: seeded })
  else {
    const { lines, problems } = formatHarnessResult(result)
    if (lines.length > 0) print(lines.join('\n'))
    for (const p of problems) warn(p)
  }
  return result.path === null ? 1 : 0
}

export function expandHome(path: string, home: string = homedir()): string {
  return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
}

/**
 * `<dir>` is the harness itself: its parent is where core creates and its
 * name is the folder, unless `--name` says the folder is created inside it.
 * A relative `<dir>` is against `cwd`, and `~` is the home directory because a
 * person types it and the shell has not expanded a value an interactive
 * prompt read.
 */
export function harnessNewTarget(dir: string | undefined, nameFlag: string | null, cwd: string = process.cwd()): { dir: string; name: string } {
  if (dir === undefined || dir.trim() === '') throw new CliError(usageOf('harness new'), 2)
  const abs = resolve(cwd, expandHome(dir.trim()))
  return nameFlag === null ? { dir: dirname(abs), name: basename(abs) } : { dir: abs, name: nameFlag }
}

/**
 * Templates are seeded first so `--template example` works on a fresh machine;
 * seeding only ever fills an absent directory.
 */
export async function harnessNew(ctx: CommandContext): Promise<number> {
  const target = harnessNewTarget(ctx.args.positionals[0], flagString(ctx.args.flags, 'name'))
  const seed = seedTemplates(templatesDir())
  if (seed.problem !== null) warn(seed.problem)
  const result = await createHarness({
    mode: 'new',
    ...target,
    template: flagString(ctx.args.flags, 'template') ?? undefined,
    templatesDir: templatesDir()
  })
  return report(ctx, result, seed.seeded)
}

/** The picker's rows: label, then the description dimmed, the way the menu paints its own. */
export function templateRows(templates: readonly TemplateChoice[], paint = colours(true)): { label: string; value: string }[] {
  return columns(templates.map((t) => [t.label, paint.dim(t.description ?? '')])).map((label, i) => ({
    label,
    value: (templates[i] as TemplateChoice).id
  }))
}

/**
 * The questions the menu asks before it can run `helm harness new`: where,
 * what to call it, and from which template. Null is a cancel at any of them.
 * The parent defaults to `cwd`, which in a popup is the pane's directory.
 */
export async function askHarnessNew(cwd: string = process.cwd()): Promise<string[] | null> {
  const parent = ask('Create the harness under', cwd)
  if (parent === null) return null
  const name = ask('Harness name')
  if (name === null) return null
  const seed = seedTemplates(templatesDir())
  if (seed.problem !== null) warn(seed.problem)
  const listing = await listTemplates(templatesDir())
  for (const p of listing.problems) warn(p)
  const template = pick(templateRows(listing.templates), { name: 'template', hint: 'Enter · Esc' })
  if (template === null) return null
  return ['harness', 'new', join(expandHome(parent), name), '--template', template]
}

/**
 * Core writes `repos: .` when the directory has no `repos/` subdirectory, so
 * repositories already at its top level stay visible; with a `repos/` it
 * leaves the default. Either way the repositories are not moved.
 */
export async function harnessConvert(ctx: CommandContext): Promise<number> {
  const dir = ctx.args.positionals[0]
  if (dir === undefined) throw new CliError(usageOf('harness convert'), 2)
  const result = await createHarness({ mode: 'convert', dir: resolve(expandHome(dir)), name: flagString(ctx.args.flags, 'name') ?? undefined })
  if (result.existing !== null) {
    register(result.existing)
    if (ctx.json) printJson({ path: result.existing, created: [], problems: result.problems })
    else print(`${result.existing} is already a harness; registered it.`)
    return 0
  }
  return report(ctx, result, false)
}

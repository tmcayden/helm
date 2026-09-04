import { basename, dirname, resolve } from 'node:path'
import { createHarness, seedTemplates, type CreateHarnessResult } from '@helm/core'
import { flagString } from '../args.ts'
import type { CommandContext } from '../command.ts'
import { readHarnessIndex, writeHarnessIndex } from '../harnesses.ts'
import { CliError, print, printJson, warn } from '../output.ts'
import { harnessIndexFile, templatesDir } from '../paths.ts'

function register(root: string): void {
  const file = harnessIndexFile()
  writeHarnessIndex(file, [...readHarnessIndex(file), root])
}

function report(ctx: CommandContext, result: CreateHarnessResult, seeded: boolean): number {
  if (result.path !== null) register(result.path)
  if (ctx.json) printJson({ path: result.path, created: result.created, problems: result.problems, templatesSeeded: seeded })
  else {
    if (result.path !== null) print(`${result.path}\n${result.created.map((c) => `  created ${c}`).join('\n')}`)
    for (const p of result.problems) warn(`problem: ${p}`)
    if (result.path !== null) print(`Registered ${result.path}.`)
  }
  return result.path === null ? 1 : 0
}

/**
 * `<dir>` is the harness itself: its parent is where core creates and its
 * name is the folder, unless `--name` says the folder is created inside it.
 * Templates are seeded first so `--template example` works on a fresh machine;
 * seeding only ever fills an absent directory.
 */
export async function harnessNew(ctx: CommandContext): Promise<number> {
  const dir = ctx.args.positionals[0]
  if (dir === undefined) throw new CliError('helm harness new needs a directory.', 2)
  const abs = resolve(dir)
  const name = flagString(ctx.args.flags, 'name')
  const seed = seedTemplates(templatesDir())
  if (seed.problem !== null) warn(seed.problem)
  const result = await createHarness({
    mode: 'new',
    dir: name === null ? dirname(abs) : abs,
    name: name ?? basename(abs),
    template: flagString(ctx.args.flags, 'template') ?? undefined,
    templatesDir: templatesDir()
  })
  return report(ctx, result, seed.seeded)
}

/**
 * Core writes `repos: .` when the directory has no `repos/` subdirectory, so
 * repositories already at its top level stay visible; with a `repos/` it
 * leaves the default. Either way the repositories are not moved.
 */
export async function harnessConvert(ctx: CommandContext): Promise<number> {
  const dir = ctx.args.positionals[0]
  if (dir === undefined) throw new CliError('helm harness convert needs a directory.', 2)
  const result = await createHarness({ mode: 'convert', dir: resolve(dir), name: flagString(ctx.args.flags, 'name') ?? undefined })
  if (result.existing !== null) {
    register(result.existing)
    if (ctx.json) printJson({ path: result.existing, created: [], problems: result.problems })
    else print(`${result.existing} is already a harness; registered it.`)
    return 0
  }
  return report(ctx, result, false)
}

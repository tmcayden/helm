import { resolve } from 'node:path'
import type { CommandContext } from '../command.ts'
import { knownHarnesses } from '../context.ts'
import { isHarnessDir, readHarnessIndex, writeHarnessIndex } from '../harnesses.ts'
import { CliError, print, printJson } from '../output.ts'
import { harnessIndexFile } from '../paths.ts'

export async function harnessAdd(ctx: CommandContext): Promise<number> {
  const dir = ctx.args.positionals[0]
  if (dir === undefined) throw new CliError('helm harness add needs a directory.', 2)
  const abs = resolve(dir)
  if (!isHarnessDir(abs)) throw new CliError(`${abs} has no harness.yaml, so it is not a harness.`)
  const file = harnessIndexFile()
  writeHarnessIndex(file, [...readHarnessIndex(file), abs])
  print(`Registered ${abs}.`)
  return 0
}

export async function harnessList(ctx: CommandContext): Promise<number> {
  const roots = await knownHarnesses()
  if (ctx.json) printJson(roots.map((root) => ({ root, exists: isHarnessDir(root) })))
  else print(roots.length === 0 ? 'No harnesses known. helm harness add <dir> registers one.' : roots.join('\n'))
  return 0
}

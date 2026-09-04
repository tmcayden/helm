import { accessSync, constants, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { seedTemplates } from '@helm/core'
import { flagString } from '../args.ts'
import { bundleFile, nvimPluginDir, nvimSpec } from '../bundle.ts'
import type { CommandContext } from '../command.ts'
import { appendLine, writeSnippet } from '../dotfiles.ts'
import type { InstallReport } from '../json.ts'
import { CliError, print, printJson } from '../output.ts'
import { dataDir, templatesDir, tmuxSnippet, zshSnippet } from '../paths.ts'
import { TMUX_SNIPPET, TMUX_SOURCE_LINE, ZSH_SNIPPET, ZSH_SOURCE_LINE } from '../snippets.ts'
import { withStore } from '../store.ts'
import { ask } from '../prompt.ts'

export const defaultSymlink = (): string => join(homedir(), '.local', 'bin', 'helm')

const isExecutable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Creates or repoints the symlink; refuses to replace a real file or point at one nobody can run. */
export function placeSymlink(link: string, target: string): 'created' | 'updated' | 'unchanged' {
  if (!isExecutable(target)) throw new CliError(`${target} is not executable; rebuild the cli (pnpm --filter @helm/cli build) before helm install.`)
  const state = ((): 'absent' | 'link' | 'file' => {
    try {
      return lstatSync(link).isSymbolicLink() ? 'link' : 'file'
    } catch {
      return 'absent'
    }
  })()
  if (state === 'file') throw new CliError(`${link} exists and is not a symlink; helm install will not replace it.`)
  if (state === 'link') {
    if (readlinkSync(link) === target) return 'unchanged'
    unlinkSync(link)
  }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link)
  return state === 'link' ? 'updated' : 'created'
}

/**
 * Helm's own files are written; the user's are appended to once, with a backup,
 * and only with consent - `--yes`, or a yes on the tty (TERMINAL.md 10).
 */
export async function install(ctx: CommandContext): Promise<number> {
  const flags = ctx.args.flags
  const report: InstallReport = {
    written: [],
    skipped: [],
    backups: [],
    templates: { seeded: false, dir: templatesDir() },
    symlink: null,
    nvimSpec: nvimSpec(nvimPluginDir()),
    problems: []
  }

  for (const [file, content] of [
    [tmuxSnippet(), TMUX_SNIPPET],
    [zshSnippet(), ZSH_SNIPPET]
  ] as const) {
    const outcome = writeSnippet(file, content)
    if (outcome === 'refused') report.problems.push(`${file} exists and was not written by helm install; move it aside first.`)
    else if (outcome === 'written') report.written.push(file)
    else report.skipped.push(file)
  }

  const seed = seedTemplates(templatesDir())
  report.templates.seeded = seed.seeded
  if (seed.problem !== null) report.problems.push(seed.problem)

  mkdirSync(dataDir(), { recursive: true })
  withStore(() => undefined)

  if (flags['no-dotfiles'] !== true) {
    const lines: [string, string][] = [
      [join(homedir(), '.tmux.conf'), TMUX_SOURCE_LINE(tmuxSnippet())],
      [join(homedir(), '.zshrc'), ZSH_SOURCE_LINE(zshSnippet())]
    ]
    for (const [file, line] of lines) {
      const consent =
        flags['yes'] === true ||
        (process.stdin.isTTY === true && !ctx.json && (ask(`Append "${line}" to ${file}? [y/N]`) ?? 'n').toLowerCase() === 'y')
      if (!consent) {
        report.skipped.push(file)
        if (flags['yes'] !== true && process.stdin.isTTY !== true) {
          report.problems.push(`${file} not changed: pass --yes to append without a tty, or --no-dotfiles to keep the lines in your own dotfiles.`)
        }
        continue
      }
      const outcome = appendLine(file, line)
      if (!outcome.changed) report.skipped.push(file)
      else {
        report.written.push(file)
        if (outcome.backup !== null) report.backups.push(outcome.backup)
      }
    }
  }

  if (flags['no-symlink'] !== true) {
    const link = flagString(flags, 'symlink') ?? defaultSymlink()
    try {
      const outcome = placeSymlink(link, bundleFile())
      report.symlink = link
      if (outcome === 'unchanged') report.skipped.push(link)
      else report.written.push(link)
    } catch (err) {
      report.problems.push(err instanceof Error ? err.message : String(err))
    }
  }

  if (ctx.json) printJson(report)
  else {
    for (const f of report.written) print(`wrote    ${f}`)
    for (const f of report.skipped) print(`kept     ${f}`)
    for (const f of report.backups) print(`backup   ${f}`)
    print(`templates ${report.templates.seeded ? 'seeded' : 'present'} at ${report.templates.dir}`)
    print(`\nlazy.nvim spec (add it yourself):\n  ${report.nvimSpec}`)
    for (const p of report.problems) print(`problem: ${p}`)
  }
  return report.problems.length === 0 ? 0 : 1
}

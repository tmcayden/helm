import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeHome } from '@helm/core'
import { bundleFile } from '../bundle.ts'
import type { CommandContext } from '../command.ts'
import { isHelmSnippet, sourcesFile } from '../dotfiles.ts'
import { isHarnessDir } from '../harnesses.ts'
import type { DoctorReport, DoctorRow } from '../json.ts'
import { print, printJson } from '../output.ts'
import { knownHarnesses } from '../context.ts'
import { dataDir, templatesDir, tmuxSnippet, zshSnippet } from '../paths.ts'
import { TMUX_SNIPPET, TMUX_SOURCE_LINE, ZSH_SNIPPET, ZSH_SOURCE_LINE } from '../snippets.ts'
import { withStore } from '../store.ts'
import { defaultSymlink } from './install.ts'

const row = (name: string, ok: boolean | null, detail: string): DoctorRow => ({ name, ok, detail })

export function nodeRow(version: string, floor = 22): DoctorRow {
  const major = Number.parseInt(version.replace(/^v/, ''), 10)
  return row('node', major >= floor, `${version}; needs >= ${String(floor)}`)
}

/** `<tool> --version` on PATH: false when absent, null when it ran but said nothing readable. */
export function toolRow(name: string, args: string[] = ['--version']): DoctorRow {
  const result = spawnSync(name, args, { encoding: 'utf8' })
  if (result.error) return row(name, false, `${name} is not on PATH`)
  const text = `${result.stdout}${result.stderr}`.trim().split('\n')[0] ?? ''
  return row(name, result.status === 0 ? true : null, text === '' ? `exit ${String(result.status)}` : text)
}

/**
 * Sign-in by existence only (CLAUDE.md, Credentials). Nothing here opens
 * `.credentials.json`; `~/.claude.json` is read for two booleans the way the
 * desktop's `readAuth` reads it. On Linux the credential may legitimately live
 * elsewhere, so "none of the three" is null, never false.
 */
export function signInRow(home: string = claudeHome(), env: NodeJS.ProcessEnv = process.env): DoctorRow {
  if ((env['ANTHROPIC_API_KEY'] ?? '').trim() !== '') return row('claude sign-in', true, 'ANTHROPIC_API_KEY is set')
  try {
    if (statSync(join(home, '.credentials.json')).size > 0) return row('claude sign-in', true, '.credentials.json is present')
  } catch {
    // Absent: one signal of three.
  }
  try {
    const parsed = JSON.parse(readFileSync(join(home, '..', '.claude.json'), 'utf8')) as Record<string, unknown>
    if (parsed['hasCompletedOnboarding'] === true && typeof parsed['userID'] === 'string') {
      return row('claude sign-in', true, '.claude.json records a completed sign-in')
    }
  } catch {
    // Absent or unreadable: the same.
  }
  return row('claude sign-in', null, 'no sign-in artefact found; credentials may live outside ~/.claude. `claude` signs in.')
}

/** Byte-identical to what install writes is ok; Helm's but different is stale; someone else's is a finding. */
export function snippetRow(name: string, file: string, expected: string): DoctorRow {
  let actual: string
  try {
    actual = readFileSync(file, 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? row(name, false, `${file} is missing; helm install writes it`)
      : row(name, null, `${file} could not be read`)
  }
  if (actual === expected) return row(name, true, file)
  if (isHelmSnippet(actual)) return row(name, false, `${file} is stale; helm install rewrites it`)
  return row(name, false, `${file} was not written by helm install`)
}

export function dotfileRow(name: string, file: string, snippet: string, line: string): DoctorRow {
  try {
    return sourcesFile(readFileSync(file, 'utf8'), snippet)
      ? row(name, true, `${file} sources it`)
      : row(name, false, `${file} lacks: ${line}`)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? row(name, false, `${file} does not exist`)
      : row(name, null, `${file} could not be read`)
  }
}

export function symlinkRow(link: string, bundle: string): DoctorRow {
  try {
    const target = realpathSync(link)
    return target === bundle
      ? row('helm symlink', true, `${link} -> ${readlinkSync(link)}`)
      : row('helm symlink', false, `${link} resolves to ${target}, this bundle is ${bundle}`)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? row('helm symlink', false, `${link} is missing; helm install creates it`)
      : row('helm symlink', null, `${link} could not be resolved`)
  }
}

function dataRow(): DoctorRow {
  try {
    mkdirSync(dataDir(), { recursive: true })
    accessSync(dataDir(), constants.W_OK)
    const migrations = withStore((s) => s.migrations.applied.length + s.migrations.alreadyApplied.length)
    return row('data dir', true, `${dataDir()} writable; helm.db open, ${String(migrations)} migrations`)
  } catch (err) {
    return row('data dir', false, `${dataDir()}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function doctorRows(runClaudeDoctor: boolean): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [nodeRow(process.version), toolRow('claude'), signInRow(), toolRow('tmux', ['-V']), toolRow('nvim'), toolRow('fzf'), toolRow('ss'), dataRow()]
  rows.push(snippetRow('helm.tmux', tmuxSnippet(), TMUX_SNIPPET))
  rows.push(snippetRow('helm.zsh', zshSnippet(), ZSH_SNIPPET))
  rows.push(dotfileRow('.tmux.conf', join(homedir(), '.tmux.conf'), tmuxSnippet(), TMUX_SOURCE_LINE(tmuxSnippet())))
  rows.push(dotfileRow('.zshrc', join(homedir(), '.zshrc'), zshSnippet(), ZSH_SOURCE_LINE(zshSnippet())))
  rows.push(symlinkRow(defaultSymlink(), bundleFile()))
  rows.push(
    existsSync(join(templatesDir(), 'README.md'))
      ? row('templates', true, `${templatesDir()} seeded`)
      : row('templates', false, `${templatesDir()} not seeded; helm install seeds it`)
  )
  for (const harness of await knownHarnesses()) {
    rows.push(isHarnessDir(harness) ? row('harness', true, harness) : row('harness', false, `${harness} has no harness.yaml`))
  }
  if (runClaudeDoctor) {
    const result = spawnSync('claude', ['doctor'], { stdio: 'inherit' })
    rows.push(row('claude doctor', result.error ? null : result.status === 0, result.error ? 'could not run' : `exit ${String(result.status)}`))
  } else rows.push(row('claude doctor', null, 'not run; it is interactive - pass --claude'))
  return rows
}

export function reportOf(rows: DoctorRow[]): DoctorReport {
  return { ok: !rows.some((r) => r.ok === false), rows }
}

export async function doctor(ctx: CommandContext): Promise<number> {
  const report = reportOf(await doctorRows(ctx.args.flags['claude'] === true))
  if (ctx.json) printJson(report)
  else {
    const mark = (ok: boolean | null) => (ok === true ? 'ok  ' : ok === false ? 'FAIL' : '?   ')
    print(report.rows.map((r) => `${mark(r.ok)} ${r.name.padEnd(14)} ${r.detail}`).join('\n'))
  }
  return report.ok ? 0 : 1
}

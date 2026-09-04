import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { flagString } from '../args.ts'
import type { CommandContext } from '../command.ts'
import { knownProfiles } from '../context.ts'
import type { ProfileCheckReport } from '../json.ts'
import { CliError, print, printJson, table } from '../output.ts'
import { resolveProfile, type ProfileEntry } from '../profiles.ts'
import { withStore } from '../store.ts'
import { colourEnabled, colours, type Painters } from '../theme.ts'
import { checkProfileText } from './profile-check.ts'

/** Sessions per `-n` name. The CLI launches a profile under its own name, so the name is the join. */
export function sessionCountsByName(): Map<string, number> {
  return withStore((store) => {
    const rows = store.raw.prepare('SELECT name, COUNT(*) AS n FROM sessions GROUP BY name').all() as {
      name: string
      n: number
    }[]
    return new Map(rows.map((r) => [r.name, r.n]))
  })
}

export function shapeProfile(entry: ProfileEntry, uses: number) {
  return {
    name: entry.name,
    harness: entry.harness,
    file: entry.file,
    root: entry.draft?.root ?? null,
    overlays: entry.draft?.overlays ?? [],
    access: entry.draft?.access ?? [],
    model: entry.draft?.model ?? null,
    effort: entry.draft?.effort ?? null,
    permissionMode: entry.draft?.permissionMode ?? null,
    openingPrompt: entry.draft?.openingPrompt ?? null,
    problems: entry.problems,
    uses
  }
}

export async function profileList(ctx: CommandContext): Promise<number> {
  const entries = await knownProfiles()
  const counts = sessionCountsByName()
  const shaped = entries.map((entry) => shapeProfile(entry, counts.get(entry.name) ?? 0))
  if (ctx.json) {
    printJson(shaped)
    return 0
  }
  if (shaped.length === 0) {
    print('No profiles. A profile is <harness>/.helm/profiles/<name>.yaml; register a harness with helm harness add <dir>.')
    return 0
  }
  print(
    table([
      ['NAME', 'HARNESS', 'MODEL/EFFORT', 'USES', 'PROBLEMS'],
      ...shaped.map((p) => [
        p.name,
        p.harness,
        `${p.model ?? '-'}/${p.effort ?? '-'}`,
        String(p.uses),
        p.problems.length === 0 ? '' : p.problems.join(' ')
      ])
    ])
  )
  return 0
}

/**
 * The card the profile picker previews: everything a launch would use, then
 * what `profile check` says about the file. `--color` paints for a pipe that
 * renders escapes, which is what fzf's preview window is.
 */
export function renderProfileCard(entry: ProfileEntry, report: ProfileCheckReport, paint: Painters): string {
  const draft = entry.draft
  const field = (label: string, value: string) => `${paint.muted(label.padEnd(9))}${value}`
  const list = (paths: readonly string[]) =>
    paths.length === 0 ? paint.dim('none') : paths.map((p) => relative(draft?.root ?? entry.harness, p) || '.').join(', ')
  const lines = [paint.accent(entry.name), field('yaml', paint.dim(entry.file))]
  if (draft !== null) {
    lines.push(
      field('root', draft.root),
      field('overlays', list(draft.overlays)),
      field('access', list(draft.access)),
      field('run', [draft.model ?? paint.dim('model?'), draft.effort ?? paint.dim('effort?'), draft.permissionMode ?? paint.dim('default')].join(paint.dim(' · '))),
      field('prompt', draft.openingPrompt ?? paint.dim('none'))
    )
  }
  lines.push('')
  if (report.problems.length === 0) lines.push(paint.ok('check ok'))
  for (const p of report.problems) {
    const where = p.line === undefined ? '' : paint.dim(`:${String(p.line)} `)
    lines.push(`${(p.level === 'error' ? paint.bad : paint.warn)(p.level)} ${where}${p.message}`)
  }
  return lines.join('\n')
}

export async function profileShow(ctx: CommandContext): Promise<number> {
  const name = ctx.args.positionals[0]
  if (name === undefined) throw new CliError('helm profile show needs a profile name.', 2)
  const found = resolveProfile(await knownProfiles(), name, flagString(ctx.args.flags, 'harness'))
  if (found.kind === 'missing') throw new CliError(`No profile named "${name}" in any known harness.`)
  if (found.kind === 'ambiguous') throw new CliError(`"${name}" is a profile in more than one harness - pass --harness <dir>.`)
  const entry = found.entry
  const report = checkProfileText(readFileSync(entry.file, 'utf8'), entry.file, entry.harness)
  if (ctx.json) printJson({ ...shapeProfile(entry, 0), check: report })
  else print(renderProfileCard(entry, report, colours(ctx.args.flags['color'] === true || colourEnabled())))
  return 0
}

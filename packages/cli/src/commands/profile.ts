import type { CommandContext } from '../command.ts'
import { knownProfiles } from '../context.ts'
import { print, printJson, table } from '../output.ts'
import type { ProfileEntry } from '../profiles.ts'
import { withStore } from '../store.ts'

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

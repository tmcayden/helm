import { cleanStaleShims, newClaudeSessionId, prepareLaunch, type LaunchPlan } from '@helm/core'
import { flagString } from '../args.ts'
import type { CommandContext } from '../command.ts'
import { knownProfiles } from '../context.ts'
import { CliError, printJson, print, warn } from '../output.ts'
import { shimRoot } from '../paths.ts'
import { resolveProfile, type ProfileEntry } from '../profiles.ts'
import { runClaude } from '../run-claude.ts'

export async function requireProfile(name: string | undefined, harness: string | null): Promise<ProfileEntry> {
  if (name === undefined) throw new CliError('helm launch needs a profile name.', 2)
  const found = resolveProfile(await knownProfiles(), name, harness)
  if (found.kind === 'missing') {
    throw new CliError(`No profile named "${name}" in any known harness - see helm profile list.`)
  }
  if (found.kind === 'ambiguous') {
    const where = found.candidates.map((c) => c.harness).join(', ')
    throw new CliError(`"${name}" is a profile in more than one harness (${where}) - pass --harness <dir>.`)
  }
  if (found.entry.draft === null || found.entry.problems.length > 0) {
    throw new CliError(`${found.entry.file}: ${found.entry.problems.join(' ')}`)
  }
  return found.entry
}

export function planFor(entry: ProfileEntry, sessionName: string | null): LaunchPlan {
  const draft = entry.draft
  if (draft === null) throw new CliError(`${entry.file} is not a readable profile.`)
  /*
   * The sweep runs here because this process *is* the app start: every Helm
   * action is a fresh process, and "swept at app start" for one that lives one
   * launch is swept once per launch. `cleanStaleShims` removes only what it
   * can prove is dead, so a shim another running `helm launch` is serving stays.
   */
  cleanStaleShims(shimRoot())
  return prepareLaunch({
    root: draft.root,
    name: sessionName ?? draft.name,
    overlays: draft.overlays,
    access: draft.access,
    model: draft.model,
    effort: draft.effort,
    permissionMode: draft.permissionMode,
    agent: draft.agent,
    openingPrompt: draft.openingPrompt,
    shimRoot: shimRoot(),
    mcp: null,
    sessionId: newClaudeSessionId(),
    target: null
  })
}

export async function launch(ctx: CommandContext): Promise<number> {
  const { args, json } = ctx
  const entry = await requireProfile(args.positionals[0], flagString(args.flags, 'harness'))
  const plan = planFor(entry, flagString(args.flags, 'name'))
  const argv = [...plan.argv, ...args.passthrough]

  if (args.flags['dry-run'] === true) {
    if (json) {
      printJson({
        cwd: plan.cwd,
        argv,
        overlays: plan.overlays.map((o) => o.dir),
        warnings: plan.warnings,
        sessionId: plan.claudeSessionId
      })
    } else {
      print(`cd ${plan.cwd}\nclaude ${argv.join(' ')}`)
      for (const w of plan.warnings) warn(`warning: ${w}`)
    }
    return 0
  }

  for (const w of plan.warnings) warn(`warning: ${w}`)
  return runClaude({ name: plan.name, cwd: plan.cwd, argv, claudeSessionId: plan.claudeSessionId })
}

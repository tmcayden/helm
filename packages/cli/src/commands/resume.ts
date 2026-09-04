import { prepareResume, readSessions, type SessionRecord } from '@helm/core'
import type { CommandContext } from '../command.ts'
import { CliError, print, printJson, warn } from '../output.ts'
import { runClaude } from '../run-claude.ts'
import { withStore } from '../store.ts'

/** A row id or a conversation id; the newest row wins when several share one. */
export function findResumable(rows: readonly SessionRecord[], key: string): SessionRecord | null {
  const asId = /^\d+$/.test(key) ? Number.parseInt(key, 10) : null
  return (
    rows.find((row) => (asId !== null ? row.id === asId : row.claudeSessionId?.toLowerCase() === key.toLowerCase())) ??
    null
  )
}

export async function resume(ctx: CommandContext): Promise<number> {
  const key = ctx.args.positionals[0]
  if (key === undefined) throw new CliError('helm resume needs a session id.', 2)
  const row = withStore((store) => findResumable(readSessions(store, { limit: 10_000 }), key))
  if (row === null) throw new CliError(`No recorded session matches "${key}" - see helm history.`)
  if (row.claudeSessionId === null) {
    throw new CliError(`Session ${String(row.id)} was started without a conversation id, so it cannot be resumed.`)
  }
  const { argv, warnings } = prepareResume({ sessionId: row.claudeSessionId, target: null })
  const full = [...argv, ...ctx.args.passthrough]
  if (ctx.args.flags['dry-run'] === true) {
    if (ctx.json) printJson({ cwd: row.cwd, argv: full, warnings, sessionId: row.claudeSessionId })
    else print(`cd ${row.cwd}\nclaude ${full.join(' ')}`)
    return 0
  }
  for (const w of warnings) warn(`warning: ${w}`)
  return runClaude({ name: row.name, cwd: row.cwd, argv: full, claudeSessionId: row.claudeSessionId })
}

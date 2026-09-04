import { claudeHome, projectsDirIn, readSessions, scanTranscripts, sessionLabel, type SessionRecord } from '@helm/core'
import { flagInt } from '../args.ts'
import type { CommandContext } from '../command.ts'
import { print, printJson, table } from '../output.ts'
import { withStore } from '../store.ts'

export interface HistoryRow {
  id: number
  name: string
  cwd: string
  branch: string | null
  status: SessionRecord['status']
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  exitCode: number | null
  claudeSessionId: string | null
  /** A transcript still exists under `~/.claude/projects`, so `helm resume` can. */
  resumable: boolean
}

/** Transcript ids are keyed lower-case by `scanTranscripts`; a row's id is matched the same way. */
export function shapeHistory(rows: readonly SessionRecord[], transcripts: ReadonlySet<string>): HistoryRow[] {
  return rows.map((row) => ({
    id: row.id,
    name: sessionLabel(row),
    cwd: row.cwd,
    branch: row.branch,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationMs: row.durationMs,
    exitCode: row.exitCode,
    claudeSessionId: row.claudeSessionId,
    resumable: row.claudeSessionId !== null && transcripts.has(row.claudeSessionId.toLowerCase())
  }))
}

export async function history(ctx: CommandContext): Promise<number> {
  const limit = flagInt(ctx.args.flags, 'limit', 30)
  const rows = withStore((store) => readSessions(store, { limit }))
  const transcripts = new Set(scanTranscripts(projectsDirIn(claudeHome())).keys())
  const shaped = shapeHistory(rows, transcripts)
  if (ctx.json) {
    printJson(shaped)
    return 0
  }
  if (shaped.length === 0) {
    print('No sessions recorded yet.')
    return 0
  }
  print(
    table([
      ['ID', 'STARTED', 'STATUS', 'EXIT', 'RESUME', 'NAME', 'CWD'],
      ...shaped.map((r) => [
        String(r.id),
        r.startedAt.slice(0, 16).replace('T', ' '),
        r.status,
        r.exitCode === null ? '-' : String(r.exitCode),
        r.resumable ? 'yes' : '-',
        r.name,
        r.cwd
      ])
    ])
  )
  return 0
}

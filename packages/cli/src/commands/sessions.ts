import {
  claudeHome,
  describeSessionListing,
  readSessionRegistry,
  readSessions,
  sessionLabel,
  sessionRegistryDir,
  type LiveSession,
  type SessionRecord,
  type SessionRegistryEntry
} from '@helm/core'
import type { CommandContext } from '../command.ts'
import { printJson, print } from '../output.ts'
import { withStore } from '../store.ts'

/**
 * Machine-wide: every `.json` record the CLI's own registry holds, joined to
 * Helm's running rows by conversation id. A record that joins to nothing is a
 * `claude` somebody started elsewhere and is listed anyway - listing is not
 * driving. A status the registry did not publish stays null, and the JSON
 * carries it as "unknown" rather than dropping the key.
 */
export function shapeLiveSessions(
  entries: readonly SessionRegistryEntry[],
  hosted: readonly SessionRecord[]
): LiveSession[] {
  const byConversation = new Map(
    hosted.filter((row) => row.claudeSessionId !== null).map((row) => [row.claudeSessionId!.toLowerCase(), row])
  )
  return entries.map((entry) => {
    const row = entry.sessionId === null ? undefined : byConversation.get(entry.sessionId.toLowerCase())
    return {
      helmSessionId: row?.id ?? null,
      pid: entry.pid,
      registered: true,
      cwd: entry.cwd ?? row?.cwd ?? null,
      name: row ? sessionLabel(row) : entry.name,
      activity: entry.activity,
      waitingFor: entry.waitingFor,
      statusSinceMs: entry.statusUpdatedAt,
      version: entry.version,
      entrypoint: entry.entrypoint,
      startedAtMs: entry.startedAt,
      claudeSessionId: entry.sessionId
    }
  })
}

export async function sessions(ctx: CommandContext): Promise<number> {
  const readAtMs = Date.now()
  const entries = readSessionRegistry(sessionRegistryDir(claudeHome()))
  const hosted = withStore((store) => readSessions(store, { status: 'running', limit: 10_000 }))
  const live = shapeLiveSessions(entries, hosted)
  if (ctx.json) {
    printJson({
      readAtMs,
      sessions: live.map((s) => ({ ...s, activity: s.activity ?? 'unknown' }))
    })
    return 0
  }
  print(describeSessionListing({ sessions: live, readAtMs, callerHelmSessionId: null }))
  return 0
}

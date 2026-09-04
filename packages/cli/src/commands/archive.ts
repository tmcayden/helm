import {
  archiveCursor,
  archiveTranscriptFile,
  archivedBytes,
  claudeHome,
  evictToCeiling,
  forgetArchiveFiles,
  indexedArchiveFiles,
  projectsDirIn,
  readArchiveStats,
  readArchiveTail,
  readSettings,
  scanTranscripts,
  type Store
} from '@helm/core'
import type { CommandContext } from '../command.ts'
import { print, printJson } from '../output.ts'
import { withStore } from '../store.ts'

export interface ArchivePassReport {
  transcripts: number
  files: number
  messages: number
  bytesRead: number
  forgotten: number
  evicted: string[]
  storedBytes: number
  maxBytes: number
  sessions: number
}

/**
 * One full pass, the desktop's `createArchiveService().pass` without its
 * budget: that budget exists to keep a window's main thread free between
 * chunks, and this process has no window and nothing waiting on it. Same
 * discipline otherwise - cursors for reaped files are dropped, a transcript
 * that cannot be read right now is skipped, and the ceiling is applied after
 * the pass rather than per file.
 */
export function archivePass(store: Store, projectsDir: string): ArchivePassReport {
  const transcripts = scanTranscripts(projectsDir)
  const known = indexedArchiveFiles(store)
  const present = new Set([...transcripts.values()].map((t) => t.file))
  const forgotten = forgetArchiveFiles(store, [...known.keys()].filter((file) => !present.has(file)))

  let files = 0
  let messages = 0
  let bytesRead = 0
  for (const transcript of [...transcripts.values()].sort((a, b) => b.modifiedMs - a.modifiedMs)) {
    const cursor = known.get(transcript.file) ?? archiveCursor(store, transcript.file)
    if (transcript.bytes === cursor) continue
    const tail = readArchiveTail(transcript.file, cursor, transcript.sessionId)
    if (tail.error !== undefined) continue
    messages += archiveTranscriptFile(store, { file: transcript.file, sessionId: transcript.sessionId, tail }).messages
    bytesRead += tail.read
    files++
  }

  const maxBytes = readSettings(store).transcriptArchiveMaxBytes
  const evicted = archivedBytes(store) > maxBytes ? evictToCeiling(store, maxBytes).sessions : []
  const stats = readArchiveStats(store, maxBytes)
  return {
    transcripts: transcripts.size,
    files,
    messages,
    bytesRead,
    forgotten,
    evicted,
    storedBytes: stats.storedBytes,
    maxBytes,
    sessions: stats.sessions
  }
}

export async function archive(ctx: CommandContext): Promise<number> {
  const report = withStore((store) => archivePass(store, projectsDirIn(claudeHome())))
  if (ctx.json) printJson(report)
  else {
    print(
      `${String(report.transcripts)} transcripts on disk, ${String(report.files)} read, ${String(report.messages)} messages added, ${String(report.bytesRead)} bytes read.\n` +
        `${String(report.forgotten)} reaped cursors dropped, ${String(report.evicted.length)} sessions evicted; ` +
        `${String(report.sessions)} sessions archived in ${String(report.storedBytes)} of ${String(report.maxBytes)} bytes.`
    )
  }
  return 0
}

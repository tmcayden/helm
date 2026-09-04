import { basename, sep } from 'node:path'
import { samePath } from '../config/live'
import { pathKey } from '../paths/key'
import { recordTranscript, scanProjectDir, scanTranscripts, type TranscriptFile } from './history'

/**
 * The transcript map for one `projects/` directory, kept level by events
 * instead of rebuilt by a walk.
 *
 * `scanTranscripts` is a `readdir` per project directory and a `stat` per
 * transcript, and the session index runs it on every pass. Over a local tree
 * that is a few milliseconds; over a distribution's tree reached through
 * `\\wsl$\` it was measured at 777-873 ms (see `core/wsl/inotify.ts`), on the
 * main thread, once a minute. The events that tree can now deliver name one
 * path each - so this holds the last full answer and moves one entry per event,
 * and the walk runs once, when the watch is established.
 *
 * The map is not merely "invalidate on any event". `TranscriptFile.bytes` is
 * what the archive reads growth off, so a transcript being appended to must
 * update its own entry, and a live session in a distro writes its transcript
 * every message. Invalidating on that would put the full walk back, once per
 * message, which is worse than the poll it replaced.
 *
 * Until `all()` has been asked once there is nothing to keep level, and events
 * are dropped: the first `all()` is a full walk that sees whatever they said.
 */
export interface LiveTranscripts {
  /** The current map. A full walk the first time, and after `invalidate`. */
  all(): Map<string, TranscriptFile>
  /** Moves the one entry an event names. `path` is spelled for this process. */
  apply(op: 'changed' | 'removed', path: string, isDir: boolean): void
  /** Forget everything: the next `all()` walks. For a watch that was re-established. */
  invalidate(): void
  /** Whether `all()` would answer from memory. */
  primed(): boolean
}

export function createLiveTranscripts(
  projectsDir: string,
  scan: (projectsDir: string) => Map<string, TranscriptFile> = scanTranscripts
): LiveTranscripts {
  let held: Map<string, TranscriptFile> | null = null

  const under = (file: string, dir: string): boolean =>
    pathKey(file).startsWith(`${pathKey(dir.replace(/[\\/]+$/, ''))}${sep}`)

  const forgetUnder = (found: Map<string, TranscriptFile>, dir: string): void => {
    for (const [id, entry] of found) if (under(entry.file, dir)) found.delete(id)
  }

  return {
    all() {
      held ??= scan(projectsDir)
      return held
    },

    apply(op, path, isDir) {
      if (held === null) return

      // `projects/` itself came or went: nothing incremental is right, walk again.
      if (isDir && samePath(path, projectsDir)) {
        held = null
        return
      }

      if (isDir) {
        // Whatever was under it is stale either way. A directory that is still
        // there - created, or renamed into place - is then read on its own.
        forgetUnder(held, path)
        if (op === 'changed') scanProjectDir(path, held)
        return
      }

      const id = basename(path).slice(0, -'.jsonl'.length).toLowerCase()
      if (op === 'removed') {
        // Keyed by id, so the entry is only dropped when it is this file: the
        // same id under a second project directory is the larger file kept
        // deliberately, and deleting the smaller one must not lose it.
        const entry = held.get(id)
        if (entry !== undefined && samePath(entry.file, path)) held.delete(id)
        return
      }

      if (!recordTranscript(path, held)) {
        // Named as changed but not there to stat: it went between the event
        // and now. Drop it if it is what we were holding.
        const entry = held.get(id)
        if (entry !== undefined && samePath(entry.file, path)) held.delete(id)
      }
    },

    invalidate() {
      held = null
    },

    primed: () => held !== null
  }
}

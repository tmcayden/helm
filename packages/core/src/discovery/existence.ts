import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'

/**
 * Whether recorded working directories are still there, answered from memory
 * and re-checked off the main thread.
 *
 * `applyProjectExistence` asks about every distinct project on every index
 * pass - it is what decides whether a conversation is offered for resume. Over
 * a local tree that is a stat per directory at 0.007 ms. Over `\\wsl$\` it is
 * 1.8 ms each, and 54 of them on this machine (see `core/wsl/inotify.ts`),
 * which is ~100 ms of synchronous main-thread time per pass, growing with
 * every worktree. The answer changes about weekly.
 *
 * So a path is stat'd synchronously the **first** time it is asked about, and
 * from memory after that. `revalidate` re-asks every path the last pass wanted,
 * through `fs.promises.stat` on libuv's pool - the same wall time, none of it
 * on the main thread - and reports whether anything moved so the caller can
 * run a pass that will see it. Paths nobody asked about since the previous
 * `revalidate` are forgotten, so the memory is bounded by the index rather than
 * by everything ever recorded.
 */
export interface ExistenceCache {
  /** Cached, or a synchronous stat on first sight. */
  exists(path: string): boolean
  /**
   * Re-checks, asynchronously, every path asked about since the last call.
   * Resolves true if any answer changed. A call while one is running joins it.
   */
  revalidate(): Promise<boolean>
}

export interface ExistenceCacheDeps {
  /** Synchronous probe for first sight. Defaults to `statSync(...).isDirectory()`. */
  probe?: ((path: string) => boolean) | undefined
  /** Asynchronous probe for revalidation. Defaults to `fs.promises.stat`. */
  probeAsync?: ((path: string) => Promise<boolean>) | undefined
  /** How many probes are in flight at once. */
  concurrency?: number | undefined
}

const isDirectorySync = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const isDirectoryAsync = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export function createExistenceCache(deps: ExistenceCacheDeps = {}): ExistenceCache {
  const probe = deps.probe ?? isDirectorySync
  const probeAsync = deps.probeAsync ?? isDirectoryAsync
  const width = Math.max(1, deps.concurrency ?? 8)

  const known = new Map<string, boolean>()
  let asked = new Set<string>()
  let inFlight: Promise<boolean> | null = null

  return {
    exists(path) {
      asked.add(path)
      const held = known.get(path)
      if (held !== undefined) return held
      const answer = probe(path)
      known.set(path, answer)
      return answer
    },

    revalidate() {
      if (inFlight !== null) return inFlight
      const wanted = asked
      asked = new Set()
      for (const key of [...known.keys()]) if (!wanted.has(key)) known.delete(key)

      const queue = [...wanted]
      inFlight = (async () => {
        let changed = false
        const worker = async (): Promise<void> => {
          for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
            const now = await probeAsync(path)
            // A path forgotten or never held while we were away is left alone:
            // the next pass's `exists` will set it.
            if (known.has(path) && known.get(path) !== now) {
              known.set(path, now)
              changed = true
            }
          }
        }
        try {
          await Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker))
        } finally {
          inFlight = null
        }
        return changed
      })()
      return inFlight
    }
  }
}

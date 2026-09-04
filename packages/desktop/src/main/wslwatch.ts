import { spawn, type ChildProcess } from 'node:child_process'
import {
  INOTIFY_READY,
  inotifyWatchArgs,
  parseInotifyLine,
  type ClaudeTreeEvent,
  type WslHome
} from '@helm/core'

/**
 * The process half of watching a distribution's `~/.claude` from inside it.
 *
 * `core/wsl/inotify.ts` has the argument for doing this at all and the two
 * measured facts about the command line. What lives here is the lifetime:
 *
 * - **One `wsl.exe` per distribution Helm reads, for as long as Helm is open.**
 *   It is a child of the main process and `history.stop()` kills it from
 *   `before-quit` - "the main process owns process lifetime". Killing `wsl.exe`
 *   reaps the Linux process behind it (measured, `main/wsl.ts`).
 * - **Established is a sentence on stderr.** `inotifywait` prints
 *   `Watches established.` once every watch is in place, and only then is
 *   `onSync` called: events before it were never going to arrive, and the
 *   caller's answer is to walk once and trust the stream from there.
 * - **A watcher that dies after establishing is respawned** with backoff, and
 *   each re-establishment is another `onSync`, because whatever happened while
 *   it was down was not seen. `wsl --shutdown` is the ordinary way this
 *   happens.
 * - **A watcher that never establishes is given up on**, after a few tries or
 *   at once when the reason is that `inotifywait` is not installed there. The
 *   caller is told and the distro is left to the poll it always had - the
 *   degraded state is the state before this existed, not a silent gap.
 *
 * One consequence is worth saying out loud rather than discovering: a distro
 * with a watcher in it does not idle down while Helm is open. Reading
 * `\\wsl$\` already woke it on every sweep, so this is not a new wake-up, but
 * it is a VM that stays up instead of one that came and went.
 */

/** Before the first respawn; doubles to the cap. */
const RESPAWN_MIN_MS = 1000
const RESPAWN_MAX_MS = 30_000

/** Starts that exited before establishing, after which the distro is left to the poll. */
const START_ATTEMPTS = 3

export interface WslTreeWatch {
  /** Whether events are currently flowing, i.e. the poll can leave this home alone. */
  live(): boolean
  stop(): void
}

export interface WslTreeWatchHandlers {
  onEvent(event: ClaudeTreeEvent): void
  /** Watches are in place. Anything before this was not seen: walk once. */
  onSync(): void
  /** Given up. `reason` is the last thing `inotifywait` or `wsl.exe` said. */
  onUnavailable(reason: string): void
}

export function watchWslClaudeTree(home: WslHome, handlers: WslTreeWatchHandlers): WslTreeWatch {
  let child: ChildProcess | null = null
  let established = false
  let stopped = false
  let failedStarts = 0
  let backoff = RESPAWN_MIN_MS
  let timer: NodeJS.Timeout | null = null

  function launch(): void {
    if (stopped) return
    established = false
    let pending = ''
    let stderr = ''
    let gone = false

    const proc = spawn('wsl.exe', inotifyWatchArgs(home), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child = proc

    // Inside the distro the output is the Linux program's own and is UTF-8 -
    // it is only `wsl.exe`'s *own* messages that are UTF-16 (`main/wsl.ts`),
    // and under `--exec` there are none on stdout.
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      pending += chunk
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        const event = parseInotifyLine(line, home)
        if (event !== null) handlers.onEvent(event)
        newline = pending.indexOf('\n')
      }
    })

    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      if (established) return
      stderr += chunk
      if (!stderr.includes(INOTIFY_READY)) return
      established = true
      failedStarts = 0
      backoff = RESPAWN_MIN_MS
      handlers.onSync()
    })

    // `error` without `exit` is what a spawn that never started looks like -
    // no `wsl.exe` on this machine - so both routes end in the same place, once.
    const ended = (code: number | null): void => {
      if (gone) return
      gone = true
      if (child === proc) child = null
      if (stopped) return

      if (!established) {
        failedStarts++
        const missing = code === 127 || /not found|No such file/i.test(stderr)
        if (missing || failedStarts >= START_ATTEMPTS) {
          stopped = true
          const said = stderr.trim().split(/\r?\n/).filter(Boolean).pop()
          handlers.onUnavailable(said ?? `exit ${String(code)}`)
          return
        }
      }

      timer = setTimeout(launch, backoff)
      timer.unref()
      backoff = Math.min(backoff * 2, RESPAWN_MAX_MS)
    }
    proc.on('error', () => ended(null))
    proc.on('exit', (code) => ended(code))
  }

  launch()

  return {
    live: () => established && child !== null,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      established = false
      const proc = child
      child = null
      proc?.kill()
    }
  }
}

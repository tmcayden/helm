import type { BrowserWindow } from 'electron'
import {
  noProcessSnapshot,
  sessionResources,
  type ProcessSnapshot,
  type SessionResources
} from '@helm/core'
import { emit } from './ipc'
import { readProcessSnapshot } from './processes'
import type { SessionHost } from './sessions'

/**
 * What each hosted session is holding: its process tree and its listening
 * ports.
 *
 * ## The budget, and why this is not on the registry's timer
 *
 * The registry poll next door is 750ms and it is cheap in the way a timer needs
 * to be cheap: one `readdir` and a handful of 450-byte reads, **0.15ms**
 * measured on this machine. A process enumeration is not in that class. One
 * pass, measured here on 2026-08-20 over two runs of five and six consecutive
 * passes: **400-480ms of wall time**, and **478-547ms** under `sessions-check`
 * with three sessions running - of which 160-240ms is the two CIM queries and
 * the rest is `powershell.exe` starting.
 *
 * Hanging that off the 750ms timer would keep a child process alive more than
 * half of the time the app is open, forever, for a fact almost nobody is
 * looking at. So this pass is budgeted three separate ways and each is a
 * different kind of limit:
 *
 *   - **It does not run unless somebody is looking.** `watch(false)` is off:
 *     no timer, no child process, no cost at all. The sessions pane turns it on
 *     while it is the pane on screen and off when it is not, so the app somebody
 *     is writing code in is the app this feature costs nothing in.
 *   - **The interval is `POLL_MS`, not the registry's.** At 4s a 400ms pass is
 *     a tenth of the wall clock rather than half of it, and that is the right
 *     scale for what is being watched: a dev server coming up or a container
 *     starting, not a keystroke. The registry's dot needs to move inside a
 *     blink; a port does not.
 *   - **The main thread's share is the JSON parse and nothing else.**
 *     `execFile`, never `execFileSync` - so the 400ms is another process's - and
 *     the parse of 58-66KB across 276-285 processes measured **0.11 to
 *     0.21ms**. That
 *     is the number this file is actually spending on a repeating timer, and it
 *     is the number that matters, because what queues behind main-thread work
 *     is pty resizes and IPC replies. The archive is the standing precedent:
 *     16MB chunks of synchronous work at start-up were enough to make
 *     `settings-check`'s terminal group fail, and that one was not on a timer.
 *
 * A fourth limit is structural rather than numeric: **passes never overlap.**
 * A machine slow enough that a pass outlasts the interval gets fewer passes,
 * never a queue of `powershell.exe` processes behind each other.
 *
 * ## What it never does
 *
 * Nothing here reads anything out of a session. `sessionResources` is handed
 * the **pty's** pid, which Helm holds because Helm spawned it, and walks the
 * children of a process Helm started. Nothing parses session output, and the
 * tree of a session Helm did not spawn is not something this can produce or
 * would try to - which is why the pane's detail half is Helm's own and its
 * listing half is machine-wide.
 *
 * ## A WSL-hosted session is a session this pass cannot see
 *
 * `readProcessSnapshot` is two CIM queries against **this** kernel. For a
 * session hosted in a distro the pty is `wsl.exe`, and everything the session
 * actually started - the `claude` process itself, its Bash children, its dev
 * server - is a Linux process in another kernel with pids from another number
 * space. Rooting the walk at the pty therefore does not fail: it *succeeds*,
 * finds `wsl.exe` alive with no Windows children, and produces a tree that says
 * the session is holding nothing. That is the one answer the shape of
 * `SessionResources` exists to prevent, and CLAUDE.md names the reason: "could
 * not look" and "nothing there" are never merged, because "holding nothing" is
 * what somebody checks before starting a second agent. Getting it wrong by
 * enumerating the wrong kernel is worse than getting it wrong by not asking,
 * since the wrong answer here is the reassuring one.
 *
 * So a WSL-hosted session gets the same record a host that could not be asked
 * gets - `processes` and `ports` null, `rootSeen` false - and the pane paints
 * "Unknown". The ports go with the tree rather than being kept: a listener
 * inside a distro reaches Windows through WSL's own relay, which holds the
 * socket under a pid that is not in this session's tree at all, so the socket
 * query answering perfectly still cannot attribute anything to this session.
 * Every port the pass could honestly credit it with is therefore not a port
 * this session may be said to hold.
 *
 * **The fix is to not claim an answer, never to go and get one.** Asking the
 * distro would mean a `wsl.exe` per distro per pass, on top of the 400-480ms
 * budget above, on a 4s timer - which would invert the whole of that budget for
 * the one kind of session it is hardest to justify spending it on. If a tree
 * inside a distro is ever wanted it is a different mechanism with its own
 * budget, not another child process hung off this one.
 */
const POLL_MS = 4_000

export interface ResourcesService {
  /** The most recent pass, per hosted session. Empty before the first one. */
  snapshots: () => SessionResources[]
  /**
   * Turn the pass on or off.
   *
   * Reference-counted rather than a boolean, because more than one surface may
   * want it - the pane, and a check driver watching alongside it - and the
   * first of them to stop looking must not switch it off under the second.
   */
  watch: (on: boolean) => void
  /**
   * Run one pass now, if anything is watching. Answers when it has landed.
   *
   * A pass already running is **joined**, not queued behind. That matters to
   * the two callers for opposite reasons. A driver calls this immediately after
   * `watch(true)`, which has itself already started one - so returning early
   * would hand back a service with nothing in it yet, and the caller would be
   * reading `snapshots()` before the machine had been asked. And a session
   * ending fires this from `onChanged`; queueing a second `powershell.exe`
   * behind the first is the one thing the whole budget above is arranged to
   * avoid, and the interval corrects the tree a moment later anyway.
   */
  refresh: () => Promise<void>
  /** What the last pass cost and whether it read anything, for a driver. */
  lastPass: () => { atMs: number; durationMs: number; processes: number; ports: number } | null
  stop: () => void
}

export interface ResourcesDeps {
  sessions: SessionHost
  window: () => BrowserWindow | null
  /** The enumeration, injected so a driver can arrange a machine. */
  read?: (() => Promise<ProcessSnapshot>) | undefined
}

export function createResourcesService({
  sessions,
  window,
  read = () => readProcessSnapshot()
}: ResourcesDeps): ResourcesService {
  let watchers = 0
  let timer: NodeJS.Timeout | null = null
  /** The pass currently running, so a second caller joins it rather than starting one. */
  let inFlight: Promise<void> | null = null
  let stopped = false
  let current: SessionResources[] = []
  let last: { atMs: number; durationMs: number; processes: number; ports: number } | null = null

  /**
   * One line per session, compared as a string.
   *
   * Same reasoning as the activity poller's signature: a channel that fired
   * every interval whether or not anything moved would be a React render per
   * tick. What is compared is the shape a person would notice changing - which
   * processes, at what depth, holding which ports - and deliberately **not**
   * `atMs`, which moves on every pass by construction. `null` and `[]` produce
   * different strings, because that difference is the whole point of the shape.
   */
  const signature = (snapshots: readonly SessionResources[]): string =>
    snapshots
      .map((snapshot) => {
        const tree =
          snapshot.processes === null
            ? '?'
            : snapshot.processes
                .map((p) => `${String(p.pid)}/${p.name}/${(p.ports ?? ['?']).join('+')}`)
                .join(',')
        return `${String(snapshot.id)}:${String(snapshot.rootPid)}:${snapshot.rootSeen ? 'y' : 'n'}:${String(snapshot.opaque)}:${tree}`
      })
      .join('|')

  async function runPass(): Promise<void> {
    if (stopped) return
    // Every session Helm is hosting whose process is still alive. A session
    // that has exited has no tree to read and its last one is not worth
    // keeping - the pane says "ended", which is a fact Helm established and
    // outranks anything an enumeration could add.
    const live = sessions
      .list()
      .filter((record) => record.status === 'running')
      .flatMap((record) => {
        const pid = sessions.pid(record.id)
        if (pid === null) return []
        // Where this session is hosted decides whether the enumeration below is
        // an answer about it at all - see the header. Null target is a session
        // this process is not hosting, which cannot happen for a row `list()`
        // returned and is treated as Windows because that is the state every
        // session had before distros existed.
        const wsl = sessions.target(record.id)?.kind === 'wsl'
        return [{ id: record.id, pid, wsl }]
      })

    if (live.length === 0) {
      if (current.length === 0) return
      current = []
      emit(window(), 'sessions:resources', current)
      return
    }

    let snapshot: ProcessSnapshot
    try {
      snapshot = await read()
    } catch {
      // `readProcessSnapshot` does not reject, but an injected reader might.
      // A pass that threw says nothing, which is the same answer as a machine
      // that could not be asked - never a reason to stop the timer.
      return
    }
    if (stopped) return

    last = {
      atMs: snapshot.atMs,
      durationMs: snapshot.durationMs,
      processes: snapshot.processes?.length ?? -1,
      ports: snapshot.ports?.length ?? -1
    }

    // A WSL-hosted session is handed the empty snapshot rather than this one,
    // so it takes the "could not look" branch of `sessionResources` by the same
    // route a machine that refused the query takes it. Built from the pass's
    // own `atMs` because the pass did run and this is when Helm last looked;
    // reusing the core function rather than writing the record inline keeps
    // "could not look" one shape with one definition, so a later field cannot
    // be filled here and left null there.
    const unasked = noProcessSnapshot(snapshot.atMs, snapshot.durationMs)
    const next = live.map(({ id, pid, wsl }) =>
      sessionResources(id, pid, wsl ? unasked : snapshot)
    )
    if (signature(next) === signature(current)) {
      // The tree has not moved. `current` is still replaced, so `atMs` is the
      // time of the pass that most recently confirmed it rather than the time
      // it was first seen - a surface saying "as of" must not say something
      // older than the last time Helm actually looked.
      current = next
      return
    }
    current = next
    emit(window(), 'sessions:resources', current)
  }

  /**
   * One pass at a time, and everybody asking for one gets the same promise.
   *
   * This is the fourth budget in the header, made structural: a machine slow
   * enough that a pass outlasts the interval gets fewer passes, never a queue
   * of `powershell.exe` processes behind each other. The promise is handed back
   * rather than swallowed so a caller that wants to know when the machine has
   * actually been asked can wait for it.
   */
  function pass(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (inFlight !== null) return inFlight
    const running = runPass().finally(() => {
      inFlight = null
    })
    inFlight = running
    return running
  }

  function schedule(): void {
    if (timer !== null || stopped || watchers <= 0) return
    timer = setInterval(() => void pass(), POLL_MS)
    // Nothing here should hold the process open: the app quits when its windows
    // are gone, not when a poller stops.
    timer.unref?.()
  }

  return {
    snapshots: () => current,

    watch(on) {
      if (stopped) return
      watchers = Math.max(0, watchers + (on ? 1 : -1))
      if (watchers > 0) {
        schedule()
        // At once, so a pane that has just opened is not blank for an interval.
        void pass()
        return
      }
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      // Kept rather than cleared. What is on screen when the pane is closed is
      // the last thing Helm actually saw, and a pane that reopened empty would
      // be claiming those sessions are holding nothing.
    },

    refresh: () => (watchers > 0 ? pass() : Promise.resolve()),

    lastPass: () => last,

    stop() {
      stopped = true
      watchers = 0
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}

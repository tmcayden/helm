import type { BrowserWindow } from 'electron'
import {
  claudeHome as homeDir,
  joinSessionRegistry,
  readForeignSessionRegistry,
  readSessionRegistry,
  sessionLabel,
  sessionRegistryDir,
  type LiveSession,
  type SessionActivityState,
  type SessionRegistryEntry,
  type SessionsOverview,
  type WslHome
} from '@helm/core'
import { emit } from './ipc'
import type { SessionHost } from './sessions'

/**
 * What each hosted session is doing, from Claude Code's own registry.
 *
 * The main process owns this for the reason it owns process lifetime: the join
 * needs the pty's pid and the conversation id Helm assigned at launch, and
 * neither of those is a React value. The renderer is told; it never reads.
 *
 * **Read-only, over a tree Helm does not own.** Nothing here writes to or
 * deletes from `~/.claude/sessions`. A record for a process that is gone is
 * dropped from this pass and left on disk - collecting it is the CLI's own
 * sweep's job, and a Helm that deleted from that directory would be a Helm that
 * writes into `~/.claude`.
 *
 * ## Why a poll rather than a watch
 *
 * `fs.watch` would be more responsive per transition and would miss the thing
 * that matters most. A hard-killed session's record is never touched again - it
 * sits on disk still claiming `busy` - so **the event that must change the tab
 * produces no file event at all**. Liveness has to be re-asked on a timer
 * whatever else is done, and once there is a timer a watch is a second
 * mechanism buying a fraction of a second.
 *
 * The interval is a straight trade against how quickly "waiting on you" appears.
 * The directory holds one small file per live session on the machine - a readdir
 * and a handful of 450-byte reads - so 750ms is cheap and puts the dot on screen
 * inside a blink of the transition.
 */
const POLL_MS = 750

export interface ActivityService {
  /** Everything currently known, for a renderer that has just (re)mounted. */
  states: () => SessionActivityState[]
  /**
   * Every live Claude Code session on the machine, Helm's own marked.
   *
   * Composed from the same pass as the states above rather than by a second
   * poller, because it is the same `readdir` - the machine-wide listing is
   * *what the registry is*, and Helm's own sessions are a subset of it that
   * happens to have more known about it.
   */
  overview: () => SessionsOverview
  /**
   * Re-read now and push if anything moved.
   *
   * Called on launch and on exit as well as on the timer, so a new tab gets its
   * dot without waiting out an interval and a finished one loses it at once.
   */
  refresh: () => void
  /**
   * Adds the WSL distributions' `~/.claude/sessions` to what the join looks in.
   *
   * A session Helm hosts in a distro registers there and nowhere else, so
   * without this its tab's dot never lights. Separate from construction because
   * finding the homes is a `wsl.exe` per distribution and the window must not
   * wait on it.
   */
  useHomes: (homes: readonly WslHome[]) => void
  /** The raw records behind the current pass, for the check driver. */
  entries: () => SessionRegistryEntry[]
  stop: () => void
}

export interface ActivityDeps {
  sessions: SessionHost
  window: () => BrowserWindow | null
  /**
   * The `.claude` home to read. Defaults to the user's, honouring
   * `CLAUDE_CONFIG_DIR` the way everything else that reads that tree does -
   * which is what lets a check point this at a fixture home.
   */
  claudeHome?: string | undefined
}

/**
 * The process a session's records have been coming from.
 *
 * Learned once from the conversation id and then followed, because neither key
 * on its own survives every case: the id stops matching after a `/clear`, and
 * the pty's pid is `cmd.exe`'s through a `.cmd` shim. `(pid, procStart)` is
 * true through both. See `joinSessionRegistry` for the measurements.
 *
 * Dropped when the session ends, so a pid the machine goes on to reuse can
 * never be picked up by a tab that has already been closed.
 */
type Pin = { pid: number; procStart: string | null } | { file: string }

export function createActivityService({
  sessions,
  window,
  claudeHome
}: ActivityDeps): ActivityService {
  const dir = sessionRegistryDir(claudeHome ?? homeDir())

  /**
   * The distributions' registries, added when the probe that finds them lands.
   *
   * A session Helm hosts inside a distro registers in *that* distro's
   * `~/.claude/sessions`, so without these its tab has a dot that never lights
   * and its status never reads anything but "no record yet".
   *
   * These are read through `readForeignSessionRegistry`, which does **not**
   * filter by liveness, because the pid in the record belongs to the distro's
   * kernel and probing it against this machine's process table would either
   * miss a running session or match an unrelated Windows process and call a
   * finished conversation live. The liveness instead comes from Helm itself:
   * only records that join to a session Helm is hosting are used, and a hosted
   * session is running because Helm holds the relay's pty. Anything that joins
   * to nothing is dropped, so nothing stale can be painted from one.
   *
   * The visible consequence, and it is a real one: a `claude` somebody started
   * in a distro's own terminal does not appear in the machine-wide listing.
   * That listing is about processes this machine can be asked about, and this
   * one cannot be - not for 0.15ms a pass, which is what it costs on NTFS.
   */
  let foreignDirs: readonly string[] = []
  const pins = new Map<number, Pin>()
  let current: SessionActivityState[] = []
  let entries: SessionRegistryEntry[] = []
  let listing: SessionsOverview = { sessions: [], readAtMs: 0 }

  /**
   * One line per session, compared as a string.
   *
   * The push is an event on a channel, and a channel that fired every 750ms
   * whether or not anything moved would be a React render per tick for every
   * open tab. Four short fields make a cheap, total comparison; a deep equality
   * helper would be the same claim with more code.
   */
  const signature = (states: readonly SessionActivityState[]): string =>
    states
      .map(
        (s) =>
          `${String(s.id)}:${s.activity ?? '-'}:${s.waitingFor ?? '-'}:${s.claudeSessionId ?? '-'}`
      )
      .join('|')

  function pass(): SessionActivityState[] {
    const live = sessions.list().filter((record) => record.status === 'running')

    /*
     * Read whatever Helm is hosting, and that is a change worth explaining.
     *
     * This began as "no hosted sessions, nobody needs the answer", which was
     * true while the only consumer was a tab's dot. It stopped being true the
     * moment the machine-wide listing existed: the whole point of that listing
     * is the session Helm is *not* hosting, and an empty tab strip is exactly
     * the state where the warning "this directory already has a session
     * running" matters most - somebody is about to start one.
     *
     * The cost is why this is affordable rather than a compromise. Measured on
     * this machine on 2026-08-20: `readdir` plus every `<pid>.json` is
     * **0.15ms** - one 451-byte file per live session, and there is one file
     * per session on the machine, not per session in history. That is a
     * five-thousandth of the 750ms interval.
     */
    entries = readSessionRegistry(dir)

    // Kept apart from `entries`, which is what the machine-wide listing walks:
    // these are joinable but not listable, for the reason `foreignDirs` gives.
    const foreign = foreignDirs.flatMap((where) => readForeignSessionRegistry(where))
    const joinable = foreign.length === 0 ? entries : [...entries, ...foreign]

    const states: SessionActivityState[] = []
    const listed: LiveSession[] = []
    const seen = new Set<number>()
    // Which records a hosted session has claimed. By file rather than by pid,
    // because the file name is the record's identity and two records for one
    // pid cannot both be live.
    const claimed = new Set<string>()

    for (const record of live) {
      seen.add(record.id)
      const ptyPid = sessions.pid(record.id)
      /*
       * A session inside a distro is joined by conversation id and then by the
       * record's file name, and never by a pid.
       *
       * Its pty is `wsl.exe`, so `ptyPid` is a Windows pid the distro's record
       * has never heard of - offering it as a key could only ever produce a
       * *wrong* match against one of this machine's own records, which is worse
       * than no match. And the record's own pid is the distro's, which is why
       * the pin is the file name instead; see `readForeignSessionRegistry`.
       */
      const inDistro = sessions.target(record.id)?.kind === 'wsl'
      const pin = pins.get(record.id) ?? null
      const found = joinSessionRegistry(joinable, {
        claudeSessionId: record.claudeSessionId,
        ptyPid: inDistro ? null : ptyPid,
        pinned: pin !== null && !('file' in pin) ? pin : null,
        pinnedFile: pin !== null && 'file' in pin ? pin.file : null
      })

      if (found === null) {
        // Not an error and not worth clearing the pin for: a record is absent
        // for the second between spawn and registration, and again for the
        // instant a `/clear` rewrites it. What it is never allowed to be is a
        // *stale* answer, so the state goes to null rather than keeping the
        // last one.
        states.push({ id: record.id, activity: null, waitingFor: null, claudeSessionId: null })
        /*
         * Listed anyway, and this is the case the listing would be wrong
         * without.
         *
         * A session with no record is not a session that is not running - Helm
         * spawned the process and holds its pid. Two measured ways in: the
         * second between spawn and registration, and a session sitting on the
         * workspace-trust prompt, which registers only *after* the startup
         * gates. Leaving it out would mean the launch warning went quiet for
         * exactly the session somebody just started and is being asked to trust.
         */
        listed.push({
          helmSessionId: record.id,
          pid: ptyPid ?? 0,
          registered: false,
          cwd: record.cwd,
          // Helm's own word for it, through the shared helper - so the pane,
          // the tab and the warning cannot end up calling one session three
          // things.
          name: sessionLabel(record),
          activity: null,
          waitingFor: null,
          // No record, so no transition to time from. Null rather than the
          // row's start time, which would read as "it has been in this status
          // since it started" about a status that does not exist yet.
          statusSinceMs: null,
          version: null,
          entrypoint: null,
          startedAtMs: Date.parse(record.startedAt) || null,
          claudeSessionId: record.claudeSessionId
        })
        continue
      }

      claimed.add(found.file)
      pins.set(
        record.id,
        inDistro ? { file: found.file } : { pid: found.pid, procStart: found.procStart }
      )
      states.push({
        id: record.id,
        activity: found.activity,
        waitingFor: found.waitingFor,
        claudeSessionId: found.sessionId
      })
      listed.push({
        helmSessionId: record.id,
        pid: found.pid,
        registered: true,
        // Helm's own row rather than the record for both of these: the cwd is
        // what Helm launched into and the name is what the tab says. The record
        // agrees in practice, and where it does not, the row is the one the
        // user can act on.
        cwd: record.cwd,
        name: sessionLabel(record),
        activity: found.activity,
        waitingFor: found.waitingFor,
        statusSinceMs: found.statusUpdatedAt,
        version: found.version,
        entrypoint: found.entrypoint,
        startedAtMs: found.startedAt ?? (Date.parse(record.startedAt) || null),
        claudeSessionId: found.sessionId
      })
    }

    for (const entry of entries) {
      if (claimed.has(entry.file)) continue
      // Everything else on the machine. Carrying only what the record knows,
      // which is the whole of the degradation: Helm did not spawn this, so it
      // has no branch, no profile, no argv and no tree for it, and there is
      // nothing to special-case because there is nothing to leave out.
      listed.push({
        helmSessionId: null,
        pid: entry.pid,
        registered: true,
        cwd: entry.cwd,
        name: entry.name,
        activity: entry.activity,
        waitingFor: entry.waitingFor,
        statusSinceMs: entry.statusUpdatedAt,
        version: entry.version,
        entrypoint: entry.entrypoint,
        startedAtMs: entry.startedAt,
        claudeSessionId: entry.sessionId
      })
    }

    // Hosted first, because those are the ones with something to open, then by
    // start time so the order is stable across passes rather than following
    // whatever order the directory happened to list in.
    listed.sort(
      (a, b) =>
        Number(a.helmSessionId === null) - Number(b.helmSessionId === null) ||
        (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0) ||
        a.pid - b.pid
    )
    listing = { sessions: listed, readAtMs: Date.now() }

    for (const id of [...pins.keys()]) if (!seen.has(id)) pins.delete(id)
    return states
  }

  /**
   * One line per listed session, compared as a string.
   *
   * Separate from the states' signature because the two channels move at
   * different rates and for different reasons: a session appearing anywhere on
   * the machine changes this and not that. `readAtMs` is deliberately not in it
   * - it moves on every pass by construction, and a signature containing it
   * would be a push per tick, which is the thing a signature exists to prevent.
   */
  const listingSignature = (overview: SessionsOverview): string =>
    overview.sessions
      .map(
        (s) =>
          `${String(s.helmSessionId ?? '-')}:${String(s.pid)}:${s.registered ? 'r' : '-'}:` +
          `${s.activity ?? '-'}:${s.waitingFor ?? '-'}:${s.cwd ?? '-'}:${s.name ?? '-'}`
      )
      .join('|')

  function refresh(): void {
    const before = listingSignature(listing)
    let next: SessionActivityState[]
    try {
      next = pass()
    } catch {
      // A pass that threw is a pass that says nothing, which is the same
      // answer as a registry that is not there. Never a reason to stop the
      // timer or to fail a launch.
      return
    }
    if (listingSignature(listing) !== before) emit(window(), 'sessions:overview', listing)
    if (signature(next) === signature(current)) return
    current = next
    emit(window(), 'session:activity', current)
  }

  const timer = setInterval(refresh, POLL_MS)
  // Nothing here should hold the process open: the app quits when its windows
  // are gone, not when a poller stops.
  timer.unref?.()

  return {
    states: () => current,
    overview: () => listing,
    refresh,
    useHomes(homes) {
      const added = homes
        .map((home) => sessionRegistryDir(home.claudeHome))
        .filter((where) => !foreignDirs.some((held) => held.toLowerCase() === where.toLowerCase()))
      if (added.length === 0) return
      foreignDirs = [...foreignDirs, ...added]
      refresh()
    },
    entries: () => entries,
    stop: () => clearInterval(timer)
  }
}

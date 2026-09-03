import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { join } from 'node:path'
import { probeProcess, type OwnerLiveness } from '../launch/overlay'
import {
  SESSION_ACTIVITIES,
  type SessionActivity,
  type SessionRegistryEntry
} from '../types'

/**
 * Claude Code's own registry of live sessions, read.
 *
 * The CLI keeps one file per running session at `~/.claude/sessions/<pid>.json`
 * carrying, among other things, what that session is doing right now. Helm reads
 * it and puts the answer on the tab.
 *
 * **This does not breach "Helm renders nothing for a live session".** Nothing
 * here parses session output, answers a prompt, or puts anything between the
 * user and the TUI. It reads a file Claude Code writes for its own purposes -
 * the same posture the usage figures and the history index already have. The
 * alternative was parsing the TUI, and the standing proof of how brittle that
 * is lives in `sessionscheck.ts`: its readiness probe matches the composer's
 * hint line, and had to be rewritten when the CLI changed its welcome layout
 * on 2.1.227.
 *
 * **`~/.claude` is Claude Code's and this only reads it.** Nothing in this file
 * writes, and nothing in it deletes - a stale record is filtered here, at read
 * time, and left on disk for the CLI's own sweep to collect. `SESS-19` hashes
 * the directory either side of a full pass to say so, the way
 * `transcript-check`'s `T-5` does for the transcript tree.
 *
 * ## What was measured, and against what
 *
 * Every claim below was taken against **Claude Code 2.1.238** on Windows 11 on
 * 2026-08-20, by driving a real session and polling this directory every 150ms.
 * It is undocumented internal behaviour of the CLI and it ships on its own
 * schedule, so a change of shape is a thing to re-measure rather than to
 * defend. The whole design point of the tolerant parse below is that the cost
 * of being wrong about any of it is a value, never an exception:
 *
 *   - The status vocabulary is `busy`, `shell`, `idle`, `waiting`, and all four
 *     were observed. `waiting` carries `waitingFor`: `"dialog open"` for a
 *     slash command that renders a UI, and `"permission prompt"` for a tool
 *     call awaiting approval.
 *   - **A permission prompt only happens where the permission mode allows it.**
 *     A session running under `auto` or `bypassPermissions` never asks, so it
 *     never reaches `waiting` that way - which is a fact about that machine's
 *     settings rather than about this reader.
 *   - **The first record of every session has no `status` at all.** It is
 *     written when the process registers; the field arrives when the
 *     interactive UI loop publishes one. A `-p` run registers and never
 *     publishes one at all.
 *   - **The record is written on transition, never on a timer.** So
 *     `statusUpdatedAt` being old means nothing changed, not that anything is
 *     stale. Liveness is the only test.
 *   - **A clean exit removes the file; a hard kill leaves it**, still claiming
 *     whatever it last said. That is the case this reader's liveness filter
 *     exists for, and it is the one `SESS-18` provokes.
 *   - **The registry is machine-wide.** A `claude` started in a terminal
 *     registers alongside anything Helm hosts. This module hands back
 *     everything it can read; joining to Helm's own sessions is
 *     `joinSessionRegistry`, one layer up.
 */

/** Where the registry lives, under a `.claude` home. */
export function sessionRegistryDir(claudeHome: string): string {
  return join(claudeHome, 'sessions')
}

/**
 * The two facts about the machine that decide whether a record is live.
 *
 * Injected the way `ShimWorld` is, and for the same reason: a test has to be
 * able to produce an `EPERM` and a pre-boot record without owning a process it
 * may not signal or rebooting the machine.
 */
export interface RegistryWorld {
  probe: (pid: number) => OwnerLiveness
  /** When this machine last booted, ms since epoch. */
  bootAtMs: number
}

function realWorld(): RegistryWorld {
  return { probe: probeProcess, bootAtMs: Date.now() - uptime() * 1000 }
}

/** A string field, or null for anything that is not a non-empty string. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** A finite number, or null. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isActivity(value: string): value is SessionActivity {
  return (SESSION_ACTIVITIES as readonly string[]).includes(value)
}

/**
 * One record, parsed.
 *
 * Exported for the tests, which need to drive the tolerance rules over shapes
 * that are awkward to arrange on disk - a status that is a number, a `pid` that
 * is a string, a record that is an array.
 *
 * Returns null only when there is no `pid`, because a record with no pid is one
 * nothing can be probed about or joined to. Everything else degrades to null in
 * its own field.
 */
export function parseRegistryRecord(file: string, text: string): SessionRegistryEntry | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>

  const pid = num(row['pid'])
  if (pid === null || pid <= 0) return null

  const rawStatus = str(row['status'])

  return {
    file,
    pid,
    // A FILETIME is written as a string because it does not fit a double
    // exactly. Accepted as a number too, since a shape that changed to one
    // would still be usable and refusing it would cost the pid-reuse guard.
    procStart: str(row['procStart']) ?? (num(row['procStart']) === null ? null : String(row['procStart'])),
    sessionId: str(row['sessionId']),
    cwd: str(row['cwd']),
    name: str(row['name']),
    version: str(row['version']),
    entrypoint: str(row['entrypoint']),
    startedAt: num(row['startedAt']),
    activity: rawStatus !== null && isActivity(rawStatus) ? rawStatus : null,
    rawStatus,
    waitingFor: str(row['waitingFor']),
    statusUpdatedAt: num(row['statusUpdatedAt'])
  }
}

/**
 * Whether a record names a process that is still there.
 *
 * Three answers collapse to two here, and the collapse runs the **opposite way**
 * to `cleanStaleShims`. There, `unknown` means leave the directory alone,
 * because deleting a live session's plugins is the unrecoverable outcome. Here
 * nothing is deleted and the unrecoverable outcome is the other one: telling
 * somebody their agent is working when the process died twenty minutes ago. So
 * only `alive` - positively established, `EPERM` included - keeps a record, and
 * anything else drops it.
 *
 * `startedAt` before this boot is dead by construction, whatever the probe
 * says: pids do not survive a restart, so that number now belongs to somebody
 * else or to nobody. Same rule `ownerVerdict` uses, for the same reason.
 */
function isLive(entry: SessionRegistryEntry, world: RegistryWorld): boolean {
  if (entry.startedAt !== null && entry.startedAt < world.bootAtMs) return false
  return world.probe(entry.pid) === 'alive'
}

/**
 * Every live session the registry knows about.
 *
 * Stale records are filtered, not deleted. An unreadable file is skipped rather
 * than fatal - the CLI writes these without locking, so a read landing mid-write
 * is an ordinary event that must cost one poll and nothing else.
 *
 * A missing directory is an empty answer, not an error: it is the state of a
 * machine whose `claude` has never run.
 */
export function readSessionRegistry(
  dir: string,
  world: RegistryWorld = realWorld()
): SessionRegistryEntry[] {
  let files: string[]
  try {
    /*
     * `.json` only, and that filter is a **credential boundary** rather than
     * tidiness.
     *
     * This directory holds more than records. Measured on 2.1.238: alongside
     * `<pid>.json` the CLI writes `<pid>.<sha256>.key`, and the contents are
     * `{"peerToken":"…","procStartFt":"…"}` - a bearer token for Claude Code's
     * own session-to-session messaging channel. CLAUDE.md's rule is that Helm
     * never handles a credential, so those files are never opened, and a future
     * change that widened this to `readdirSync(dir)` would open them by
     * accident. The name is the only thing about a `.key` this module ever sees.
     */
    files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json'))
  } catch {
    return []
  }

  const entries: SessionRegistryEntry[] = []
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(join(dir, file), 'utf8')
    } catch {
      continue
    }
    const entry = parseRegistryRecord(file, text)
    if (entry === null) continue
    if (!isLive(entry, world)) continue
    entries.push(entry)
  }
  return entries
}

/**
 * A registry whose pids belong to another kernel, read without a liveness test.
 *
 * A session hosted in a WSL distribution registers in *that* distro's
 * `~/.claude/sessions`, and the `pid` in the record is a **Linux** pid. Probing
 * it here is not merely useless, it is unsafe in the direction that matters:
 * the number would be tested against this machine's process table, where it
 * either matches nothing - dropping a session that is running - or matches an
 * unrelated Windows process and reports a dead conversation as live. The dot
 * saying "busy" about a session that has exited is the one failure the liveness
 * filter exists to prevent, so the probe is refused rather than approximated.
 *
 * Asking the distro instead would be a `wsl.exe` per pass on a 750ms timer,
 * which is the budget rule in CLAUDE.md turned inside out - the process
 * enumeration is watch-gated at 4s for costing 400ms, and this would be worse.
 *
 * So liveness comes from somewhere better: **the caller must join every record
 * returned here to a session it is itself hosting**, and a hosted session is
 * live because Helm holds the relay's pty and reaps it. A record that joins to
 * nothing is dropped by the caller, which is why nothing stale can be painted
 * from one of these. The consequence, stated rather than hidden, is that a
 * `claude` somebody started in a distro's own terminal is not in the
 * machine-wide listing; `readSessionRegistry` is still the only thing that
 * lists a session Helm did not spawn.
 *
 * The `.json` filter is the same credential boundary, for the same reason.
 */
export function readForeignSessionRegistry(dir: string): SessionRegistryEntry[] {
  let files: string[]
  try {
    files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json'))
  } catch {
    return []
  }

  const entries: SessionRegistryEntry[] = []
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(join(dir, file), 'utf8')
    } catch {
      continue
    }
    // Prefixed so two distros - or a distro and this machine - cannot produce
    // one identity from two records. The file name is the record's identity
    // everywhere downstream (`claimed`, and the pane's key), and `4068.json`
    // is a name every kernel on the machine can mint.
    const entry = parseRegistryRecord(`${dir}#${file}`, text)
    if (entry === null) continue
    entries.push(entry)
  }
  return entries
}

/**
 * What Helm knows about one of its own sessions, as a key into the registry.
 *
 * `pinned` is the interesting half and it is why this is not a one-liner. The
 * two obvious keys each fail a case that actually happens:
 *
 *   - **The pty's pid** is `cmd.exe`'s when the CLI is a `.cmd` shim, and
 *     `claude.exe` registers under its own. Measured: pty 23496, registry 4068.
 *   - **The minted `sessionId`** stops matching the moment somebody types
 *     `/clear`, which re-registers the same process under a new conversation id.
 *     Measured: `7b3d1c20-…` became `9d9071aa-…` with the pid, `startedAt` and
 *     `procStart` all unchanged.
 *
 * So the id is used **once, to learn which process this is**, and the process
 * is what is followed afterwards. `(pid, procStart)` is stable across a
 * `/clear`, correct through a shim, and `procStart` is what keeps it honest
 * when a pid is reused - which Claude Code's own sweep does not check for.
 */
export interface RegistryJoin {
  /** The uuid Helm minted or resumed under, if it had one. */
  claudeSessionId: string | null
  /** The pid Helm holds for the pty. Not always the CLI's own. */
  ptyPid: number | null
  /** Learned from a previous join and authoritative once it is set. */
  pinned: { pid: number; procStart: string | null } | null
  /**
   * The same thing for a session inside a WSL distribution, whose record
   * carries a Linux pid this machine has no process table for. Set instead of
   * `pinned`, never as well, and it wins outright the way `pinned` does.
   */
  pinnedFile?: string | null
}

/**
 * The record belonging to one of Helm's sessions, or null.
 *
 * In order, first match wins: the pinned process, then the conversation id,
 * then the pty's pid. The last is the only route open to a CLI with no
 * `--session-id` flag, and it works for a direct spawn, which is what such a
 * CLI's users have.
 */
export function joinSessionRegistry(
  entries: readonly SessionRegistryEntry[],
  join: RegistryJoin
): SessionRegistryEntry | null {
  const { pinnedFile, pinned, claudeSessionId, ptyPid } = join

  /*
   * A record pinned by its own file name, which is what a foreign registry has
   * instead of a probeable pid.
   *
   * The file is `<pid>.json` and the CLI rewrites it in place - a `/clear`
   * re-registers the same process under a new conversation id and the same
   * name, which is the case the pid pin exists for and the only reason this
   * cannot simply be the conversation id every pass. `readForeignSessionRegistry`
   * prefixes the directory, so a pid two distros both happen to hold is two
   * names here rather than one.
   */
  if (pinnedFile !== null && pinnedFile !== undefined) {
    return entries.find((e) => e.file === pinnedFile) ?? null
  }

  if (pinned !== null) {
    // `procStart` compared including the null case: two records for one pid
    // cannot both be live, so a null on either side is the absence of the
    // guard rather than a mismatch.
    const found = entries.find(
      (e) =>
        e.pid === pinned.pid &&
        (pinned.procStart === null || e.procStart === null || e.procStart === pinned.procStart)
    )
    return found ?? null
  }

  if (claudeSessionId !== null) {
    const found = entries.find((e) => e.sessionId === claudeSessionId)
    if (found) return found
  }

  if (ptyPid !== null) {
    const found = entries.find((e) => e.pid === ptyPid)
    if (found) return found
  }

  return null
}

/**
 * A fresh conversation id for a launch.
 *
 * Minted per launch and **never reused**, because a uuid that already exists is
 * refused outright: `Error: Session ID <uuid> is already in use.`, exit 1,
 * measured on 2.1.238. So this is not a key anything may launch from twice, and
 * the resume path passes `--resume` with the id it already has rather than
 * re-asserting it - which was measured to register under that same id.
 */
export function newClaudeSessionId(): string {
  return randomUUID()
}

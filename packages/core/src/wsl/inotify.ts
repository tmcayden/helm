import { isTranscriptName } from '../discovery/history'
import type { WslHome } from '../types'
import { toWindowsPath } from './path'

/**
 * Change notification out of a distribution's `~/.claude`, as a stream of lines.
 *
 * The 9P share behind `\\wsl$\` carries no change notification of any kind -
 * `fs.watch` over it throws `EISDIR` immediately - so for a distro the session
 * index had only a poll, and the poll's sweep re-walked the distro's transcripts
 * over 9P every minute: measured 2026-09-03 at **777-873 ms of synchronous
 * main-thread time** per sweep over 1,066 transcripts (a `stat` over 9P is 1.8
 * ms against 0.007 ms on NTFS - 250x), and the number grows with every worktree
 * a session is opened in. That is the stall a user feels as typing that stops
 * and then arrives all at once: pty writes and IPC replies queue behind it.
 *
 * Inside the distro, inotify works as it does anywhere on Linux. So the host
 * runs `inotifywait` there and reads its stdout - measured at **0.8 ms** from a
 * write in the distro to a line in the main process, against a poll that could
 * take a minute to notice. No port, no token, no listener: a child process's
 * pipe is a channel the operating system already scopes to its parent, and the
 * network posture in CLAUDE.md did not have to move for it.
 *
 * This module is the pure half - the argv and the parser - so it can be tested
 * without a distro. `main/wslwatch.ts` owns the process.
 *
 * Two facts about the command line, both measured rather than read:
 *
 * - **`--exec`, never `--`.** `wsl.exe -- cmd` hands the argv to the user's
 *   login shell to re-parse; with zsh as that shell a `--format` containing
 *   `|` became a pipe and `%w%f` a job spec, and `inotifywait` started with
 *   "No files specified to watch!". `--exec` runs the program with the argv
 *   verbatim. It also skips the login shell, which is fine here: `stdbuf` and
 *   `inotifywait` are on the default PATH or they are nowhere.
 * - **`stdbuf -o0`.** `inotifywait` block-buffers when stdout is a pipe, so
 *   without it nothing arrives until 4 KB of events have accumulated.
 *
 * `-r` over the whole `.claude` tree rather than a hand-picked set of
 * directories, because a project directory created after the watch began is
 * picked up automatically (measured: a file inside a directory made after
 * "Watches established" reported, and so did one inside a directory renamed
 * into place). What that costs is events for the rest of the tree -
 * `sessions/`, `todos/`, subagent transcripts - which the parser drops by path
 * before anything is done with them. Nothing here opens a file the line names;
 * a `sessions/<pid>.<sha>.key` appearing in an event is a name and nothing
 * more, and it is discarded on the first test below.
 */

/** The inotify events subscribed. Not `modify`: `close_write` is one event per save. */
export const INOTIFY_EVENTS = 'create,delete,moved_to,moved_from,close_write'

/** What `inotifywait` prints on stderr once every watch is in place. */
export const INOTIFY_READY = 'Watches established'

/** Between the event flags and the path. Safe under `--exec`; see above for `--`. */
export const INOTIFY_SEPARATOR = '|'

/** The distro's `~/.claude`, Linux-spelled, without a trailing slash. */
export function claudeTreeOf(home: WslHome): string {
  return `${home.home.replace(/\/+$/, '')}/.claude`
}

/** The argv for `wsl.exe` that watches one distribution's tree. */
export function inotifyWatchArgs(home: WslHome): string[] {
  return [
    '-d',
    home.distro,
    '--exec',
    'stdbuf',
    '-o0',
    'inotifywait',
    '-m',
    '-r',
    '-e',
    INOTIFY_EVENTS,
    '--format',
    `%e${INOTIFY_SEPARATOR}%w%f`,
    claudeTreeOf(home)
  ]
}

/**
 * What one line means to the session index.
 *
 * `history` says the distro's `history.jsonl` changed, whatever happened to it.
 * `transcript` names one path under `projects/`, spelled so this process can
 * open it: a session transcript, or a project directory (`isDir`), or the
 * `projects/` directory itself. `removed` is a delete or a move away; anything
 * else is `changed`, including a move into place.
 */
export type ClaudeTreeEvent =
  | { kind: 'history' }
  | { kind: 'transcript'; op: 'changed' | 'removed'; path: string; isDir: boolean }

export function parseInotifyLine(line: string, home: WslHome): ClaudeTreeEvent | null {
  const trimmed = line.replace(/\r$/, '')
  const at = trimmed.indexOf(INOTIFY_SEPARATOR)
  if (at <= 0) return null
  const flags = trimmed.slice(0, at).split(',')
  const linuxPath = trimmed.slice(at + 1).replace(/\/+$/, '')

  const tree = `${claudeTreeOf(home)}/`
  if (!linuxPath.startsWith(tree)) return null
  const rel = linuxPath.slice(tree.length)

  if (rel === 'history.jsonl') return { kind: 'history' }

  const isDir = flags.includes('ISDIR')
  const op = flags.includes('DELETE') || flags.includes('MOVED_FROM') ? 'removed' : 'changed'

  let named: boolean
  if (rel === 'projects') {
    named = isDir
  } else if (rel.startsWith('projects/')) {
    const parts = rel.slice('projects/'.length).split('/')
    const [project, name] = parts
    if (project === undefined || project === '') return null
    if (parts.length === 1) named = isDir
    else if (parts.length === 2 && name !== undefined) named = !isDir && isTranscriptName(name)
    else named = false
  } else {
    named = false
  }
  if (!named) return null

  const path = toWindowsPath(linuxPath, { distro: home.distro })
  return path === null ? null : { kind: 'transcript', op, path, isDir }
}

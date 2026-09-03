import type { BrowserWindow } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import * as pty from 'node-pty'
import { release } from 'node:os'
import { join } from 'node:path'

/**
 * Environment variables Electron injects (or that leak from the dev toolchain)
 * which must not reach a hosted `claude` process. NODE_OPTIONS in particular
 * gets applied to every Node child the session spawns.
 */
const STRIPPED_ENV = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_RENDERER_URL',
  'ELECTRON_IS_DEV',
  'NODE_OPTIONS',
  'NODE_ENV',
  'VITE_DEV_SERVER_URL',
  // Claude Code stamps these on every process it spawns. If Helm is launched
  // from inside a session they are inherited, and the hosted `claude` decides
  // it is a nested child: it announces "Transcript saving is off - inherited
  // CLAUDE_CODE_CHILD_SESSION marker" and stops writing a transcript. Observed
  // during Spike C; a host has to hand every session a clean slate.
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_PID'
]

/**
 * A hosted TUI only renders in full colour if the host advertises it. Claude
 * Code, like most Ink apps, resolves colour depth from COLORTERM first and
 * falls back to a 256-colour palette without it - the single most likely cause
 * of a "the theme looks wrong in the app" report.
 */
export function ptyEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !STRIPPED_ENV.includes(k)) env[k] = v
  }
  delete env.NO_COLOR
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return { ...env, ...extra }
}

/** Windows build number, e.g. 26100 from "10.0.26100". xterm uses it to pick
 * ConPTY quirk handling. */
export function windowsBuildNumber(): number | undefined {
  const parts = release().split('.')
  const build = Number(parts[2])
  return Number.isFinite(build) ? build : undefined
}

let pwsh: string | null = null

/**
 * PowerShell 7, resolved once, for the drivers that need a shell whose
 * behaviour their assertions are calibrated against.
 *
 * They used to pass the bare string `pwsh.exe` to node-pty. When PowerShell is
 * installed from the Store that name does not resolve: the execution alias
 * lives in `%LOCALAPPDATA%\Microsoft\WindowsApps`, which is not always on
 * PATH, and the package directory that *is* on PATH cannot be launched from.
 * node-pty opens a pty anyway, nothing ever writes a prompt into it, and every
 * check sits in `waitForPrompt` until its own timeout - a run that prints
 * nothing for twenty minutes and then fails all nine. Measured on this machine
 * twice before anyone looked for the shell.
 *
 * Falling back to Windows PowerShell 5.1 would be worse than failing. C9
 * asserts a drain rate calibrated against pwsh 7, and 5.1 drains at a
 * different one, so the check would report a number that is not comparable to
 * the ceiling it is being measured against. A missing shell is a fact about
 * the machine and is said as one.
 */
export function pwshPath(): string {
  if (pwsh) return pwsh

  // `where.exe` exits 1 when it matches nothing, which execFileSync throws on -
  // that is the ordinary answer here, not a failure worth propagating.
  let found: string | undefined
  try {
    found = execFileSync('where.exe', ['pwsh.exe'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
  } catch {
    found = undefined
  }
  if (found) {
    pwsh = found
    return pwsh
  }

  // The Store alias, found by **listing the directory** rather than by asking
  // about the path. An execution alias is an AppExecLink reparse point:
  // `existsSync` on one returns false and `statSync` throws EACCES, measured
  // here on the alias that launches pwsh 7.6.4 perfectly well. A readdir sees
  // it, and node-pty spawns it by full path without trouble.
  const dir = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps')
  try {
    if (readdirSync(dir).includes('pwsh.exe')) {
      pwsh = join(dir, 'pwsh.exe')
      return pwsh
    }
  } catch {
    // No such directory. Nothing to add to the error below.
  }

  throw new Error(
    'PowerShell 7 (pwsh.exe) is not on PATH and there is no execution alias in ' +
      `${dir}. Install it, or put that directory on PATH. Windows PowerShell ` +
      '5.1 is deliberately not used as a fallback: the throughput ceiling is ' +
      'calibrated against pwsh 7.'
  )
}

export interface SpawnOptions {
  file: string
  /**
   * An argv array, or a **raw Windows command line** for the one case that
   * cannot be expressed as one.
   *
   * node-pty joins an array into a command line with its own quoting, which is
   * right for every direct spawn and wrong for `cmd.exe /c`: cmd re-parses that
   * line under a rule of its own, and its rule strips the first and last quote
   * on it. With more than one quoted argument - a shim path holding a space and
   * a session name holding one - that leaves the shim's path split in half.
   * `claudePtyArgs` builds the string that survives it; see the comment there
   * for the measurement.
   */
  args?: string[] | string
  cols: number
  rows: number
  cwd: string
  env?: Record<string, string>
}

function open(opts: SpawnOptions): pty.IPty {
  return pty.spawn(opts.file, opts.args ?? [], {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: ptyEnv(opts.env),
    useConpty: true,
    conptyInheritCursor: false
  })
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

/**
 * The backstop behind `IPty.kill()`.
 *
 * Spike C deviation #8: node-pty's console-process enumeration hits
 * `AttachConsole failed` and falls back to killing the pty's own pid alone. A
 * hosted `claude` is a process *tree* - it spawns Node children for MCP
 * servers, ripgrep for searches, whatever a Bash tool call started - so that
 * fallback can leave the tree behind while the pane it belonged to is gone.
 * `taskkill /T` walks the tree the way node-pty could not.
 *
 * Not a substitute for `IPty.kill()`, which is still what releases the ConPTY
 * handles: this runs alongside it.
 */
function treeKill(pid: number, sync: boolean): void {
  if (pid <= 0) return
  if (process.platform !== 'win32') {
    try {
      // Negative pid = the process group, which is the POSIX equivalent of /T.
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone, or never had a group of its own.
    }
    return
  }
  const args = ['/PID', String(pid), '/T', '/F']
  if (sync) {
    try {
      execFileSync('taskkill.exe', args, { windowsHide: true, stdio: 'ignore', timeout: 4000 })
    } catch {
      // Exit code 128 means "no such process", which is the outcome we wanted.
    }
    return
  }
  execFile('taskkill.exe', args, { windowsHide: true, timeout: 4000 }, () => undefined)
}

/** How long a process gets to honour `IPty.kill()` before the tree kill. */
const GRACE_MS = 1500

// ---------------------------------------------------------------------------
// App sessions - many at once, one per tab
// ---------------------------------------------------------------------------

export interface SessionHandle {
  id: string
  pid: number
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  /** Terminate. Idempotent; the hard kill follows if the process ignores it. */
  kill: () => void
  exitCode: () => number | null
}

interface LiveSession extends SessionHandle {
  pty: pty.IPty
  hardKillTimer: NodeJS.Timeout | null
}

const live = new Map<string, LiveSession>()

export interface SessionSpawnOptions extends SpawnOptions {
  id: string
  onData: (chunk: string) => void
  /** Fires once, whether the process exited on its own or was killed. */
  onExit: (exitCode: number, signal: number | undefined) => void
}

export function spawnSession(opts: SessionSpawnOptions): SessionHandle {
  const p = open(opts)
  let code: number | null = null

  const session: LiveSession = {
    id: opts.id,
    pid: p.pid,
    pty: p,
    hardKillTimer: null,
    write: (data) => {
      try {
        p.write(data)
      } catch {
        // Raced with the process exiting; the keystroke has nowhere to go.
      }
    },
    resize: (cols, rows) => {
      try {
        p.resize(Math.max(cols, 1), Math.max(rows, 1))
      } catch {
        // Same race. A resize that misses is corrected by the next one.
      }
    },
    kill: () => killSession(opts.id),
    exitCode: () => code
  }

  p.onData(opts.onData)
  p.onExit(({ exitCode, signal }) => {
    code = exitCode
    if (session.hardKillTimer) clearTimeout(session.hardKillTimer)
    live.delete(opts.id)
    opts.onExit(exitCode, signal)
  })

  live.set(opts.id, session)
  return session
}

export function getSession(id: string): SessionHandle | undefined {
  return live.get(id)
}

export function liveSessionIds(): string[] {
  return [...live.keys()]
}

export function killSession(id: string): void {
  const session = live.get(id)
  if (!session) return

  try {
    session.pty.kill()
  } catch {
    // Already gone.
  }
  // `onExit` clears this. If it has not fired by then the process outlived the
  // polite kill, which is exactly the case deviation #8 predicted.
  if (!session.hardKillTimer) {
    session.hardKillTimer = setTimeout(() => {
      if (live.has(id)) treeKill(session.pid, false)
    }, GRACE_MS)
  }
}

/**
 * Terminates everything, synchronously, for app shutdown.
 *
 * Synchronous on purpose: `before-quit` is the last moment the main process is
 * guaranteed to still be running, and a kill scheduled on a timer there is a
 * kill that may never happen. The tree kill goes first so that the tree is
 * still intact when it walks it - once the pty's own process has gone, its
 * children have been reparented and `/T` finds nothing.
 */
export function killAllSessionsSync(): void {
  for (const session of live.values()) {
    treeKill(session.pid, true)
    try {
      session.pty.kill()
    } catch {
      // Expected: the tree kill above already took it.
    }
    if (session.hardKillTimer) clearTimeout(session.hardKillTimer)
  }
  live.clear()
}

// ---------------------------------------------------------------------------
// Spike harness - one pty, fully recorded
// ---------------------------------------------------------------------------

/**
 * The single-pty surface Spike B and C's drivers assert against. It records
 * both directions of the wire, which is what makes key encodings and bracketed
 * paste provable, and it is deliberately separate from the session registry
 * above: the regression checks measure one terminal in a page with nothing else
 * in it, and a shared registry would put the app's lifecycle in the middle of
 * that measurement.
 */
export interface PtyHandle {
  pty: pty.IPty
  /** Everything the process has written, unmodified. */
  output: () => string
  /** Everything the host has written *to* the process - the input side of the
   * wire, which is where bracketed paste and key encoding are provable. */
  input: () => string
  /**
   * The same bytes, still separated into the writes that carried them.
   *
   * One `pty:input` message is one `p.write`, and the renderer sends one per
   * xterm `onData`, so this counts a keystroke's data events at the wire - the
   * only place a driver can count them without instrumenting the page under
   * test. It exists because "one Ctrl+V produced one paste" cannot be settled
   * from `input()`: a stream carrying the paste twice contains a correct one,
   * and every substring test over it passes. C5.
   */
  chunks: () => string[]
  clearOutput: () => void
  /** Clears `input()` and `chunks()` together - they are one record. */
  clearInput: () => void
  exited: () => number | null
}

let current: PtyHandle | null = null

export function activePty(): PtyHandle | null {
  return current
}

export function spawnPty(win: BrowserWindow, opts: SpawnOptions): PtyHandle {
  const p = open(opts)

  let out = ''
  let inp = ''
  let inChunks: string[] = []
  let exitCode: number | null = null

  p.onData((chunk) => {
    out += chunk
    win.webContents.send('term:write', chunk)
  })
  p.onExit(({ exitCode: code }) => {
    exitCode = code
  })

  const handle: PtyHandle = {
    pty: p,
    output: () => out,
    input: () => inp,
    chunks: () => [...inChunks],
    clearOutput: () => {
      out = ''
    },
    clearInput: () => {
      inp = ''
      inChunks = []
    },
    exited: () => exitCode
  }
  // Record host->process bytes regardless of who writes them, so the driver can
  // assert on the exact encoding of a keystroke or a paste - and on how many
  // writes carried it, which is a different question and the one C5 asks.
  const rawWrite = p.write.bind(p)
  p.write = (data: string): void => {
    inp += data
    inChunks.push(data)
    rawWrite(data)
  }

  current = handle
  return handle
}

export function killPty(): void {
  if (!current) return
  // Tree first, then the pty - same order and the same reason as
  // `killAllSessionsSync`.
  treeKill(current.pty.pid, true)
  try {
    current.pty.kill()
  } catch {
    // Expected once the tree kill has taken it.
  }
  current = null
}

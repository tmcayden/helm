import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PortRow, ProcessRow, ProcessSnapshot } from './resources'

/**
 * The Linux half of process enumeration: `/proc` for the table, `ss` for the
 * listening sockets, into the same `ProcessSnapshot` the Windows pass produces.
 *
 * The contract is the Windows one exactly, because `sessionResources` is what
 * reads it and the surfaces above were written against those distinctions:
 *
 *   - `processes` is **null** when `/proc` could not be listed at all, and
 *     **`[]`** when it could and held nothing readable.
 *   - `commandLine` is **null** where the kernel would not give one up - a
 *     `cmdline` this user may not open, or one that is empty, which is how a
 *     kernel thread reads - and never `''`.
 *   - `ports` is **null** when `ss` is absent or exits non-zero, independently
 *     of `processes`, and `[]` when it ran and nothing was listening.
 *
 * A pid directory that vanishes between `readdir` and its read is a process
 * that exited mid-pass, so the row is dropped rather than the pass failing: the
 * table is a sample, not a census, and this is the sampling showing.
 *
 * Unprivileged by design. `ss -p` names an owning pid only for sockets this
 * user holds, so a listener somebody else's process owns is a row with no pid
 * and is skipped - the same shape as the Windows pass's withheld command lines,
 * and **no elevation is ever assumed** to change it.
 */

const PROC_DIR = '/proc'
const SS_TIMEOUT_MS = 15_000

/** The `/proc/<pid>/stat` fields this needs: pid, comm and ppid. */
export function parseProcStat(text: string): Pick<ProcessRow, 'pid' | 'parentPid' | 'name'> | null {
  // `comm` is parenthesised and may itself hold spaces and parentheses -
  // `(tmux: server)`, `(Web Content)` - so it ends at the *last* `)`.
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const pid = Number(text.slice(0, open).trim())
  const name = text.slice(open + 1, close)
  const rest = text.slice(close + 1).trim().split(/\s+/)
  const parentPid = Number(rest[1])
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid)) return null
  return { pid, parentPid, name }
}

/** `/proc/<pid>/cmdline`, NUL-separated, as one line; null for the empty one. */
export function parseCmdline(bytes: Uint8Array | string): string | null {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8')
  const joined = text.replace(/\0+$/, '').split('\0').join(' ').trim()
  return joined === '' ? null : joined
}

/**
 * `ss -tlnpH` lines into port rows, one per owning pid.
 *
 *     LISTEN 0 4096 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=123,fd=21),("node",pid=124,fd=21))
 *
 * The address is kept as `ss` prints it, `0.0.0.0` and `::` included, because
 * "loopback only" and "every interface" are the distinction the ports surface
 * exists to draw. `*` is how `ss -n` spells the IPv6 any-address and is written
 * as `::` so the two families read alike; brackets round a literal IPv6
 * address are dropped for the same reason.
 */
export function parseSsOutput(text: string): PortRow[] {
  const rows: PortRow[] = []
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 5) continue
    const local = columns[0] === 'LISTEN' ? columns[3] : columns[2]
    if (local === undefined) continue
    const colon = local.lastIndexOf(':')
    if (colon < 0) continue
    const port = Number(local.slice(colon + 1))
    if (!Number.isInteger(port) || port <= 0) continue
    const address = addressOf(local.slice(0, colon))
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(match[1])
      if (Number.isInteger(pid) && pid > 0) rows.push({ pid, port, address })
    }
  }
  return rows
}

function addressOf(raw: string): string | null {
  const bare = raw.replace(/^\[|\]$/g, '')
  if (bare === '') return null
  return bare === '*' ? '::' : bare
}

async function readProcess(procDir: string, pid: string): Promise<ProcessRow | null> {
  let stat: string
  try {
    stat = await readFile(join(procDir, pid, 'stat'), 'utf8')
  } catch {
    // Exited between the listing and this read.
    return null
  }
  const parsed = parseProcStat(stat)
  if (parsed === null) return null

  let commandLine: string | null
  try {
    commandLine = parseCmdline(await readFile(join(procDir, pid, 'cmdline')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    commandLine = null
  }
  return { ...parsed, commandLine }
}

async function readProcTable(procDir: string): Promise<ProcessRow[] | null> {
  let entries: string[]
  try {
    entries = await readdir(procDir)
  } catch {
    return null
  }
  const rows = await Promise.all(
    entries.filter((entry) => /^\d+$/.test(entry)).map((pid) => readProcess(procDir, pid))
  )
  return rows.filter((row): row is ProcessRow => row !== null)
}

/** `ss -tlnpH` on this machine, or null when it is absent or failed. */
export function runSs(timeoutMs = SS_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'ss',
        ['-tlnpH'],
        { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => {
          resolve(error ? null : stdout)
        }
      )
    } catch {
      resolve(null)
    }
  })
}

export interface LinuxEnumerationHost {
  /** The proc filesystem root; a test points this at a fixture. */
  procDir?: string
  /** The socket listing, as `ss -tlnpH` prints it, or null for a failed run. */
  listenSockets?: () => Promise<string | null>
}

/** One pass over this machine's processes and listening TCP sockets. */
export async function enumerateLinuxProcesses(host: LinuxEnumerationHost = {}): Promise<ProcessSnapshot> {
  const atMs = Date.now()
  const startedHr = process.hrtime.bigint()
  const [processes, sockets] = await Promise.all([
    readProcTable(host.procDir ?? PROC_DIR),
    (host.listenSockets ?? runSs)()
  ])
  return {
    processes,
    ports: sockets === null ? null : parseSsOutput(sockets),
    atMs,
    durationMs: Number(process.hrtime.bigint() - startedHr) / 1e6
  }
}

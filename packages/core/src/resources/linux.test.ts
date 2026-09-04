import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { enumerateLinuxProcesses, parseCmdline, parseProcStat, parseSsOutput } from './linux'

const STAT = (pid: number, comm: string, ppid: number): string =>
  `${String(pid)} (${comm}) S ${String(ppid)} ${String(pid)} ${String(pid)} 0 -1 4194304 135 0 0 0 0 0 0 0 20 0 1 0 3495417 3350528 384 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 22 0 0 0 0 0\n`

describe('parseProcStat', () => {
  it('reads pid, comm and ppid', () => {
    expect(parseProcStat(STAT(45381, 'cat', 45333))).toEqual({
      pid: 45381,
      parentPid: 45333,
      name: 'cat'
    })
  })

  it('keeps a comm holding spaces and parentheses whole', () => {
    expect(parseProcStat(STAT(7, 'tmux: server', 1))).toEqual({
      pid: 7,
      parentPid: 1,
      name: 'tmux: server'
    })
    expect(parseProcStat(STAT(8, 'a (b) c', 1))?.name).toBe('a (b) c')
  })

  it('refuses a line that is not a stat record', () => {
    expect(parseProcStat('')).toBeNull()
    expect(parseProcStat('not a stat line')).toBeNull()
  })
})

describe('parseCmdline', () => {
  it('joins NUL-separated arguments into one line', () => {
    expect(parseCmdline(Buffer.from('node\0server.js\0--port\x005173\0'))).toBe(
      'node server.js --port 5173'
    )
  })

  it('is null for an empty one, which is how a kernel thread reads', () => {
    expect(parseCmdline(Buffer.alloc(0))).toBeNull()
    expect(parseCmdline('\0')).toBeNull()
  })
})

describe('parseSsOutput', () => {
  const SS = [
    'LISTEN 0      4096    127.0.0.53%lo:53 0.0.0.0:*',
    'LISTEN 0      511          0.0.0.0:5173 0.0.0.0:* users:(("node",pid=123,fd=21),("node",pid=124,fd=21))',
    'LISTEN 0      511             [::1]:5173    [::]:* users:(("node",pid=123,fd=22))',
    'LISTEN 0      128                *:22       *:* users:(("sshd",pid=9,fd=3))',
    ''
  ].join('\n')

  it('gives one row per owning pid, with the address as printed', () => {
    expect(parseSsOutput(SS)).toEqual([
      { pid: 123, port: 5173, address: '0.0.0.0' },
      { pid: 124, port: 5173, address: '0.0.0.0' },
      { pid: 123, port: 5173, address: '::1' },
      { pid: 9, port: 22, address: '::' }
    ])
  })

  it('skips a socket whose owner an unprivileged query was not told', () => {
    expect(parseSsOutput(SS).some((row) => row.port === 53)).toBe(false)
  })

  it('reads the columns without the state prefix too', () => {
    expect(parseSsOutput('0 128 127.0.0.1:8080 0.0.0.0:* users:(("python3",pid=42,fd=3))')).toEqual([
      { pid: 42, port: 8080, address: '127.0.0.1' }
    ])
  })

  it('is empty for no output', () => {
    expect(parseSsOutput('')).toEqual([])
  })
})

describe('enumerateLinuxProcesses over a fixture', () => {
  let proc: string

  const process_ = (pid: number, comm: string, ppid: number, cmdline: string | null): void => {
    mkdirSync(join(proc, String(pid)))
    writeFileSync(join(proc, String(pid), 'stat'), STAT(pid, comm, ppid))
    if (cmdline !== null) writeFileSync(join(proc, String(pid), 'cmdline'), cmdline)
  }

  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), 'helm-proc-'))
    mkdirSync(join(proc, 'sys'))
    process_(1, 'systemd', 0, '/sbin/init\0splash\0')
    process_(2, 'kthreadd', 0, '')
    process_(300, 'tmux: server', 1, 'tmux\0new\0-s\0main\0')
    // A pid whose directory emptied between the listing and the read.
    mkdirSync(join(proc, '999'))
  })

  afterEach(() => {
    rmSync(proc, { recursive: true, force: true })
  })

  it('reads the table, withholding a command line rather than inventing one', async () => {
    const snapshot = await enumerateLinuxProcesses({
      procDir: proc,
      listenSockets: () => Promise.resolve('LISTEN 0 1 127.0.0.1:7 0.0.0.0:* users:(("tmux",pid=300,fd=5))')
    })
    expect(snapshot.processes).toEqual([
      { pid: 1, parentPid: 0, name: 'systemd', commandLine: '/sbin/init splash' },
      { pid: 2, parentPid: 0, name: 'kthreadd', commandLine: null },
      { pid: 300, parentPid: 1, name: 'tmux: server', commandLine: 'tmux new -s main' }
    ])
    expect(snapshot.ports).toEqual([{ pid: 300, port: 7, address: '127.0.0.1' }])
    expect(snapshot.durationMs).toBeGreaterThanOrEqual(0)
    expect(snapshot.atMs).toBeGreaterThan(0)
  })

  it('drops a pid that vanished mid-read instead of failing the pass', async () => {
    writeFileSync(join(proc, '999', 'stat'), STAT(999, 'gone', 1))
    const snapshot = await enumerateLinuxProcesses({ procDir: proc, listenSockets: () => Promise.resolve('') })
    expect(snapshot.processes?.map((row) => row.pid)).toEqual([1, 2, 300])
  })

  it('reports ports null when ss failed, with the processes still populated', async () => {
    const snapshot = await enumerateLinuxProcesses({ procDir: proc, listenSockets: () => Promise.resolve(null) })
    expect(snapshot.ports).toBeNull()
    expect(snapshot.processes).toHaveLength(3)
  })

  it('reports ports [] when ss ran and nothing was listening', async () => {
    const snapshot = await enumerateLinuxProcesses({ procDir: proc, listenSockets: () => Promise.resolve('') })
    expect(snapshot.ports).toEqual([])
  })

  it('reports processes null when /proc could not be listed, independently of ports', async () => {
    const snapshot = await enumerateLinuxProcesses({
      procDir: join(proc, 'missing'),
      listenSockets: () => Promise.resolve('')
    })
    expect(snapshot.processes).toBeNull()
    expect(snapshot.ports).toEqual([])
  })

  it('reports processes [] for a proc directory holding no processes', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'helm-proc-empty-'))
    try {
      const snapshot = await enumerateLinuxProcesses({ procDir: empty, listenSockets: () => Promise.resolve(null) })
      expect(snapshot.processes).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform !== 'linux')('enumerateLinuxProcesses on this machine', () => {
  it('finds its own process under its own parent', async () => {
    const snapshot = await enumerateLinuxProcesses()
    expect(snapshot.processes).not.toBeNull()
    const self = snapshot.processes?.find((row) => row.pid === process.pid)
    expect(self?.parentPid).toBe(process.ppid)
    expect(self?.commandLine).toContain('node')
    expect(snapshot.durationMs).toBeGreaterThan(0)
  })
})

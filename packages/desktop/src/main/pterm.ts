import type { BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { wslDistroOf, type DetectedShell } from '@helm/core'
import { getSession, killSession, spawnSession } from './pty'

/**
 * Project shells: a plain terminal per project, opened in that project's
 * directory and shown under the project pane.
 *
 * Deliberately not a session. A hosted `claude` gets a database row, an exit
 * notification and a place in history; a shell for `git status` and `pnpm dev`
 * is furniture, and recording it would put noise in every surface that reads
 * sessions. It rides the same pty registry (`spawnSession`), so app shutdown
 * tree-kills shells exactly the way it kills sessions - but under `shell:` ids
 * the session host never sees.
 *
 * One shell per project path: reopening a project tab reattaches to the shell
 * it already had rather than stacking processes.
 *
 * Which executable that is has three sources, in order: what the pane asked for
 * (its own picker), the `terminalShell` setting, and failing both, detection.
 * Only the last of those is memoised, and it is the only one that is a fact
 * about the machine rather than a choice someone made - so a settings change
 * takes effect on the next shell opened, with no restart.
 */

interface ShellRecord {
  id: number
  path: string
  shell: string
  cols: number
  rows: number
  /**
   * The grid the pty was opened at - the renderer's pre-spawn estimate, before
   * any pane had measured itself. Kept because it is the only record of it:
   * the first fit overwrites `cols`/`rows` within a frame, and "the estimate
   * lands within a column of the fit" is a claim about the difference.
   */
  opened: { cols: number; rows: number }
}

export interface OpenShellRequest {
  path: string
  cols: number
  rows: number
  /** This pane only. Absent means the default shell. */
  shell?: string | null | undefined
}

export interface OpenedShell {
  id: number
  /** The executable actually running. */
  shell: string
  /** What was asked for, when that is not what runs. Null when they agree. */
  requested: string | null
  /** Why. Null when nothing went wrong. */
  problem: string | null
}

export interface PtermHost {
  open: (request: OpenShellRequest) => OpenedShell
  input: (id: number, data: string) => void
  resize: (id: number, cols: number, rows: number) => void
  close: (id: number) => void
  /** The grid the pane last reported, which is what the pty is actually at. */
  grid: (id: number) => { cols: number; rows: number } | null
  /** Open shells, for a driver to check what is running where. */
  list: () => Array<{
    id: number
    path: string
    shell: string
    grid: { cols: number; rows: number }
    opened: { cols: number; rows: number }
  }>
  /** Shells found on this machine, for the pickers. */
  detected: () => DetectedShell[]
}

// ---------------------------------------------------------------------------
// Which shells this machine has
// ---------------------------------------------------------------------------

/**
 * The shells Helm knows how to launch, and the arguments each one wants.
 *
 * Keyed by **file name**, not by substring of the whole path. The substring
 * test this replaces asked whether the executable's path contained `powershell`
 * or `pwsh`, which is true of `C:\pwsh-tools\bin\bash.exe` - and `bash -NoLogo`
 * does not start a shell, it prints a usage error and exits.
 *
 * `cmd.exe` has no quiet flag; its two-line banner is unavoidable. The POSIX
 * shells are launched **without** `-l`: a login shell sources a profile, and
 * under Git for Windows that profile changes directory to `$HOME` unless
 * `CHERE_INVOKING` is set - which would defeat the one thing a project shell is
 * for.
 */
const KNOWN_SHELLS: Array<{
  file: string
  label: string
  args: string[]
  /**
   * Absolute locations to look in as well as `PATH`. See `pwshLocations` below
   * for why `where.exe` alone is not enough to conclude a shell is absent.
   */
  installed?: () => string[]
}> = [
  // The banner is three lines of chrome in a pane that is deliberately short.
  { file: 'pwsh.exe', label: 'PowerShell 7', args: ['-NoLogo'], installed: pwshLocations },
  { file: 'powershell.exe', label: 'Windows PowerShell', args: ['-NoLogo'] },
  { file: 'cmd.exe', label: 'Command Prompt', args: [] },
  { file: 'wsl.exe', label: 'WSL', args: [] },
  { file: 'bash.exe', label: 'Bash', args: [], installed: gitBashLocations },
  { file: 'bash', label: 'Bash', args: [] },
  { file: 'zsh', label: 'Zsh', args: [] },
  { file: 'fish', label: 'Fish', args: [] },
  { file: 'sh', label: 'Shell', args: [] }
]

/**
 * `existsSync`, for a path that may be a Windows **app-execution alias**.
 *
 * `existsSync` is a `stat`, and `stat` follows reparse points. The launcher
 * stubs the Store installs under `%LOCALAPPDATA%\Microsoft\WindowsApps` are a
 * reparse point of a kind it cannot follow: Windows answers **EACCES**, and
 * `existsSync` turns that into `false`. Measured here - `statSync` throws
 * EACCES on the pwsh stub, `lstatSync` reports an 85-byte link, `accessSync`
 * succeeds, and `node-pty` spawns it and gets PowerShell 7.6.4 - so the file is
 * present, launchable, and invisible to the obvious test.
 *
 * `lstat` does not follow the reparse point, which makes it the right question
 * anyway: this asks whether the entry is there, not what is on the other end.
 */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * PowerShell 7 installations, wherever this machine put one.
 *
 * Measured on the machine this was reported from: PowerShell 7.6.4 was
 * installed from the Store, `where.exe pwsh.exe` found nothing, and Helm
 * concluded the machine had no PowerShell 7 and opened Windows PowerShell 5.1
 * instead. Two things have to be true at once for that, and both are ordinary:
 * the Store build puts its launcher in `%LOCALAPPDATA%\Microsoft\WindowsApps`,
 * which was not on `PATH` at all, and an *older* package directory left behind
 * by a previous version still was - pointing at a directory that no longer
 * exists. So `PATH` carried a dead pwsh entry and no live one.
 *
 * The visible symptom is not "the picker is missing a row". 5.1 and 7 read
 * *different* profiles - `Documents\WindowsPowerShell\` against
 * `Documents\PowerShell\` - so a user whose prompt, aliases and functions are
 * set up in the 7 profile gets a shell with none of them and no indication why.
 *
 * MSI installs first and newest major first, because that is the one a person
 * who has both would mean; the Store launcher last, as it is a stub that
 * resolves to whatever package is currently registered.
 */
function pwshLocations(): string[] {
  const found: string[] = []
  const bases = [
    process.env['ProgramW6432'],
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)']
  ]
  for (const base of bases) {
    if (base === undefined || base === '') continue
    const root = join(base, 'PowerShell')
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    const majors = entries.filter((e) => /^\d+$/.test(e)).sort((a, b) => Number(b) - Number(a))
    for (const major of majors) {
      const exe = join(root, major, 'pwsh.exe')
      if (present(exe)) found.push(exe)
    }
  }
  const local = process.env['LOCALAPPDATA']
  if (local !== undefined && local !== '') {
    const alias = join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe')
    if (present(alias)) found.push(alias)
  }
  return found
}

/**
 * Git for Windows' bash, which is what `bash.exe` means on a Windows machine
 * that has one. Git puts `cmd\` on `PATH` and not `bin\`, so `where.exe
 * bash.exe` misses it on a default install unless something else added it.
 */
function gitBashLocations(): string[] {
  const found: string[] = []
  for (const base of [process.env['ProgramW6432'], process.env['ProgramFiles']]) {
    if (base === undefined || base === '') continue
    const exe = join(base, 'Git', 'bin', 'bash.exe')
    if (present(exe)) found.push(exe)
  }
  return found
}

function known(file: string): { file: string; label: string; args: string[] } | undefined {
  const name = basename(file).toLowerCase()
  return KNOWN_SHELLS.find((entry) => entry.file === name)
}

/** The arguments to launch `file` with. Unknown shells get none. */
export function shellArgs(file: string): string[] {
  return known(file)?.args ?? []
}

/** `where.exe <name>`, first hit only. Absolute, which is what gets stored. */
function whereIs(name: string): string | null {
  try {
    const out = execFileSync('where.exe', [name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000
    })
    const first = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '')
    return first ?? null
  } catch {
    return null
  }
}

let detectedShells: DetectedShell[] | null = null

/**
 * Every known shell this machine actually has.
 *
 * `PATH` first, then the locations an installer is known to use. `where.exe` is
 * the better answer when it has one - it is what the user's own terminal would
 * resolve - but a miss from it is not evidence of absence: it answers about
 * `PATH`, and `PATH` is a list somebody's installers have been appending to for
 * years. See `pwshLocations` for the install this got wrong, and for why the
 * consequence was a shell with the wrong profile rather than a missing row.
 *
 * Memoised: `where.exe` five times is a hundred milliseconds, and the answer is
 * a property of the installation rather than of the app's state. Nothing a user
 * can change in Helm changes it.
 */
export function detectShells(): DetectedShell[] {
  if (detectedShells !== null) return detectedShells

  const found: DetectedShell[] = []
  if (process.platform === 'win32') {
    for (const entry of KNOWN_SHELLS) {
      if (!entry.file.endsWith('.exe')) continue
      const onPath = whereIs(entry.file)
      // One row per shell: the picker names executables, and two rows reading
      // `pwsh.exe` differing only in a path the header truncates is a choice
      // nobody can make. `PATH` wins because it is what `pwsh` already means in
      // this user's own terminal.
      const path = onPath ?? entry.installed?.()[0] ?? null
      if (path === null) continue
      found.push({ path, name: basename(path), label: entry.label, args: entry.args })
    }
  } else {
    const fromEnv = process.env['SHELL']
    const candidates = [fromEnv, '/bin/bash', '/bin/zsh', '/bin/sh'].filter(
      (candidate): candidate is string => candidate !== undefined && candidate !== ''
    )
    for (const candidate of candidates) {
      if (found.some((entry) => entry.path === candidate)) continue
      const entry = known(candidate)
      found.push({
        path: candidate,
        name: basename(candidate),
        label: entry?.label ?? basename(candidate),
        args: entry?.args ?? []
      })
    }
  }
  detectedShells = found
  return found
}

/** The shell to use when nothing has been chosen. */
function autoShell(): string {
  const found = detectShells()
  if (found.length > 0) return found[0]?.path ?? 'powershell.exe'
  // Nothing was found, which on Windows means `where.exe` itself failed. The
  // guaranteed-present fallbacks are better than refusing to open a shell.
  return process.platform === 'win32' ? 'powershell.exe' : (process.env['SHELL'] ?? 'bash')
}

/** Every other shell to try, in detection order, when `wanted` will not start. */
function alternativesTo(wanted: string): string[] {
  const seen = new Set([wanted.toLowerCase()])
  const out: string[] = []
  for (const candidate of [...detectShells().map((entry) => entry.path), autoShell()]) {
    const key = candidate.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
  }
  return out
}

export interface PtermDeps {
  window: () => BrowserWindow | null
  /**
   * The `terminalShell` setting, read at every open rather than captured.
   * Reading it once would make the choice a property of when Helm started.
   */
  defaultShell: () => string | null
}

export function createPtermHost(deps: PtermDeps): PtermHost {
  let nextId = 1
  const byId = new Map<number, ShellRecord>()
  const byPath = new Map<string, ShellRecord>()

  const drop = (record: ShellRecord): void => {
    byId.delete(record.id)
    if (byPath.get(record.path.toLowerCase()) === record) {
      byPath.delete(record.path.toLowerCase())
    }
  }

  /**
   * How to open a shell *in* a folder, which is not the same question for every
   * folder.
   *
   * A project inside a WSL distribution is served by that distribution's own
   * login shell, for the same reason its sessions run that distribution's
   * `claude`: the folder is Linux, and the tools somebody wants their hands on
   * there are Linux ones. PowerShell in `\\wsl$\Ubuntu\home\me\thing` would be
   * the wrong shell even if it started - and it does not start, because
   * `CreateProcess` refuses a UNC working directory outright. So the pane was
   * offering a terminal that could only fail.
   *
   * `--cd` takes the Windows spelling and translates it itself, so the path
   * needs no translation here; what does need care is `cwd`, which is where
   * *this* process starts `wsl.exe` and therefore may not be the UNC path. The
   * home directory, exactly as `sessions.ts` does it.
   */
  const shellPlan = (file: string, request: OpenShellRequest): { file: string; args: string[]; cwd: string } => {
    const distro = wslDistroOf(request.path)
    if (distro === null) return { file, args: shellArgs(file), cwd: request.path }
    return { file: 'wsl.exe', args: ['-d', distro, '--cd', request.path], cwd: homedir() }
  }

  const start = (id: number, file: string, request: OpenShellRequest): void => {
    const plan = shellPlan(file, request)
    spawnSession({
      id: `shell:${String(id)}`,
      file: plan.file,
      args: plan.args,
      cols: request.cols,
      rows: request.rows,
      cwd: plan.cwd,
      onData: (chunk) => {
        const win = deps.window()
        if (win && !win.isDestroyed()) win.webContents.send('pterm:data', { id, data: chunk })
      },
      onExit: (exitCode) => {
        const record = byId.get(id)
        if (record) drop(record)
        const win = deps.window()
        if (win && !win.isDestroyed()) win.webContents.send('pterm:exit', { id, exitCode })
      }
    })
  }

  return {
    open: (request) => {
      const existing = byPath.get(request.path.toLowerCase())
      if (existing) {
        return { id: existing.id, shell: existing.shell, requested: null, problem: null }
      }

      /*
       * The shell setting is a *Windows* shell, so it does not decide this for
       * a folder inside a distribution - the distro's own login shell does, and
       * `wsl.exe` with no command is how you ask for it. Recorded as `wsl.exe`
       * so the pane names what is actually running rather than the PowerShell
       * nobody started.
       */
      const distro = wslDistroOf(request.path)
      const wanted =
        distro !== null ? 'wsl.exe' : (request.shell ?? deps.defaultShell() ?? autoShell())
      const id = nextId++

      let shell = wanted
      let requested: string | null = null
      let problem: string | null = null
      try {
        start(id, wanted, request)
      } catch (err) {
        // A shell that will not spawn - uninstalled since it was picked, or
        // renamed - must not leave the project pane with an empty box and no
        // explanation. Fall through the other shells this machine has and say
        // what happened.
        //
        // The whole list rather than `autoShell()` alone, because the one that
        // just failed can *be* what `autoShell()` answers: detection is
        // memoised at first use, so a shell that goes away while Helm is open
        // is still in it. Trying it again and rethrowing left the pane with the
        // empty box this branch exists to prevent.
        // No alternatives inside a distribution. Every candidate here is a
        // Windows shell and the working directory is a UNC path, so each one
        // would fail the same way - and a "we fell back to PowerShell" notice
        // over a Linux folder would be describing a shell nobody could use.
        if (distro !== null) throw err
        const started = alternativesTo(wanted).find((candidate) => {
          try {
            start(id, candidate, request)
            return true
          } catch {
            return false
          }
        })
        if (started === undefined) throw err
        shell = started
        requested = wanted
        problem = err instanceof Error ? err.message : String(err)
      }

      const record: ShellRecord = {
        id,
        path: request.path,
        shell,
        cols: request.cols,
        rows: request.rows,
        opened: { cols: request.cols, rows: request.rows }
      }
      byId.set(id, record)
      byPath.set(request.path.toLowerCase(), record)
      return { id, shell, requested, problem }
    },

    input: (id, data) => getSession(`shell:${String(id)}`)?.write(data),

    resize: (id, cols, rows) => {
      const record = byId.get(id)
      if (record) {
        record.cols = cols
        record.rows = rows
      }
      getSession(`shell:${String(id)}`)?.resize(cols, rows)
    },

    close: (id) => {
      const record = byId.get(id)
      if (!record) return
      drop(record)
      killSession(`shell:${String(id)}`)
    },

    grid: (id) => {
      const record = byId.get(id)
      return record ? { cols: record.cols, rows: record.rows } : null
    },

    list: () =>
      [...byId.values()].map((record) => ({
        id: record.id,
        path: record.path,
        shell: record.shell,
        grid: { cols: record.cols, rows: record.rows },
        opened: { ...record.opened }
      })),

    detected: () => detectShells()
  }
}

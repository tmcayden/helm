import { execFile } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { readWslConfig, setNetworkingMode } from '@helm/core'
import type {
  WslNetworkingMode,
  WslNetworkingState,
  WslNetworkingWriteResult
} from '@helm/core/types'

const run = promisify(execFile)

/**
 * The one change Helm offers to make to `%USERPROFILE%\.wslconfig`.
 *
 * Why it exists: measured 2026-09-02 and recorded in SPEC 4.8, a WSL2 distro on
 * the default NAT networking mode cannot reach Helm's loopback endpoint at all
 * - not on `127.0.0.1`, which only mirrors under `networkingMode=mirrored`, and
 * not on the gateway, because the server binds loopback only and that rule is
 * not being loosened (CLAUDE.md, "The agent tools"). So a session hosted in a
 * distro launches with no `--mcp-config` and no tools, and
 * `unreachableEndpointNote` in `wsl.ts` prints the fix. This module is that
 * sentence made pressable.
 *
 * Four rules, and each is a thing that only shows up when it is broken.
 *
 * - **It is a Settings action, not a profile field and not an install step.**
 *   `networkingMode` is in one file in the user's profile and applies to *every*
 *   distribution and every WSL process on the machine, so a per-profile control
 *   would imply a scope it does not have. And writing the file during install,
 *   before the user has any context for it, is Helm changing a file it does not
 *   own without being asked - the opposite of the warn-and-name-the-fix posture
 *   SPEC 7 pins everywhere else.
 * - **Nothing already in the file is lost.** The parse and the rewrite are pure
 *   and live in `core/wsl/wslconfig.ts` with the unit tests; a file that cannot
 *   be read with confidence is reported and left alone. See that file's header.
 * - **Every write leaves a way back.** A timestamped copy goes down beside the
 *   file *before* it is touched, and a failure to take it aborts the write -
 *   the same order and the same guarantee as the config console's snapshot
 *   (`writeConfigFile`: nothing is written until the previous bytes are safe).
 *   Timestamped rather than a single `.wslconfig.bak`, because a second change
 *   must not overwrite the copy of what the user originally had.
 * - **`wsl --shutdown` is never a side effect of the write.** It terminates
 *   every running WSL process on the machine - somebody's editor, their server,
 *   their build, and any Claude Code session running in a distro. So the write
 *   says the change takes effect after WSL restarts, and restarting it is a
 *   separate action the user confirms in a dialog that names what it ends.
 */

/** Where `wsl.exe` lives. Under `System32`, so PATH is enough. */
const WSL = 'wsl.exe'

/**
 * The file, in the spelling the sentence in `unreachableEndpointNote` uses.
 *
 * `USERPROFILE` first and `homedir()` as the fallback: WSL reads the file from
 * the profile directory Windows reports, and `homedir()` derives the same
 * answer from the same place. The variable is preferred only so that what Helm
 * shows and what the platform reads are one string on the machines where they
 * could differ.
 */
export function wslConfigPath(): string {
  const profile = process.env['USERPROFILE']
  return join(profile !== undefined && profile !== '' ? profile : homedir(), '.wslconfig')
}

/** The file's bytes, or what went wrong reading them. */
function read(path: string): { text: string; exists: boolean; error: string | null } {
  try {
    return { text: readFileSync(path, 'utf8'), exists: true, error: null }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // No file is the ordinary answer on a machine nobody has configured WSL on,
    // and it is not an error: it means the platform defaults are in force.
    if (code === 'ENOENT') return { text: '', exists: false, error: null }
    return {
      text: '',
      exists: true,
      error: `Helm could not read ${path}: ${String((err as Error).message)}`
    }
  }
}

/**
 * What the file says now.
 *
 * Never says anything about reachability. Whether a distro can open a socket to
 * the endpoint is `describeWslDistro`'s question, answered by a connect, and
 * the two facts are deliberately not merged: a file reading `mirrored` while
 * WSL has not restarted is the state a user most needs to be shown, and one
 * verdict over both would hide it.
 */
export function readWslNetworking(): WslNetworkingState {
  const path = wslConfigPath()
  const file = read(path)
  if (file.error !== null) {
    return {
      path,
      exists: file.exists,
      networkingMode: null,
      hasWsl2Section: false,
      refusal: file.error
    }
  }
  return { path, exists: file.exists, ...readWslConfig(file.text) }
}

/**
 * Sets `networkingMode` under `[wsl2]`, having copied the file first.
 *
 * Returns rather than throws for every outcome a user causes - a file too odd
 * to touch, a file that already says this - because both are things the pane
 * has to *show*, and an exception crossing IPC arrives as a string with no
 * state on it (the reason `writeSnapshottedFile` returns too).
 */
export function setWslNetworking(mode: WslNetworkingMode): WslNetworkingWriteResult {
  const path = wslConfigPath()
  const file = read(path)
  const failed = (error: string): WslNetworkingWriteResult => ({
    ok: false,
    state: readWslNetworking(),
    backupPath: null,
    unchanged: false,
    error
  })

  if (file.error !== null) return failed(file.error)

  const edit = setNetworkingMode(file.text, mode)
  if (!edit.ok) return failed(edit.problem)
  if (!edit.changed) {
    return { ok: true, state: readWslNetworking(), backupPath: null, unchanged: true, error: null }
  }

  // The backup goes down first and its failure aborts the write, so "every
  // change to this file has a copy of what was there" holds even when the write
  // then fails. Nothing to copy for a file that does not exist yet - the way
  // back from creating one is deleting it.
  let backupPath: string | null = null
  if (file.exists) {
    backupPath = `${path}.${stamp()}.helm.bak`
    try {
      copyFileSync(path, backupPath)
    } catch (err) {
      return failed(
        `Helm did not change ${path}: it could not first copy it to ${backupPath} ` +
          `(${String((err as Error).message)}).`
      )
    }
  }

  try {
    writeFileSync(path, edit.text, 'utf8')
  } catch (err) {
    return failed(`Helm could not write ${path}: ${String((err as Error).message)}`)
  }

  return { ok: true, state: readWslNetworking(), backupPath, unchanged: false, error: null }
}

/**
 * `20260903-090812`. Sortable, second-resolution, no characters Windows
 * refuses in a filename - which rules out the colons in an ISO timestamp.
 */
function stamp(): string {
  const iso = new Date().toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

/**
 * Restarts WSL, which is to say ends every WSL process on this machine.
 *
 * **Never called as part of a write.** It is a separate channel because it is a
 * separate act with a cost nothing in Helm can see the extent of: other
 * people's editors, servers and builds inside any distribution, and any Claude
 * Code session running in one - including sessions this Helm is hosting on a
 * WSL target. The renderer's confirmation names that before the call is made,
 * and the same reasoning is why nothing here checks first and proceeds anyway:
 * a survey of what is running would be a claim, and the user's answer is not
 * Helm's to infer.
 */
export async function shutdownWsl(): Promise<{ ok: boolean; error: string | null }> {
  try {
    await run(WSL, ['--shutdown'], { timeout: 60_000, windowsHide: true })
    return { ok: true, error: null }
  } catch (err) {
    // A machine with no WSL at all lands here, and so does a shutdown that
    // timed out. Both are a sentence rather than a throw: the caller asked a
    // question whose "no" is an ordinary answer.
    return { ok: false, error: `\`wsl --shutdown\` failed: ${String((err as Error).message)}` }
  }
}

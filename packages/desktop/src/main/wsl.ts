import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { wslHomeOf } from '@helm/core'
import type { WslDistro, WslHome, WslProbe } from '@helm/core/types'
import type { ClaudeCommand } from './claude-cli'

const run = promisify(execFile)

/**
 * Hosting a session inside a WSL distribution.
 *
 * Helm stays a Windows process throughout. What changes for a WSL target is
 * only which program the pty opens - `wsl.exe`, with the distro's own `claude`
 * behind `--` - and the spelling of the paths on its argv, which
 * `core/wsl/path.ts` translates. Everything downstream is unchanged: the pty is
 * a pty, the row is a row, and teardown is the same `treeKill`.
 *
 * Four things were measured on 2026-09-02 before any of this was written, and
 * each one is why a piece of it looks the way it does.
 *
 * - **A Windows junction resolves inside the distro**, surfacing as a symlink
 *   whose target is already translated to `/mnt/c/...`. So the overlay shims
 *   (SPEC 2) cross the boundary with no second implementation, and nothing in
 *   `launch/overlay.ts` needed to know about any of this.
 * - **Killing `wsl.exe` reaps the Linux process.** CLAUDE.md's "the main
 *   process owns process lifetime" therefore still holds through the relay, and
 *   session teardown needed no WSL-specific path.
 * - **`wsl.exe --cd` accepts a Windows path** and translates it itself, which
 *   is why the plan's `cwd` stays in Windows spelling while its argv does not.
 * - **The loopback endpoint is not reachable from a distro** under the default
 *   NAT networking mode - not on `127.0.0.1`, which only mirrors under
 *   `networkingMode=mirrored`, and not on the gateway, because the server binds
 *   loopback only and that rule is not being loosened (SPEC 5). So the tools
 *   are offered only where a probe says they would work, and the launch says
 *   what to change when they would not.
 */

/** Where `wsl.exe` lives. Under `System32`, so PATH is enough. */
const WSL = 'wsl.exe'

/**
 * `wsl.exe` writes **UTF-16LE** on its own streams, so its output has to be
 * decoded rather than read as text.
 *
 * This is the detail that makes a naive `wsl -l -v` parse return one distro
 * whose name is `U`, or none at all: read as UTF-8 every character is followed
 * by a NUL. `encoding: 'buffer'` and an explicit decode is the whole fix, and
 * it applies to the listing only - anything run *inside* the distro is the
 * Linux program's own output and is ordinary UTF-8.
 */
function decodeWslOutput(buffer: Buffer): string {
  const text = buffer.toString('utf16le')
  // A BOM, when there is one, would otherwise become the first character of
  // the first distro's name. Tested by code point rather than stripped with a
  // regex, because a literal BOM in this file is invisible to whoever reads it
  // next and `no-irregular-whitespace` refuses one anyway.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * The distributions this machine has.
 *
 * `--list --verbose` rather than the quiet form because the state and version
 * are worth having, and because the quiet form's output is just as UTF-16 and
 * saves nothing. An empty list is the ordinary answer on a machine with no WSL
 * and is not an error: `wsl.exe` is absent, or exits non-zero saying nothing is
 * installed, and both mean the same thing to every caller.
 *
 * Version 1 distros are listed like any other. They run the same CLI the same
 * way; what they do not have is the WSL2 network stack, which only ever makes
 * the endpoint probe below answer differently.
 */
export async function listWslDistros(): Promise<WslDistro[]> {
  let text: string
  try {
    const { stdout } = await run(WSL, ['--list', '--verbose'], {
      encoding: 'buffer',
      timeout: 10_000,
      windowsHide: true
    })
    text = decodeWslOutput(stdout)
  } catch {
    return []
  }

  const distros: WslDistro[] = []
  // The header row is localised, so it is skipped by shape rather than by
  // matching "NAME": a data row always has a name, a state and an integer
  // version, and the header's third column never parses as one.
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const isDefault = trimmed.startsWith('*')
    const columns = trimmed.replace(/^\*\s*/, '').split(/\s+/)
    if (columns.length < 3) continue
    const name = columns[0] ?? ''
    const state = columns[1] ?? ''
    const version = Number.parseInt(columns[2] ?? '', 10)
    if (name === '' || !Number.isFinite(version)) continue
    distros.push({ name, state, version, isDefault })
  }
  return distros
}

/**
 * Runs one command inside a distro and returns what it printed.
 *
 * A **login** shell, because that is where a user's `~/.local/bin` gets onto
 * PATH - measured on this machine, where `claude` is at
 * `$HOME/.local/bin/claude` and a non-login shell cannot see it. Null rather
 * than a throw for every failure: every caller here is asking a question whose
 * "no" is an ordinary answer.
 */
async function inDistro(distro: string, script: string): Promise<string | null> {
  try {
    const { stdout } = await run(WSL, ['-d', distro, '--', 'bash', '-lc', script], {
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    })
    return stdout.toString().trim()
  } catch {
    return null
  }
}

/**
 * What Helm found inside one distro.
 *
 * The same posture SPEC 7 pins for the Windows CLI - assert, warn, do not
 * block. A distro with no `claude` is a row that says so and a launch that
 * explains itself, never a silent failure at spawn time.
 *
 * `port` is Helm's own endpoint, and passing null skips the reachability probe
 * entirely - which is what a caller with both tool settings off should do,
 * since there is then nothing to be reachable.
 */
export async function probeWslDistro(distro: string, port: number | null): Promise<WslProbe> {
  // One round trip for the three facts about the distro. Three `wsl.exe`
  // invocations would be three cold starts of the relay, and they are ~200ms
  // each on this machine.
  const answer = await inDistro(
    distro,
    'echo "$HOME"; command -v claude || true; claude --version 2>/dev/null || true'
  )
  if (answer === null) {
    return {
      distro,
      claudePath: null,
      claudeVersion: null,
      home: null,
      endpointReachable: false,
      problem: `${distro} did not answer. It may not be installed, or it may have failed to start.`
    }
  }

  const [home = '', claudePath = '', claudeVersion = ''] = answer.split(/\r?\n/)
  const endpointReachable = port === null ? false : await probeEndpoint(distro, port)

  return {
    distro,
    claudePath: claudePath.trim() === '' ? null : claudePath.trim(),
    claudeVersion: claudeVersion.trim() === '' ? null : claudeVersion.trim(),
    home: home.trim() === '' ? null : home.trim(),
    endpointReachable,
    problem:
      claudePath.trim() === ''
        ? `No \`claude\` inside ${distro}. Install Claude Code there - a session runs that distribution's own CLI, not this machine's.`
        : null
  }
}

/**
 * Probes, memoised for the run.
 *
 * Every fact a probe reads is a property of the installation rather than of
 * Helm's state - where `claude` is, what it prints, whether this machine's
 * networking mode shares loopback - and none of them can change without
 * something outside Helm changing first. Launching three sessions into one
 * distro should not be three `wsl.exe` cold starts, which are ~200ms each here.
 *
 * The same reasoning `detectShells` memoises on, and it has the same escape
 * hatch: `forgetWslProbes` for the case where the user has just been told to
 * change `.wslconfig` and wants to be asked again without restarting Helm.
 */
const probes = new Map<string, Promise<WslProbe>>()

/** The probe for a distro, asked once per run. */
export function describeWslDistro(distro: string, port: number | null): Promise<WslProbe> {
  const key = `${distro.toLowerCase()}#${String(port ?? 'none')}`
  const held = probes.get(key)
  if (held !== undefined) return held
  const fresh = probeWslDistro(distro, port)
  probes.set(key, fresh)
  return fresh
}

/** Ask again - after a `.wslconfig` change, or a distro being installed. */
export function forgetWslProbes(): void {
  probes.clear()
  homes = null
}

/**
 * Every distribution's `~/.claude`, as paths this process can open.
 *
 * The list the config console, the history index and the usage index all build
 * on: a distro-hosted session writes its settings, skills, prompts and
 * transcripts into the distro's own `~/.claude`, and none of that is in the one
 * on this machine. `wslHomeOf` turns a probe's `$HOME` into
 * `\\wsl$\<distro>\home\me\.claude`, which is an ordinary directory to
 * `readdirSync` - so the readers needed a second path, not a second
 * implementation.
 *
 * `port` is null throughout. These callers want the home, and the endpoint
 * probe is a two-second connect attempt per distro that would be paid on
 * startup for an answer only the launcher uses. Passing null skips it, and
 * `describeWslDistro` keys its cache on the port, so the launcher's own probe
 * is still asked and cached separately.
 *
 * Distros with no answer are absent rather than present-and-empty: a guessed
 * home would be a scope browsing a directory that is not there.
 *
 * **Empty when `CLAUDE_CONFIG_DIR` is set**, and that rule is here rather than
 * at the four call sites so that every reader of a `.claude` tree obeys it or
 * none does. The variable says which tree this machine's CLI reads, and a
 * process told to read one tree has no business also reading the ones inside
 * every distribution - trees that variable cannot move, because it is this
 * machine's environment and the distro's CLI has never seen it (`core/wsl/home.ts`).
 *
 * Found by `pnpm transcript-check` on 2026-09-03, which is pointed at a fixture
 * tree with the real variable rather than with `--claude-home`. The fan-out in
 * `index.ts` was gated on the flag only, so it widened the archive to the
 * developer's real Ubuntu underneath a driver isolated from everything else:
 * 123 real conversations arrived in the middle of a bounded-storage probe, and
 * T-4 failed for a reason that had nothing to do with eviction. The comment on
 * that gate already stated this rule - "a check pointed at a fixture tree must
 * not reach into the developer's real distributions" - and named only one of
 * the two ways a check does the pointing.
 */
let homes: Promise<WslHome[]> | null = null

export function wslHomes(): Promise<WslHome[]> {
  homes ??= (async () => {
    const pointedElsewhere = process.env['CLAUDE_CONFIG_DIR']
    if (pointedElsewhere !== undefined && pointedElsewhere.trim() !== '') return []
    const distros = await listWslDistros()
    const probed = await Promise.all(
      distros.map(async (distro) => {
        const probe = await describeWslDistro(distro.name, null)
        return wslHomeOf(distro.name, probe.home)
      })
    )
    return probed.filter((home): home is WslHome => home !== null)
  })()
  return homes
}

/**
 * Whether the distro can open a socket to Helm's endpoint.
 *
 * Measured rather than inferred from the networking mode. Reading `.wslconfig`
 * would be Helm deciding what a file it does not own means, and the file is
 * absent on the machine where the answer is "no" - so absence would have to be
 * read as a verdict. A connect either works or it does not.
 *
 * `/dev/tcp` rather than `curl` or `nc`, neither of which a minimal distro is
 * guaranteed to have. It is a bash builtin, and bash is what the launch already
 * needs. Two seconds is generous for a loopback connect and short enough that a
 * launch is not held up by a machine where the answer is no.
 */
async function probeEndpoint(distro: string, port: number): Promise<boolean> {
  const answer = await inDistro(
    distro,
    `timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${String(port)}' 2>/dev/null && echo reachable || echo no`
  )
  return answer === 'reachable'
}

/**
 * The sentence shown when a WSL session cannot have Helm's own tools.
 *
 * Names the change and where to make it, because "the tools are off" with no
 * reason is the thing this whole probe exists to avoid. It is a change to the
 * user's machine and not to Helm - the endpoint stays loopback-bound, which is
 * the rule in `browser-mcp.ts` and the network posture in SPEC 5.
 */
export function unreachableEndpointNote(distro: string): string {
  return (
    `${distro} cannot reach Helm's endpoint, so this session gets no browser or session tools. ` +
    'WSL only shares this machine’s loopback under mirrored networking: turn it on ' +
    'in Settings › WSL, or put `[wsl2]` and `networkingMode=mirrored` in ' +
    '`%USERPROFILE%\\.wslconfig` yourself. Either way it takes effect after WSL restarts.'
  )
}

/**
 * How to spawn `claude` inside a distro.
 *
 * The same `ClaudeCommand` shape a Windows launch produces, so every caller -
 * the session host, the version read, the disclosure sentence - is unchanged.
 *
 * `--cd` takes the **Windows** path and translates it itself (measured), which
 * is why the cwd is not translated here. `shim` is false: there is no `cmd.exe`
 * in this path, so nothing re-parses the command line and the argv stays an
 * array. That also means the pty's pid is `wsl.exe`'s rather than the CLI's -
 * the same position a `.cmd` shim leaves it in, and the reason the session
 * registry is joined on the conversation id rather than on that pid.
 */
export function wslClaudeCommand(
  distro: string,
  claudePath: string,
  cwd: string
): ClaudeCommand {
  return {
    file: WSL,
    prefixArgs: ['-d', distro, '--cd', cwd, '--', claudePath],
    resolved: claudePath,
    shim: false
  }
}

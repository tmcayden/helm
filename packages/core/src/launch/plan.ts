import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, win32 } from 'node:path'
import type {
  EffortLevel,
  LaunchPlan,
  LaunchTarget,
  PermissionMode,
  Profile
} from '../types'
import { launchTarget } from '../types'
import { toWslPath, wslDistroOf } from '../wsl/path'
import {
  composeOverlayMemory,
  MEMORY_PREFIX,
  planOverlays,
  syncOverlay,
  type OverlayPlan
} from './overlay'
import { writeSessionMcpConfig, type SessionMcpServer } from './mcp'
import { buildResumeArgs, sanitizeSessionName } from './session'

/**
 * A profile becomes argv.
 *
 * This is the whole product in one function: the composition SPEC 2 describes
 * is not expressible in the CLI without assembling these flags by hand every
 * time, and eliminating that ceremony is what Helm is for.
 */

export interface LaunchRequest {
  /** Working directory. Claude Code resolves `.claude/` config from it. */
  root: string
  /** Session display name, before uniquing. */
  name: string
  /** Project paths to compose as plugins. */
  overlays?: readonly string[] | undefined
  /** Project paths to grant tool access to. */
  access?: readonly string[] | undefined
  model?: string | null | undefined
  effort?: EffortLevel | null | undefined
  permissionMode?: PermissionMode | null | undefined
  agent?: string | null | undefined
  /** Submitted as the session's first message. */
  openingPrompt?: string | null | undefined
  /** Where synthesised overlay shims live. Owned by the host. */
  shimRoot: string
  /**
   * Helm's own MCP endpoint, registered for this session alone.
   *
   * Null - the ordinary case for anything that is not the app - passes no
   * `--mcp-config` at all, which is what both tool settings off produces and
   * what every launch looked like before the endpoint existed. `dir` is where
   * the ephemeral file goes and is the host's to supply for the same reason
   * `shimRoot` is: core does not know where this install keeps its data.
   *
   * A **list** of servers, because the one listener serves more than one family
   * of tools and each family has its own tick. An empty list is the same
   * outcome as null: no file, no flag.
   */
  mcp?: { dir: string; servers: readonly SessionMcpServer[] } | null | undefined
  /**
   * The conversation id to assign, or null to let the CLI pick its own.
   *
   * The host decides, because only the host knows whether the `claude` on this
   * machine has the flag at all - and a flag an older CLI does not recognise is
   * a launch that fails outright rather than a session missing a feature.
   */
  sessionId?: string | null | undefined
  /**
   * Where the CLI runs. Omitted or null means Windows, which is what every
   * caller meant before this existed.
   */
  target?: LaunchTarget | null | undefined
}

/**
 * Every path on the argv, in the spelling the process that reads it uses.
 *
 * A Windows target is the identity. A WSL target translates, and a path that
 * cannot be translated is **dropped with a warning** rather than passed
 * through: `--add-dir C:\work` inside a distro is a directory that does not
 * exist, and the CLI's own answer to that is worse than Helm's - it either
 * fails the launch or silently grants nothing. See `toWslPath` for which paths
 * are undecidable and why they are not guessed.
 *
 * `prepareLaunch` is not the only thing that assembles argv. A resume builds
 * its own - it must not borrow a model or an overlay set from anywhere - and
 * for a while that meant it skipped this too, which is what `prepareResume`
 * below exists to make impossible.
 */
function translatePaths(
  paths: readonly string[],
  target: LaunchTarget,
  warnings: string[],
  what: string
): string[] {
  if (target.kind === 'windows') return [...paths]
  const out: string[] = []
  for (const path of paths) {
    const translated = toWslPath(path, { distro: target.distro })
    if (translated === null) {
      warnings.push(`${what} skipped - ${path} has no path inside ${target.distro}.`)
      continue
    }
    out.push(translated)
  }
  return out
}

/** The launch shape of a stored profile. */
export function launchRequestFromProfile(
  profile: Profile,
  shimRoot: string,
  name?: string
): LaunchRequest {
  return {
    root: profile.root,
    name: name ?? profile.name,
    overlays: profile.overlays,
    access: profile.access,
    model: profile.model,
    effort: profile.effort,
    permissionMode: profile.permissionMode,
    agent: profile.agent,
    openingPrompt: profile.openingPrompt,
    shimRoot,
    target: profile.target
  }
}

/**
 * Argv after the executable.
 *
 * The order is not cosmetic. `--add-dir` is variadic - it consumes arguments
 * until the next one that starts with a dash - so anything positional placed
 * after it would be swallowed into the directory list. `-n` always follows it
 * and always exists, which terminates that list, and the opening prompt goes
 * last where the CLI expects a bare prompt.
 */
export function buildLaunchArgs(
  req: Omit<LaunchRequest, 'shimRoot'> & {
    /** Shim directories, already synthesised. */
    pluginDirs?: readonly string[] | undefined
    /** Composed project instructions, already written. */
    memoryFile?: string | null | undefined
    /** The ephemeral per-session MCP config, already written. */
    mcpConfigFile?: string | null | undefined
  }
): string[] {
  const argv: string[] = []

  // The target decides whether these are this machine's paths or the distro's,
  // and therefore whether `resolve` may touch them at all. See `dedupePaths`.
  const access = dedupePaths(req.access ?? [], req.target)
  if (access.length > 0) argv.push('--add-dir', ...access)

  argv.push('-n', sanitizeSessionName(req.name))

  for (const dir of req.pluginDirs ?? []) argv.push('--plugin-dir', dir)
  if (req.memoryFile) argv.push('--append-system-prompt-file', req.memoryFile)
  // One value, so it is safe anywhere after `-n` and before the positional
  // prompt. Assigning the conversation id rather than discovering it later is
  // what lets the session row and the CLI's live registry agree from the first
  // instant; see `SessionRecord.claudeSessionId`.
  if (req.sessionId) argv.push('--session-id', req.sessionId)
  // One value, so it is safe anywhere after `-n`. Here rather than at the end
  // because the opening prompt is positional and everything before it has to
  // be a flag with its argument.
  if (req.mcpConfigFile) argv.push('--mcp-config', req.mcpConfigFile)

  if (req.model) argv.push('--model', req.model)
  if (req.effort) argv.push('--effort', req.effort)
  if (req.permissionMode) argv.push('--permission-mode', req.permissionMode)
  if (req.agent) argv.push('--agent', req.agent)

  // Last, and only if it is really there: an empty string here would be a
  // positional argument the CLI reads as an empty prompt.
  const prompt = req.openingPrompt?.trim()
  if (prompt) argv.push(prompt)

  return argv
}

/**
 * Case-insensitively unique, order preserved.
 *
 * A profile that lists the same repo under `overlays` and `access` - which is
 * the normal case, since composing a repo's skills without granting its files
 * is rarely what anyone wants - would otherwise pass the same path twice.
 */
function dedupePaths(paths: readonly string[], target?: LaunchTarget | null | undefined): string[] {
  /*
   * A distro path is **never** resolved, and this is not a tidiness rule.
   *
   * `resolve` is `path.win32.resolve` in this process, and it reads a leading
   * `/` as "the root of the current drive" - so `resolve('/mnt/c/work')` on
   * Windows returns `C:\mnt\c\work`, silently un-translating a path that had
   * already been translated correctly. That is a `--add-dir` naming a
   * directory that does not exist on either side of the boundary.
   *
   * It was invisible on Linux, where `resolve` leaves such a path alone, and
   * the Windows test run is what caught it. A translated path is already
   * absolute and already normalised, so there is nothing for `resolve` to do
   * here anyway.
   */
  const translated = target != null && target.kind === 'wsl'
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    const abs = translated ? path : resolve(path)
    // Case-insensitively for Windows, whose paths are; exactly for a distro,
    // whose paths are not - `/home/me/Work` and `/home/me/work` are two
    // directories there, and folding them would drop one.
    const key = translated ? abs : abs.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(abs)
  }
  return out
}

/** Where a launch's composed instructions are written. */
function memoryFileFor(shimRoot: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'session'
  return join(shimRoot, `${MEMORY_PREFIX}${slug}.md`)
}

/**
 * Synthesises everything a composed session needs and returns the argv for it.
 *
 * Does the disk work - shims, the composed memory file - because all of it is a
 * pure function of the profile and none of it belongs to a window. The host
 * supplies `shimRoot` and spawns the result.
 */
export function prepareLaunch(req: LaunchRequest): LaunchPlan {
  const warnings: string[] = []
  const shimRoot = resolve(req.shimRoot)
  mkdirSync(shimRoot, { recursive: true })

  const overlayPaths = dedupePaths(req.overlays ?? []).filter((path) => {
    if (existsSync(path)) return true
    warnings.push(`Overlay skipped - ${path} is not there any more.`)
    return false
  })

  const plans: OverlayPlan[] = planOverlays(overlayPaths, shimRoot)
  const shims = plans.map((plan) => {
    if (plan.links.length === 0 && plan.claudeMdPath === null) {
      warnings.push(`${plan.projectPath} has no .claude/ directory and no CLAUDE.md to compose.`)
    }
    return syncOverlay(plan)
  })

  // Note there is no sweep of other shims here. A launch knows which shims it
  // needs and nothing about which ones another live session is still reading
  // out of, and a plugin directory removed underneath a running session takes
  // its skills with it. Sweeping is `cleanStaleShims`, at app start, where the
  // answer to "is anything using this" is reliably no.

  const memory = composeOverlayMemory(plans)
  let memoryFile: string | null = null
  if (memory !== null) {
    memoryFile = memoryFileFor(shimRoot, req.name)
    writeFileSync(memoryFile, memory)
  } else if (plans.length > 0) {
    warnings.push('No overlay had a CLAUDE.md, so no project instructions were composed.')
  }

  const access = dedupePaths(req.access ?? []).filter((path) => {
    if (existsSync(path)) return true
    warnings.push(`Access directory skipped - ${path} is not there any more.`)
    return false
  })

  /*
   * Helm's own endpoint, registered for this session and no other.
   *
   * Written here rather than by the host so that the file and the flag are
   * produced by the same call - a launch path that composed the argv in one
   * place and the file in another would have a state where one exists without
   * the other, and the failure would be a session holding a token for a file
   * that is not there.
   */
  let mcpConfigFile: string | null = null
  if (req.mcp) {
    try {
      mcpConfigFile = writeSessionMcpConfig(req.mcp.dir, req.mcp.servers)
    } catch (err) {
      // A session without Helm's tools is a working session. A launch that
      // failed because a JSON file could not be written is not.
      warnings.push(
        `Helm's own tools were not registered for this session: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  /*
   * The Windows→distro translation happens here and nowhere else.
   *
   * Deliberately after every write above: the shims, the composed memory file
   * and the MCP document are all created by *this* process, which is a Windows
   * process, so they are authored in Windows spelling and only the argv that
   * names them changes. Translating earlier would mean writing files to paths
   * this process cannot open.
   */
  /*
   * A project that lives inside a distro launches inside that distro, whatever
   * the profile says.
   *
   * Not a convenience. A Windows process cannot be spawned with a UNC working
   * directory - `CreateProcess` answers ENOENT, measured 2026-09-02 - so a
   * profile rooted at `\\wsl$\Ubuntu\...` on the Windows target does not
   * degrade, it fails to start with an error naming neither WSL nor the root.
   * Inferring is the difference between a working launch and an unexplainable
   * one, so the path wins over the setting.
   *
   * A profile naming a *different* distro is the one case worth a sentence: it
   * is a real contradiction rather than an unset field, and silently going with
   * the path would hide a profile somebody has to fix.
   */
  // A `\\wsl$\` root is a Windows path whatever host is planning, so it is
  // resolved as one; a posix `resolve` would prepend the working directory.
  const resident = wslDistroOf(req.root)
  const cwd = resident === null ? resolve(req.root) : win32.resolve(req.root)
  const chosen = launchTarget(req.target)
  let target = chosen
  if (resident !== null) {
    if (chosen.kind === 'wsl' && chosen.distro.toLowerCase() !== resident.toLowerCase()) {
      warnings.push(
        `${cwd} is inside ${resident}, so this session runs there rather than in ${chosen.distro}.`
      )
    }
    target = { kind: 'wsl', distro: resident }
  }
  const cwdForTarget = translatePaths([cwd], target, warnings, 'Working directory')[0] ?? null
  if (cwdForTarget === null) {
    // Everything else degrades to a warning; this one cannot. A session whose
    // working directory is wrong resolves the wrong `.claude/` tree, which is
    // the whole problem SPEC 1 exists to solve, and it would do it silently.
    warnings.push(`${cwd} has no path inside ${targetName(target)}, so the launch has no cwd.`)
  }

  const argv = buildLaunchArgs({
    root: cwdForTarget ?? cwd,
    name: req.name,
    // Carried through so `buildLaunchArgs` knows the paths below are already
    // the distro's and must not be resolved again.
    target,
    access: translatePaths(access, target, warnings, 'Access directory'),
    model: req.model,
    effort: req.effort,
    permissionMode: req.permissionMode,
    agent: req.agent,
    openingPrompt: req.openingPrompt,
    pluginDirs: translatePaths(
      shims.map((shim) => shim.dir),
      target,
      warnings,
      'Overlay'
    ),
    memoryFile: memoryFile === null ? null : (translatePaths([memoryFile], target, warnings, 'Project instructions')[0] ?? null),
    mcpConfigFile:
      mcpConfigFile === null
        ? null
        : (translatePaths([mcpConfigFile], target, warnings, "Helm's own tools")[0] ?? null),
    sessionId: req.sessionId
  })

  return {
    // The Windows path, always. This is what the pty is opened with and what
    // the session row records, and `wsl.exe --cd` accepts a Windows path and
    // translates it itself - measured 2026-09-02. The *argv* carries the
    // translated spelling because the CLI inside the distro reads those.
    cwd,
    name: sanitizeSessionName(req.name),
    argv,
    overlays: shims,
    memoryFile,
    mcpConfigFile,
    claudeSessionId: req.sessionId ?? null,
    target,
    warnings
  }
}

/** What to call a target in a sentence a user reads. */
function targetName(target: LaunchTarget): string {
  return target.kind === 'wsl' ? target.distro : 'Windows'
}

/**
 * The resume analogue of `prepareLaunch`, and it exists because there was not
 * one.
 *
 * A resume deliberately borrows nothing from `prepareLaunch` - no model, no
 * effort, no overlay set, no `-n`; the conversation was had under whatever it
 * was had under - so `resume()` assembled its own argv inline. What it borrowed
 * by omission was the path translation, and the one path a resume does carry is
 * `--mcp-config`. A resumed WSL session therefore received
 * `C:\Users\...\Helm\mcp\mcp-<pid>-<hex>.json`, whose backslashes the distro's
 * shell ate before resolving the remains against the cwd; the CLI then refused
 * to start at all, on a path nothing could have created. Measured 2026-09-03.
 *
 * So the translation lives beside `translatePaths` rather than at the call
 * site, and a resume gets a target for the same reason a launch does.
 *
 * A path that cannot be translated **drops the flag**, exactly as every other
 * path does. The session then resumes without Helm's tools, which is the same
 * degradation a WSL launch already takes when the endpoint is unreachable - and
 * strictly better than the flag reaching the CLI, which is not a session
 * missing a feature but a session that does not start.
 */
export function prepareResume(req: {
  /** The conversation id, as `history.jsonl` recorded it. */
  sessionId: string
  /** The ephemeral per-session MCP config, already written, Windows-spelled. */
  mcpConfigFile?: string | null | undefined
  /** Where the CLI runs. Omitted means Windows, as everywhere else. */
  target?: LaunchTarget | null | undefined
}): { argv: string[]; warnings: string[] } {
  const target = launchTarget(req.target)
  const warnings: string[] = []
  const mcpConfigFile =
    req.mcpConfigFile == null
      ? null
      : (translatePaths([req.mcpConfigFile], target, warnings, "Helm's own tools")[0] ?? null)
  return { argv: buildResumeArgs(req.sessionId, mcpConfigFile), warnings }
}

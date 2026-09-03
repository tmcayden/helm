import { join } from 'node:path'
import type { WslHome } from '../types'
import { isLinuxPath, toWindowsPath, wslDistroOf } from './path'

/**
 * A distribution's own `~/.claude`, reached without leaving the Windows process.
 *
 * This is the second half of the WSL work and the one that makes a distro a
 * place Helm *knows about* rather than only a place it can spawn into. A
 * distro-hosted session writes its prompts, transcripts, settings, skills and
 * session registry into that distro's `~/.claude`, and none of it is in the
 * `~/.claude` on this machine - so before this existed a WSL session launched
 * correctly and then vanished from history, usage and the config console.
 *
 * The mechanism is one line of `toWindowsPath`: `\\wsl$\<distro>\home\me\.claude`
 * is an ordinary directory to `readdirSync`, `statSync` and `writeFileSync`.
 * Measured 2026-09-02 against a live distro - a 1.2 MB `history.jsonl`, 100
 * project transcript directories, `settings.json`, `agents/`, `commands/` - and
 * reads and writes both land with the right ownership. So every reader in
 * `discovery/`, `usage/`, `config/` and `registry/` works unchanged over one;
 * what they needed was not a WSL implementation but a second **path**, which is
 * the whole of what this module produces.
 *
 * Two things it deliberately does not do. It does not run `wsl.exe` - `core/`
 * never spawns, and the distro's `$HOME` is discovered by the host's probe and
 * passed in. And it does not honour `CLAUDE_CONFIG_DIR`: that variable is this
 * machine's environment, and applying a Windows process's override to a
 * directory inside a distro would point at a tree the distro's own CLI has
 * never read.
 */

/** `~/.claude` inside a distro, as a path this process can open, or null. */
export function wslClaudeHome(distro: string, linuxHome: string): string | null {
  const home = linuxHome.trim()
  if (distro.trim() === '' || home === '' || !home.startsWith('/')) return null
  const windows = toWindowsPath(home, { distro })
  return windows === null ? null : join(windows, '.claude')
}

/** The `WslHome` for a probe that found a home, or null for one that did not. */
export function wslHomeOf(distro: string, linuxHome: string | null): WslHome | null {
  if (linuxHome === null) return null
  const claudeHome = wslClaudeHome(distro, linuxHome)
  return claudeHome === null ? null : { distro, home: linuxHome, claudeHome }
}

/**
 * Which `~/.claude` decides what a session in `path` sees.
 *
 * Null for a path on this machine, which is every path that is not under a
 * `\\wsl$\` root - so the caller's own Windows home stays the default and this
 * only ever *adds* an answer. Null again for a distro Helm has no home for:
 * the distro is not installed, or its probe did not answer, and guessing
 * `/home/<windows username>` would be a config console browsing a directory
 * that does not exist and an effective view composed from nothing.
 *
 * Matched case-insensitively because `\\wsl$\ubuntu` and `\\wsl$\Ubuntu` are the
 * same distribution to the platform, and a path typed by hand into a folder
 * picker is where the disagreement comes from.
 */
/**
 * A path a distro's CLI wrote down, spelled so this process can open it.
 *
 * Claude Code records the working directory **as the CLI saw it**, so a session
 * in a distro leaves `/home/me/harness` in its `history.jsonl` - a path with no
 * drive letter, which `statSync` on Windows resolves against the current drive
 * root and reports as absent. Measured against a real distro: 214 conversations
 * with a surviving transcript, and every one of them counted unresumable
 * because the directory it named "did not exist".
 *
 * A Linux path names no distro, so every installed one is tried and the first
 * that has it wins. That is a real ambiguity and it is bounded to where it does
 * no harm: this answers *whether the directory is there*, which decides whether
 * a conversation is offered for resume, while **which** CLI to hand the resume
 * to is read off the transcript's own path and is exact. On the ordinary
 * machine, with one distro, there is nothing to be ambiguous about.
 *
 * Returns the path unchanged when it is already this machine's - a drive path,
 * or a `\\wsl$\` one - so callers can put every recorded path through it.
 */
export function resolveRecordedPath(
  path: string,
  homes: readonly WslHome[],
  exists: (path: string) => boolean
): string | null {
  if (!isLinuxPath(path)) return path
  for (const home of homes) {
    const windows = toWindowsPath(path, { distro: home.distro })
    if (windows !== null && exists(windows)) return windows
  }
  return null
}

export function claudeHomeFor(path: string, homes: readonly WslHome[]): WslHome | null {
  const distro = wslDistroOf(path)
  if (distro === null) return null
  const wanted = distro.toLowerCase()
  return homes.find((home) => home.distro.toLowerCase() === wanted) ?? null
}

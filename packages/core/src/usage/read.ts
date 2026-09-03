import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { claudeHome } from '../discovery/history'
import { parseUsage, usageProblem, type UsageSnapshot } from './shape'

/**
 * Getting `cachedUsageUtilization` off the disk, and nothing else.
 *
 * Separated from `shape.ts` because that file is pure and this one touches the
 * filesystem: the renderer re-derives the view it paints from the pure half on
 * a timer, and a `node:fs` import behind it would fail the browser bundle at
 * rollup rather than at typecheck (CLAUDE.md, hard rules).
 */

/**
 * Where the CLI keeps its config JSON.
 *
 * Normally `~/.claude.json`, a sibling of `~/.claude` rather than a file inside
 * it. `CLAUDE_CONFIG_DIR` moves the whole config directory - credentials
 * included, which is why config-check cannot point a live session at a fixture
 * home -
 * and the JSON goes with it. Rather than encode which of the two is right for a
 * given release, this prefers whichever is actually there, so a fixture may use
 * either layout.
 */
export function claudeConfigFileIn(home: string = claudeHome()): string {
  const inside = join(home, '.claude.json')
  if (existsSync(inside)) return inside
  return join(dirname(home), '.claude.json')
}

/**
 * Enough of the file's identity to tell "unchanged" from "changed" in one
 * syscall. Size alone is not enough: the CLI rewrites this file in place and a
 * refreshed percentage can land on exactly the same byte count.
 */
export interface UsageFileState {
  size: number
  mtimeMs: number
}

export function usageFileState(file: string): UsageFileState | null {
  try {
    const stats = statSync(file)
    return { size: stats.size, mtimeMs: stats.mtimeMs }
  } catch {
    return null
  }
}

/**
 * A ceiling on what will be parsed on the main process's thread.
 *
 * `~/.claude.json` also holds per-project prompt history, so it grows with use:
 * 134 KB on the machine this was written against, which parses in about a
 * millisecond. 64 MB is far past any plausible version of that and is here so
 * that a file which has gone wrong stalls nothing - it reports a problem, which
 * shows as no number, which is the correct outcome anyway.
 */
const MAX_BYTES = 64 * 1024 * 1024

/**
 * The whole file, parsed, reduced to what Helm will show.
 *
 * Read whole rather than tailed - unlike `history.jsonl` this is not append
 * only, and one changed digit rewrites it. The incremental treatment that file
 * gets is not available here and is not needed: it is a single-figure read of a
 * small file, behind a debounce, gated on the file having changed at all.
 */
export function readUsage(file: string): UsageSnapshot {
  const state = usageFileState(file)
  if (state === null) {
    return usageProblem(file, 'no-file', `${file} is not there, so Claude Code has no figures yet.`)
  }
  if (state.size > MAX_BYTES) {
    return usageProblem(
      file,
      'unreadable',
      `${file} is ${String(Math.round(state.size / 1024 / 1024))} MB, which is too large to parse for one figure.`
    )
  }

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    return usageProblem(file, 'unreadable', err instanceof Error ? err.message : String(err))
  }

  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (err) {
    // Reachable in normal use: the CLI rewrites this file in place, and a read
    // that lands mid-write sees half of it. The next pass sees the whole one.
    return usageProblem(
      file,
      'not-json',
      `${file} did not parse: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  return parseUsage(root, file)
}

/**
 * The best of several readings of the same account: the freshest one.
 *
 * Every Claude Code install writes its own `~/.claude.json`, and once Helm
 * reads the `~/.claude` inside each WSL distribution there are several of them
 * - this machine's and one per distro. They are not several accounts and not
 * several plans: `cachedUsageUtilization` is the *server's* answer about the
 * account, cached by whichever CLI last asked. So the files do not need
 * reconciling, they need ranking, and `fetchedAtMs` is the ranking - the file
 * fetched most recently is the most recent description of the one thing they
 * all describe.
 *
 * This is what the WSL paragraph in SPEC 4.8 said could not be decided ("every
 * CLI writes its own copy of the same account-level reading and choosing
 * between two would be a rule with nothing behind it"). The evidence that
 * settles it was already in the file - each copy is stamped with when it was
 * fetched - and the failure the old answer caused is the one the usage surface
 * exists to prevent: somebody who works entirely inside a distro got this
 * machine's stale or absent percentage under a dollar figure summed over *both*
 * homes' transcripts, so the two figures beside each other described different
 * things.
 *
 * Deliberately ranked by fetch time and never by whether the reading is
 * paintable. Preferring the reading that happens to produce a number would be
 * choosing the answer first and the evidence after - a stale or rolled-over
 * *freshest* reading is the honest state of the account, and `usageView` is the
 * one place allowed to decide what may be painted from it.
 *
 * Ties keep the earlier candidate, which is why the caller passes this machine
 * first: two files stamped the same millisecond are the same reading, and the
 * one that needs no explanation in the tooltip wins. A machine with one home
 * therefore takes exactly the path it took before this existed.
 */
export function freshestUsage(snapshots: readonly UsageSnapshot[]): UsageSnapshot {
  let best: UsageSnapshot | null = null
  for (const snapshot of snapshots) {
    // A snapshot carrying a problem carries no `fetchedAtMs` either, so this is
    // one test rather than two - and it is the reason an absent distro file can
    // never beat a real reading however the loop is ordered.
    if (snapshot.problem !== null || snapshot.fetchedAtMs === null) continue
    if (best === null || snapshot.fetchedAtMs > (best.fetchedAtMs ?? 0)) best = snapshot
  }
  // Nothing usable anywhere: hand back the first candidate's own reason rather
  // than inventing one. That is this machine's `~/.claude.json` in every real
  // configuration, so "no figures yet" still names the file somebody can look
  // at, and the surface paints nothing exactly as it did before.
  return best ?? snapshots[0] ?? usageProblem('', 'no-file', 'No usage file to read.')
}

/**
 * Reads every install's `~/.claude.json` and returns the freshest reading.
 *
 * One `readUsage` per candidate, on the main process's thread, which is
 * affordable for the same reason one was: a whole-file parse measures about a
 * millisecond at 134 KB, and there is one file per installed distribution
 * behind a debounce that only fires when a `stat` says something changed.
 */
export function readUsageAcross(files: readonly string[]): UsageSnapshot {
  return freshestUsage(files.map(readUsage))
}

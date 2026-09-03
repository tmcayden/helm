import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import type { WslHome } from '../types'
import { toWindowsPath } from '../wsl/path'

/**
 * Where to point a fresh install. Helm is harness-agnostic by design, so this
 * only ever *suggests* - it never scans somewhere the user did not choose, and
 * it never falls back to the home directory, which would walk a decade of
 * unrelated files on first run.
 */

const HARNESS_MANIFEST = 'harness.yaml'

/**
 * The conventional harness folder names inside a home directory.
 *
 * `.harness` is Helm's own spelling and the only one this machine's home is
 * asked about, because widening the Windows guess is a behaviour change nobody
 * asked for. A distro home is asked about both: a Linux `$HOME` is a directory
 * people keep their work directly in, so `~/harness` undotted is as ordinary
 * there as `~/.harness` is here, and offering only the dotted one is what sent
 * the first user of a distro-hosted session off to paste
 * `\\wsl$\Ubuntu\home\me` into the folder picker by hand.
 */
const HOME_HARNESS_DIRS = ['.harness', 'harness'] as const

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isHarness(path: string): Promise<boolean> {
  try {
    return (await stat(join(path, HARNESS_MANIFEST))).isFile()
  } catch {
    return false
  }
}

/**
 * Walks up from `startDir` looking for a `harness.yaml`. Helm is normally run
 * from inside the harness it manages, so its own location is the strongest
 * available hint.
 */
export async function findEnclosingHarness(startDir: string): Promise<string | null> {
  let current = resolve(startDir)
  const root = parse(current).root

  for (;;) {
    if (await isHarness(current)) return current
    if (current === root) return null
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Ordered best guesses for a first-run scan root: the harness Helm is running
 * inside, then its parent (which usually holds sibling harnesses), then a
 * conventional `~/.harness`, then the same conventional folders inside each
 * distro home the host hands in. Empty is a legitimate answer - the launcher
 * then asks rather than guessing.
 *
 * `homes` is passed in rather than discovered: `core/` never spawns, and the
 * only way to learn a distro's `$HOME` is to run something inside it, so the
 * host's own memoised probe (`wslHomes` in `main/wsl.ts`) is the authority and
 * this stays pure. A caller with none - every machine with no WSL - gets a list
 * byte-for-byte identical to the one this returned before distros existed.
 *
 * What is deliberately *not* offered is the distro home itself, however plainly
 * that is where the work is. `\\wsl$\Ubuntu\home\me` is the home directory rule
 * one filesystem over: a scan rooted there walks a decade of dotfiles, caches
 * and language toolchains over a UNC share that is slower than the local disk
 * by an order of magnitude. So a distro is offered the same *shape* of guess as
 * this machine - a named folder that either exists or does not - and nothing
 * wider.
 */
export async function suggestRoots(
  cwd = process.cwd(),
  homes: readonly WslHome[] = []
): Promise<string[]> {
  const candidates: string[] = []

  const enclosing = await findEnclosingHarness(cwd)
  if (enclosing) {
    // The parent covers this harness *and* its siblings, which is what someone
    // running several harnesses actually wants pointed at.
    candidates.push(dirname(enclosing))
  }

  candidates.push(join(homedir(), '.harness'))

  for (const home of homes) {
    // The distro's `$HOME` is Linux-spelled; `\\wsl$\<distro>\home\me` is the
    // same directory as an ordinary path to `stat`, which is what lets the one
    // filter below decide a distro candidate exactly as it decides a local one.
    // Null is a home that cannot be spelled for this process - it is skipped
    // rather than approximated, because a guessed root is a scan pointed
    // somewhere nobody chose.
    const windowsHome = toWindowsPath(home.home, { distro: home.distro })
    if (windowsHome === null) continue
    for (const name of HOME_HARNESS_DIRS) candidates.push(join(windowsHome, name))
  }

  const out: string[] = []
  for (const candidate of candidates) {
    const normalised = resolve(candidate)
    if (out.some((existing) => existing.toLowerCase() === normalised.toLowerCase())) continue
    if (await isDirectory(normalised)) out.push(normalised)
  }
  return out
}

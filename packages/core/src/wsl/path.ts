/**
 * Windows ↔ WSL path translation.
 *
 * A session hosted inside a distro is still launched by a Windows process, so
 * every path that reaches its argv was written in Windows spelling and has to
 * arrive in Linux spelling: `--add-dir`, `--plugin-dir`,
 * `--append-system-prompt-file` and `--mcp-config` all name files the CLI will
 * open from inside the distro.
 *
 * Pure, and deliberately so - `core/` never imports Electron and never spawns.
 * `wslpath` is the authority on a machine whose automount root has been moved,
 * and the host injects it as a `resolver` where the rule below cannot decide.
 * The common case needs no subprocess at all, which matters because this runs
 * once per path per launch.
 */

/** The default `/mnt` automount root, as `/etc/wsl.conf` ships it. */
export const DEFAULT_AUTOMOUNT_ROOT = '/mnt'

/** `C:\x\y` - a local drive, the case the rule below can always decide. */
const DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/

/** `\\wsl$\Ubuntu\home\me` and its `\\wsl.localhost\` spelling. */
const WSL_UNC = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\?(.*)$/i

/** A path already written the way the distro would write it. */
export function isLinuxPath(path: string): boolean {
  return path.startsWith('/')
}

/**
 * The distro a path lives inside, or null for a path on this machine.
 *
 * This is what makes a WSL-resident project work at all, and it is not a
 * convenience. **A Windows process cannot be spawned with a UNC working
 * directory** - measured 2026-09-02, `CreateProcess` answers ENOENT - so a
 * project under `\\wsl$\Ubuntu\...` launched on the Windows target is not a
 * degraded session, it is a session that cannot start. The target therefore
 * follows the path rather than being a choice somebody has to remember to make.
 *
 * Only the UNC form answers. A bare `/home/me` is ambiguous - every distro has
 * one - and a drive path is this machine's.
 */
export function wslDistroOf(path: string): string | null {
  const unc = WSL_UNC.exec(path)
  return unc === null ? null : (unc[1] ?? null)
}

/**
 * A Windows path as the distro sees it, or null when only `wslpath` can say.
 *
 * Null rather than a guess. A wrong path here is a `--plugin-dir` pointing at
 * nothing, and a session that silently loses its composed skills is the exact
 * failure Helm exists to prevent - so an undecidable path is handed to the
 * resolver instead of being approximated.
 */
export function toWslPath(
  path: string,
  options: { distro: string; automountRoot?: string } | { distro: string }
): string | null {
  // Already Linux-spelled. A profile authored against a distro-resident
  // directory carries `/home/me/work`, and translating it again would produce
  // `/mnt/...` nonsense.
  if (isLinuxPath(path)) return path

  const unc = WSL_UNC.exec(path)
  if (unc) {
    // A UNC path into a distro names a path *inside* that distro's filesystem
    // root, and it is only meaningful to the distro it names. Pointing a
    // session in Ubuntu at `\\wsl$\Debian\home\me` translates to a directory
    // Ubuntu does not have, so the mismatch is refused rather than mangled.
    if (unc[1]?.toLowerCase() !== options.distro.toLowerCase()) return null
    const rest = (unc[2] ?? '').replace(/\\/g, '/')
    return `/${rest}`
  }

  const drive = DRIVE_PATH.exec(path)
  if (drive) {
    const root =
      'automountRoot' in options && options.automountRoot !== undefined
        ? options.automountRoot
        : DEFAULT_AUTOMOUNT_ROOT
    const letter = (drive[1] ?? '').toLowerCase()
    const rest = (drive[2] ?? '').replace(/\\/g, '/')
    return rest === '' ? `${root}/${letter}` : `${root}/${letter}/${rest}`
  }

  // A relative path, a bare drive letter, a device path. None of these mean
  // anything to the distro without a working directory to resolve against, and
  // every caller in Helm resolves before it gets here.
  return null
}

/**
 * A distro path as Windows sees it: the UNC route into the distro's filesystem.
 *
 * The inverse of the `/mnt` case is a real Windows path and the inverse of
 * everything else is `\\wsl$\<distro>\...`, which is how the discovery,
 * transcript and usage readers reach a distro's `~/.claude` without leaving the
 * Windows process.
 */
export function toWindowsPath(
  path: string,
  options: { distro: string; automountRoot?: string }
): string | null {
  if (!isLinuxPath(path)) return null

  const root = options.automountRoot ?? DEFAULT_AUTOMOUNT_ROOT
  const mounted = new RegExp(`^${escapeRegExp(root)}/([a-zA-Z])(?:/(.*))?$`).exec(path)
  if (mounted) {
    const letter = (mounted[1] ?? '').toUpperCase()
    const rest = (mounted[2] ?? '').replace(/\//g, '\\')
    return rest === '' ? `${letter}:\\` : `${letter}:\\${rest}`
  }

  const rest = path.replace(/^\//, '').replace(/\//g, '\\')
  return rest === ''
    ? `\\\\wsl$\\${options.distro}`
    : `\\\\wsl$\\${options.distro}\\${rest}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

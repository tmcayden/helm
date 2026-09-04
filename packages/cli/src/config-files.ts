import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { assertWritable } from '@helm/core'
import { CliError } from './output.ts'

export interface SnapshotTarget {
  path: string
  /** The scope's base directory, the same one the config console records. */
  scopePath: string
  guard: (scopePath: string, path: string) => void
}

/**
 * Which scope a configuration file belongs to, from its path alone. The editor
 * hands over a file, not a scope, so the scope is the directory whose
 * `.claude` the file is under - or the `.claude` itself for the user's, whose
 * base directory *is* the tree (see `userConfigScope`). `~/.claude.json` is
 * under no scope, so it is keyed against its own directory the way the desktop's
 * `mcp add` snapshots it; that is the one file `assertWritable` would refuse.
 */
export function snapshotTargetFor(file: string, claudeHome: string, claudeJson: string): SnapshotTarget {
  if (!isAbsolute(file)) throw new CliError(`${file} is not an absolute path.`)
  const path = resolve(file)
  const home = resolve(claudeHome)

  if (path === resolve(claudeJson)) {
    return { path, scopePath: dirname(path), guard: () => {} }
  }
  if (path.startsWith(home + sep)) {
    return { path, scopePath: home, guard: assertWritable }
  }
  const segments = path.split(sep)
  const claudeIndex = segments.lastIndexOf('.claude')
  if (claudeIndex > 0 && claudeIndex < segments.length - 1) {
    return { path, scopePath: segments.slice(0, claudeIndex).join(sep) || sep, guard: assertWritable }
  }
  const name = basename(path)
  if (name.toLowerCase() === 'claude.md' || name === '.mcp.json') {
    return { path, scopePath: dirname(path), guard: assertWritable }
  }
  throw new CliError(`${path} is not configuration: only files under a .claude directory, a CLAUDE.md, a .mcp.json or ~/.claude.json are snapshotted.`)
}

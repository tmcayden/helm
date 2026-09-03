import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { claudeHome } from '../discovery/history'
import type { ConfigFile, ConfigFileKind, ConfigScope, ConfigScopeKind, ConfigTree } from '../types'
import { frontmatterField } from './validate'

/**
 * A `.claude/` tree, listed the way Claude Code resolves it.
 *
 * The distinction `claude-inventory.ts` makes for counting is the same one that
 * matters for browsing, and it is not what a file explorer shows: a *skill* is a
 * directory holding a `SKILL.md`, so the thing to open is the file and the thing
 * to call it is the directory. Commands and agents are markdown at any depth,
 * and a command's namespace is its path - `commands/spec/plan.md` is
 * `/spec:plan`, which is unguessable from a flat listing.
 *
 * This walks rather than counts, so it returns the files themselves. It shares
 * no code with the inventory counter on purpose: they answer different
 * questions, and a browser that agreed with the counter by construction could
 * not disagree with it when the counter was wrong.
 */

/** Deep enough for `commands/spec/section/thing.md`, shallow enough to end. */
const MAX_DEPTH = 8

/**
 * Files under a `.claude` tree that are not configuration.
 *
 * `hooks/` is listed - a hook is executable configuration and editing one is
 * exactly what this console is for - but the directories Claude Code uses as
 * working storage are not, and neither are the ones a hook's own toolchain
 * creates.
 */
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  'projects',
  'sessions',
  'shell-snapshots',
  'file-history',
  'paste-cache',
  'statsig',
  'cache',
  'debug',
  'downloads',
  'todos',
  'backups',
  'ide',
  'tasks',
  'teams',
  'session-env',
  'chrome',
  'plugins',
  '__pycache__'
])

/** Extensions worth opening in a text editor. Everything else is listed as binary. */
const TEXT_EXT = new Set([
  '.md',
  '.markdown',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.txt',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.sh',
  '.ps1',
  '.py',
  '.bat',
  '.cmd'
])

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * The user scope, which is `~/.claude` itself rather than a directory
 * containing one.
 *
 * `claudeHome()` is used rather than `~/.claude` directly so that a machine
 * with `CLAUDE_CONFIG_DIR` set browses the tree the CLI would actually read.
 * The base path stays the home directory, because `~/CLAUDE.md` is not a thing
 * and the user scope's instruction file lives *inside* `.claude`.
 *
 * There can be more than one of these, which is why the label is a parameter.
 * A WSL distribution has a `~/.claude` of its own - its own settings, its own
 * skills, its own `history.jsonl` - and a session hosted there reads that one
 * and never this machine's. Helm opens it over `\\wsl$\<distro>\...`, so it is
 * an ordinary directory to everything below here and needs no second walker;
 * what it needs is to be distinguishable in the switcher, hence "User
 * (Ubuntu)" beside plain "User".
 */
export function userConfigScope(home: string = claudeHome(), label = 'User'): ConfigScope {
  return {
    kind: 'user',
    path: home,
    claudeDir: home,
    label,
    exists: isDir(home)
  }
}

export function projectConfigScope(
  projectPath: string,
  kind: ConfigScopeKind = 'project',
  label?: string
): ConfigScope {
  const base = resolve(projectPath)
  return {
    kind,
    path: base,
    claudeDir: join(base, '.claude'),
    label: label ?? (basename(base) || base),
    exists: isDir(join(base, '.claude')) || isFile(join(base, 'CLAUDE.md'))
  }
}

/** `~` on any platform, for the label under the user scope. */
export function homeDirectory(): string {
  return homedir()
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * A path beside a `.claude` directory: `CLAUDE.md` or `.mcp.json`, and nothing
 * else. Both change how a session behaves and neither lives inside `.claude`.
 */
function classifyLoose(name: string): { kind: ConfigFileKind; name: string } | null {
  const lower = name.toLowerCase()
  if (lower === 'claude.md') return { kind: 'claude-md', name: 'CLAUDE.md' }
  if (name === '.mcp.json') return { kind: 'mcp', name: '.mcp.json' }
  return null
}

/**
 * What a path *inside* a `.claude` directory is.
 *
 * Decided from the path rather than the contents, because that is how the CLI
 * decides it: a markdown file in `commands/` is a command whatever is in it.
 * The one exception is `skills/`, where only the `SKILL.md` is the skill and
 * anything beside it is a resource the skill bundles.
 *
 * Takes the path relative to the `.claude` directory rather than to the scope,
 * because those are not the same thing: for a project the two differ by a
 * leading `.claude/`, and for the user scope the base directory *is* `.claude`.
 */
function classify(inside: string[]): { kind: ConfigFileKind; name: string } | null {
  const file = inside.at(-1) ?? ''
  const lower = file.toLowerCase()
  const top = inside[0] ?? ''
  const tail = inside.slice(1)

  if (inside.length === 1) {
    if (lower === 'settings.json') return { kind: 'settings', name: 'settings.json' }
    if (lower === 'settings.local.json') return { kind: 'settings-local', name: 'settings.local.json' }
    if (lower === 'claude.md') return { kind: 'claude-md', name: 'CLAUDE.md' }
    if (lower === '.mcp.json') return { kind: 'mcp', name: '.mcp.json' }
    return { kind: 'other', name: file }
  }

  if (top === 'skills') {
    // The skill's name is its directory, which is what the platform namespaces:
    // `skills/think/SKILL.md` is `think`, and `skills/a/b/SKILL.md` is `b`.
    if (lower === 'skill.md') {
      return { kind: 'skill', name: tail.at(-2) ?? tail[0] ?? file }
    }
    return { kind: 'other', name: tail.join('/') }
  }

  if (top === 'commands' && lower.endsWith('.md')) {
    // The path *is* the name: `commands/spec/plan.md` is invoked as `/spec:plan`.
    return { kind: 'command', name: tail.join(':').replace(/\.md$/i, '') }
  }

  if (top === 'agents' && lower.endsWith('.md')) {
    return { kind: 'agent', name: tail.join('/').replace(/\.md$/i, '') }
  }

  if (top === 'hooks') return { kind: 'hook', name: tail.join('/') }
  if (top === 'rules') return { kind: 'rule', name: tail.join('/').replace(/\.md$/i, '') }

  return { kind: 'other', name: inside.join('/') }
}

/** Forward slashes on every platform, because these are identifiers as well as paths. */
function relativeParts(from: string, path: string): string[] {
  return relative(from, path).split(sep)
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/** The `description:` a skill or agent declares, without reading whole files
 * that have no frontmatter to find. */
function describe(path: string, kind: ConfigFileKind): string | null {
  if (kind !== 'skill' && kind !== 'agent' && kind !== 'command') return null
  try {
    // Frontmatter is at the top by definition, so a partial read is enough -
    // and some skills bundle bodies measured in tens of kilobytes.
    const head = readFileSync(path, 'utf8').slice(0, 4096)
    return frontmatterField(head, 'description')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Every configuration file in a scope, with what it is and how it is addressed.
 *
 * Symlinked directories are not followed. A shim's junction points back into a
 * real repository, and a scope that walked into one would list another
 * project's skills as its own - and, on a link that points at an ancestor,
 * would not finish.
 */
export function readConfigTree(scope: ConfigScope): ConfigTree {
  const files: ConfigFile[] = []
  const errors: string[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      // The scope's own `.claude` not being there is the normal case for a
      // project with no configuration, and is reported by `scope.exists`.
      if (dir !== scope.claudeDir) {
        errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) continue
        if (SKIPPED_DIRS.has(entry.name.toLowerCase())) continue
        walk(path, depth + 1)
        continue
      }
      if (!entry.isFile()) continue

      const relPath = relativeParts(scope.path, path).join('/')
      const what = classify(relativeParts(scope.claudeDir, path))
      if (!what) continue

      let stat
      try {
        stat = statSync(path)
      } catch {
        // Deleted between the readdir and the stat. Not there, so not listed.
        continue
      }

      const binary = !TEXT_EXT.has(extensionOf(entry.name))
      files.push({
        path,
        relPath,
        kind: what.kind,
        name: what.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        description: binary ? null : describe(path, what.kind),
        binary
      })
    }
  }

  walk(scope.claudeDir, 0)

  // `CLAUDE.md` and `.mcp.json` sit beside `.claude/`, not in it, and both
  // change how a session behaves - so a scope with neither a `.claude` nor a
  // config directory still has something to show.
  if (scope.kind !== 'user') {
    for (const name of ['CLAUDE.md', '.mcp.json']) {
      const path = join(scope.path, name)
      try {
        const stat = statSync(path)
        if (!stat.isFile()) continue
        const what = classifyLoose(name)
        if (!what) continue
        files.push({
          path,
          relPath: name,
          kind: what.kind,
          name: what.name,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          description: null,
          binary: false
        })
      } catch {
        // Absent, which is not an error.
      }
    }
  }

  // Grouped by kind in the order the console shows them, then by name, so the
  // list is stable across scans rather than in readdir order.
  const ORDER: ConfigFileKind[] = [
    'claude-md',
    'settings',
    'settings-local',
    'mcp',
    'skill',
    'command',
    'agent',
    'hook',
    'rule',
    'other'
  ]
  files.sort((a, b) => {
    const byKind = ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind)
    if (byKind !== 0) return byKind
    return a.name.localeCompare(b.name) || a.relPath.localeCompare(b.relPath)
  })

  return { scope, files, errors, scannedAt: new Date().toISOString() }
}

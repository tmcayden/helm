import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { join } from 'node:path'
import { pathKey } from '../paths/key'
import { parse as parseYaml } from 'yaml'
import type { DiscoveryResult, Harness, Project } from '../types'
import { hasClaudeDir, readClaudeInventory } from './claude-inventory'
import { readGitStates } from './git'

/**
 * Turns a list of root paths into the launcher's tree.
 *
 * The shape it looks for, in order:
 *   1. the root itself is a harness  (`harness.yaml`)  -> harness + its repos/*
 *   2. the root *contains* harnesses                    -> each one, as above
 *   3. the root's children look like projects           -> those children
 *   4. anything else                                    -> the root itself
 *
 * SPEC's portability requirement is the reason for step 3: Helm must be useful
 * pointed at a directory of ordinary repos, with no harness anywhere in sight.
 * Step 4 is the answer to what step 3 used to do unconditionally - see
 * `looksLikeProject`.
 */

const HARNESS_MANIFEST = 'harness.yaml'
const REPOS_DIRNAME = 'repos'

/**
 * What makes a directory a project in its own right rather than a container of
 * them. Any one of these is enough.
 *
 * These three and no more, and the shortness of the list is the point: they are
 * exactly the things Helm already has something to say about a project - the
 * git chip, the `.claude/` flag and the instruction file on its pane. A list
 * that grew to `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod` and
 * whatever comes next would be a list that is wrong for every ecosystem not yet
 * added to it, and wrong silently.
 */
const PROJECT_MARKERS = ['.git', '.claude', 'CLAUDE.md']

/** Directories that are never projects, skipped before any I/O is spent on them. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__'
])

export interface ScanOptions {
  roots: string[]
  /** Read git state for every discovered project. Off for a fast first paint. */
  includeGit?: boolean
  /** How deep to look for harnesses below a root. 1 finds `<root>/<harness>`. */
  maxDepth?: number
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

interface HarnessManifest {
  name: string | null
  template: string | null
  version: string | null
  /** The `repos:` key, verbatim. Resolved by `reposDirOf`, not here. */
  repos: string | null
}

async function readHarnessManifest(path: string): Promise<HarnessManifest | null> {
  try {
    const raw = await readFile(join(path, HARNESS_MANIFEST), 'utf8')
    const parsed: unknown = parseYaml(raw)
    if (parsed === null || typeof parsed !== 'object') {
      return { name: null, template: null, version: null, repos: null }
    }
    const record = parsed as Record<string, unknown>
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
    return {
      name: str(record['name']),
      template: str(record['template']),
      version: str(record['version']),
      repos: str(record['repos'])
    }
  } catch {
    // A harness with an unreadable or malformed manifest is still a harness -
    // the file's presence is the signal, its contents are decoration.
    return null
  }
}

/**
 * Which directory a harness keeps its repositories in.
 *
 * `repos:` is optional and relative to the harness root; absent means `repos/`.
 * The key exists so an *existing* folder of repositories can become a harness
 * without hiding them: dropping a bare `harness.yaml` into a directory whose
 * repos sit at its top level used to make every one of them disappear, because
 * a harness only ever listed `repos/*`. `repos: .` is the answer to that, and
 * it is the value the "convert a folder" action writes.
 *
 * Two values are refused rather than honoured: an absolute path, and anything
 * that climbs out of the harness. A manifest is a file that travels with
 * someone else's workspace, and a scan root that can be redirected to `C:\` by
 * a line in a YAML file is a scan root that walks the whole disk. Both fall
 * back to `repos/`.
 */
function reposDirOf(harnessPath: string, manifest: HarnessManifest | null): string {
  const declared = manifest?.repos?.trim()
  if (declared === undefined || declared === '' || isAbsolute(declared)) {
    return join(harnessPath, REPOS_DIRNAME)
  }
  const resolved = resolve(harnessPath, declared)
  const within = relative(harnessPath, resolved)
  const escapes = within.startsWith('..') || isAbsolute(within)
  return escapes ? join(harnessPath, REPOS_DIRNAME) : resolved
}

async function listDirs(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

async function describeProject(
  path: string,
  kind: Project['kind'],
  harnessPath: string | null
): Promise<Project> {
  const [inventory, claudeDir] = await Promise.all([
    readClaudeInventory(path),
    hasClaudeDir(path)
  ])
  return {
    path,
    name: basename(path),
    kind,
    harnessPath,
    hasClaudeDir: claudeDir,
    inventory,
    git: null
  }
}

/** A harness and every project under its repos directory. */
async function scanHarness(
  path: string
): Promise<{ harness: Harness; projects: Project[] }> {
  const manifest = await readHarnessManifest(path)
  const reposDir = reposDirOf(path, manifest)

  let repoNames: string[] = []
  if (await isDirectory(reposDir)) {
    try {
      repoNames = await listDirs(reposDir)
    } catch {
      repoNames = []
    }
  }

  const repoPaths = repoNames.map((name) => join(reposDir, name))
  const projects = await Promise.all([
    // The harness root is itself a project: it has its own `.claude/` and is
    // the cwd a session actually launches from.
    describeProject(path, 'harness', path),
    ...repoPaths.map((repoPath) => describeProject(repoPath, 'repo', path))
  ])

  return {
    harness: {
      path,
      name: manifest?.name ?? basename(path),
      template: manifest?.template ?? null,
      version: manifest?.version ?? null,
      repoPaths
    },
    projects
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
 * Whether `path` carries any of `PROJECT_MARKERS`.
 *
 * Existence only, not kind: a repository checked out as a git worktree has
 * `.git` as a *file* holding a `gitdir:` line, and refusing to see one would
 * hide exactly the directories somebody working on two branches at once cares
 * most about.
 */
async function looksLikeProject(path: string): Promise<boolean> {
  const probes = await Promise.all(
    PROJECT_MARKERS.map(async (marker) => {
      try {
        await stat(join(path, marker))
        return true
      } catch {
        return false
      }
    })
  )
  return probes.some(Boolean)
}

export async function scan(opts: ScanOptions): Promise<DiscoveryResult> {
  const startedAt = Date.now()
  const maxDepth = opts.maxDepth ?? 1

  const harnesses: Harness[] = []
  const projects: Project[] = []
  const errors: Array<{ path: string; message: string }> = []
  const seen = new Set<string>()

  const roots = opts.roots.map((r) => resolve(r))

  const addProjects = (found: Project[]): void => {
    for (const project of found) {
      const key = pathKey(project.path)
      if (seen.has(key)) continue
      seen.add(key)
      projects.push(project)
    }
  }

  const visit = async (path: string, depth: number): Promise<void> => {
    if (await isHarness(path)) {
      const { harness, projects: found } = await scanHarness(path)
      harnesses.push(harness)
      addProjects(found)
      return
    }

    if (depth >= maxDepth) {
      // Out of budget to look deeper, so treat what we are standing on as a
      // project in its own right rather than reporting nothing.
      addProjects([await describeProject(path, 'folder', null)])
      return
    }

    let children: string[]
    try {
      children = await listDirs(path)
    } catch (err) {
      errors.push({ path, message: err instanceof Error ? err.message : String(err) })
      return
    }

    const results = await Promise.all(
      children.map(async (name) => {
        const child = join(path, name)
        return { child, harness: await isHarness(child) }
      })
    )

    const harnessChildren = results.filter((r) => r.harness)
    if (harnessChildren.length > 0) {
      // A directory of harnesses. Its non-harness siblings are not projects -
      // they are whatever else happens to live beside them.
      for (const { child } of harnessChildren) await visit(child, depth + 1)
      return
    }

    // No harness anywhere below, so the root is either a container of projects
    // or a project. Nothing about the *root* can tell those apart - a directory
    // with subdirectories in it is both - so the answer is read off the
    // children, and only a child that looks like a project is evidence.
    //
    // This branch used to have no test in it at all: every child became a
    // project unconditionally, which is right for `C:\repos` and catastrophic
    // for a folder someone picked meaning "this one". Reported from a real
    // workspace: adding a single Python tool directory put `data`, `scripts`,
    // `src` and `tests` in the launcher and nothing carrying the name of the
    // folder that was picked. The rule is the one the report asked for - the
    // folder you picked is the thing that appears.
    //
    // Deliberately *not* the converse test - "the root looks like a project, so
    // it is one". A directory of repositories that happens to carry a CLAUDE.md
    // at its top is a container, and asking about the root first would collapse
    // it to a single row. Asking about the children only ever narrows what this
    // did before, which is the whole of the change.
    const projectChildren = await Promise.all(results.map((r) => looksLikeProject(r.child)))
    if (!projectChildren.some(Boolean)) {
      addProjects([await describeProject(path, 'folder', null)])
      return
    }

    addProjects(
      await Promise.all(results.map(({ child }) => describeProject(child, 'folder', null)))
    )
  }

  for (const root of roots) {
    if (!(await isDirectory(root))) {
      errors.push({ path: root, message: 'not a directory' })
      continue
    }
    try {
      await visit(root, 0)
    } catch (err) {
      errors.push({ path: root, message: err instanceof Error ? err.message : String(err) })
    }
  }

  if (opts.includeGit) {
    const states = await readGitStates(projects.map((p) => p.path))
    for (const project of projects) project.git = states.get(project.path) ?? null
  }

  projects.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }))

  return {
    roots,
    harnesses,
    projects,
    errors,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt
  }
}

/**
 * Whether `path` is `root` or sits under it.
 *
 * Case-insensitively on Windows, which `relative` handles: two spellings of one
 * directory are one directory, and every path here came out of a picker, a
 * settings row or a database column that may each have recorded a different
 * one.
 */
export function isWithin(root: string, path: string): boolean {
  const within = relative(resolve(root), resolve(path))
  return within === '' || (!within.startsWith('..') && !isAbsolute(within))
}

/**
 * The cached project rows a completed scan has **disproved**.
 *
 * The discovery cache exists so the launcher can paint before a scan lands, and
 * a scan otherwise only ever writes to it: rows it did not see are left alone,
 * so a project on a drive that is not plugged in is stale rather than gone.
 * That rule has one hole, and it is permanent - a row written by a scan that
 * was wrong is a row nothing ever takes back. The subdirectories the folder-root
 * bug wrote would have gone on painting for a second at every start, for good,
 * on a machine where the bug itself was fixed.
 *
 * So a row is forgotten only where this pass can *prove* it wrong: it is under
 * a root that was just walked with no error at or below it, and the walk did
 * not return it. A root that errored - or a row belonging to no current root -
 * keeps everything under it, which is exactly the unplugged drive the original
 * rule is about.
 */
export function disprovedProjectPaths(
  cached: readonly string[],
  result: Pick<DiscoveryResult, 'roots' | 'projects' | 'errors'>
): string[] {
  const trusted = result.roots.filter(
    (root) => !result.errors.some((error) => isWithin(root, error.path))
  )
  if (trusted.length === 0) return []

  const found = new Set(result.projects.map((project) => pathKey(project.path)))
  return cached.filter(
    (path) =>
      !found.has(pathKey(path)) && trusted.some((root) => isWithin(root, path))
  )
}

/**
 * The cached project rows that removing `removed` from the scan roots orphans:
 * under it, and under none of the roots that remain.
 *
 * The scan cannot answer this one - a root that is no longer scanned is a root
 * nothing walks again - so removal has to say so itself, and it is the same
 * claim `disprovedProjectPaths` makes: the rows this root put there go with it.
 */
export function orphanedProjectPaths(
  cached: readonly string[],
  removed: string,
  remaining: readonly string[]
): string[] {
  return cached.filter(
    (path) => isWithin(removed, path) && !remaining.some((root) => isWithin(root, path))
  )
}

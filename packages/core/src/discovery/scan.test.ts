import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_INVENTORY } from '../types'
import { disprovedProjectPaths, orphanedProjectPaths, scan } from './scan'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'helm-scan-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function file(relative: string, content = ''): Promise<void> {
  const path = join(root, relative)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

async function dir(relative: string): Promise<void> {
  await mkdir(join(root, relative), { recursive: true })
}

describe('scan', () => {
  it('reports a root that does not exist as an error rather than throwing', async () => {
    const result = await scan({ roots: [join(root, 'nope')] })
    expect(result.projects).toEqual([])
    expect(result.errors).toEqual([{ path: join(root, 'nope'), message: 'not a directory' }])
  })

  it('finds a harness pointed at directly, and its repos', async () => {
    await file('dev/harness.yaml', 'name: "dev"\ntemplate: "dev"\nversion: "0.1.0"\n')
    await dir('dev/repos/alpha')
    await dir('dev/repos/beta')
    await file('dev/.claude/skills/notes/SKILL.md')
    await file('dev/repos/alpha/.claude/skills/one/SKILL.md')
    await file('dev/repos/alpha/.claude/agents/reviewer.md')

    const result = await scan({ roots: [join(root, 'dev')] })

    expect(result.harnesses).toHaveLength(1)
    expect(result.harnesses[0]).toMatchObject({ name: 'dev', template: 'dev', version: '0.1.0' })

    const byName = new Map(result.projects.map((p) => [p.name, p]))
    expect([...byName.keys()].sort()).toEqual(['alpha', 'beta', 'dev'])
    expect(byName.get('dev')?.kind).toBe('harness')
    expect(byName.get('alpha')?.kind).toBe('repo')
    expect(byName.get('alpha')?.harnessPath).toBe(join(root, 'dev'))
    expect(byName.get('dev')?.inventory.skills).toBe(1)
    expect(byName.get('alpha')?.inventory.skills).toBe(1)
    expect(byName.get('alpha')?.inventory.agents).toBe(1)
    expect(byName.get('beta')?.inventory.skills).toBe(0)
  })

  it('finds harnesses one level below the root', async () => {
    await file('dev/harness.yaml', 'name: "dev"\n')
    await dir('dev/repos/alpha')
    await file('work/harness.yaml', 'name: "work"\n')
    await dir('work/repos/gamma')
    // A sibling that is not a harness is not a project of its own here - the
    // root turned out to be a directory of harnesses.
    await dir('downloads')

    const result = await scan({ roots: [root] })

    expect(result.harnesses.map((h) => h.name).sort()).toEqual(['dev', 'work'])
    expect(result.projects.map((p) => p.name).sort()).toEqual(['alpha', 'dev', 'gamma', 'work'])
  })

  it('degrades to plain folders when there is no harness anywhere', async () => {
    await dir('one')
    await dir('two')
    await file('one/CLAUDE.md')

    const result = await scan({ roots: [root] })

    expect(result.harnesses).toEqual([])
    expect(result.projects.map((p) => p.name).sort()).toEqual(['one', 'two'])
    expect(result.projects.every((p) => p.kind === 'folder')).toBe(true)
    expect(result.projects.find((p) => p.name === 'one')?.inventory.claudeMd).toBe(true)
  })

  it('lists the folder itself when none of its children looks like a project', async () => {
    // The reported bug: a project directory added as a root listed its own
    // source tree as four projects and itself as none.
    await dir('tool/data')
    await dir('tool/scripts')
    await dir('tool/src')
    await dir('tool/tests')
    await file('tool/pyproject.toml')

    const result = await scan({ roots: [join(root, 'tool')] })

    expect(result.projects.map((p) => p.name)).toEqual(['tool'])
    expect(result.projects[0]?.path).toBe(join(root, 'tool'))
    expect(result.projects[0]?.kind).toBe('folder')
  })

  it('still lists the children when one of them looks like a project', async () => {
    // The other half of the same rule, and the reason it is read off the
    // children: `.git`, `.claude` and `CLAUDE.md` each say "container" on their
    // own, and the siblings come with it.
    await dir('repos/alpha')
    await dir('repos/beta')
    await dir('repos/gamma')

    const bare = await scan({ roots: [join(root, 'repos')] })
    expect(bare.projects.map((p) => p.name)).toEqual(['repos'])

    for (const marker of ['alpha/.git', 'alpha/.claude/skills/one/SKILL.md', 'alpha/CLAUDE.md']) {
      await rm(join(root, 'repos', 'alpha'), { recursive: true, force: true })
      await file(join('repos', marker))

      const result = await scan({ roots: [join(root, 'repos')] })
      expect(result.projects.map((p) => p.name).sort()).toEqual(['alpha', 'beta', 'gamma'])
    }
  })

  it('sees a git worktree, whose .git is a file rather than a directory', async () => {
    await dir('checkouts/branch-b')
    await file('checkouts/branch-a/.git', 'gitdir: ../../real/.git/worktrees/branch-a\n')

    const result = await scan({ roots: [join(root, 'checkouts')] })

    expect(result.projects.map((p) => p.name).sort()).toEqual(['branch-a', 'branch-b'])
  })

  it('lists an empty root as itself rather than as nothing at all', async () => {
    await dir('empty')

    const result = await scan({ roots: [join(root, 'empty')] })

    expect(result.projects.map((p) => p.name)).toEqual(['empty'])
    expect(result.errors).toEqual([])
  })

  it('handles a harness whose manifest is malformed', async () => {
    await file('dev/harness.yaml', ':\n  - this is not: valid: yaml\n')
    await dir('dev/repos/alpha')

    const result = await scan({ roots: [join(root, 'dev')] })

    // The file's presence is the signal; its contents are decoration.
    expect(result.harnesses).toHaveLength(1)
    expect(result.harnesses[0]?.name).toBe('dev')
    expect(result.projects.map((p) => p.name).sort()).toEqual(['alpha', 'dev'])
  })

  it('handles a harness with no repos directory', async () => {
    await file('dev/harness.yaml', 'name: "dev"\n')

    const result = await scan({ roots: [join(root, 'dev')] })

    expect(result.harnesses[0]?.repoPaths).toEqual([])
    expect(result.projects.map((p) => p.name)).toEqual(['dev'])
  })

  it('honours a `repos:` key naming a different directory', async () => {
    await file('dev/harness.yaml', 'name: "dev"\nrepos: "projects"\n')
    await dir('dev/projects/alpha')
    await dir('dev/projects/beta')
    // The default location exists too, and must be ignored: `repos:` names the
    // directory, it does not add one.
    await dir('dev/repos/ignored')

    const result = await scan({ roots: [join(root, 'dev')] })

    expect(result.projects.map((p) => p.name).sort()).toEqual(['alpha', 'beta', 'dev'])
    expect(result.harnesses[0]?.repoPaths.sort()).toEqual([
      join(root, 'dev', 'projects', 'alpha'),
      join(root, 'dev', 'projects', 'beta')
    ])
  })

  it('falls back to `repos/` when the key is absent, empty or not a string', async () => {
    await file('a/harness.yaml', 'name: "a"\n')
    await dir('a/repos/one')
    await file('b/harness.yaml', 'name: "b"\nrepos: ""\n')
    await dir('b/repos/two')
    await file('c/harness.yaml', 'name: "c"\nrepos: 3\n')
    await dir('c/repos/three')

    for (const [name, repo] of [
      ['a', 'one'],
      ['b', 'two'],
      ['c', 'three']
    ]) {
      const result = await scan({ roots: [join(root, name as string)] })
      expect(result.projects.map((p) => p.name).sort()).toEqual([name, repo].sort())
    }
  })

  it('does not hide the repos of a folder converted in place with `repos: .`', async () => {
    // The failure this key exists for: before it, dropping a harness.yaml into
    // a folder whose repos sit at its top level made every one of them vanish.
    await dir('work/alpha')
    await dir('work/beta')
    await file('work/alpha/.claude/skills/one/SKILL.md')

    const before = await scan({ roots: [join(root, 'work')] })
    expect(before.projects.map((p) => p.name).sort()).toEqual(['alpha', 'beta'])

    await file('work/harness.yaml', 'name: "work"\nrepos: "."\n')

    const after = await scan({ roots: [join(root, 'work')] })
    expect(after.harnesses.map((h) => h.name)).toEqual(['work'])
    expect(after.projects.map((p) => p.name).sort()).toEqual(['alpha', 'beta', 'work'])
    expect(after.projects.find((p) => p.name === 'alpha')?.harnessPath).toBe(join(root, 'work'))
    expect(after.projects.find((p) => p.name === 'alpha')?.inventory.skills).toBe(1)
  })

  it('refuses a `repos:` that leaves the harness, rather than scanning it', async () => {
    await dir('outside/secret')
    await file('dev/harness.yaml', `name: "dev"\nrepos: "../outside"\n`)
    await dir('dev/repos/alpha')

    const escaped = await scan({ roots: [join(root, 'dev')] })
    expect(escaped.projects.map((p) => p.name).sort()).toEqual(['alpha', 'dev'])

    await file('dev/harness.yaml', `name: "dev"\nrepos: ${JSON.stringify(join(root, 'outside'))}\n`)
    const absolute = await scan({ roots: [join(root, 'dev')] })
    expect(absolute.projects.map((p) => p.name).sort()).toEqual(['alpha', 'dev'])
  })

  it('handles repo directories whose names contain spaces', async () => {
    await file('dev/harness.yaml', 'name: "dev"\n')
    await file('dev/repos/Acme Project/.claude/skills/one/SKILL.md')

    const result = await scan({ roots: [join(root, 'dev')] })

    const project = result.projects.find((p) => p.name === 'Acme Project')
    expect(project).toBeDefined()
    expect(project?.inventory.skills).toBe(1)
  })

  it('skips node_modules and dotted directories', async () => {
    await dir('project/node_modules/left-pad')
    await dir('project/.git')
    await dir('project/src')

    const result = await scan({ roots: [root] })

    expect(result.projects.map((p) => p.name)).toEqual(['project'])
  })

  it('does not report the same project twice when two roots overlap', async () => {
    await file('dev/harness.yaml', 'name: "dev"\n')
    await dir('dev/repos/alpha')

    const result = await scan({ roots: [root, join(root, 'dev')] })

    expect(result.projects.map((p) => p.name).sort()).toEqual(['alpha', 'dev'])
  })

  it('leaves git null unless asked for it', async () => {
    await file('dev/harness.yaml', 'name: "dev"\n')
    const result = await scan({ roots: [join(root, 'dev')] })
    expect(result.projects.every((p) => p.git === null)).toBe(true)
  })
})

describe('reconciling the discovery cache', () => {
  const scanned = (
    roots: string[],
    projects: string[],
    errors: Array<{ path: string; message: string }> = []
  ): Parameters<typeof disprovedProjectPaths>[1] => ({
    roots,
    projects: projects.map((path) => ({
      path,
      name: path,
      kind: 'folder' as const,
      harnessPath: null,
      hasClaudeDir: false,
      inventory: EMPTY_INVENTORY,
      git: null
    })),
    errors
  })

  it('disproves a cached row a completed scan of its own root did not return', () => {
    const tool = join(root, 'tool')
    const cached = [join(tool, 'src'), join(tool, 'tests'), tool]

    expect(disprovedProjectPaths(cached, scanned([tool], [tool]))).toEqual([
      join(tool, 'src'),
      join(tool, 'tests')
    ])
  })

  it('keeps everything under a root the scan could not read', () => {
    // The unplugged drive. A row is only ever dropped where this pass can prove
    // it wrong, and a root that errored proves nothing about what is under it.
    const gone = join(root, 'gone')
    const cached = [join(gone, 'alpha')]

    expect(
      disprovedProjectPaths(cached, scanned([gone], [], [{ path: gone, message: 'not a directory' }]))
    ).toEqual([])
    // An error *below* the root is the same answer: the walk was incomplete.
    expect(
      disprovedProjectPaths(
        cached,
        scanned([gone], [], [{ path: join(gone, 'beta'), message: 'EPERM' }])
      )
    ).toEqual([])
  })

  it('keeps a cached row that belongs to no current root at all', () => {
    // Nothing scanned it, so nothing has an opinion about it. Removal is what
    // takes these, and it says so itself.
    const cached = [join(root, 'elsewhere', 'alpha')]
    expect(disprovedProjectPaths(cached, scanned([join(root, 'here')], []))).toEqual([])
  })

  it('matches roots and rows across two spellings of one directory', () => {
    const cached = [join(root, 'Tool', 'SRC')]
    const tool = join(root, 'tool')
    // On Windows `Tool/SRC` is under the `tool` root and the scan did not find
    // it, so it is disproved. On Linux it is a different directory under no
    // trusted root, and a row nothing looked at cannot be disproved.
    expect(disprovedProjectPaths(cached, scanned([tool], [tool]))).toEqual(
      process.platform === 'win32' ? [join(root, 'Tool', 'SRC')] : []
    )
    expect(disprovedProjectPaths(cached, scanned([tool], [join(root, 'tool', 'src')]))).toEqual([])
  })

  it('orphans the rows a removed root put there, and only those', () => {
    const removed = join(root, 'tool')
    const kept = join(root, 'work')
    const cached = [join(removed, 'src'), removed, join(kept, 'alpha')]

    expect(orphanedProjectPaths(cached, removed, [kept])).toEqual([join(removed, 'src'), removed])
  })

  it('keeps an orphan that another root still covers', () => {
    // Two overlapping roots, which the settings pane allows: dropping the inner
    // one may not take rows the outer one is still scanning.
    const outer = root
    const inner = join(root, 'tool')
    const cached = [join(inner, 'src')]

    expect(orphanedProjectPaths(cached, inner, [outer])).toEqual([])
  })
})

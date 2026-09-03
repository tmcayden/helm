import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, harnessNameProblems } from './harness'
import { scan } from './scan'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'helm-harness-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Every path under a directory, relative and sorted. */
async function tree(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    out.push(path.slice(base.length + 1).split('\\').join('/'))
    if (entry.isDirectory()) out.push(...(await tree(path, base)))
  }
  return out.sort()
}

describe('createHarness', () => {
  /*
   * These two are about the **minimal template**, and say so.
   *
   * They used to be about creation full stop - "scaffolds the minimum and
   * nothing else" over whatever `createHarness` did - which was the same claim
   * while there was only one thing it could do. A template writes its own tree,
   * so the exact-three-entries assertion is now a statement about `minimal`
   * specifically, and pinning it to every creation would have made adding a
   * template a red test rather than a new one. `minimal` is passed explicitly
   * even though it is the default: the point of the test is which scaffold is
   * being asserted about.
   */
  it('scaffolds the minimum and nothing else, for the minimal template', async () => {
    const result = await createHarness({
      mode: 'new',
      dir: root,
      name: 'work',
      template: 'minimal'
    })

    expect(result.problems).toEqual([])
    expect(result.path).toBe(join(root, 'work'))
    expect(await tree(join(root, 'work'))).toEqual(['.claude', 'harness.yaml', 'repos'])
  })

  it('defaults to the minimal template when none is named', async () => {
    const result = await createHarness({ mode: 'new', dir: root, name: 'work' })

    expect(result.created).toEqual(['repos', '.claude', 'harness.yaml'])
    expect(await tree(join(root, 'work'))).toEqual(['.claude', 'harness.yaml', 'repos'])
    expect(await readFile(join(root, 'work', 'harness.yaml'), 'utf8')).toMatch(
      /^template: "minimal"$/m
    )
  })

  it('writes four keys and no prose', async () => {
    await createHarness({ mode: 'new', dir: root, name: 'work', template: 'minimal' })
    const manifest = await readFile(join(root, 'work', 'harness.yaml'), 'utf8')

    const lines = manifest.trim().split('\n')
    expect(lines.map((l) => l.split(':')[0])).toEqual(['name', 'template', 'version', 'created'])
    expect(manifest).not.toMatch(/#/)
    expect(manifest).toMatch(/^name: "work"$/m)
    expect(manifest).toMatch(/^template: "minimal"$/m)
    expect(manifest).toMatch(/^created: "\d{4}-\d{2}-\d{2}T/m)
  })

  it('produces a harness the scanner immediately sees', async () => {
    const { path } = await createHarness({ mode: 'new', dir: root, name: 'work' })
    await mkdir(join(path as string, 'repos', 'alpha'), { recursive: true })

    const result = await scan({ roots: [path as string] })

    expect(result.harnesses.map((h) => h.name)).toEqual(['work'])
    expect(result.projects.map((p) => p.name).sort()).toEqual(['alpha', 'work'])
  })

  it('accepts a name with spaces and dashes', async () => {
    const result = await createHarness({ mode: 'new', dir: root, name: 'My Work-Space' })
    expect(result.problems).toEqual([])
    expect(result.path).toBe(join(root, 'My Work-Space'))
  })

  it('refuses a name that is not a folder name', async () => {
    for (const name of ['', '  ', 'a/b', 'a\\b', 'a:b', 'con', 'trailing.', '..']) {
      const result = await createHarness({ mode: 'new', dir: root, name })
      expect(result.path, name).toBeNull()
      expect(result.problems.length, name).toBeGreaterThan(0)
    }
  })

  it('refuses to write into a directory that already exists', async () => {
    await mkdir(join(root, 'work'))
    const result = await createHarness({ mode: 'new', dir: root, name: 'work' })
    expect(result.path).toBeNull()
    expect(result.problems).toEqual([`${join(root, 'work')} already exists.`])
  })

  it('converts a folder of repos in place without hiding them', async () => {
    await mkdir(join(root, 'alpha'), { recursive: true })
    await mkdir(join(root, 'beta'), { recursive: true })

    const result = await createHarness({ mode: 'convert', dir: root })
    expect(result.problems).toEqual([])
    expect(result.created).toContain('harness.yaml')

    const manifest = await readFile(join(root, 'harness.yaml'), 'utf8')
    expect(manifest).toMatch(/^repos: "\."$/m)

    const scanned = await scan({ roots: [root] })
    expect(scanned.harnesses).toHaveLength(1)
    expect(scanned.projects.map((p) => p.name).sort()).toEqual(
      ['alpha', 'beta', scanned.harnesses[0]?.name ?? ''].sort()
    )
  })

  it('omits `repos:` when converting a folder that already has repos/', async () => {
    await mkdir(join(root, 'repos', 'alpha'), { recursive: true })

    await createHarness({ mode: 'convert', dir: root })

    const manifest = await readFile(join(root, 'harness.yaml'), 'utf8')
    expect(manifest).not.toMatch(/^repos:/m)

    const scanned = await scan({ roots: [root] })
    expect(scanned.projects.map((p) => p.name)).toContain('alpha')
  })

  it('refuses to convert a directory that is already a harness', async () => {
    await writeFile(join(root, 'harness.yaml'), 'name: "already"\n')
    const result = await createHarness({ mode: 'convert', dir: root })
    expect(result.path).toBeNull()
    expect(result.problems).toEqual([`${root} is already a harness.`])
    // Names the harness that is already there, so the caller can add its root
    // rather than showing an error about a folder the launcher does not list -
    // which is what a WSL harness looks like, since no root ever covers one.
    expect(result.existing).toBe(root)
  })

  it('reports no existing harness for any other refusal', async () => {
    const missing = join(root, 'not-here')
    const notAFolder = await createHarness({ mode: 'convert', dir: missing })
    expect(notAFolder.path).toBeNull()
    expect(notAFolder.existing).toBeNull()

    // `new` over a directory that is already a harness stays a refusal with
    // nothing to adopt: the request named a folder to create, and one being
    // there is a collision rather than the thing that was asked for.
    const taken = join(root, 'taken')
    await mkdir(taken, { recursive: true })
    await writeFile(join(taken, 'harness.yaml'), 'name: "taken"\n')
    const collision = await createHarness({ mode: 'new', dir: root, name: 'taken' })
    expect(collision.path).toBeNull()
    expect(collision.problems).toEqual([`${taken} is already a harness.`])
    expect(collision.existing).toBeNull()
  })
})

describe('harnessNameProblems', () => {
  it('passes ordinary names', () => {
    for (const name of ['dev', 'my-work', 'Work Space', 'a1']) {
      expect(harnessNameProblems(name), name).toEqual([])
    }
  })
})

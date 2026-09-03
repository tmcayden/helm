import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanStaleShims,
  composeOverlayMemory,
  overlayPluginName,
  overlayPluginNames,
  planOverlays,
  probeProcess,
  syncOverlay,
  type ShimOwner,
  type ShimWorld
} from './overlay'

let root: string
let shimRoot: string

const STAMP = '.helm-overlay.json'

/**
 * A machine that has rebooted since the shim was stamped.
 *
 * Which is what "the previous run" means once the sweep asks about processes: a
 * pid recorded before this boot cannot name anything running now, so every
 * owner on the stamp is dead by construction and the probe is never consulted.
 * The tests that predate ownership all describe exactly that situation.
 */
function rebooted(): Partial<ShimWorld> {
  return { bootAtMs: Date.now() + 1000 }
}

function readOwners(dir: string): ShimOwner[] {
  const stamp: unknown = JSON.parse(readFileSync(join(dir, STAMP), 'utf8'))
  return (stamp as { owners?: ShimOwner[] }).owners ?? []
}

/** Rewrites a real shim's owner list, standing in for another Helm's claim. */
function setOwners(dir: string, owners: ShimOwner[] | undefined): void {
  const stamp: unknown = JSON.parse(readFileSync(join(dir, STAMP), 'utf8'))
  const next = { ...(stamp as Record<string, unknown>) }
  if (owners === undefined) delete next['owners']
  else next['owners'] = owners
  writeFileSync(join(dir, STAMP), JSON.stringify(next, null, 2))
}

/** A pid that is not this process, with a start time inside the current boot. */
function otherHelm(pid: number): ShimOwner {
  return { pid, startedAt: new Date().toISOString() }
}

/** A repo with a `.claude/` tree, the way the fixtures in `repos/` look. */
function makeProject(
  name: string,
  opts: { skills?: string[]; agents?: string[]; commands?: string[]; claudeMd?: string } = {}
): string {
  const dir = join(root, name)
  for (const skill of opts.skills ?? []) {
    mkdirSync(join(dir, '.claude', 'skills', skill), { recursive: true })
    writeFileSync(join(dir, '.claude', 'skills', skill, 'SKILL.md'), `# ${skill}\n`)
  }
  for (const agent of opts.agents ?? []) {
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'agents', `${agent}.md`), `# ${agent}\n`)
  }
  for (const command of opts.commands ?? []) {
    mkdirSync(join(dir, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'commands', `${command}.md`), `# ${command}\n`)
  }
  if (opts.claudeMd !== undefined) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), opts.claudeMd)
  }
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm-overlay-'))
  shimRoot = join(root, '.shims')
  mkdirSync(shimRoot, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('overlayPluginName', () => {
  it('uses the repo name, which is what skills get prefixed with', () => {
    expect(overlayPluginName('C:/repos/acme')).toBe('acme')
    expect(overlayPluginName('/home/x/repos/acme-reporting')).toBe('acme-reporting')
  })

  it('reduces to something a namespace can carry', () => {
    expect(overlayPluginName('/repos/Acme Project')).toBe('acme-project')
    expect(overlayPluginName('/repos/my repo!!')).toBe('my-repo')
  })

  it('falls back rather than producing an empty prefix', () => {
    expect(overlayPluginName('/repos/!!!')).toBe('overlay')
  })

  it('distinguishes same-named repos from different harnesses', () => {
    expect(overlayPluginNames(['/a/repos/acme', '/b/repos/acme'])).toEqual([
      'acme',
      'acme-2'
    ])
  })
})

describe('syncOverlay', () => {
  it('builds a plugin the CLI can load: manifest plus the convention dirs', () => {
    const project = makeProject('acme', { skills: ['think'], agents: ['reviewer'] })
    const [plan] = planOverlays([project], shimRoot)
    const shim = syncOverlay(plan!)

    expect(shim.name).toBe('acme')
    expect(shim.rebuilt).toBe(true)
    expect(shim.linked.sort()).toEqual(['agents', 'skills'])

    const manifest: unknown = JSON.parse(
      readFileSync(join(shim.dir, '.claude-plugin', 'plugin.json'), 'utf8')
    )
    expect(manifest).toMatchObject({ name: 'acme' })
    // Read through the link, which is the thing that has to work.
    expect(readFileSync(join(shim.dir, 'skills', 'think', 'SKILL.md'), 'utf8')).toBe('# think\n')
  })

  it('only links the convention dirs the source actually has', () => {
    const project = makeProject('bare', { skills: ['one'] })
    const [plan] = planOverlays([project], shimRoot)
    expect(syncOverlay(plan!).linked).toEqual(['skills'])
    expect(existsSync(join(shimRoot, 'overlay-bare', 'agents'))).toBe(false)
  })

  it('reuses an unchanged shim instead of rebuilding it', () => {
    const project = makeProject('acme', { skills: ['think'] })
    const [plan] = planOverlays([project], shimRoot)
    expect(syncOverlay(plan!).rebuilt).toBe(true)

    const [again] = planOverlays([project], shimRoot)
    expect(syncOverlay(again!).rebuilt).toBe(false)
  })

  it('rebuilds when the source .claude tree changes', () => {
    const project = makeProject('acme', { skills: ['think'] })
    syncOverlay(planOverlays([project], shimRoot)[0]!)

    mkdirSync(join(project, '.claude', 'skills', 'newer'), { recursive: true })
    writeFileSync(join(project, '.claude', 'skills', 'newer', 'SKILL.md'), '# newer\n')

    expect(syncOverlay(planOverlays([project], shimRoot)[0]!).rebuilt).toBe(true)
  })

  it('rebuilds when a convention dir appears that was not there before', () => {
    const project = makeProject('acme', { skills: ['think'] })
    expect(syncOverlay(planOverlays([project], shimRoot)[0]!).linked).toEqual(['skills'])

    mkdirSync(join(project, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(project, '.claude', 'agents', 'reviewer.md'), '# reviewer\n')

    const shim = syncOverlay(planOverlays([project], shimRoot)[0]!)
    expect(shim.rebuilt).toBe(true)
    expect(shim.linked.sort()).toEqual(['agents', 'skills'])
  })

  it('rebuilds when only CLAUDE.md changed, since that one is copied not linked', () => {
    const project = makeProject('acme', { skills: ['think'], claudeMd: '# first\n' })
    syncOverlay(planOverlays([project], shimRoot)[0]!)

    writeFileSync(join(project, 'CLAUDE.md'), '# second\n')
    expect(syncOverlay(planOverlays([project], shimRoot)[0]!).rebuilt).toBe(true)
  })

  /**
   * The rebuild path deletes the shim, and the shim's `skills` is a junction
   * into the real repository. Observed for real during a profile check run: the
   * source's skill directory was emptied by a rebuild, and the next session
   * loaded a plugin pointing at nothing. Asserted on the source, not on the
   * shim, because the shim being right is not the property that matters here.
   */
  it('a rebuild leaves the source repo untouched behind the junction', () => {
    const project = makeProject('acme', { skills: ['think'], agents: ['reviewer'] })
    syncOverlay(planOverlays([project], shimRoot)[0]!)

    // The edit that forces the rebuild.
    writeFileSync(join(project, '.claude', 'skills', 'think', 'SKILL.md'), '# edited\n')
    const shim = syncOverlay(planOverlays([project], shimRoot)[0]!)
    expect(shim.rebuilt).toBe(true)

    expect(readdirSync(join(project, '.claude', 'skills'))).toEqual(['think'])
    expect(readFileSync(join(project, '.claude', 'skills', 'think', 'SKILL.md'), 'utf8')).toBe(
      '# edited\n'
    )
    expect(existsSync(join(project, '.claude', 'agents', 'reviewer.md'))).toBe(true)
    // And the rebuilt shim reaches it.
    expect(readFileSync(join(shim.dir, 'skills', 'think', 'SKILL.md'), 'utf8')).toBe('# edited\n')
  })

  it('an edit to a skill is visible through the link without a rebuild', () => {
    const project = makeProject('acme', { skills: ['think'] })
    const shim = syncOverlay(planOverlays([project], shimRoot)[0]!)

    writeFileSync(join(project, '.claude', 'skills', 'think', 'SKILL.md'), '# edited\n')
    expect(readFileSync(join(shim.dir, 'skills', 'think', 'SKILL.md'), 'utf8')).toBe('# edited\n')
  })
})

/**
 * Junctions that lead nowhere, which is what a UNC target produces.
 *
 * Measured 2026-09-02 on Windows 11: `symlinkSync(target, path, 'junction')`
 * with a `\\wsl$\...` target **succeeds** and the link then resolves to
 * nothing - `existsSync`, `lstat`, `realpath` and `readdir` all say it is not
 * there. Every project inside a WSL distribution has such a path, so this was
 * reached by an ordinary overlay rather than by anything exotic.
 *
 * Windows-only: on any other platform `symlinkSync` ignores the `'junction'`
 * type and makes an ordinary symlink, which fails differently and is not the
 * thing being pinned here.
 */
describe.skipIf(process.platform !== 'win32')('a junction the filesystem will not resolve', () => {
  /** No distro of this name, so the test needs no WSL to run. */
  const UNREACHABLE = '\\\\wsl$\\HelmNoSuchDistro\\home\\me\\work'

  it('is still the premise: Windows creates one without complaining', () => {
    // If this ever starts throwing, `link`'s existence check has become
    // unnecessary rather than wrong - and this is what would say so.
    const path = join(shimRoot, 'premise')
    mkdirSync(shimRoot, { recursive: true })
    symlinkSync(UNREACHABLE, path, 'junction')
    expect(existsSync(path)).toBe(false)
    rmdirSync(path)
  })

  it('is never reported as a linked shim', () => {
    // Before the fix this returned `mode: 'junction'` with `linked: ['skills']`
    // and a dead link behind it, so the session got a `--plugin-dir` that
    // composed nothing and said nothing. Throwing is the right answer for a
    // source that genuinely cannot be read: the copy fallback has nothing to
    // copy from.
    expect(() =>
      syncOverlay({
        name: 'gone',
        projectPath: UNREACHABLE,
        dir: join(shimRoot, 'overlay-gone'),
        links: ['skills'],
        claudeMdPath: null
      })
    ).toThrow()

    expect(existsSync(join(shimRoot, 'overlay-gone', 'skills'))).toBe(false)
  })

  it('does not wedge the sweep when an older build left one behind', () => {
    // `lstat` on a dead link throws, so it used to be skipped - and then the
    // recursive delete found an entry it could not remove and failed with
    // ENOTEMPTY, taking every later shim's cleanup with it.
    const project = makeProject('acme', { skills: ['think'] })
    syncOverlay(planOverlays([project], shimRoot)[0]!)
    symlinkSync(UNREACHABLE, join(shimRoot, 'overlay-acme', 'stale'), 'junction')

    expect(cleanStaleShims(shimRoot, [], rebooted())).toEqual([join(shimRoot, 'overlay-acme')])
    expect(existsSync(join(shimRoot, 'overlay-acme'))).toBe(false)
    // And the source repo is untouched, which is the rule the sweep exists for.
    expect(readFileSync(join(project, '.claude', 'skills', 'think', 'SKILL.md'), 'utf8')).toBe(
      '# think\n'
    )
  })
})

describe('cleanStaleShims', () => {
  it('removes shims nothing asked to keep', () => {
    const a = makeProject('alpha', { skills: ['one'] })
    const b = makeProject('beta', { skills: ['two'] })
    syncOverlay(planOverlays([a], shimRoot)[0]!)
    syncOverlay(planOverlays([b], shimRoot)[0]!)

    const removed = cleanStaleShims(shimRoot, ['alpha'], rebooted())
    expect(removed).toEqual([join(shimRoot, 'overlay-beta')])
    expect(existsSync(join(shimRoot, 'overlay-alpha'))).toBe(true)
    expect(existsSync(join(shimRoot, 'overlay-beta'))).toBe(false)
  })

  it('removes every shim when nothing is running', () => {
    const a = makeProject('alpha', { skills: ['one'] })
    syncOverlay(planOverlays([a], shimRoot)[0]!)
    expect(cleanStaleShims(shimRoot, [], rebooted())).toHaveLength(1)
    expect(existsSync(join(shimRoot, 'overlay-alpha'))).toBe(false)
  })

  /**
   * The one that matters. A shim's subdirectories are junctions into the user's
   * real repo, so a cleanup that descended through them would delete the skills
   * it exists to expose.
   */
  it('unlinks junctions rather than deleting the repo behind them', () => {
    const project = makeProject('acme', { skills: ['think'], agents: ['reviewer'] })
    syncOverlay(planOverlays([project], shimRoot)[0]!)

    cleanStaleShims(shimRoot, [], rebooted())

    expect(existsSync(join(shimRoot, 'overlay-acme'))).toBe(false)
    expect(readFileSync(join(project, '.claude', 'skills', 'think', 'SKILL.md'), 'utf8')).toBe(
      '# think\n'
    )
    expect(existsSync(join(project, '.claude', 'agents', 'reviewer.md'))).toBe(true)
  })

  it('leaves directories that are not Helm shims alone', () => {
    mkdirSync(join(shimRoot, 'overlay-not-ours'), { recursive: true })
    writeFileSync(join(shimRoot, 'overlay-not-ours', 'keep.txt'), 'x')
    mkdirSync(join(shimRoot, 'unrelated'), { recursive: true })

    expect(cleanStaleShims(shimRoot, [], rebooted())).toEqual([])
    expect(existsSync(join(shimRoot, 'overlay-not-ours', 'keep.txt'))).toBe(true)
    expect(existsSync(join(shimRoot, 'unrelated'))).toBe(true)
  })

  it('is fine with a shim root that does not exist yet', () => {
    expect(cleanStaleShims(join(root, 'nope'))).toEqual([])
  })

  /** One per distinct session name, and nothing else ever collects them. */
  it('collects the composed instruction files too', () => {
    writeFileSync(join(shimRoot, 'memory-cloud-sync.md'), '# composed')
    writeFileSync(join(shimRoot, 'notes.md'), 'not ours')

    const removed = cleanStaleShims(shimRoot, [], rebooted())
    expect(removed).toEqual([join(shimRoot, 'memory-cloud-sync.md')])
    expect(existsSync(join(shimRoot, 'notes.md'))).toBe(true)
  })
})

/**
 * Who is allowed to delete a shim.
 *
 * The failure being ruled out is one process removing another's live
 * `--plugin-dir`: the session keeps running and silently loses its skills, so
 * there is no symptom to notice. Every case below is therefore written from the
 * sweep's point of view, and the ones with no clear answer assert that nothing
 * happened.
 */
describe('cleanStaleShims and the process holding the shim', () => {
  /** Builds a real shim and returns where it landed. */
  function plant(name: string): string {
    const project = makeProject(name, { skills: ['one'] })
    return syncOverlay(planOverlays([project], shimRoot)[0]!).dir
  }

  it('records this process as the owner of a shim it just built', () => {
    const dir = plant('alpha')
    expect(readOwners(dir)).toEqual([
      { pid: process.pid, startedAt: expect.any(String) as unknown as string }
    ])
  })

  it('leaves a shim whose owner is still running', () => {
    const dir = plant('alpha')
    setOwners(dir, [otherHelm(4321)])

    const removed = cleanStaleShims(shimRoot, [], { probe: () => 'alive' })
    expect(removed).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })

  it('removes a shim whose owner is gone', () => {
    const dir = plant('alpha')
    setOwners(dir, [otherHelm(4321)])

    expect(cleanStaleShims(shimRoot, [], { probe: () => 'gone' })).toEqual([dir])
    expect(existsSync(dir)).toBe(false)
  })

  /**
   * The pre-boot rule, which is what makes pid reuse safe rather than merely
   * unlikely: a pid recorded before this boot names nothing that is running
   * now, whatever the kernel says about the number today.
   */
  it('removes a shim stamped before the current boot even if the pid is live', () => {
    const dir = plant('alpha')
    setOwners(dir, [{ pid: 4321, startedAt: new Date(Date.now() - 86_400_000).toISOString() }])

    const removed = cleanStaleShims(shimRoot, [], {
      probe: () => 'alive',
      bootAtMs: Date.now() - 60_000
    })
    expect(removed).toEqual([dir])
    expect(existsSync(dir)).toBe(false)
  })

  it('leaves a shim when the kernel will not say', () => {
    const dir = plant('alpha')
    setOwners(dir, [otherHelm(4321)])

    expect(cleanStaleShims(shimRoot, [], { probe: () => 'unknown' })).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })

  it('leaves a shim when one of several owners is still running', () => {
    const dir = plant('alpha')
    setOwners(dir, [otherHelm(4321), otherHelm(8765)])

    const removed = cleanStaleShims(shimRoot, [], {
      probe: (pid) => (pid === 8765 ? 'alive' : 'gone')
    })
    expect(removed).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })

  it('removes a shim once every owner has gone', () => {
    const dir = plant('alpha')
    setOwners(dir, [otherHelm(4321), otherHelm(8765)])

    expect(cleanStaleShims(shimRoot, [], { probe: () => 'gone' })).toEqual([dir])
    expect(existsSync(dir)).toBe(false)
  })

  it('never removes a shim this process itself holds', () => {
    const dir = plant('alpha')
    // The probe would say gone for anything it is asked about; the self entry
    // must not reach it.
    expect(cleanStaleShims(shimRoot, [], { probe: () => 'gone' })).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })

  /**
   * A shim built by a Helm from before ownership was recorded. Nothing can be
   * said about who holds it, so the clock decides: within this boot it is left
   * alone, and the next boot collects it.
   */
  it('leaves a stamp with no owners that was built during this boot', () => {
    const dir = plant('alpha')
    setOwners(dir, undefined)

    expect(cleanStaleShims(shimRoot, [], { probe: () => 'gone' })).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })

  it('removes a stamp with no owners that predates this boot', () => {
    const dir = plant('alpha')
    setOwners(dir, undefined)

    const removed = cleanStaleShims(shimRoot, [], {
      probe: () => 'gone',
      bootAtMs: Date.now() + 1000
    })
    expect(removed).toEqual([dir])
    expect(existsSync(dir)).toBe(false)
  })

  /**
   * Re-syncing an unchanged shim adds this process to the list rather than
   * replacing it. Two Helms that launched the same profile both hold it, and a
   * sweep after the first exits must still find the second.
   */
  it('adds a claim to an unchanged shim instead of taking it over', () => {
    const project = makeProject('alpha', { skills: ['one'] })
    const plan = planOverlays([project], shimRoot)[0]!
    const dir = syncOverlay(plan).dir
    setOwners(dir, [otherHelm(4321)])
    // 4321 is nothing on this machine, and a claim that probes as gone would be
    // pruned - which is a different behaviour from the one under test.
    vi.spyOn(process, 'kill').mockReturnValue(true)

    expect(syncOverlay(plan).rebuilt).toBe(false)
    expect(readOwners(dir).map((owner) => owner.pid)).toEqual([4321, process.pid])
    vi.restoreAllMocks()
  })

  it('prunes owners that have gone when it claims one', () => {
    const project = makeProject('alpha', { skills: ['one'] })
    const plan = planOverlays([project], shimRoot)[0]!
    const dir = syncOverlay(plan).dir
    // Stamped before this boot, so the claim is dead however the pid probes.
    setOwners(dir, [{ pid: 4321, startedAt: new Date(0).toISOString() }])

    syncOverlay(plan)
    expect(readOwners(dir).map((owner) => owner.pid)).toEqual([process.pid])
  })
})

/**
 * The probe itself, against the kernel where the answer is unambiguous and
 * against a stubbed `process.kill` where it is not.
 *
 * `EPERM` is the case worth stubbing. A machine cannot be relied on to hold a
 * process this one may not signal - and the pid that would, on Windows, is a
 * protected system process, which is a brittle thing to build a test on - but
 * getting it wrong is what deletes a live session's plugin directory, so it is
 * not a branch to leave unexercised.
 */
describe('probeProcess', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('says a process that is running is alive', () => {
    expect(probeProcess(process.pid)).toBe('alive')
  })

  it('says a process that has exited is gone', () => {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    expect(child.status).toBe(0)
    expect(child.pid).toBeGreaterThan(0)
    expect(probeProcess(child.pid!)).toBe('gone')
  })

  it('reads a pid it may not signal as alive rather than absent', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('operation not permitted')
      err.code = 'EPERM'
      throw err
    })
    expect(probeProcess(4321)).toBe('alive')
  })

  it('says unknown for anything else the platform raises', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('invalid argument')
      err.code = 'EINVAL'
      throw err
    })
    expect(probeProcess(4321)).toBe('unknown')
  })
})

/**
 * And the sweep's own reading of an EPERM, end to end: the probe classifies,
 * `ownerVerdict` refuses to delete on anything but `gone`, and the directory is
 * still there afterwards.
 */
describe('cleanStaleShims against a pid it may not signal', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('leaves the shim', () => {
    const project = makeProject('alpha', { skills: ['one'] })
    const dir = syncOverlay(planOverlays([project], shimRoot)[0]!).dir
    setOwners(dir, [{ pid: 4321, startedAt: new Date().toISOString() }])

    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('operation not permitted')
      err.code = 'EPERM'
      throw err
    })

    expect(cleanStaleShims(shimRoot)).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })
})

describe('composeOverlayMemory', () => {
  it('carries each overlay CLAUDE.md, attributed to the project it governs', () => {
    const a = makeProject('acme', { skills: ['think'], claudeMd: '# Acme\nPyQt5 app.' })
    const b = makeProject('reporting', { skills: ['think'], claudeMd: '# Reporting\ndotnet API.' })
    const memory = composeOverlayMemory(planOverlays([a, b], shimRoot))

    expect(memory).not.toBeNull()
    expect(memory).toContain('PyQt5 app.')
    expect(memory).toContain('dotnet API.')
    // Attribution, because the instructions inside say "this repo" and the
    // session's cwd is neither of them.
    expect(memory).toContain(a)
    expect(memory).toContain(b)
  })

  it('is null when no overlay has one, so no flag gets emitted', () => {
    const project = makeProject('acme', { skills: ['think'] })
    expect(composeOverlayMemory(planOverlays([project], shimRoot))).toBeNull()
  })
})

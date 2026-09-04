import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { cleanStaleMcpConfigs, removeSessionMcpConfig, writeSessionMcpConfig } from './mcp'
import { buildLaunchArgs, prepareLaunch, prepareResume } from './plan'

let root: string
let shimRoot: string

function makeProject(name: string, claudeMd?: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, '.claude', 'skills', 'think'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'skills', 'think', 'SKILL.md'), `# ${name} think\n`)
  if (claudeMd !== undefined) writeFileSync(join(dir, 'CLAUDE.md'), claudeMd)
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm-plan-'))
  shimRoot = join(root, '.shims')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('buildLaunchArgs', () => {
  it('is just the name when nothing is composed', () => {
    expect(buildLaunchArgs({ root: '/x', name: 'plain' })).toEqual(['-n', 'plain'])
  })

  it('emits the flags the composition needs', () => {
    expect(
      buildLaunchArgs({
        root: '/x',
        name: 'cloud sync',
        access: ['/repos/a', '/repos/b'],
        pluginDirs: ['/shims/overlay-a'],
        memoryFile: '/shims/memory.md',
        model: 'opus',
        effort: 'high',
        permissionMode: 'auto',
        agent: 'reviewer'
      })
    ).toEqual([
      '--add-dir',
      resolve('/repos/a'),
      resolve('/repos/b'),
      '-n',
      'cloud sync',
      '--plugin-dir',
      '/shims/overlay-a',
      '--append-system-prompt-file',
      '/shims/memory.md',
      '--model',
      'opus',
      '--effort',
      'high',
      '--permission-mode',
      'auto',
      '--agent',
      'reviewer'
    ])
  })

  /**
   * `--add-dir` is variadic: it eats arguments until one starts with a dash. If
   * the opening prompt were reachable from it, `/recap` would be added as a
   * directory instead of submitted, and the session would start with neither.
   */
  it('terminates the variadic --add-dir before the opening prompt', () => {
    const argv = buildLaunchArgs({
      root: '/x',
      name: 'session',
      access: ['/repos/a'],
      openingPrompt: '/recap'
    })
    expect(argv).toEqual(['--add-dir', resolve('/repos/a'), '-n', 'session', '/recap'])
    expect(argv.indexOf('-n')).toBeGreaterThan(argv.indexOf('--add-dir'))
    expect(argv.at(-1)).toBe('/recap')
  })

  it('puts the opening prompt last, after every flag', () => {
    const argv = buildLaunchArgs({
      root: '/x',
      name: 'session',
      pluginDirs: ['/shims/a'],
      model: 'opus',
      openingPrompt: '/recap'
    })
    expect(argv.at(-1)).toBe('/recap')
  })

  it('omits an opening prompt that is only whitespace', () => {
    expect(buildLaunchArgs({ root: '/x', name: 's', openingPrompt: '   ' })).toEqual(['-n', 's'])
  })

  it('passes each access dir once, however many times it was listed', () => {
    const argv = buildLaunchArgs({
      root: '/x',
      name: 's',
      access: ['/repos/a', '/repos/a/', '/repos/A']
    })
    expect(argv.filter((a) => a !== '-n' && a !== 's' && a !== '--add-dir')).toHaveLength(1)
  })
})

describe('the assigned conversation id', () => {
  const uuid = '7b3d1c20-4a55-4f18-9c21-8e0c5a6d1f01'

  it('goes on the argv as --session-id, after -n and before the prompt', () => {
    const argv = buildLaunchArgs({
      root: '/x',
      name: 'plain',
      sessionId: uuid,
      openingPrompt: 'review this'
    })
    const at = argv.indexOf('--session-id')
    expect(at).toBeGreaterThan(argv.indexOf('-n'))
    expect(argv[at + 1]).toBe(uuid)
    // The opening prompt is positional, so every flag has to be behind it.
    expect(argv.at(-1)).toBe('review this')
  })

  it('passes no flag at all where the caller assigned none', () => {
    // A CLI with no `--session-id` gets exactly the argv it got before this
    // existed. An unrecognised flag is a launch that fails outright, which is
    // worth strictly more than the join it would have bought.
    expect(buildLaunchArgs({ root: '/x', name: 'plain' })).not.toContain('--session-id')
    expect(buildLaunchArgs({ root: '/x', name: 'plain', sessionId: null })).not.toContain(
      '--session-id'
    )
  })

  it('is reported back on the plan so the row does not re-parse the argv', () => {
    const plan = prepareLaunch({ root, name: 'assigned', shimRoot, sessionId: uuid })
    expect(plan.claudeSessionId).toBe(uuid)
    expect(plan.argv[plan.argv.indexOf('--session-id') + 1]).toBe(uuid)

    const none = prepareLaunch({ root, name: 'unassigned', shimRoot })
    expect(none.claudeSessionId).toBeNull()
    expect(none.argv).not.toContain('--session-id')
  })
})

describe('prepareLaunch', () => {
  it('composes two overlays into one launch', () => {
    const a = makeProject('acme', '# Acme\nPyQt5 desktop app.')
    const b = makeProject('acme-reporting', '# Reporting\ndotnet sync receiver.')

    const plan = prepareLaunch({
      root,
      name: 'cloud sync',
      overlays: [a, b],
      access: [a, b],
      shimRoot,
      model: 'opus',
      openingPrompt: '/recap'
    })

    expect(plan.cwd).toBe(resolve(root))
    expect(plan.overlays.map((o) => o.name)).toEqual(['acme', 'acme-reporting'])

    // Both shims on the argv, as separate repeated flags.
    expect(plan.argv.filter((a2) => a2 === '--plugin-dir')).toHaveLength(2)
    for (const shim of plan.overlays) expect(plan.argv).toContain(shim.dir)

    // And the composed instructions, which is the part `--add-dir` does not do.
    expect(plan.memoryFile).not.toBeNull()
    const memory = readFileSync(plan.memoryFile!, 'utf8')
    expect(memory).toContain('PyQt5 desktop app.')
    expect(memory).toContain('dotnet sync receiver.')
    expect(plan.argv).toContain('--append-system-prompt-file')
    expect(plan.warnings).toEqual([])
  })

  it('emits no memory flag when no overlay has a CLAUDE.md', () => {
    const a = makeProject('acme')
    const plan = prepareLaunch({ root, name: 's', overlays: [a], shimRoot })
    expect(plan.memoryFile).toBeNull()
    expect(plan.argv).not.toContain('--append-system-prompt-file')
    expect(plan.warnings).toContain('No overlay had a CLAUDE.md, so no project instructions were composed.')
  })

  it('skips an overlay whose directory has gone and says so', () => {
    const a = makeProject('acme', '# Acme')
    const gone = join(root, 'deleted')
    const plan = prepareLaunch({ root, name: 's', overlays: [a, gone], shimRoot })

    expect(plan.overlays.map((o) => o.name)).toEqual(['acme'])
    expect(plan.warnings.some((w) => w.includes('deleted'))).toBe(true)
  })

  it('reuses shims across launches and rebuilds when the source changed', () => {
    const a = makeProject('acme', '# Acme')
    expect(prepareLaunch({ root, name: 's', overlays: [a], shimRoot }).overlays[0]?.rebuilt).toBe(
      true
    )
    expect(prepareLaunch({ root, name: 's', overlays: [a], shimRoot }).overlays[0]?.rebuilt).toBe(
      false
    )

    writeFileSync(join(a, '.claude', 'skills', 'think', 'SKILL.md'), '# edited\n')
    expect(prepareLaunch({ root, name: 's', overlays: [a], shimRoot }).overlays[0]?.rebuilt).toBe(
      true
    )
  })

  /**
   * Two profiles can be open at once, and the second one's launch must not
   * remove the first one's plugin directory - a live session reads skills out
   * of it. Sweeping is `cleanStaleShims`, at app start.
   */
  it('leaves another profile’s shim in place', () => {
    const a = makeProject('alpha', '# A')
    const b = makeProject('beta', '# B')
    const first = prepareLaunch({ root, name: 'first', overlays: [a], shimRoot })
    prepareLaunch({ root, name: 'second', overlays: [b], shimRoot })

    expect(readFileSync(join(first.overlays[0]!.dir, '.claude-plugin', 'plugin.json'), 'utf8')).toContain(
      'alpha'
    )
  })

  /*
   * Helm's own MCP endpoint, registered per session.
   *
   * The two halves are asserted together on purpose: an argv carrying
   * `--mcp-config` and no file, or a file nothing points at, are both states
   * that would look fine from one side.
   */
  describe('the per-session MCP registration', () => {
    const browserServer = {
      name: 'helm-browser',
      url: 'http://127.0.0.1:51234/mcp',
      headers: { Authorization: 'Bearer 0123456789abcdef' }
    }
    // The second family, on the same port and the same token, at its own route.
    const sessionsServer = {
      name: 'helm-sessions',
      url: 'http://127.0.0.1:51234/mcp/sessions',
      headers: { Authorization: 'Bearer 0123456789abcdef' }
    }

    it('writes a file under the directory it was given and points the argv at it', () => {
      const dir = join(root, 'mcp')
      const plan = prepareLaunch({ root, name: 'with tools', shimRoot, mcp: { dir, servers: [browserServer] } })

      expect(plan.mcpConfigFile).not.toBeNull()
      expect(resolve(plan.mcpConfigFile!)).toBe(resolve(join(dir, basename(plan.mcpConfigFile!))))
      const at = plan.argv.indexOf('--mcp-config')
      expect(at).toBeGreaterThan(-1)
      expect(plan.argv[at + 1]).toBe(plan.mcpConfigFile)

      const written = JSON.parse(readFileSync(plan.mcpConfigFile!, 'utf8')) as {
        mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
      }
      expect(written.mcpServers['helm-browser']).toEqual({
        type: 'http',
        url: browserServer.url,
        headers: browserServer.headers
      })
    })

    it('passes no flag at all when there is nothing to register', () => {
      const plan = prepareLaunch({ root, name: 'no tools', shimRoot })
      expect(plan.mcpConfigFile).toBeNull()
      expect(plan.argv).not.toContain('--mcp-config')
    })

    /*
     * Two families of tools, two names, one document - and one route each.
     *
     * The whole of what "two servers on one listener" costs a session: two keys
     * under `mcpServers`, the same port and the same bearer token in both. The
     * urls are asserted to differ because a second name pointed at the same
     * route would be one server registered twice, which is a client that lists
     * every tool under both names.
     */
    it('writes one key per server, sharing the port and the token', () => {
      const dir = join(root, 'mcp')
      const plan = prepareLaunch({
        root,
        name: 'both families',
        shimRoot,
        mcp: { dir, servers: [browserServer, sessionsServer] }
      })

      const written = JSON.parse(readFileSync(plan.mcpConfigFile!, 'utf8')) as {
        mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
      }
      expect(Object.keys(written.mcpServers).sort()).toEqual(['helm-browser', 'helm-sessions'])
      expect(written.mcpServers['helm-sessions']?.url).toBe(sessionsServer.url)
      expect(written.mcpServers['helm-sessions']?.url).not.toBe(browserServer.url)
      expect(written.mcpServers['helm-sessions']?.headers).toEqual(browserServer.headers)
      // One `--mcp-config`, not one per server.
      expect(plan.argv.filter((word) => word === '--mcp-config')).toHaveLength(1)
    })

    /*
     * And one family alone, which is what a tick switched off produces.
     *
     * This is the assertion that makes "off is off" a claim about the argv
     * rather than about the endpoint: with the browser tools off and the
     * session tools on, the document exists and the name that is off is simply
     * not in it.
     */
    it('leaves a switched-off family out of the document entirely', () => {
      const dir = join(root, 'mcp')
      const plan = prepareLaunch({
        root,
        name: 'sessions only',
        shimRoot,
        mcp: { dir, servers: [sessionsServer] }
      })
      const written = JSON.parse(readFileSync(plan.mcpConfigFile!, 'utf8')) as {
        mcpServers: Record<string, unknown>
      }
      expect(Object.keys(written.mcpServers)).toEqual(['helm-sessions'])
      expect(readFileSync(plan.mcpConfigFile!, 'utf8')).not.toContain('helm-browser')
    })

    /** Both off is the same outcome as no endpoint at all: no file, no flag. */
    it('writes nothing at all for an empty list', () => {
      const dir = join(root, 'mcp')
      const plan = prepareLaunch({ root, name: 'neither', shimRoot, mcp: { dir, servers: [] } })
      expect(plan.mcpConfigFile).toBeNull()
      expect(plan.argv).not.toContain('--mcp-config')
      expect(writeSessionMcpConfig(dir, [])).toBeNull()
    })

    it('gives two sessions two files, so releasing one cannot disarm the other', () => {
      const dir = join(root, 'mcp')
      const first = prepareLaunch({ root, name: 'one', shimRoot, mcp: { dir, servers: [browserServer] } })
      const second = prepareLaunch({ root, name: 'two', shimRoot, mcp: { dir, servers: [browserServer] } })
      expect(first.mcpConfigFile).not.toBe(second.mcpConfigFile)
    })

    /**
     * The flag lands where the CLI can read it: after `-n`, which terminates
     * the variadic `--add-dir` list, and before the positional prompt.
     */
    it('sits between the name and the opening prompt', () => {
      const dir = join(root, 'mcp')
      const plan = prepareLaunch({
        root,
        name: 'ordered',
        shimRoot,
        access: [root],
        openingPrompt: 'go',
        mcp: { dir, servers: [browserServer] }
      })
      const at = plan.argv.indexOf('--mcp-config')
      expect(at).toBeGreaterThan(plan.argv.indexOf('-n'))
      expect(at + 1).toBeLessThan(plan.argv.length - 1)
      expect(plan.argv[plan.argv.length - 1]).toBe('go')
    })
  })
})

describe('the ephemeral MCP config sweep', () => {
  const browserServer = {
    name: 'helm-browser',
    url: 'http://127.0.0.1:51234/mcp',
    headers: { Authorization: 'Bearer 0123456789abcdef' }
  }

  it('removes what a dead process left and keeps everything else', () => {
    const dir = join(root, 'mcp')
    const mine = writeSessionMcpConfig(dir, [browserServer])!
    writeFileSync(join(dir, 'mcp-999999-deadbeef.json'), '{}')
    writeFileSync(join(dir, 'mcp-424242-c0ffee.json'), '{}')
    writeFileSync(join(dir, 'not-ours.json'), '{}')

    // `999999` is gone; `424242` answers EPERM, which means alive.
    const removed = cleanStaleMcpConfigs(dir, (pid) =>
      pid === 999999 ? 'gone' : pid === 424242 ? 'alive' : 'unknown'
    )

    expect(removed.map((path) => basename(path))).toEqual(['mcp-999999-deadbeef.json'])
    // This process's own file is not stale, whatever the probe says about it.
    expect(existsSync(mine)).toBe(true)
    expect(existsSync(join(dir, 'mcp-424242-c0ffee.json'))).toBe(true)
    expect(existsSync(join(dir, 'not-ours.json'))).toBe(true)
  })

  it('leaves a file alone when the owner cannot be established', () => {
    const dir = join(root, 'mcp')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mcp-777777-abc123.json'), '{}')
    expect(cleanStaleMcpConfigs(dir, () => 'unknown')).toEqual([])
    expect(existsSync(join(dir, 'mcp-777777-abc123.json'))).toBe(true)
  })

  it('removes one by name, and says nothing about one that is already gone', () => {
    const dir = join(root, 'mcp')
    const file = writeSessionMcpConfig(dir, [browserServer])!
    removeSessionMcpConfig(file)
    expect(existsSync(file)).toBe(false)
    expect(() => {
      removeSessionMcpConfig(file)
      removeSessionMcpConfig(null)
    }).not.toThrow()
  })
})

describe('a WSL target', () => {
  /**
   * The translation is asserted on the **argv**, never on the plan's `cwd`.
   *
   * `wsl.exe --cd` takes a Windows path and translates it itself (measured
   * 2026-09-02), and the pty is opened with that path - so a plan whose `cwd`
   * had been translated would be a pty opened on a directory this process
   * cannot see. The argv is the half the CLI inside the distro reads.
   */
  it('translates every path on the argv and leaves the cwd alone', () => {
    const project = makeProject('acme', '# Acme\n')
    const plan = prepareLaunch({
      root,
      name: 'wsl session',
      overlays: [project],
      access: [project],
      shimRoot,
      target: { kind: 'wsl', distro: 'Ubuntu' }
    })

    expect(plan.target).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    // The pty's cwd stays in this process's own spelling.
    expect(plan.cwd).toBe(resolve(root))
    // ... and so do the files this process wrote.
    expect(plan.memoryFile).not.toBeNull()
    expect(existsSync(plan.memoryFile as string)).toBe(true)

    // Nothing the distro will open may still be Windows-spelled.
    for (const flag of ['--add-dir', '--plugin-dir', '--append-system-prompt-file']) {
      const at = plan.argv.indexOf(flag)
      expect(at, `${flag} is on the argv`).toBeGreaterThanOrEqual(0)
      const value = plan.argv[at + 1] ?? ''
      expect(value.startsWith('/'), `${flag} value ${value} is a distro path`).toBe(true)
      expect(value).not.toMatch(/^[A-Za-z]:/)
    }
  })

  it('is the identity for a Windows target', () => {
    const project = makeProject('acme', '# Acme\n')
    const plan = prepareLaunch({
      root,
      name: 'windows session',
      overlays: [project],
      access: [project],
      shimRoot,
      target: { kind: 'windows' }
    })
    expect(plan.argv).toContain(resolve(project))
    expect(plan.target).toEqual({ kind: 'windows' })
  })

  it('defaults to Windows when no target is given', () => {
    // Every caller that existed before targets did takes this branch.
    const plan = prepareLaunch({ root, name: 'untargeted', shimRoot })
    expect(plan.target).toEqual({ kind: 'windows' })
  })

  it('warns about a path with no spelling inside the distro rather than passing it through', () => {
    // A UNC path into a *different* distro: `/home/me` in Debian is not
    // `/home/me` in Ubuntu, so passing it through would grant the wrong tree.
    const plan = prepareLaunch({
      root,
      name: 'mismatched',
      access: ['\\\\wsl$\\Debian\\home\\me'],
      shimRoot,
      target: { kind: 'wsl', distro: 'Ubuntu' }
    })
    expect(plan.argv).not.toContain('--add-dir')
    // Dropped silently would be a session quietly granted nothing.
    expect(plan.warnings.join(' ')).toMatch(/Debian/)
  })
})

describe('a project that lives inside a distro', () => {
  /**
   * The inference is a correctness requirement, not a convenience: a Windows
   * process cannot be spawned with a UNC working directory at all - measured
   * 2026-09-02, `CreateProcess` answers ENOENT - so this profile on the
   * Windows target is a session that never starts.
   */
  it('runs in that distro even though the profile says Windows', () => {
    const plan = prepareLaunch({
      root: '\\\\wsl$\\Ubuntu\\home\\me\\harness',
      name: 'resident',
      shimRoot,
      target: { kind: 'windows' }
    })
    expect(plan.target).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
  })

  it('says so when the profile named a different distro', () => {
    // A real contradiction rather than an unset field, so it earns a sentence.
    const plan = prepareLaunch({
      root: '\\\\wsl$\\Ubuntu\\home\\me\\harness',
      name: 'mismatched',
      shimRoot,
      target: { kind: 'wsl', distro: 'Debian' }
    })
    expect(plan.target).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    expect(plan.warnings.join(' ')).toMatch(/Debian/)
  })
})

/**
 * A resume into a distro, which for a while handed the CLI a Windows path.
 *
 * `--mcp-config C:\Users\...\mcp-1234-abc.json` inside a distro is not a
 * session missing a feature - the shell eats the backslashes, the remains
 * resolve against the cwd, and the CLI refuses to start on a path nothing could
 * have created. Measured 2026-09-03; the reported error named
 * `<cwd>/C:Users...json`, which is that mangling exactly.
 */
describe('prepareResume', () => {
  const ID = '7d2b0a1e-0000-4000-8000-000000000001'
  const CONFIG = 'C:\\Users\\me\\AppData\\Roaming\\Helm\\mcp\\mcp-1234-abcdef012345.json'

  it('is the id alone when the host wrote no config', () => {
    expect(prepareResume({ sessionId: ID }).argv).toEqual(['--resume', ID])
  })

  it('leaves a Windows target’s path alone', () => {
    const { argv, warnings } = prepareResume({ sessionId: ID, mcpConfigFile: CONFIG })
    expect(argv).toEqual(['--resume', ID, '--mcp-config', CONFIG])
    expect(warnings).toEqual([])
  })

  it('translates the config path for a distro, and never passes a drive letter', () => {
    const { argv, warnings } = prepareResume({
      sessionId: ID,
      mcpConfigFile: CONFIG,
      target: { kind: 'wsl', distro: 'Ubuntu' }
    })
    const at = argv.indexOf('--mcp-config')
    expect(at).toBeGreaterThan(-1)
    expect(argv[at + 1]).toBe(
      '/mnt/c/Users/me/AppData/Roaming/Helm/mcp/mcp-1234-abcdef012345.json'
    )
    // The whole of the bug, stated as the thing that must never be on the argv.
    expect(argv.join(' ')).not.toContain('\\')
    expect(argv.join(' ')).not.toMatch(/[A-Za-z]:/)
    expect(warnings).toEqual([])
  })

  it('drops the flag rather than passing a path the distro has no spelling for', () => {
    const { argv, warnings } = prepareResume({
      sessionId: ID,
      // Another distro's filesystem. `toWslPath` refuses it rather than
      // approximating, and a resume must not then fall back to the raw path.
      mcpConfigFile: '\\\\wsl$\\Debian\\home\\me\\mcp.json',
      target: { kind: 'wsl', distro: 'Ubuntu' }
    })
    expect(argv).toEqual(['--resume', ID])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Ubuntu')
  })

  it('still passes no -n, so resuming cannot rename the conversation', () => {
    const { argv } = prepareResume({
      sessionId: ID,
      mcpConfigFile: CONFIG,
      target: { kind: 'wsl', distro: 'Ubuntu' }
    })
    expect(argv).not.toContain('-n')
    expect(argv.indexOf(ID)).toBe(argv.indexOf('--resume') + 1)
  })
})

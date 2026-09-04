import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../store/db'
import { countConfigSnapshots, readConfigSnapshots } from '../store/config'
import { computeEffectiveView, projectEntry } from './effective'
import { diffLines, previewMcpAdd } from './mcp'
import { projectConfigScope, readConfigTree, userConfigScope } from './tree'
import { readConfigFileContent, restoreConfigSnapshot, writeConfigFile } from './write'

/**
 * The config console's core, against a real directory rather than a mock.
 *
 * Everything here is about files on disk, and a filesystem stubbed well enough
 * to be worth testing against is a filesystem. `mkdtemp` costs a millisecond.
 */

let root: string
let store: Store

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function write(relPath: string, content: string): string {
  const path = join(root, relPath)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm-config-'))
  store = openStore({ file: ':memory:' })
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

describe('readConfigTree', () => {
  it('names a skill after its directory and a command after its path', () => {
    write('.claude/skills/think/SKILL.md', '---\nname: think\ndescription: Ponder.\n---\n# Think\n')
    write('.claude/skills/deep/nested/SKILL.md', '# Nested\n')
    write('.claude/commands/spec/plan.md', '# Plan\n')
    write('.claude/agents/reviewer.md', '---\ndescription: Reviews.\n---\n')

    const tree = readConfigTree(projectConfigScope(root))
    const named = new Map(tree.files.map((file) => [file.name, file]))

    // The directory is the skill, not the file - `skills/think/SKILL.md` is
    // invoked as `think`, and a listing that said `SKILL.md` would name four
    // files identically.
    expect(named.get('think')?.kind).toBe('skill')
    expect(named.get('think')?.description).toBe('Ponder.')
    expect(named.get('nested')?.kind).toBe('skill')
    // A command's namespace is its path: `commands/spec/plan.md` is `/spec:plan`.
    expect(named.get('spec:plan')?.kind).toBe('command')
    expect(named.get('reviewer')?.kind).toBe('agent')
  })

  it('lists a skill resource as `other` rather than as a second skill', () => {
    write('.claude/skills/think/SKILL.md', '# Think\n')
    write('.claude/skills/think/reference.md', '# Reference\n')

    const tree = readConfigTree(projectConfigScope(root))
    expect(tree.files.filter((file) => file.kind === 'skill')).toHaveLength(1)
    expect(tree.files.some((file) => file.kind === 'other' && file.relPath.endsWith('reference.md'))).toBe(true)
  })

  it('includes CLAUDE.md and .mcp.json, which sit beside .claude rather than in it', () => {
    write('CLAUDE.md', '# Instructions\n')
    write('.mcp.json', '{"mcpServers":{}}\n')

    const tree = readConfigTree(projectConfigScope(root))
    expect(tree.files.map((file) => file.kind).sort()).toEqual(['claude-md', 'mcp'])
  })

  it('has files for a project with no .claude directory at all', () => {
    write('CLAUDE.md', '# Only this\n')
    const scope = projectConfigScope(root)
    expect(scope.exists).toBe(true)
    expect(readConfigTree(scope).files).toHaveLength(1)
  })

  it('treats the user scope as the .claude directory itself', () => {
    const home = join(root, 'fakehome')
    mkdirSync(join(home, 'skills', 'alpha'), { recursive: true })
    writeFileSync(join(home, 'skills', 'alpha', 'SKILL.md'), '# Alpha\n')
    writeFileSync(join(home, 'settings.json'), '{}')

    const tree = readConfigTree(userConfigScope(home))
    const kinds = tree.files.map((file) => file.kind).sort()
    expect(kinds).toEqual(['settings', 'skill'])
  })

  it('marks a non-text file as binary rather than offering to edit it', () => {
    write('.claude/hooks/tool.exe', 'MZ\u0000\u0000')
    const tree = readConfigTree(projectConfigScope(root))
    expect(tree.files[0]?.binary).toBe(true)
  })
})

describe('writeConfigFile', () => {
  const scopeWrite = (relPath: string, content: string, expectedHash: string | null) =>
    writeConfigFile(store, {
      scopePath: root,
      path: join(root, relPath),
      content,
      expectedHash,
      reason: 'edit'
    })

  it('snapshots the previous bytes before replacing them', () => {
    const path = write('.claude/settings.json', '{"model":"opus"}')
    const before = readConfigFileContent(path)

    const result = scopeWrite('.claude/settings.json', '{"model":"haiku"}', before.hash)

    expect(result.ok).toBe(true)
    expect(result.snapshotId).not.toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('{"model":"haiku"}')

    const versions = readConfigSnapshots(store, root, '.claude/settings.json')
    expect(versions).toHaveLength(1)
    expect(versions[0]?.contentHash).toBe(sha256('{"model":"opus"}'))
  })

  it('refuses when the bytes on disk are not the ones the editor was based on', () => {
    const path = write('.claude/settings.json', '{"a":1}')
    const stale = readConfigFileContent(path).hash
    // Somebody else edits it. This is criterion 6, and the guarantee behind it
    // is here rather than in the watcher - it holds whether or not `fs.watch`
    // ever said anything, and across a change made while Helm was not running.
    writeFileSync(path, '{"a":2}')

    const result = scopeWrite('.claude/settings.json', '{"a":3}', stale)

    expect(result.ok).toBe(false)
    expect(result.conflict?.onDiskContent).toBe('{"a":2}')
    expect(readFileSync(path, 'utf8')).toBe('{"a":2}')
    expect(countConfigSnapshots(store)).toBe(0)
  })

  it('treats a file that has appeared as a conflict for a create', () => {
    write('.claude/settings.json', '{"a":1}')
    const result = scopeWrite('.claude/settings.json', '{"a":2}', null)
    expect(result.ok).toBe(false)
    expect(result.conflict).toBeDefined()
  })

  it('writes a new file, recording that there was nothing there', () => {
    const result = scopeWrite('.claude/settings.json', '{"new":true}', null)
    expect(result.ok).toBe(true)
    const versions = readConfigSnapshots(store, root, '.claude/settings.json')
    expect(versions[0]?.reason).toBe('create')
    expect(versions[0]?.bytes).toBe(0)
  })

  it('does nothing, and snapshots nothing, when the content is unchanged', () => {
    const path = write('.claude/settings.json', '{"a":1}')
    const hash = readConfigFileContent(path).hash
    const result = scopeWrite('.claude/settings.json', '{"a":1}', hash)
    expect(result.unchanged).toBe(true)
    expect(result.snapshotId).toBeNull()
    expect(countConfigSnapshots(store)).toBe(0)
  })

  it('refuses a path outside the scope', () => {
    expect(() =>
      writeConfigFile(store, {
        scopePath: root,
        path: join(root, '..', 'elsewhere.json'),
        content: '{}',
        expectedHash: null,
        reason: 'edit'
      })
    ).toThrow(/not inside/)
  })

  it('refuses a path inside the scope that is not configuration', () => {
    expect(() => scopeWrite('src/index.ts', 'nope', null)).toThrow(/configuration/)
  })
})

describe('restoreConfigSnapshot', () => {
  it('brings back the exact prior bytes', () => {
    const path = write('.claude/settings.json', '{"model":"opus"}\n')
    const original = readConfigFileContent(path)

    writeConfigFile(store, {
      scopePath: root,
      path,
      content: '{"model":"haiku"}\n',
      expectedHash: original.hash,
      reason: 'edit'
    })

    const [version] = readConfigSnapshots(store, root, '.claude/settings.json')
    expect(version).toBeDefined()
    const restored = restoreConfigSnapshot(store, version?.id ?? -1, path)

    expect(restored.ok).toBe(true)
    // Byte-for-byte, which is the claim the criterion actually makes.
    expect(readFileSync(path, 'utf8')).toBe('{"model":"opus"}\n')
    expect(restored.file.hash).toBe(original.hash)
  })

  it('snapshots what it is discarding, so an undo can be undone', () => {
    const path = write('.claude/settings.json', 'one')
    const first = readConfigFileContent(path).hash
    writeConfigFile(store, { scopePath: root, path, content: 'two', expectedHash: first, reason: 'edit' })

    const [version] = readConfigSnapshots(store, root, '.claude/settings.json')
    restoreConfigSnapshot(store, version?.id ?? -1, path)

    const versions = readConfigSnapshots(store, root, '.claude/settings.json')
    expect(versions).toHaveLength(2)
    expect(versions[0]?.reason).toBe('restore')
    // The restore recorded `two`, so going forward again is possible.
    expect(versions[0]?.contentHash).toBe(sha256('two'))
  })

  it('removes the file when the version being restored is one that did not exist', () => {
    const path = join(root, '.claude', 'settings.json')
    writeConfigFile(store, { scopePath: root, path, content: '{}', expectedHash: null, reason: 'edit' })

    const [created] = readConfigSnapshots(store, root, '.claude/settings.json')
    expect(created?.reason).toBe('create')
    restoreConfigSnapshot(store, created?.id ?? -1, path)

    // An empty `settings.json` is a parse error; an absent one is a layer the
    // CLI skips. Restoring "there was nothing here" has to produce the second.
    expect(readConfigFileContent(path).exists).toBe(false)
  })
})

describe('computeEffectiveView', () => {
  function fixture(): { cwd: string; home: string; alpha: string; beta: string } {
    const cwd = join(root, 'workspace')
    const home = join(root, 'home', '.claude')
    const alpha = join(root, 'repos', 'alpha')
    const beta = join(root, 'repos', 'beta')

    mkdirSync(join(home, 'skills', 'userskill'), { recursive: true })
    writeFileSync(join(home, 'skills', 'userskill', 'SKILL.md'), '# User\n')
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'opus', env: { A: 'user' } }))
    writeFileSync(join(home, 'CLAUDE.md'), '# user instructions\n')

    for (const [repo, extra] of [
      [alpha, 'alpha-only'],
      [beta, 'beta-only']
    ] as const) {
      mkdirSync(join(repo, '.claude', 'skills', 'think'), { recursive: true })
      writeFileSync(join(repo, '.claude', 'skills', 'think', 'SKILL.md'), `# think in ${extra}\n`)
      mkdirSync(join(repo, '.claude', 'skills', extra), { recursive: true })
      writeFileSync(join(repo, '.claude', 'skills', extra, 'SKILL.md'), `# ${extra}\n`)
      writeFileSync(join(repo, 'CLAUDE.md'), `# ${extra} instructions\n`)
    }

    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ env: { A: 'project', B: 'project' } })
    )
    writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ env: { A: 'local' } }))

    return { cwd, home, alpha, beta }
  }

  it('predicts an overlay namespace per Spike A', () => {
    const { cwd, home, alpha, beta } = fixture()
    const view = computeEffectiveView({ cwd, overlays: [alpha, beta], userHome: home })

    const invocations = view.skills.map((skill) => skill.invocation).sort()
    expect(invocations).toEqual([
      'alpha:alpha-only',
      'alpha:think',
      'beta:beta-only',
      'beta:think',
      'userskill'
    ])
  })

  it('shows a same-named skill under both namespaces rather than as a collision', () => {
    const { cwd, home, alpha, beta } = fixture()
    const view = computeEffectiveView({ cwd, overlays: [alpha, beta], userHome: home })

    // The platform namespaces everything a plugin contributes, so two overlays
    // defining `think` both resolve. There is nothing to detect and everything
    // to predict.
    const shared = view.sharedNames.find((entry) => entry.name === 'think')
    expect(shared?.invocations).toEqual(['alpha:think', 'beta:think'])
  })

  it('resolves settings per leaf, local over project over user', () => {
    const { cwd, home, alpha } = fixture()
    const view = computeEffectiveView({ cwd, overlays: [alpha], userHome: home })
    const byKey = new Map(view.settings.map((setting) => [setting.key, setting]))

    // Measured against the CLI on 2.1.225: a leaf only the project sets still
    // applies, and one both set goes to the local file.
    expect(byKey.get('env.A')?.value).toBe('"local"')
    expect(byKey.get('env.A')?.winner).toBe('local')
    expect(byKey.get('env.A')?.overridden).toBe(true)
    expect(byKey.get('env.B')?.winner).toBe('project')
    expect(byKey.get('model')?.winner).toBe('user')
    expect(byKey.get('model')?.overridden).toBe(false)
  })

  it('lists the instruction files in the order a session receives them', () => {
    const { cwd, home, alpha, beta } = fixture()
    const view = computeEffectiveView({ cwd, overlays: [alpha, beta], userHome: home })
    expect(view.instructions.map((file) => file.source)).toEqual([
      'user',
      'overlay',
      'overlay'
    ])
  })

  it('warns rather than throws for an overlay that is not on disk', () => {
    const { cwd, home } = fixture()
    const missing = join(root, 'repos', 'gone')
    const view = computeEffectiveView({ cwd, overlays: [missing], userHome: home })

    expect(view.overlays[0]?.exists).toBe(false)
    expect(view.warnings.join(' ')).toMatch(/not on disk/)
  })

  it('reports a settings layer that is not valid JSON instead of ignoring it', () => {
    const { cwd, home } = fixture()
    writeFileSync(join(cwd, '.claude', 'settings.json'), '{ broken')
    const view = computeEffectiveView({ cwd, userHome: home })

    expect(view.settingsLayers.find((layer) => layer.kind === 'project')?.error).not.toBeNull()
    expect(view.warnings.join(' ')).toMatch(/not valid JSON/)
  })
})

/**
 * The `local` MCP scope, which is keyed by a path string the CLI wrote.
 *
 * Counted on the machine this was written on: 75 keys in `~/.claude.json`, 72
 * with forward slashes and 3 with backslashes, one directory present under both
 * forms. An exact match against `resolve(cwd)` found three of them, so the
 * config console reported "no MCP servers" for a directory whose own session
 * had one loaded.
 */
describe('projectEntry', () => {
  // Every document here is a Windows CLI's, so the Windows key rule is asked for
  // by name rather than left to whichever host runs the suite.
  const servers = { mcpServers: { clickup: { command: 'npx' } } }

  it('finds an entry the CLI wrote with forward slashes', () => {
    const doc = { 'C:/Users/x/repos/helm': servers }
    expect(projectEntry(doc, 'C:\\Users\\x\\repos\\helm', 'win32')).toEqual(servers)
  })

  it('finds an entry the CLI wrote with backslashes', () => {
    const doc = { 'C:\\Users\\x\\repos\\helm': servers }
    expect(projectEntry(doc, 'C:/Users/x/repos/helm', 'win32')).toEqual(servers)
  })

  it('matches case-insensitively, because these are Windows paths', () => {
    const doc = { 'c:/users/X/Repos/Helm': servers }
    expect(projectEntry(doc, 'C:\\Users\\x\\repos\\helm', 'win32')).toEqual(servers)
  })

  it('prefers the duplicate that actually defines servers', () => {
    const doc = { 'C:\\Users\\x': { history: [] }, 'C:/Users/x': servers }
    expect(projectEntry(doc, 'C:\\Users\\x', 'win32')).toEqual(servers)
  })

  it('still answers with a matching entry that defines none', () => {
    const doc = { 'C:/Users/x': { history: [] } }
    expect(projectEntry(doc, 'C:\\Users\\x', 'win32')).toEqual({ history: [] })
  })

  it('does not match a different directory, or a prefix of one', () => {
    const doc = { 'C:/Users/x/repos/helmet': servers, 'C:/Users/x/repos': servers }
    expect(projectEntry(doc, 'C:\\Users\\x\\repos\\helm', 'win32')).toBeUndefined()
  })

  it('tolerates a document with no projects at all', () => {
    expect(projectEntry(undefined, 'C:\\Users\\x', 'win32')).toBeUndefined()
    expect(projectEntry(null, 'C:\\Users\\x', 'win32')).toBeUndefined()
    expect(projectEntry([], 'C:\\Users\\x', 'win32')).toBeUndefined()
  })
})

describe('previewMcpAdd', () => {
  it('predicts the document the CLI would write for the project scope', () => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd, { recursive: true })

    const preview = previewMcpAdd({
      scope: 'project',
      name: 'probe',
      json: '{"command":"node","args":["s.mjs"]}',
      cwd
    })

    expect(preview.error).toBeNull()
    expect(preview.file).toBe(join(cwd, '.mcp.json'))
    expect(JSON.parse(preview.after)).toEqual({
      mcpServers: { probe: { command: 'node', args: ['s.mjs'] } }
    })
    expect(preview.replaces).toBeNull()
  })

  it('says what it would replace', () => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { probe: { command: 'old' } } }, null, 2)
    )

    const preview = previewMcpAdd({ scope: 'project', name: 'probe', json: '{"command":"new"}', cwd })
    expect(preview.replaces).toContain('old')
    expect(preview.diff.some((line) => line.sign === '-' && line.text.includes('old'))).toBe(true)
    expect(preview.diff.some((line) => line.sign === '+' && line.text.includes('new'))).toBe(true)
  })

  it('refuses configuration that is not a JSON object', () => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd, { recursive: true })
    expect(previewMcpAdd({ scope: 'project', name: 'p', json: '[1,2]', cwd }).error).toMatch(/object/)
    expect(previewMcpAdd({ scope: 'project', name: '', json: '{}', cwd }).error).toMatch(/name/)
  })
})

describe('diffLines', () => {
  it('marks only what changed', () => {
    const diff = diffLines('a\nb\nc\n', 'a\nB\nc\n')
    expect(diff.filter((line) => line.sign === '-').map((line) => line.text)).toEqual(['b'])
    expect(diff.filter((line) => line.sign === '+').map((line) => line.text)).toEqual(['B'])
    expect(diff.filter((line) => line.sign === ' ')).toHaveLength(2)
  })

  it('does not report the trailing newline as an added blank line', () => {
    // Both files end in one, which is the normal case - and a diff that showed
    // it would put a `+` on the last row of every preview.
    expect(diffLines('a\n', 'a\n')).toEqual([{ sign: ' ', text: 'a' }])
  })

  it('handles a file that did not exist', () => {
    const diff = diffLines('', 'one\ntwo\n')
    expect(diff.map((line) => [line.sign, line.text])).toEqual([
      ['+', 'one'],
      ['+', 'two']
    ])
  })
})

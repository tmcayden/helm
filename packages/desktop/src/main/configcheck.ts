import { type BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import {
  claudeHome,
  countConfigSnapshots,
  createProfile,
  deleteProfile,
  findProfileByName,
  readConfigFileContent,
  type Profile
} from '@helm/core'
import { screenshot, sleep, stripAnsi, waitFor } from './bridge'
import { runScan, updateSettings } from './services'
import { emit } from './ipc'
import { profiles } from './profiles'
import type { Check } from './fidelity'
import type { Collector, CheckContext } from './sessionscheck'
import { ask, waitForPrompt } from './profilescheck'

/**
 * The config-console criteria, driven through the app the way a user reaches
 * them.
 *
 * The discipline is history-check's: nothing is asserted against Helm's own
 * answer alone. Every count, hash and predicted name is checked against a
 * second read written in this file, which shares no code with the thing it is
 * checking - a naive
 * `readdirSync` walk beside the tree scanner, a `createHash` beside the
 * snapshot table, a hand-built `<overlay>:<skill>` beside the effective view.
 * A parser agreeing with itself proves nothing.
 *
 * And for the criterion that is about a *session* rather than a file, the
 * second opinion is a real one: a live `claude` on haiku is asked what it
 * actually sees, and the prediction is compared to its answer.
 *
 * This is also the one milestone that writes into `~/.claude`, so the driver
 * treats the user's real files the way the app does - a snapshot first, a
 * hash-verified restore afterwards, and a plain copy on disk as a backstop in
 * case this process dies between the two.
 *
 * `pnpm config-check` -> helm-data/config-report.json
 */

const MODEL = 'haiku'
const PROFILE_NAME = 'Effective view'

/** Distinctive enough that they cannot appear in a TUI by accident. */
const TOKENS = {
  alphaThink: 'HELMM5ALPHATHINK',
  betaThink: 'HELMM5BETATHINK',
  alphaOnly: 'HELMM5ALPHAONLY',
  mcp: 'HELMM5MCPTOKEN',
  harnessSkill: 'HELMM5HARNESSSKILL'
}

const MCP_SERVER = 'helm-config-probe'

/**
 * The live-state fixtures, and where they live.
 *
 * In `alpha` - an overlay - rather than in the workspace, deliberately. The
 * workspace's settings are read by a *real session* in the effective group and
 * its files are edited and restored by the edit group, so a hooks block planted
 * there would be a hook a live `claude` could run and a file two groups would
 * be rewriting underneath each other. An overlay is a scope the switcher offers
 * (the profile puts it there), and nothing else in this driver reads its
 * settings: an overlay contributes skills, commands, agents and a CLAUDE.md to
 * a session, never a settings layer.
 *
 * The matcher names no tool that exists, so even a session pointed here could
 * not fire it. What the pane has to say about the hook does not depend on the
 * matcher matching anything.
 */
const HOOK_FILE = 'probe-hook.js'
const HOOK_EVENT = 'PreToolUse'
const HOOK_MATCHER = 'HelmConfigProbeNoSuchTool'
const BUNDLED_FILE = 'probe-resource.md'

// ---------------------------------------------------------------------------
// A second opinion about what is on disk
// ---------------------------------------------------------------------------

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/**
 * What a `.claude` tree contains, walked naively.
 *
 * Deliberately not the tree scanner's algorithm: a plain recursion, a check for
 * `SKILL.md` by name, and `.md` counted under `commands/` and `agents/`. The
 * point is to disagree with the scanner if the scanner is wrong.
 */
interface Walked {
  skills: string[]
  commands: string[]
  agents: string[]
  settings: string[]
  claudeMd: boolean
  mcpJson: boolean
}

function walk(dir: string, into: string[], suffix: string): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      walk(path, into, suffix)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
      into.push(path)
    }
  }
}

function walkSkills(dir: string, into: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const child = join(dir, entry.name)
    if (existsSync(join(child, 'SKILL.md'))) into.push(entry.name)
    else walkSkills(child, into)
  }
}

/** `isUserScope` because the user scope's base directory *is* `.claude`. */
function walkTree(base: string, isUserScope: boolean): Walked {
  const claudeDir = isUserScope ? base : join(base, '.claude')
  const skills: string[] = []
  const commands: string[] = []
  const agents: string[] = []
  const settings: string[] = []

  walkSkills(join(claudeDir, 'skills'), skills)
  walk(join(claudeDir, 'commands'), commands, '.md')
  walk(join(claudeDir, 'agents'), agents, '.md')
  for (const name of ['settings.json', 'settings.local.json']) {
    if (existsSync(join(claudeDir, name))) settings.push(name)
  }

  return {
    skills: skills.sort(),
    commands: commands.sort(),
    agents: agents.sort(),
    settings: settings.sort(),
    // Beside the `.claude` directory for a project; inside it for the user.
    claudeMd: existsSync(join(isUserScope ? base : base, 'CLAUDE.md')),
    mcpJson: existsSync(join(base, '.mcp.json'))
  }
}

/**
 * The names a session would resolve, predicted by hand.
 *
 * The overlay's namespace is `basename(path).toLowerCase()` and nothing else,
 * written out here rather than borrowed from `overlayPluginNames` - because
 * borrowing it would make the check and the thing it checks the same function.
 */
function predictSkillNames(cwd: string, overlays: string[], userHome: string): string[] {
  const out: string[] = []
  const bare: string[] = []
  walkSkills(join(userHome, 'skills'), bare)
  walkSkills(join(cwd, '.claude', 'skills'), bare)
  out.push(...bare)
  for (const overlay of overlays) {
    const names: string[] = []
    walkSkills(join(overlay, '.claude', 'skills'), names)
    out.push(...names.map((name) => `${basename(overlay).toLowerCase()}:${name}`))
  }
  return out.sort()
}

/**
 * Which settings layer wins each leaf, computed independently.
 *
 * Local over project over user, per leaf path - which is the order the CLI
 * documents and which the live-session probe below re-measures rather than
 * assumes.
 */
function flattenJson(value: unknown, prefix: string, into: Map<string, string>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) {
      if (prefix !== '') into.set(prefix, '{}')
      return
    }
    for (const [key, child] of entries) {
      flattenJson(child, prefix === '' ? key : `${prefix}.${key}`, into)
    }
    return
  }
  if (prefix !== '') into.set(prefix, JSON.stringify(value))
}

function settingsTruth(cwd: string, userHome: string): Map<string, { value: string; layer: string }> {
  const layers: Array<[string, string]> = [
    ['local', join(cwd, '.claude', 'settings.local.json')],
    ['project', join(cwd, '.claude', 'settings.json')],
    ['user', join(userHome, 'settings.json')]
  ]
  const winners = new Map<string, { value: string; layer: string }>()
  for (const [layer, file] of layers) {
    const flat = new Map<string, string>()
    try {
      flattenJson(JSON.parse(readFileSync(file, 'utf8')), '', flat)
    } catch {
      continue
    }
    for (const [key, value] of flat) {
      if (!winners.has(key)) winners.set(key, { value, layer })
    }
  }
  return winners
}

// ---------------------------------------------------------------------------
// Talking to the renderer
// ---------------------------------------------------------------------------

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  try {
    return (await win.webContents.executeJavaScript(expression, true)) as T
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`renderer expression failed: ${detail}\n${expression}`, { cause: err })
  }
}

async function click(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false; el.click(); return true })()`
  )
}

async function pollJs(win: BrowserWindow, expression: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await js<boolean>(win, `Boolean(${expression})`).catch(() => false)
    if (ok) return true
    if (Date.now() >= deadline) return false
    await sleep(150)
  }
}

/**
 * Sets a React-controlled field.
 *
 * Assigning `.value` updates the DOM node and nothing else - React tracks the
 * previous value on the element and skips a change it did not see happen. The
 * prototype's setter plus a bubbling `input` event is the path a keystroke and
 * a paste both take. Used rather than typing because the editor's content is a
 * whole file, and a hundred lines at twelve milliseconds a character is a
 * minute per assertion.
 */
async function setValue(win: BrowserWindow, selector: string, value: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement
        : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true })()`
  )
}

/** Opens the console, waiting for its list to paint. */
async function showConsole(win: BrowserWindow): Promise<boolean> {
  if (!(await click(win, '[data-tab="config"]'))) {
    await click(win, 'aside button[data-open-config]')
  }
  return pollJs(win, `document.querySelector('select[data-config-scope]')`, 15_000)
}

/**
 * Points the switcher at a scope, and refuses to continue if it did not move.
 *
 * A `<select>` assigned a value it has no option for keeps the one it had, and
 * every assertion after that would then be made against the wrong directory -
 * silently, and in the case of a save, destructively. This is the check that
 * caught exactly that during development.
 */
async function selectScope(win: BrowserWindow, path: string): Promise<void> {
  await setValue(win, 'select[data-config-scope]', path)
  await sleep(700)
  const landed = await js<string>(
    win,
    `document.querySelector('select[data-config-scope]')?.value ?? ''`
  )
  if (landed.toLowerCase() !== path.toLowerCase()) {
    throw new Error(
      `the scope switcher has no option for ${path} - it is showing ${landed || '(nothing)'}`
    )
  }
}

async function selectView(win: BrowserWindow, view: string): Promise<boolean> {
  const ok = await click(win, `button[data-config-view="${view}"]`)
  await sleep(500)
  return ok
}

/** What the file list is currently showing, read off the rendered rows. */
async function listedFiles(win: BrowserWindow): Promise<Array<{ relPath: string; kind: string }>> {
  return js<Array<{ relPath: string; kind: string }>>(
    win,
    `[...document.querySelectorAll('button[data-config-file]')].map((el) => ({
      relPath: el.dataset.configFile, kind: el.dataset.configKind }))`
  )
}

/**
 * Puts the open file's raw text on screen, whatever kind it is.
 *
 * The detail pane opens in its reading view - rendered markdown, a settings
 * form - so the textarea the write path has always used is behind a segment.
 * `source` where there is one (a settings file, whose `edit` is the form),
 * `edit` otherwise; both land on the same textarea and the same save button.
 */
async function openSource(win: BrowserWindow): Promise<boolean> {
  if (await js<boolean>(win, `Boolean(document.querySelector('textarea[data-config-editor]'))`)) {
    return true
  }
  if (!(await click(win, 'button[data-config-mode="source"]'))) {
    await click(win, 'button[data-config-mode="edit"]')
  }
  return pollJs(win, `document.querySelector('textarea[data-config-editor]')`, 10_000)
}

/**
 * Opens a file in the editor and edits it, through the surface.
 *
 * Returns what the pane reported rather than what the disk says - the caller
 * checks the disk itself, with its own read.
 */
async function editFile(
  win: BrowserWindow,
  relPath: string,
  content: string
): Promise<{ opened: boolean; saved: boolean; dirtyBeforeSave: boolean; status: string }> {
  const opened = await click(win, `button[data-config-file="${cssEscape(relPath)}"]`)
  if (!opened) return { opened: false, saved: false, dirtyBeforeSave: false, status: '' }
  // Reading is the pane's default now, so the text is one segment away. `edit`
  // is the textarea for every kind except a settings file, where it is the
  // schema form and `source` is the raw JSON - which is what this types into.
  await openSource(win)
  await sleep(300)

  await setValue(win, 'textarea[data-config-editor]', content)
  await sleep(250)
  const dirtyBeforeSave = await js<boolean>(
    win,
    `document.querySelector('[data-dirty]')?.dataset.dirty === 'true'`
  )
  const saved = await click(win, 'button[data-save-config]')
  await sleep(900)
  const status = await js<string>(
    win,
    `(document.querySelector('[data-dirty]')?.textContent ?? '').trim()`
  )
  return { opened, saved, dirtyBeforeSave, status }
}

/**
 * A relative path as a CSS attribute value.
 *
 * The paths here use forward slashes, which need no escaping - but a quote in a
 * file name would end the selector, and a file named by a user can contain one.
 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  root: string
  workspace: string
  alpha: string
  beta: string
  mcpServer: string
  /**
   * A scan root holding one harness of this driver's own, and the harness in
   * it.
   *
   * Both exist because the harness scope used to be **borrowed**: whatever
   * `services.lastScan` happened to hold, with the user's own `~/.claude` as a
   * silent fallback. Two things were wrong with that, and on 2026-09-03 they
   * both bit at once. The scan is asynchronous and took 58 seconds on this
   * machine, so CFG-1 and CFG-2 ran before it landed and fell back; and the
   * fallback is a directory with no skill in it, because on a machine whose
   * Claude Code lives in WSL the Windows `~/.claude` legitimately holds nothing
   * - 0 skills against Ubuntu's 8. So both failed for reasons that had nothing
   * to do with the config console, which is the failure mode CLAUDE.md names:
   * "a check that fails for a reason unrelated to what it measures gets waved
   * past, and then so does the day it fails for a real one."
   *
   * A real harness rather than a directory smuggled in through a profile: it
   * carries a `harness.yaml`, so discovery classifies it `harness` the way it
   * classifies the user's, and the scope it produces is the one under test.
   */
  harnessRoot: string
  harness: string
}

function writeSkill(repo: string, name: string, token: string): void {
  const dir = join(repo, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: Helm config probe skill. Reports the token ${token}.`,
      '---',
      '',
      `# ${token}`,
      '',
      `This skill exists to be read back. Its token is ${token}.`,
      ''
    ].join('\n')
  )
}

/**
 * A workspace and two overlay repos the driver owns.
 *
 * Against fixtures rather than the user's repositories, for the same reason
 * profiles-check's skill-edit check is: composing an overlay builds a shim whose
 * subdirectories are junctions into the source, and a check that plants probe
 * files in one of the user's own repositories - or that tears a shim down over it - is not
 * something a check gets to do with somebody's real work.
 *
 * Both overlays define `think`, which is what makes the same-named-skill
 * criterion checkable: the two bodies differ, so a session quoting both
 * headings has resolved two distinct skills rather than one twice.
 */
function buildFixtures(dataDir: string): Fixtures {
  const root = join(dataDir, 'config-fixtures')
  rmSync(root, { recursive: true, force: true })

  const workspace = join(root, 'workspace')
  const alpha = join(root, 'alpha')
  const beta = join(root, 'beta')

  writeSkill(alpha, 'think', TOKENS.alphaThink)
  writeSkill(alpha, 'alpha-only', TOKENS.alphaOnly)
  writeSkill(beta, 'think', TOKENS.betaThink)

  // The live-state fixtures. See the constants above for why they are in the
  // overlay rather than in the workspace.
  writeFileSync(
    join(alpha, '.claude', 'skills', 'alpha-only', BUNDLED_FILE),
    `# Bundled\n\nA resource beside a SKILL.md. Part of the skill, not a file of its own.\n`
  )
  mkdirSync(join(alpha, '.claude', 'hooks'), { recursive: true })
  writeFileSync(
    join(alpha, '.claude', 'hooks', HOOK_FILE),
    '#!/usr/bin/env node\n// A Helm config probe. Its matcher names no tool, so nothing fires it.\nprocess.exit(0)\n'
  )
  // `model` is set by both layers and disagrees, `cleanupPeriodDays` by one -
  // so this file is *partly* shadowed and the local one wins outright, which
  // is the pair the row's live state has to tell apart.
  writeFileSync(
    join(alpha, '.claude', 'settings.json'),
    `${JSON.stringify(
      {
        model: 'sonnet',
        cleanupPeriodDays: 30,
        hooks: {
          [HOOK_EVENT]: [
            {
              matcher: HOOK_MATCHER,
              hooks: [{ type: 'command', command: `node .claude/hooks/${HOOK_FILE}` }]
            }
          ]
        }
      },
      null,
      2
    )}\n`
  )
  writeFileSync(
    join(alpha, '.claude', 'settings.local.json'),
    `${JSON.stringify({ model: 'opus' }, null, 2)}\n`
  )
  writeFileSync(join(alpha, 'CLAUDE.md'), '# Alpha instructions\n\nComposed by Helm.\n')
  writeFileSync(join(beta, 'CLAUDE.md'), '# Beta instructions\n\nComposed by Helm.\n')

  mkdirSync(join(workspace, '.claude'), { recursive: true })
  writeSkill(workspace, 'workspace-skill', 'HELMM5WORKSPACE')
  writeFileSync(join(workspace, 'CLAUDE.md'), '# Workspace instructions\n')
  mkdirSync(join(workspace, '.claude', 'commands'), { recursive: true })
  writeFileSync(join(workspace, '.claude', 'commands', 'probe.md'), '# probe command\n')
  mkdirSync(join(workspace, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(workspace, '.claude', 'agents', 'probe-agent.md'), '---\ndescription: A probe.\n---\n')

  // The layer pair the settings criterion turns on. `PROJECTONLY` is set only
  // by the lower of the two, so a session reporting both proves the merge is
  // per leaf rather than a whole-key replacement.
  writeFileSync(
    join(workspace, '.claude', 'settings.json'),
    `${JSON.stringify(
      { env: { HELM_M5_LAYER: 'PROJECTWINS', HELM_M5_PROJECTONLY: 'PROJECTONLY' } },
      null,
      2
    )}\n`
  )
  writeFileSync(
    join(workspace, '.claude', 'settings.local.json'),
    `${JSON.stringify({ env: { HELM_M5_LAYER: 'LOCALWINS' } }, null, 2)}\n`
  )

  // A dependency-free stdio MCP server, so criterion 4 does not depend on the
  // network or on a package that might not install.
  const mcpDir = join(root, 'mcp')
  mkdirSync(mcpDir, { recursive: true })
  const mcpServer = join(mcpDir, 'server.mjs')
  writeFileSync(
    mcpServer,
    `import { createInterface } from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method } = msg
  if (id === undefined) return
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: ${JSON.stringify(MCP_SERVER)}, version: '0.0.1' } } })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'helm_probe_token',
      description: 'Returns the Helm config probe token.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } })
  } else if (method === 'tools/call') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: ${JSON.stringify(TOKENS.mcp)} }], isError: false } })
  } else if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: [] } })
  } else if (method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { prompts: [] } })
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
  }
})
`
  )

  /*
   * The harness scope, built rather than borrowed. See `Fixtures.harnessRoot`.
   *
   * A space in the directory name, like every other fixture path in this repo:
   * Windows-first, and a scope path reaches `claude`'s argv.
   */
  const harnessRoot = join(root, 'harness root')
  const harness = join(harnessRoot, 'probe harness')
  mkdirSync(harness, { recursive: true })
  writeFileSync(join(harness, 'harness.yaml'), 'name: probe harness\n')
  // Two files, because CFG-15's claim is that a file beside a `SKILL.md` is on
  // the skill's row and has no row of its own - and a harness with a bare
  // skill could not tell that apart from a harness with nothing in it.
  writeSkill(harness, 'harness-skill', TOKENS.harnessSkill)
  writeFileSync(join(harness, 'CLAUDE.md'), '# Probe harness instructions\n')

  return { root, workspace, alpha, beta, mcpServer, harnessRoot, harness }
}

/**
 * The token a skill body declares, read out of the file.
 *
 * Asked for by name rather than as "the first H1 heading", which is what this
 * started as and which is not a stable thing to compare against: a model
 * answering `S1=# HELMM5ALPHATHINK` has read the right file and quoted the
 * heading *including its hash*, and an equality check on the text calls that a
 * failure. The token is a bare word with one meaning.
 *
 * Read from disk rather than from the constant it was written with, so this is
 * still a claim about the file the session resolved.
 */
function skillToken(file: string): string {
  try {
    return /Its token is ([A-Z0-9]+)\./.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const GROUPS = [
  'browse',
  'files',
  'edit',
  'snapshot',
  'json',
  'external',
  'create',
  'rename',
  'delete',
  'mcp',
  'effective',
  'doctor'
] as const
type Group = (typeof GROUPS)[number]

export async function runConfigChecks(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string,
  dataDir: string,
  only?: readonly string[]
): Promise<Check[]> {
  const wanted = new Set<string>(only && only.length > 0 ? only : GROUPS)
  const running = (group: Group): boolean => wanted.has(group)

  const checks: Check[] = []
  const { win, services } = ctx
  const fixtures = buildFixtures(dataDir)
  const userHome = claudeHome()

  /*
   * The fixture harness, discovered before any group asks for a harness scope.
   *
   * Added as a scan root and scanned **here**, synchronously awaited, rather
   * than relying on the start-up scan: that one is asynchronous and took 58
   * seconds on the machine where this was written, so the groups below used to
   * read a `services.lastScan` that was still null. Whatever the app's own scan
   * then finds is left in place beside it - this adds a root, it does not
   * replace the user's.
   *
   * `includeGit: false` because none of these fixtures is a repository and the
   * git pass is the expensive half of a scan.
   */
  /*
   * The app's own start-up scan is waited for **first**, and that order is the
   * whole of this. `lastScan` is null until it lands, it reads its roots when
   * it begins, and it took 58 seconds on this machine - so a scan of this
   * driver's own done before it finishes is a scan the start-up one then
   * *overwrites*, roots and all. That is a real run: the fixture harness was
   * discovered, replaced 40 seconds later by a listing that had never heard of
   * it, and the browse group threw with "the scope switcher has no option for
   * ...\probe harness".
   */
  await waitFor(() => services.lastScan !== null, 180_000)

  const rootsBefore = services.settings.scanRoots
  if (!rootsBefore.some((root) => root.toLowerCase() === fixtures.harnessRoot.toLowerCase())) {
    updateSettings(services, { scanRoots: [...rootsBefore, fixtures.harnessRoot] })
  }
  await runScan(services, { includeGit: false })

  /**
   * The harness scope the groups below use, found the way they find it: out of
   * the scan, matched to the fixture by path.
   *
   * Read back out of the scan rather than assumed from the path, so what is
   * under test is "a harness Helm discovered" and not "a directory this driver
   * made". Its absence is a *failure* wherever it is used - never a quiet
   * fallback to the user's home, which is what used to happen.
   */
  const findFixtureHarness = (): { path: string } | undefined =>
    (services.lastScan?.projects ?? []).find(
      (project) =>
        project.kind === 'harness' &&
        project.path.toLowerCase() === fixtures.harness.toLowerCase()
    )
  if (findFixtureHarness() === undefined) {
    console.warn(
      `config-check: the scan did not classify ${fixtures.harness} as a harness. ` +
        'The harness-scope claims below will fail rather than fall back.'
    )
  }

  /**
   * The user's real `~/.claude/settings.json`, copied before anything touches
   * it. The restore at the end goes through Helm's snapshot history - which is
   * the mechanism under test - and this is the backstop for the case where this
   * process does not reach the end.
   */
  const userSettings = join(userHome, 'settings.json')
  const userSettingsBefore = existsSync(userSettings) ? readFileSync(userSettings, 'utf8') : null
  const userSettingsHash = userSettingsBefore === null ? null : sha256(userSettingsBefore)
  const backup = join(dataDir, 'config-user-settings.backup.json')
  if (userSettingsBefore !== null) copyFileSync(userSettings, backup)

  /**
   * The profile goes in first, before anything is browsed.
   *
   * Not only because CFG-9 launches it: a profile's root and overlays are scopes
   * the switcher offers, and the fixture workspace is not inside any scanned
   * root. Creating the profile is what makes it reachable through the surface,
   * which is the same thing that would make a user's out-of-tree profile
   * reachable.
   */
  const stale = findProfileByName(services.store, PROFILE_NAME)
  if (stale) deleteProfile(services.store, stale.id)
  const profile: Profile = createProfile(services.store, {
    name: PROFILE_NAME,
    root: fixtures.workspace,
    overlays: [fixtures.alpha, fixtures.beta],
    access: [fixtures.alpha, fixtures.beta],
    model: MODEL,
    effort: null,
    permissionMode: null,
    agent: null,
    mcp: [],
    openingPrompt: null,
    pinnedOrder: null,
    target: null
  })

  /*
   * The window is told the profile exists.
   *
   * `createProfile` above is a store write, and the renderer's profile list
   * comes from `profiles:changed` - which only the `profile:*` channels emit.
   * So without this the pane never hears about it: the effective view's profile
   * picker has no option to select, `setValue` silently leaves it on "A
   * directory, with no overlays", and CFG-8 compares a pane resolving the
   * workspace *alone* against a service resolving it with two overlays. That is
   * what it did - one skill painted against four - and the reason it passed for
   * so long is worse than the bug: a profile of the same name left behind by an
   * earlier run was already in the seeded database at start-up, so the picker
   * had an option and nobody noticed the emit was missing.
   */
  emit(win, 'profiles:changed', profiles(services))
  await sleep(300)

  const openedConsole = await showConsole(win)
  // The scope list is rebuilt from `profiles:changed`, which the store write
  // above does not emit - so the pane is asked to re-read it the way a rescan
  // would.
  await click(win, 'button[data-config-refresh]')
  await sleep(400)
  const scopeReachable = await pollJs(
    win,
    `[...document.querySelectorAll('select[data-config-scope] option')]
       .some((o) => o.value.toLowerCase() === ${JSON.stringify(fixtures.workspace.toLowerCase())})`,
    15_000
  )
  await sleep(400)

  checks.push({
    id: 'CFG-0',
    criterion: 'setup',
    title: 'The console opens and offers the fixture workspace as a scope',
    ok:
      openedConsole &&
      scopeReachable &&
      existsSync(join(fixtures.alpha, '.claude', 'skills', 'think', 'SKILL.md')) &&
      existsSync(join(fixtures.beta, '.claude', 'skills', 'think', 'SKILL.md')) &&
      existsSync(fixtures.mcpServer),
    detail: {
      fixtures: fixtures.root,
      profile: { id: profile.id, root: profile.root, overlays: profile.overlays },
      offeredInTheSwitcher: scopeReachable,
      userSettings,
      userSettingsBackedUpTo: userSettingsBefore === null ? null : backup,
      userSettingsHash
    },
    notes: [
      'The overlays are fixtures the driver owns rather than the user’s repos: composing one',
      'builds a shim of junctions into the source, and a check does not get to tear that down',
      'over somebody’s real work.',
      'The workspace is outside every scanned root, so it is only a scope because a profile',
      'points at it - which is the case a scan-only scope list would miss.'
    ]
  })

  /**
   * A group that throws becomes a failing check rather than an absent report.
   *
   * The runner treats "no report" as a failure, which is right - but it is also
   * the least useful failure there is, because the eight groups that would have
   * passed never ran. A thrown group is one group's problem.
   */
  const group = async (name: Group, run: () => Promise<Check[]>): Promise<void> => {
    if (!running(name)) return
    try {
      checks.push(...(await run()))
    } catch (err) {
      checks.push({
        id: `CFG-${name.toUpperCase()}-THREW`,
        criterion: name,
        title: `The ${name} group threw before it could assert anything`,
        ok: false,
        detail: { error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) },
        notes: ['The groups after this one still ran; this is one group’s failure, not the run’s.']
      })
    }
  }

  try {
    await group('browse', () => browseChecks(ctx, shotDir, fixtures, userHome))
    await group('files', () => filesChecks(ctx, shotDir, fixtures, userHome))
    await group('edit', () => editChecks(ctx, shotDir, fixtures, userHome))
    await group('snapshot', async () => [await snapshotCheck(ctx, fixtures)])
    await group('json', async () => [await jsonCheck(ctx, shotDir, fixtures)])
    await group('external', async () => [await externalCheck(ctx, shotDir, fixtures)])
    // The three that change what is *in* the tree rather than what is in a
    // file. Each plants and removes its own fixtures, so any one of them is
    // runnable on its own with `--only=`.
    await group('create', () => createChecks(ctx, shotDir, fixtures, userHome))
    await group('rename', () => renameChecks(ctx, shotDir, fixtures))
    await group('delete', () => deleteChecks(ctx, shotDir, fixtures))
    await group('mcp', async () => [await mcpCheck(ctx, shotDir, fixtures)])
    await group('effective', () =>
      effectiveChecks(ctx, collector, shotDir, fixtures, userHome, profile, running('mcp'))
    )
    await group('doctor', async () => [await doctorCheck(ctx, shotDir)])
  } finally {
    // Whatever happened above, the user's settings go back. Through the plain
    // copy rather than the snapshot table, because this has to work even if the
    // failure was in the snapshot table.
    if (userSettingsBefore !== null && sha256File(userSettings) !== userSettingsHash) {
      writeFileSync(userSettings, userSettingsBefore)
    }
    const profile = findProfileByName(services.store, PROFILE_NAME)
    if (profile) deleteProfile(services.store, profile.id)
  }

  checks.push({
    id: 'CFG-Z',
    criterion: 'setup',
    title: 'The user’s settings.json is byte-identical to how the run found it',
    ok: sha256File(userSettings) === userSettingsHash,
    detail: {
      file: userSettings,
      hashBefore: userSettingsHash,
      hashAfter: sha256File(userSettings),
      backup
    },
    notes: [
      'This milestone is the one exception to "Helm only reads ~/.claude", so the driver',
      'proves it left the file it borrowed exactly as it found it.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// CFG-1: browsing every scope
// ---------------------------------------------------------------------------

async function browseChecks(
  ctx: CheckContext,
  shotDir: string,
  fixtures: Fixtures,
  userHome: string
): Promise<Check[]> {
  const { win, services } = ctx
  const checks: Check[] = []

  // The driver's own harness, matched by path - never simply "the first harness the
  // developer's scan happened to find"; see `Fixtures.harnessRoot`.
  const harness = (services.lastScan?.projects ?? []).find(
    (p) => p.kind === 'harness' && p.path.toLowerCase() === fixtures.harness.toLowerCase()
  )
  const scopes: Array<{ kind: string; path: string; isUser: boolean }> = [
    { kind: 'user', path: userHome, isUser: true },
    ...(harness ? [{ kind: 'harness', path: harness.path, isUser: false }] : []),
    { kind: 'project', path: fixtures.workspace, isUser: false }
  ]

  const perScope: Array<Record<string, unknown>> = []
  let allAgree = scopes.length === 3

  for (const scope of scopes) {
    // The fixture workspace is not a scanned project, so it is reached through
    // the service rather than the switcher - which is exactly what the switcher
    // would do with it if the scan had found it.
    const tree = ctx.config.tree(scope.path)
    const truth = walkTree(scope.path, scope.isUser)

    const skills = tree.files.filter((f) => f.kind === 'skill')
    const commands = tree.files.filter((f) => f.kind === 'command')
    const agents = tree.files.filter((f) => f.kind === 'agent')
    const settings = tree.files.filter((f) => f.kind === 'settings' || f.kind === 'settings-local')

    const agrees =
      skills.length === truth.skills.length &&
      commands.length === truth.commands.length &&
      agents.length === truth.agents.length &&
      settings.length === truth.settings.length &&
      // Names, not just counts: a scanner that found the right number of files
      // and called them the wrong things would pass a count check.
      skills.map((f) => f.name).sort().join(',') === truth.skills.join(',')

    if (!agrees) allAgree = false
    perScope.push({
      scope: scope.kind,
      path: scope.path,
      pane: {
        skills: skills.length,
        commands: commands.length,
        agents: agents.length,
        settings: settings.map((f) => f.name)
      },
      independentWalk: {
        skills: truth.skills.length,
        commands: truth.commands.length,
        agents: truth.agents.length,
        settings: truth.settings
      },
      skillNames: skills.map((f) => f.name).sort(),
      agrees
    })
  }

  // And through the window. The fixture harness whether or not the scan
  // classified it: `selectScope` throws when the switcher has no option for a
  // path, which is the loud failure this used to swap for the user's home - a
  // directory that holds no skill on a machine whose Claude Code is in WSL, so
  // the fallback failed the "some row is a skill" claim while the console was
  // working perfectly.
  const harnessPath = harness?.path ?? fixtures.harness
  await selectScope(win, harnessPath)
  const painted = await listedFiles(win)
  const paintedTruth = ctx.config.tree(harnessPath)

  /**
   * The files the list nests inside a skill instead of giving a row of their
   * own, decided here by asking the filesystem: a file whose own directory
   * holds a `SKILL.md` is part of that skill.
   *
   * The pane's rule is written in `bundledWith`; this one shares no code with
   * it, which is the point. A row per file stopped being the claim when the
   * bundle went inside the skill - the claim now is that every file is either a
   * row or inside the skill that owns it, and CFG-15 is the other half.
   */
  const bundled = paintedTruth.files.filter(
    (file) =>
      file.kind === 'other' &&
      file.relPath.includes('/') &&
      existsSync(join(harnessPath, file.relPath.slice(0, file.relPath.lastIndexOf('/')), 'SKILL.md'))
  )
  const expectedRows = paintedTruth.files.length - bundled.length
  const shot = await screenshot(win, shotDir, 'config-files.png')

  checks.push({
    id: 'CFG-1',
    criterion: 'Can view any skill/command/agent/CLAUDE.md/settings.json across all three scopes',
    title: 'Each scope’s tree matches an independent walk of the same directory',
    ok:
      allAgree &&
      painted.length === expectedRows &&
      painted.some((row) => row.kind === 'skill'),
    detail: {
      scopes: perScope,
      throughTheWindow: {
        scope: harnessPath,
        rows: painted.length,
        expected: expectedRows,
        filesInTheTree: paintedTruth.files.length,
        nestedUnderTheirSkill: bundled.map((file) => file.relPath),
        kinds: [...new Set(painted.map((row) => row.kind))].sort()
      },
      screenshot: shot.file
    },
    notes: [
      'The second read is a plain readdirSync walk in configcheck.ts, sharing no code with the',
      'tree scanner: skills are directories holding a SKILL.md, commands and agents are .md',
      'at any depth. Names are compared as well as counts.',
      'A row per file stopped being the claim when a skill’s bundle went inside it, so the',
      'expected row count subtracts the files whose own directory holds a SKILL.md - asked of',
      'the filesystem here rather than of the rule the pane uses. CFG-15 is the other half:',
      'those files are on the skill’s row and on its pane.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// CFG-12 .. CFG-16: the Files view itself
// ---------------------------------------------------------------------------

/** Every row the list is painting, with what it claims about each. */
async function paintedRows(
  win: BrowserWindow
): Promise<Array<{ relPath: string; kind: string; live: string; note: string; bundled: string }>> {
  return js(
    win,
    `[...document.querySelectorAll('button[data-config-file]')].map((el) => {
      const lines = [...el.querySelectorAll(':scope > span')];
      return {
        relPath: el.dataset.configFile,
        kind: el.dataset.configKind,
        live: el.dataset.configLive ?? '',
        note: (lines[1]?.textContent ?? '').trim(),
        bundled: (lines[2]?.textContent ?? '').trim()
      } })`
  )
}

/**
 * The Files view's own criteria: live state on the row, the detail pane a kind
 * opens in, and a skill's bundle nesting under it.
 *
 * Everything is asserted against a second reader in this file. The settings
 * winner comes from `settingsTruth`, which is this driver's own flatten and its
 * own precedence chain; the hook binding from a plain `JSON.parse` of the
 * settings file; the bundle from a `readdirSync` of the skill's directory; the
 * invocation from `predictSkillNames`, which spells the namespace rule out by
 * hand. None of them shares code with `computeConfigLive`.
 *
 * The scope is the `alpha` overlay, which the profile puts in the switcher. Its
 * settings are read by nothing else in this driver and by no session, so the
 * hooks block planted in it is a fixture rather than a hook somebody's `claude`
 * could run.
 */
async function filesChecks(
  ctx: CheckContext,
  shotDir: string,
  fixtures: Fixtures,
  userHome: string
): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []
  const settingsFile = join(fixtures.alpha, '.claude', 'settings.json')

  await selectScope(win, fixtures.alpha)
  // The rows say nothing until the resolution has arrived, which is the design:
  // a row with no answer paints no dot rather than a wrong one.
  const resolved = await pollJs(
    win,
    `[...document.querySelectorAll('button[data-config-file]')].some((el) => el.dataset.configLive)`,
    15_000
  )
  const rows = await paintedRows(win)
  const row = (relPath: string): (typeof rows)[number] | undefined =>
    rows.find((candidate) => candidate.relPath.toLowerCase() === relPath.replace(/\\/g, '/').toLowerCase())

  // ---- CFG-12: the settings rows, against this file's own precedence ----
  const truth = settingsTruth(fixtures.alpha, userHome)
  const declared: Map<string, string> = new Map()
  flattenJson(JSON.parse(readFileSync(settingsFile, 'utf8')), '', declared)
  const outranked = [...declared].filter(([key, value]) => {
    const winner = truth.get(key)
    return winner !== undefined && winner.value !== value
  })
  // The fixture has to discriminate, or "1 of 3 outranked" would pass against a
  // file where nothing is outranked at all (CLAUDE.md, "no evidence behind it").
  const fixtureDiscriminates = declared.size >= 2 && outranked.length === 1

  const settingsRow = row('.claude/settings.json')
  const localRow = row('.claude/settings.local.json')
  const expectedState = outranked.length === 0 ? 'live' : outranked.length === declared.size ? 'shadowed' : 'partial'

  await click(win, `button[data-config-file="${cssEscape('.claude/settings.json')}"]`)
  await pollJs(win, `document.querySelector('[data-config-settings]')`, 10_000)
  const painted = await js<Array<{ key: string; wins: string }>>(
    win,
    `[...document.querySelectorAll('[data-config-setting]')].map((el) => ({
      key: el.dataset.configSetting, wins: el.dataset.configSettingWins }))`
  )
  const paneAgrees = [...declared.keys()].every((key) => {
    const seen = painted.find((candidate) => candidate.key === key)
    const winner = truth.get(key)
    return seen !== undefined && seen.wins === String(winner?.value === declared.get(key))
  })
  const settingsShot = await screenshot(win, shotDir, 'config-settings-live.png')

  checks.push({
    id: 'CFG-12',
    criterion: 'Rows carry live state read from the effective view: shadowed by another scope, namespaced under an overlay, or overridden downstream',
    title: 'A settings file’s row and its pane agree with an independent precedence chain',
    ok:
      resolved &&
      fixtureDiscriminates &&
      settingsRow?.live === expectedState &&
      localRow?.live === 'live' &&
      painted.length === declared.size &&
      paneAgrees,
    detail: {
      scope: fixtures.alpha,
      independentChain: [...truth].map(([key, winner]) => ({ key, ...winner })),
      declaredHere: [...declared],
      outrankedHere: outranked.map(([key]) => key),
      fixtureDiscriminates,
      row: settingsRow,
      localRow,
      expectedState,
      paneRows: painted,
      paneAgrees,
      screenshot: settingsShot.file
    },
    notes: [
      'The second reader is `settingsTruth` in this file: its own flatten, its own local > project >',
      'user chain, no code shared with the effective view. The fixture is asserted to be',
      'discriminating first - one key outranked and one not - because "all keys win" is what a',
      'pane that read nothing would also report.'
    ]
  })

  // ---- CFG-13: a skill's row carries the invocation a session would type ----
  const predicted = predictSkillNames(fixtures.alpha, [], userHome)
  const contested = predicted.filter((name) => name === 'alpha-only').length > 1
  const skillRow = row('.claude/skills/alpha-only/SKILL.md')
  const skillState = contested ? 'partial' : 'live'

  checks.push({
    id: 'CFG-13',
    criterion: 'Rows carry live state read from the effective view',
    title: 'A skill’s row names the invocation a session in this directory would resolve',
    ok:
      predicted.includes('alpha-only') &&
      skillRow !== undefined &&
      skillRow.live === skillState &&
      skillRow.note.includes('alpha-only'),
    detail: {
      predictedByHand: predicted,
      // Two unprefixed sources landing on one name is a contest Helm does not
      // predict a winner for, so the expectation is derived rather than fixed.
      alsoInTheUserDirectory: contested,
      expectedState: skillState,
      row: skillRow
    },
    notes: [
      '`predictSkillNames` walks the directories itself and spells the `<overlay>:<skill>` rule',
      'out by hand, so the expected invocation is not borrowed from the code that paints it.'
    ]
  })

  // ---- CFG-14: a hook says what runs it, and from which settings block ----
  const settingsDoc = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
    hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>
  }
  const events = Object.entries(settingsDoc.hooks ?? {})
    .filter(([, blocks]) =>
      blocks.some((block) => (block.hooks ?? []).some((step) => (step.command ?? '').includes(HOOK_FILE)))
    )
    .map(([event]) => event)

  await click(win, `button[data-config-file="${cssEscape(`.claude/hooks/${HOOK_FILE}`)}"]`)
  await pollJs(win, `document.querySelector('[data-hook-provenance]')`, 10_000)
  const provenance = await js<{ count: string; events: string[]; source: string; text: string }>(
    win,
    `(() => {
      const box = document.querySelector('[data-hook-provenance]');
      return {
        count: box?.dataset.hookProvenance ?? '',
        events: [...document.querySelectorAll('[data-hook-event]')].map((el) => el.dataset.hookEvent),
        source: document.querySelector('[data-open-layer]')?.textContent ?? '',
        text: (box?.textContent ?? '').replace(/\\s+/g, ' ').trim()
      } })()`
  )
  const hookShot = await screenshot(win, shotDir, 'config-hook-provenance.png')

  checks.push({
    id: 'CFG-14',
    criterion: 'A hook file shows which event fires it and from which settings block, above its source',
    title: 'The hook pane names the event, the matcher and the settings file, read back from the file itself',
    ok:
      events.length === 1 &&
      events[0] === HOOK_EVENT &&
      provenance.events.join(',') === HOOK_EVENT &&
      provenance.source.includes('settings.json') &&
      provenance.text.includes(HOOK_MATCHER),
    detail: {
      hook: join(fixtures.alpha, '.claude', 'hooks', HOOK_FILE),
      eventsInTheFile: events,
      painted: provenance,
      screenshot: hookShot.file
    },
    notes: [
      'The expected event comes from a plain JSON.parse of the settings file in this driver, not',
      'from the effective view the pane reads. The matcher names no real tool, so the fixture',
      'cannot fire in any session this run starts.'
    ]
  })

  // ---- CFG-15: a skill's bundle nests under it instead of landing in Other ----
  const skillDir = join(fixtures.alpha, '.claude', 'skills', 'alpha-only')
  const onDisk = readdirSync(skillDir).filter((name) => name.toLowerCase() !== 'skill.md')
  const bundledRow = row('.claude/skills/alpha-only/SKILL.md')
  const inOther = rows.filter((candidate) => candidate.relPath.endsWith(`/${BUNDLED_FILE}`))
  const opened = await click(
    win,
    `button[data-config-file="${cssEscape('.claude/skills/alpha-only/SKILL.md')}"]`
  )
  await pollJs(win, `document.querySelector('[data-bundled]')`, 10_000)
  const bundledInPane = await js<string[]>(
    win,
    `[...document.querySelectorAll('[data-bundled-file]')].map((el) => el.dataset.bundledFile)`
  )
  const bundleShot = await screenshot(win, shotDir, 'config-skill-bundle.png')

  checks.push({
    id: 'CFG-15',
    criterion: 'Skill-bundled resources nest under their skill instead of appearing in Other',
    title: 'The file beside a SKILL.md is on the skill’s row and on its pane, and has no row of its own',
    ok:
      onDisk.length === 1 &&
      onDisk[0] === BUNDLED_FILE &&
      opened &&
      inOther.length === 0 &&
      bundledRow?.bundled.includes(BUNDLED_FILE) === true &&
      bundledInPane.some((relPath) => relPath.endsWith(BUNDLED_FILE)),
    detail: {
      skillDirectory: skillDir,
      besideTheSkillOnDisk: onDisk,
      rowsForItInTheList: inOther.map((candidate) => candidate.relPath),
      skillRowSecondLine: bundledRow?.bundled,
      onThePane: bundledInPane,
      screenshot: bundleShot.file
    },
    notes: [
      'The second reader is a readdirSync of the skill directory. The nesting is presentation:',
      '`readConfigTree` still returns the file, which is why "no row of its own" is asserted',
      'against the painted list rather than against the tree.'
    ]
  })

  // ---- CFG-16: each kind opens in its own pane ----
  const skillToken = /Its token is ([A-Z0-9]+)\./.exec(
    readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
  )?.[1]
  const markdown = await js<{ body: string; chips: number; textarea: boolean }>(
    win,
    `(() => {
      const body = document.querySelector('[data-markdown-surface="config"]');
      return {
        body: (body?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 400),
        chips: Number(document.querySelector('[data-frontmatter-chips]')?.dataset.frontmatterChips ?? 0),
        textarea: Boolean(document.querySelector('textarea[data-config-editor]'))
      } })()`
  )
  // The same file, edited: the raw text is one segment away and is the same
  // editor the write path has always used.
  await click(win, 'button[data-config-mode="edit"]')
  await pollJs(win, `document.querySelector('textarea[data-config-editor]')`, 10_000)
  const editable = await js<boolean>(
    win,
    `Boolean(document.querySelector('textarea[data-config-editor]')?.value.includes('SKILL'))
     || Boolean(document.querySelector('textarea[data-config-editor]')?.value.length)`
  )
  const shot = await screenshot(win, shotDir, 'config-skill-rendered.png')

  checks.push({
    id: 'CFG-16',
    criterion: 'Markdown kinds open rendered, frontmatter as chips, with an edit toggle - reusing the content pane’s renderer',
    title: 'A SKILL.md opens as rendered HTML with its frontmatter as chips, and its source is one click away',
    ok:
      skillToken !== undefined &&
      skillToken !== '' &&
      markdown.textarea === false &&
      markdown.chips >= 2 &&
      markdown.body.includes(skillToken) &&
      editable,
    detail: {
      tokenInTheFile: skillToken,
      rendered: markdown,
      textareaAfterEditToggle: editable,
      screenshot: shot.file
    },
    notes: [
      'The token is read out of the fixture here and required to be non-empty before the rendered',
      'body is searched for it - PROF-4’s lesson: an expected value that can go empty makes every',
      'answer match. The absence of a textarea in the reading view is the other half: "rendered"',
      'has to mean the source is not what is on screen.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// CFG-2: editing, in all three scopes
// ---------------------------------------------------------------------------

interface EditOutcome {
  scope: string
  relPath: string
  opened: boolean
  saved: boolean
  dirtyBeforeSave: boolean
  status: string
  onDiskAfter: string | null
  expected: string
  restored: boolean
  restoredHashMatches: boolean
}

async function editChecks(
  ctx: CheckContext,
  shotDir: string,
  fixtures: Fixtures,
  userHome: string
): Promise<Check[]> {
  const { win, services } = ctx
  // The driver's own harness, matched by path - never simply "the first harness the
  // developer's scan happened to find"; see `Fixtures.harnessRoot`.
  const harness = (services.lastScan?.projects ?? []).find(
    (p) => p.kind === 'harness' && p.path.toLowerCase() === fixtures.harness.toLowerCase()
  )
  const outcomes: EditOutcome[] = []

  /**
   * Edits one file through the pane, checks the disk with its own read, then
   * puts it back from the snapshot history and checks the disk again.
   *
   * The restore is not a courtesy to the user's files - it is the criterion-3
   * assertion, made against every edit rather than against one contrived one.
   */
  const roundTrip = async (
    scopePath: string,
    scopeName: string,
    relPath: string,
    transform: (before: string) => string
  ): Promise<EditOutcome> => {
    const absolute = join(scopePath, relPath)
    const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : ''
    const beforeHash = sha256(before)
    const next = transform(before)

    await selectScope(win, scopePath)
    const edit = await editFile(win, relPath, next)
    const onDiskAfter = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null

    // Back to how it was, through the version list in the pane's own footer.
    const versions = ctx.config.snapshots(scopePath, absolute)
    const newest = versions[0]
    let restoredHashMatches = false
    let restored = false
    if (newest) {
      const result = ctx.config.restore(newest.id, absolute)
      restored = result.ok
      restoredHashMatches = sha256File(absolute) === beforeHash
    }

    return {
      scope: scopeName,
      relPath,
      opened: edit.opened,
      saved: edit.saved,
      dirtyBeforeSave: edit.dirtyBeforeSave,
      status: edit.status,
      onDiskAfter: onDiskAfter === null ? null : onDiskAfter.slice(0, 160),
      expected: next.slice(0, 160),
      restored,
      restoredHashMatches
    }
  }

  // ---- user scope: CLAUDE.md, which every session on the machine reads ----
  if (existsSync(join(userHome, 'CLAUDE.md'))) {
    outcomes.push(
      await roundTrip(userHome, 'user', 'CLAUDE.md', (before) => `${before}\n<!-- helm config probe -->\n`)
    )
  }

  // ---- user scope: settings.json, a JSON editor rather than a markdown one --
  outcomes.push(
    await roundTrip(userHome, 'user', 'settings.json', (before) => {
      const document: Record<string, unknown> = before.trim() === '' ? {} : JSON.parse(before)
      const env = { ...((document['env'] as Record<string, unknown>) ?? {}) }
      // Read back out of a live session further down, which is what makes the
      // user layer a *measured* part of the precedence chain rather than an
      // assumed one.
      env['HELM_M5_USERLAYER'] = 'USERLAYER'
      env['HELM_M5_LAYER'] = 'USERWINS'
      return `${JSON.stringify({ ...document, env }, null, 2)}\n`
    })
  )

  // ---- harness scope: a real skill ----
  if (harness) {
    const tree = ctx.config.tree(harness.path)
    const skill = tree.files.find((file) => file.kind === 'skill')
    if (skill) {
      outcomes.push(
        await roundTrip(harness.path, 'harness', skill.relPath, (before) =>
          before.replace(/\n?$/, '\n\n<!-- helm config probe -->\n')
        )
      )
    }
  }

  // ---- project scope: an agent and a settings file in the fixture ----
  outcomes.push(
    await roundTrip(fixtures.workspace, 'project', '.claude/agents/probe-agent.md', (before) =>
      `${before}\nEdited by the config-console driver.\n`
    )
  )
  outcomes.push(
    await roundTrip(fixtures.workspace, 'project', '.claude/settings.json', (before) => {
      const document: Record<string, unknown> = JSON.parse(before)
      return `${JSON.stringify({ ...document, model: 'haiku' }, null, 2)}\n`
    })
  )

  const shot = await screenshot(win, shotDir, 'config-editor.png')
  const kinds = new Set(outcomes.map((outcome) => outcome.scope))

  return [
    {
      id: 'CFG-2',
      criterion:
        'Can view and edit any skill/command/agent/CLAUDE.md/settings.json across all three scopes without leaving the app',
      title: 'A file in each of the three scopes was edited through the pane and landed on disk',
      ok:
        kinds.size === 3 &&
        outcomes.length >= 4 &&
        outcomes.every(
          (outcome) =>
            outcome.opened &&
            outcome.saved &&
            outcome.dirtyBeforeSave &&
            outcome.onDiskAfter !== null &&
            outcome.expected.startsWith(outcome.onDiskAfter.slice(0, 120))
        ),
      detail: { scopesCovered: [...kinds], edits: outcomes, screenshot: shot.file },
      notes: [
        'Every edit is read back with this file’s own readFileSync, not with the pane’s.',
        'The user scope’s files are the user’s real ones; each edit is undone from the',
        'snapshot history immediately, and CFG-3 asserts the bytes came back exactly.'
      ]
    },
    {
      id: 'CFG-3',
      criterion: 'Every write has a snapshot; restore brings back the exact prior bytes (hash-verified)',
      title: 'Every edit above restored to a file whose sha256 matches the pre-edit bytes',
      ok: outcomes.length > 0 && outcomes.every((outcome) => outcome.restored && outcome.restoredHashMatches),
      detail: {
        restores: outcomes.map((outcome) => ({
          scope: outcome.scope,
          file: outcome.relPath,
          restored: outcome.restored,
          hashMatchesPreEditBytes: outcome.restoredHashMatches
        }))
      },
      notes: [
        'The hash is computed in configcheck.ts over the bytes read before the edit and again',
        'after the restore. The snapshot table’s own recorded hash is not consulted - it is',
        'the thing being checked.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// CFG-4: no write without a snapshot
// ---------------------------------------------------------------------------

async function snapshotCheck(ctx: CheckContext, fixtures: Fixtures): Promise<Check> {
  const path = join(fixtures.workspace, '.claude', 'settings.local.json')
  const before = readFileSync(path, 'utf8')
  const beforeHash = sha256(before)
  const snapshotsBefore = countConfigSnapshots(ctx.services.store)
  // Genuinely different bytes, so this is a write rather than a no-op - the
  // no-op is the second half of the check and has to be distinguishable from
  // it. Still valid JSON, because a settings file that is not is a different
  // failure.
  const document = JSON.parse(before) as Record<string, unknown>
  const changed = `${JSON.stringify({ ...document, cleanupPeriodDays: 30 }, null, 2)}\n`

  const first = ctx.config.write({
    scopePath: fixtures.workspace,
    path,
    content: changed,
    expectedHash: sha256File(path) ?? '',
    reason: 'edit'
  })

  // The same bytes again. Nothing is written, so nothing is snapshotted - which
  // is the one case where "every write has a snapshot" is satisfied by there
  // being no write.
  const repeat = ctx.config.write({
    scopePath: fixtures.workspace,
    path,
    content: changed,
    expectedHash: sha256File(path) ?? '',
    reason: 'edit'
  })

  const afterWrites = countConfigSnapshots(ctx.services.store)
  // This file's own history, not the newest row in the database: the snapshot
  // table holds every file the run has touched, and restoring another scope's
  // version into this path is exactly what `assertWritable` exists to refuse.
  const rows = ctx.config.snapshots(fixtures.workspace, path)
  const newest = rows[0]

  // The restore is against the *recorded* content, verified byte for byte here.
  const restored = newest ? ctx.config.restore(newest.id, path) : null
  const backToStart = sha256File(path) === beforeHash

  return {
    id: 'CFG-4',
    criterion: 'Every write has a snapshot; never write without a snapshot',
    title: 'A changed write takes exactly one snapshot, an unchanged one takes none, and neither loses bytes',
    ok:
      first.ok &&
      first.snapshotId !== null &&
      repeat.ok &&
      repeat.unchanged &&
      repeat.snapshotId === null &&
      afterWrites === snapshotsBefore + 1 &&
      newest?.contentHash === beforeHash &&
      restored?.ok === true &&
      backToStart,
    detail: {
      file: path,
      snapshotsBefore,
      snapshotsAfter: afterWrites,
      firstWrite: { ok: first.ok, snapshotId: first.snapshotId, unchanged: first.unchanged },
      repeatWrite: { ok: repeat.ok, snapshotId: repeat.snapshotId, unchanged: repeat.unchanged },
      recordedHash: newest?.contentHash ?? null,
      independentPreWriteHash: beforeHash,
      bytesBackAfterRestore: backToStart
    },
    notes: [
      'The snapshot row goes in before the file is touched, and a failure to write it aborts',
      'the write - so the invariant holds even when the disk write then fails.'
    ]
  }
}

// ---------------------------------------------------------------------------
// CFG-5: malformed JSON never reaches the disk
// ---------------------------------------------------------------------------

async function jsonCheck(ctx: CheckContext, shotDir: string, fixtures: Fixtures): Promise<Check> {
  const { win } = ctx
  const relPath = '.claude/settings.json'
  const path = join(fixtures.workspace, relPath)
  const before = readFileSync(path, 'utf8')
  const beforeHash = sha256(before)
  const snapshotsBefore = countConfigSnapshots(ctx.services.store)

  await selectScope(win, fixtures.workspace)
  await click(win, `button[data-config-file="${cssEscape(relPath)}"]`)
  await openSource(win)
  await sleep(300)

  // A trailing comma on line 3 - the mistake a hand-edited settings file
  // actually gets, and the one V8's own message locates worst.
  const broken = '{\n  "env": {\n    "A": "b",\n  }\n}\n'
  await setValue(win, 'textarea[data-config-editor]', broken)
  await sleep(400)

  const state = await js<{
    saveDisabled: boolean
    error: string
    hasErrorStrip: boolean
  }>(
    win,
    `(() => {
      const save = document.querySelector('button[data-save-config]');
      const strip = document.querySelector('button[data-json-error]');
      return {
        saveDisabled: Boolean(save && save.disabled),
        error: (strip?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        hasErrorStrip: Boolean(strip)
      } })()`
  )

  // Clicked anyway. A disabled button ignores it, which is the point.
  await click(win, 'button[data-save-config]')
  await sleep(600)

  const shot = await screenshot(win, shotDir, 'config-json-error.png')
  const afterHash = sha256File(path)
  const snapshotsAfter = countConfigSnapshots(ctx.services.store)

  // The error has to name a place, and the place has to be the right one: the
  // trailing comma is on line 3, and a validator that reported the end of the
  // file would also "locate" it.
  const located = /(^|\s)3:\d+/.test(state.error)

  return {
    id: 'CFG-5',
    criterion: 'Malformed JSON is rejected client-side before write, with the error located',
    title: 'A trailing comma disables the save, is reported at line 3, and reaches neither the disk nor the snapshot table',
    ok:
      state.saveDisabled &&
      state.hasErrorStrip &&
      located &&
      afterHash === beforeHash &&
      snapshotsAfter === snapshotsBefore,
    detail: {
      file: path,
      typed: broken,
      saveDisabled: state.saveDisabled,
      reported: state.error,
      reportedLine3: located,
      fileUnchanged: afterHash === beforeHash,
      snapshotsBefore,
      snapshotsAfter,
      screenshot: shot.file
    },
    notes: [
      'The position is scanned for rather than read out of V8’s exception: on Node 24 a',
      'trailing comma reports `Unexpected token \',\' ... is not valid JSON` with no offset at',
      'all, and a validator that fell back to the end of the file would mark the wrong line.',
      'Rejected in the renderer, so nothing is sent - the main process is never asked.'
    ]
  }
}

// ---------------------------------------------------------------------------
// CFG-6: an edit made outside the app
// ---------------------------------------------------------------------------

async function externalCheck(ctx: CheckContext, shotDir: string, fixtures: Fixtures): Promise<Check> {
  const { win } = ctx
  const relPath = '.claude/agents/probe-agent.md'
  const path = join(fixtures.workspace, relPath)

  await selectScope(win, fixtures.workspace)
  await click(win, `button[data-config-file="${cssEscape(relPath)}"]`)
  await openSource(win)
  await sleep(400)

  const openedWith = readFileSync(path, 'utf8')
  const staleHash = sha256(openedWith)

  // The user starts typing.
  await setValue(win, 'textarea[data-config-editor]', `${openedWith}\nTyped in Helm.\n`)
  await sleep(200)

  // Something else writes the file. Not through Helm - this is the driver's own
  // `writeFileSync`, which is what another editor would do.
  const outside = `${openedWith}\nWritten by another editor.\n`
  writeFileSync(path, outside)

  const warned = await pollJs(win, `document.querySelector('[data-external-change]')`, 15_000)
  await sleep(400)

  const state = await js<{ warning: string; saveDisabled: boolean; hasReload: boolean }>(
    win,
    `(() => {
      const banner = document.querySelector('[data-external-change]');
      const save = document.querySelector('button[data-save-config]');
      return {
        warning: (banner?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        saveDisabled: Boolean(save && save.disabled),
        hasReload: Boolean(document.querySelector('button[data-reload-external]'))
      } })()`
  )

  const shot = await screenshot(win, shotDir, 'config-external-change.png')
  const stillOutside = readFileSync(path, 'utf8') === outside

  // And the guarantee under the warning: the write path refuses on the hash
  // whether or not the watcher ever fired.
  const refused = ctx.config.write({
    scopePath: fixtures.workspace,
    path,
    content: 'clobbered',
    expectedHash: staleHash,
    reason: 'edit'
  })

  return {
    id: 'CFG-6',
    criterion: 'External edits are detected and the open editor warns before clobbering',
    title: 'A file changed underneath the editor warns, blocks the save, and the write path refuses it anyway',
    ok:
      warned &&
      state.saveDisabled &&
      state.hasReload &&
      /changed on disk/i.test(state.warning) &&
      stillOutside &&
      !refused.ok &&
      refused.conflict?.onDiskContent === outside &&
      readFileSync(path, 'utf8') === outside,
    detail: {
      file: path,
      warningShown: warned,
      warning: state.warning.slice(0, 220),
      saveDisabledWhileUnresolved: state.saveDisabled,
      offersReload: state.hasReload,
      fileStillTheExternalVersion: stillOutside,
      mainProcessRefusal: {
        ok: refused.ok,
        conflicted: refused.conflict !== undefined,
        onDiskMatchesTheExternalWrite: refused.conflict?.onDiskContent === outside
      },
      screenshot: shot.file
    },
    notes: [
      'Two mechanisms, and only one of them is allowed to fail. The fs.watch is a courtesy:',
      'it warns while the user is still typing. The hash check inside writeConfigFile is the',
      'guarantee - it runs on every write, on a filesystem where the watch is silent, and',
      'after a change made while Helm was not running. Both are asserted here.'
    ]
  }
}

// ---------------------------------------------------------------------------
// CFG-7: adding an MCP server through the UI
// ---------------------------------------------------------------------------

async function mcpCheck(ctx: CheckContext, shotDir: string, fixtures: Fixtures): Promise<Check> {
  const { win } = ctx
  const mcpFile = join(fixtures.workspace, '.mcp.json')
  const settingsLocal = join(fixtures.workspace, '.claude', 'settings.local.json')
  rmSync(mcpFile, { force: true })

  await selectScope(win, fixtures.workspace)
  await selectView(win, 'mcp')
  await sleep(500)

  await click(win, 'button[data-mcp-add-open]')
  await sleep(300)
  await setValue(win, 'input[data-mcp-name]', MCP_SERVER)
  await setValue(win, 'select[data-mcp-scope-select]', 'project')
  await setValue(
    win,
    'textarea[data-mcp-json]',
    JSON.stringify({ type: 'stdio', command: 'node', args: [fixtures.mcpServer] })
  )
  await sleep(400)

  const previewed = await click(win, 'button[data-mcp-preview]')
  const diffShown = await pollJs(win, `document.querySelector('[data-mcp-diff]')`, 10_000)
  await sleep(300)

  const diff = await js<string>(
    win,
    `(document.querySelector('[data-mcp-diff] pre')?.textContent ?? '').trim()`
  )
  const diffShot = await screenshot(win, shotDir, 'config-mcp-diff.png')

  // The file must not exist yet: the diff is shown *before* anything is run.
  const fileBeforeApply = existsSync(mcpFile)

  const applied = await click(win, 'button[data-mcp-apply]')
  const written = await waitFor(() => existsSync(mcpFile), 90_000)
  await sleep(1500)

  const onDisk = ((): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(mcpFile, 'utf8')) as Record<string, unknown>
    } catch {
      return null
    }
  })()
  const servers = (onDisk?.['mcpServers'] ?? {}) as Record<string, unknown>
  const entry = servers[MCP_SERVER] as { command?: string; args?: string[] } | undefined

  // A `.mcp.json` server gates on first launch until a settings layer approves
  // it, so the console offers the approval - and it is a snapshotted write like
  // any other, not a special case.
  await sleep(600)
  const approveClicked = await click(win, `button[data-mcp-approve="${MCP_SERVER}"]`)
  await waitFor(() => {
    try {
      const parsed = JSON.parse(readFileSync(settingsLocal, 'utf8')) as Record<string, unknown>
      const list = parsed['enabledMcpjsonServers']
      return Array.isArray(list) && list.includes(MCP_SERVER)
    } catch {
      return false
    }
  }, 20_000)
  await sleep(600)

  const approved = ((): boolean => {
    try {
      const parsed = JSON.parse(readFileSync(settingsLocal, 'utf8')) as Record<string, unknown>
      const list = parsed['enabledMcpjsonServers']
      return Array.isArray(list) && list.includes(MCP_SERVER)
    } catch {
      return false
    }
  })()

  const shot = await screenshot(win, shotDir, 'config-mcp.png')
  const approvalSnapshots = ctx.config.snapshots(fixtures.workspace, settingsLocal)

  return {
    id: 'CFG-7',
    criterion: 'MCP servers: add via `claude mcp add-json` subprocess; show .mcp.json diff before applying',
    title: 'The diff is shown before the CLI runs, and the CLI writes the server into .mcp.json',
    ok:
      previewed &&
      diffShown &&
      !fileBeforeApply &&
      diff.includes(MCP_SERVER) &&
      applied &&
      written &&
      entry?.command === 'node' &&
      entry.args?.[0] === fixtures.mcpServer &&
      approveClicked &&
      approved &&
      approvalSnapshots.length > 0,
    detail: {
      file: mcpFile,
      fileExistedWhenTheDiffWasShown: fileBeforeApply,
      diff: diff.slice(0, 600),
      writtenByTheCli: written,
      onDisk: entry ?? null,
      approvedInSettingsLocal: approved,
      approvalSnapshotTaken: approvalSnapshots.length > 0,
      screenshots: [diffShot.file, shot.file]
    },
    notes: [
      'Helm never edits this file itself: the diff is a prediction, and `claude mcp add-json`',
      'is what actually writes. The file is snapshotted before the subprocess runs, because a',
      'write Helm delegates is still a write Helm caused.',
      'Whether the server actually *works* is CFG-9, which asks a real session to call its tool.'
    ]
  }
}

// ---------------------------------------------------------------------------
// CFG-8 / CFG-9: the effective view, against a computation and against a session
// ---------------------------------------------------------------------------

async function effectiveChecks(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string,
  fixtures: Fixtures,
  userHome: string,
  profile: Profile,
  mcpConfigured: boolean
): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []
  const overlays = [fixtures.alpha, fixtures.beta]

  /**
   * The top of the settings chain, put in place before anything is predicted.
   *
   * The three layers have to be live *at launch* for a session to be able to
   * report which one won - a value written and restored beforehand is a layer
   * the session never saw. So the user layer is set here, through the console's
   * own snapshotted write path, and taken back out at the end of this group
   * from the snapshot that write produced.
   *
   * This is the user's real `~/.claude/settings.json`. It is the only way to
   * measure the user layer rather than assume it: `CLAUDE_CONFIG_DIR` moves the
   * whole config directory, credentials included, so a session pointed at a
   * fixture home cannot start.
   */
  const userSettings = join(userHome, 'settings.json')
  const userBefore = readConfigFileContent(userSettings)
  const userBeforeHash = sha256File(userSettings)
  const userDocument =
    userBefore.exists && userBefore.content.trim() !== ''
      ? (JSON.parse(userBefore.content) as Record<string, unknown>)
      : {}
  const userWrite = ctx.config.write({
    scopePath: userHome,
    path: userSettings,
    content: `${JSON.stringify(
      {
        ...userDocument,
        env: {
          ...((userDocument['env'] as Record<string, unknown>) ?? {}),
          HELM_M5_LAYER: 'USERWINS',
          HELM_M5_USERLAYER: 'USERLAYER'
        }
      },
      null,
      2
    )}\n`,
    expectedHash: userBefore.exists ? userBefore.hash : null,
    reason: 'edit'
  })

  const view = ctx.config.effective({ profileId: profile.id })

  // ---- against an independent computation --------------------------------
  const predicted = predictSkillNames(fixtures.workspace, overlays, userHome)
  const fromView = view.skills.map((skill) => skill.invocation).sort()

  const settings = settingsTruth(fixtures.workspace, userHome)
  const viewSettings = new Map(view.settings.map((setting) => [setting.key, setting]))
  const settingsDisagreements = [...settings.entries()]
    .filter(([key, expected]) => {
      const actual = viewSettings.get(key)
      return actual === undefined || actual.value !== expected.value || actual.winner !== expected.layer
    })
    .map(([key]) => key)

  // The scope this group is about, chosen rather than inherited.
  //
  // The effective view resolves from a *working directory*, and the console
  // takes that from the scope on screen - so this used to depend on whichever
  // scope the group before it happened to leave selected. It passed for as long
  // as that was the workspace, and stopped the moment the browse group started
  // ending on a harness of its own: the pane painted that harness's one skill
  // and the probe compared it against the workspace's four.
  await selectScope(win, fixtures.workspace)
  await selectView(win, 'effective')
  await setValue(win, 'select[data-effective-profile]', String(profile.id))

  const readPainted = (): Promise<{ invocations: string[]; shared: string[] }> =>
    js<{ invocations: string[]; shared: string[] }>(
      win,
      `(() => ({
      invocations: [...document.querySelectorAll('[data-invocation]')].map((el) => el.dataset.invocation),
      shared: [...document.querySelectorAll('[data-shared-name]')].map((el) => el.dataset.sharedName)
    }))()`
    )

  /*
   * Wait for the resolved-names list to settle rather than sleeping at it.
   *
   * The fixed 1.2s was enough until this pane had more to resolve than it used
   * to, and then it was not: the probe read a list that had painted one of its
   * four rows and reported the pane as disagreeing with a service that had
   * answered correctly.
   *
   * The loop cannot invent the right answer - it only stops early. Whatever the
   * pane is holding when the deadline passes is what gets asserted, so a pane
   * that settles on three rows still fails, and one that paints nothing fails
   * with an empty list in the detail rather than with a timeout nobody can read.
   */
  let painted = await readPainted()
  const settleBy = Date.now() + 20_000
  while (painted.invocations.length !== view.skills.length && Date.now() < settleBy) {
    await sleep(300)
    painted = await readPainted()
  }
  const viewShot = await screenshot(win, shotDir, 'config-effective.png')

  const sharedThink = view.sharedNames.find((entry) => entry.name === 'think')

  checks.push({
    id: 'CFG-8',
    criterion: 'Effective view: which skills resolve and under which overlay namespace',
    title: 'Every predicted name matches a hand-built `<overlay>:<skill>` list, and the pane paints them',
    ok:
      fromView.join(',') === predicted.join(',') &&
      sharedThink?.invocations.join(',') === 'alpha:think,beta:think' &&
      settingsDisagreements.length === 0 &&
      painted.invocations.length === view.skills.length &&
      painted.shared.includes('think'),
    detail: {
      cwd: view.cwd,
      overlays: view.overlays,
      view: fromView,
      independentPrediction: predicted,
      sameNamedSkill: sharedThink ?? null,
      settingsKeysChecked: settings.size,
      settingsDisagreements,
      paintedInTheWindow: painted.invocations.length,
      screenshot: viewShot.file
    },
    notes: [
      'The second list is built in configcheck.ts from `basename(overlay).toLowerCase()` and the',
      'skill directory names - it does not call overlayPluginNames, which is the function the',
      'view uses, so the two can disagree.',
      'Settings are compared per leaf against an independent flatten-and-pick over the three',
      'files, winner included.'
    ]
  })

  // ---- against a live session --------------------------------------------
  const before = ctx.sessions.list().length
  const launched = await ctx.sessions.launchProfile({ profileId: profile.id, cols: 100, rows: 30 })
  await waitFor(() => ctx.sessions.list().length > before, 30_000)
  const id = launched.session.id

  const ready = await waitForPrompt(ctx, collector, id, 180_000)

  /*
   * What the terminal actually had on it, recorded whether or not the wait
   * succeeded.
   *
   * Without this the failure reads "the session never reached a prompt" and
   * says nothing about *why* - which is where this check sat for two runs.
   * A gate nobody answered, a CLI that printed an error and exited, and a
   * machine that is simply slow are three different problems with one symptom,
   * and the tail tells them apart. `profilescheck` keeps a local helper of the
   * same shape for the same reason; this is that argument applied to the check
   * that had the failure.
   */
  const terminalTail = stripAnsi(collector.output(id)).replace(/\s+/g, ' ').trim().slice(-1200)

  const tokens = {
    alphaThink: skillToken(join(fixtures.alpha, '.claude', 'skills', 'think', 'SKILL.md')),
    betaThink: skillToken(join(fixtures.beta, '.claude', 'skills', 'think', 'SKILL.md')),
    alphaOnly: skillToken(join(fixtures.alpha, '.claude', 'skills', 'alpha-only', 'SKILL.md'))
  }
  /**
   * The tokens have to exist and differ for the answer to be evidence.
   *
   * This is the PROF-4 lesson, applied here on purpose: a reader that returns
   * `''` for a missing fixture turns the expected token into a substring of
   * every answer, and the check reports green having proved nothing.
   */
  const values = Object.values(tokens)
  const tokensUsable = values.every((token) => token !== '') && new Set(values).size === 3

  // Three skills, one of them the same-named pair under both predicted
  // namespaces. The two `think` bodies carry different tokens, so an answer
  // with both is proof of two distinct skills rather than one resolving twice.
  const skills =
    ready && tokensUsable
      ? await ask(
          ctx,
          collector,
          id,
          `Invoke the skill named alpha:think, then beta:think, then alpha:alpha-only. ` +
            `Each skill body states a token. Then reply with exactly three lines: ` +
            `S1=<the first skill's token>, S2=<the second skill's token>, S3=<the third skill's token>.`,
          [`S1=${tokens.alphaThink}`, `S2=${tokens.betaThink}`, `S3=${tokens.alphaOnly}`]
        )
      : {
          ok: false,
          answer: ready
            ? 'the fixture skills carry no distinct tokens, so no answer would be evidence'
            : 'the session never reached a prompt'
        }

  // The settings override, observed rather than assumed. `env` is the one
  // setting whose winner a session can be asked about directly.
  const settingsProbe = ready
    ? await ask(
        ctx,
        collector,
        id,
        'Use the Bash tool to run: echo "$HELM_M5_LAYER|$HELM_M5_PROJECTONLY|$HELM_M5_USERLAYER" ' +
          'and then reply with exactly ENV=<the line it printed>.',
        ['ENV=LOCALWINS|PROJECTONLY|USERLAYER']
      )
    : { ok: false, answer: 'the session never reached a prompt' }

  const mcpProbe =
    ready && mcpConfigured
      ? await ask(
          ctx,
          collector,
          id,
          'Call the MCP tool helm_probe_token (it takes no arguments) and reply with exactly ' +
            'MCP=<the text it returned>.',
          [`MCP=${TOKENS.mcp}`]
        )
      : { ok: false, answer: mcpConfigured ? 'the session never reached a prompt' : 'the mcp group was not run' }

  const sessionShot = await screenshot(win, shotDir, 'config-session.png')

  const predictedLayer = viewSettings.get('env.HELM_M5_LAYER')

  checks.push({
    id: 'CFG-9',
    criterion:
      'Effective view for a real profile matches observed in-session behavior (>=3 skills, 1 same-named skill in two overlays, 1 setting override)',
    title: 'A live session resolved all three predicted skills and reported the predicted settings winner',
    ok: ready && tokensUsable && skills.ok && settingsProbe.ok,
    detail: {
      session: { id, cwd: launched.session.cwd, argv: launched.session.argv },
      overlaysComposed: launched.overlays,
      reachedPrompt: ready,
      // The last of what was on the terminal. The first thing to read when
      // `reachedPrompt` is false.
      terminalTail,
      skills: {
        asked: ['alpha:think', 'beta:think', 'alpha:alpha-only'],
        expected: { S1: tokens.alphaThink, S2: tokens.betaThink, S3: tokens.alphaOnly },
        tokensUsableAsEvidence: tokensUsable,
        matched: skills.ok,
        answer: skills.answer
      },
      settingOverride: {
        key: 'env.HELM_M5_LAYER',
        predictedWinner: predictedLayer?.winner ?? null,
        predictedValue: predictedLayer?.value ?? null,
        alsoDefinedBy: predictedLayer?.candidates.map((c) => `${c.layer}=${c.value}`) ?? [],
        userLayerWrittenByTheConsole: {
          ok: userWrite.ok,
          snapshotId: userWrite.snapshotId,
          file: userSettings
        },
        observed: settingsProbe.answer,
        matched: settingsProbe.ok
      },
      screenshot: sessionShot.file
    },
    notes: [
      'The two `think` bodies carry different tokens, so a session reporting both has resolved',
      'two distinct skills under two predicted namespaces - not one skill twice. The tokens are',
      'read out of the fixture files and asserted distinct first, because an expected value of',
      '`` is a substring of every answer (see PROF-4, which passed for weeks on exactly that).',
      '`env` is the setting a session can be asked about: the three layers set',
      'HELM_M5_LAYER to USERWINS / PROJECTWINS / LOCALWINS and the session reports which one',
      'arrived. HELM_M5_PROJECTONLY is set only by the project layer, so its presence shows',
      'the merge is per leaf rather than a whole-key replacement - which is why the effective',
      'view is keyed by leaf path.'
    ]
  })

  if (mcpConfigured) {
    checks.push({
      id: 'CFG-10',
      criterion: 'Adding an MCP server through the UI results in a working server in the next launched session',
      title: 'The session launched after the UI added the server called its tool and got the token back',
      ok: ready && mcpProbe.ok,
      detail: {
        server: MCP_SERVER,
        addedBy: 'the config console, via `claude mcp add-json --scope project`',
        approvedBy: 'the config console, via enabledMcpjsonServers in settings.local.json',
        expected: `MCP=${TOKENS.mcp}`,
        answer: mcpProbe.answer,
        transport: 'stdio, a dependency-free node script written by this driver'
      },
      notes: [
        'The server is a fixture rather than a real one on purpose: the criterion is about',
        'Helm’s plumbing, and a check that depended on the network would fail for reasons that',
        'are not Helm’s.',
        'The session is launched *after* both UI actions, which is what "the next launched',
        'session" means.'
      ]
    })
  }

  await ctx.sessions.close({ id, force: true })
  await sleep(2000)

  // The user's file goes back, through the snapshot the write above produced -
  // which is the restore path the console offers, exercised against the one
  // file on the machine where getting it wrong would matter most.
  const undo = userWrite.snapshotId === null ? null : ctx.config.restore(userWrite.snapshotId, userSettings)
  checks.push({
    id: 'CFG-9B',
    criterion: 'Every write has a snapshot; restore brings back the exact prior bytes (hash-verified)',
    title: 'The user’s settings.json, borrowed for the probe above, came back byte-identical',
    ok: userWrite.ok && undo?.ok === true && sha256File(userSettings) === userBeforeHash,
    detail: {
      file: userSettings,
      written: { ok: userWrite.ok, snapshotId: userWrite.snapshotId },
      restored: undo?.ok ?? false,
      hashBefore: userBeforeHash,
      hashAfter: sha256File(userSettings)
    },
    notes: [
      'Not a contrived file: this is `~/.claude/settings.json`, which every session on the',
      'machine reads. The hashes are computed in configcheck.ts, not read off the snapshot row.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// CFG-11: claude doctor
// ---------------------------------------------------------------------------

async function doctorCheck(ctx: CheckContext, shotDir: string): Promise<Check> {
  const { win } = ctx
  await showConsole(win)
  await selectView(win, 'health')
  await sleep(400)

  const clicked = await click(win, 'button[data-run-doctor]')
  const painted = await pollJs(win, `document.querySelector('[data-doctor-output]')`, 180_000)
  await sleep(600)

  const shown = await js<{ output: string; rows: number; exit: string }>(
    win,
    `(() => ({
      output: (document.querySelector('[data-doctor-output]')?.textContent ?? '').trim(),
      rows: document.querySelectorAll('[data-doctor-rows] > div').length,
      exit: (document.querySelector('[data-doctor-exit]')?.textContent ?? '').trim()
    }))()`
  )
  const shot = await screenshot(win, shotDir, 'config-health.png')

  // Independently: the same CLI, run again from here. The two runs are seconds
  // apart, so the version and the platform lines have to agree even though the
  // timing lines will not.
  const { resolveClaudeCommand } = await import('./claude-cli')
  const command = resolveClaudeCommand()
  let secondRun = ''
  if (command) {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    try {
      const result = await promisify(execFile)(command.file, [...command.prefixArgs, 'doctor'], {
        timeout: 120_000,
        windowsHide: true
      })
      secondRun = `${result.stdout}${result.stderr}`.trim()
    } catch (err) {
      const failure = err as { stdout?: string; stderr?: string }
      secondRun = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim()
    }
  }

  const versionLine = /Running:\s*(.+)/.exec(secondRun)?.[1]?.trim() ?? ''

  return {
    id: 'CFG-11',
    criterion: '`claude doctor` output surfaced as a health panel',
    title: 'The panel shows the CLI’s own output, and it agrees with a second run from this file',
    ok:
      clicked &&
      painted &&
      shown.output.length > 20 &&
      shown.rows >= 3 &&
      versionLine !== '' &&
      shown.output.includes(versionLine),
    detail: {
      clicked,
      rowsParsed: shown.rows,
      exit: shown.exit,
      panelOutput: shown.output.slice(0, 400),
      secondRunFromTheDriver: secondRun.slice(0, 400),
      agreedOn: versionLine,
      screenshot: shot.file
    },
    notes: [
      'Shown, not interpreted: the CLI is the authority on whether its own installation is',
      'healthy, and a shell that paraphrased that into a green tick would be inventing a',
      'judgement it did not make. The rows are a layout of its lines, and the raw text is kept',
      'below them for the ones the parse did not recognise.'
    ]
  }
}

// ---------------------------------------------------------------------------
// CFG-12 / CFG-13 / CFG-14: creating, renaming and deleting an entry
// ---------------------------------------------------------------------------

/**
 * The three things a directory supports that replacing one file's bytes does
 * not, driven through the dialogs a user reaches them from.
 *
 * Each group plants what it needs with this file's own `writeFileSync` and
 * removes it again, so any one of them survives `--only=`. Nothing here is
 * asserted against the console's own answer: the tree is re-read with
 * `readdirSync`, the bytes with `readFileSync`, the frontmatter with a regex
 * written below rather than with `parseFrontmatter`, and the restores against a
 * `sha256` taken here before anything was touched.
 */

/** Every file under a directory, relative and forward-slashed, sorted. */
function listUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (at: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(at, entry.name)
      if (entry.isDirectory()) walk(child, `${prefix}${entry.name}/`)
      else if (entry.isFile()) out.push(`${prefix}${entry.name}`)
    }
  }
  walk(dir, '')
  return out.sort()
}

/**
 * A frontmatter field, read by a regex written here.
 *
 * Deliberately not `parseFrontmatter`: the scaffold is produced by code that
 * shares that parser, and a scaffold checked with the parser it was written
 * against is a parser agreeing with itself.
 */
function frontmatterValue(text: string, key: string): string | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!block) return null
  const line = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(block[1] ?? '')
  return line?.[1]?.trim() ?? null
}

/** Escape hatch out of a dialog the driver deliberately could not complete. */
async function dismissDialog(win: BrowserWindow): Promise<void> {
  await js<boolean>(
    win,
    `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true })()`
  )
  await sleep(300)
}

/** Re-reads the scope after the driver has changed the disk behind the app. */
async function refreshScope(win: BrowserWindow): Promise<void> {
  await click(win, 'button[data-config-refresh]')
  await sleep(800)
}

/**
 * The state on screen, in both themes.
 *
 * A UI change is not done until it has been looked at in both, and these
 * dialogs are exactly what `design-shot`'s itinerary does not reach: each is
 * two clicks in, behind a state the walk would have to create and then unwind.
 * The preference is put back, because a check does not get to park a setting.
 *
 * Clicked through `el.click()` rather than a pointer, which is what lets it
 * reach the title bar while a modal backdrop covers the window - and which
 * dispatches no `mousedown`, so the backdrop's own dismiss never fires.
 */
async function shootBothThemes(
  win: BrowserWindow,
  outDir: string,
  name: string
): Promise<{ files: string[]; applied: boolean }> {
  const before = await js<string>(
    win,
    `(() => {
      const on = document.querySelector('[role="radiogroup"][aria-label="Theme"] [aria-checked="true"]');
      return on?.getAttribute('aria-label') ?? 'Match the system theme' })()`
  )
  const files: string[] = []
  let applied = true
  for (const [theme, label] of [
    ['dark', 'Dark theme'],
    ['light', 'Light theme']
  ] as const) {
    await click(win, `button[aria-label="${label}"]`)
    /**
     * Waited for rather than slept through, and reported when it does not
     * happen.
     *
     * The preference goes to main and comes back as `theme:resolved`, so a
     * capture taken on a fixed timer can photograph the previous theme - which
     * had already happened here: two PNGs, one called `-dark` and one `-light`,
     * byte-for-byte identical. Two pictures of the same thing is a design
     * review with no evidence behind it, and it looks exactly like one with.
     */
    const landed = await pollJs(
      win,
      `document.documentElement.classList.contains('dark') === ${String(theme === 'dark')}`,
      8_000
    )
    if (!landed) applied = false
    await sleep(400)
    /**
     * One frame is captured and thrown away first.
     *
     * `capturePage` can hand back the frame the compositor last committed, and
     * on a window nobody is looking at that is the *previous* state - which is
     * how a shot of the rename dialog and a shot of the delete dialog came out
     * byte-for-byte identical here. Asking twice forces a current one.
     */
    await win.webContents.capturePage()
    await sleep(250)
    files.push((await screenshot(win, outDir, `${name}-${theme}.png`)).file)
  }

  // And the belt to that pair of braces: two files with the same bytes are two
  // pictures of one thing, whatever the names on them say.
  const [dark, light] = files
  if (dark !== undefined && light !== undefined && sha256File(dark) === sha256File(light)) {
    applied = false
  }

  await click(win, `button[aria-label="${before}"]`)
  await sleep(350)
  return { files, applied }
}

interface NewDialogRun {
  opened: boolean
  /** The path the dialog says it will write, read off its own preview. */
  target: string
  problem: string
  createDisabled: boolean
  closed: boolean
}

/** Opens New, fills it in, and presses Create. */
async function createThrough(
  win: BrowserWindow,
  kind: string,
  name: string | null
): Promise<NewDialogRun> {
  const opened =
    (await click(win, 'button[data-config-new]')) &&
    (await pollJs(win, `document.querySelector('[data-config-new-dialog]')`, 10_000))
  if (!opened) {
    return { opened: false, target: '', problem: '', createDisabled: true, closed: false }
  }

  await setValue(win, 'select[data-config-new-kind]', kind)
  await sleep(250)
  if (name !== null) await setValue(win, 'input[data-config-new-name]', name)
  await sleep(400)

  const state = await js<{ target: string; problem: string; createDisabled: boolean }>(
    win,
    `(() => {
      const create = document.querySelector('button[data-config-new-create]');
      return {
        target: (document.querySelector('[data-config-new-target]')?.textContent ?? '').trim(),
        problem: (document.querySelector('[data-config-dialog-problem]')?.textContent ?? '')
          .replace(/\\s+/g, ' ').trim(),
        createDisabled: Boolean(create && create.disabled)
      } })()`
  )

  await click(win, 'button[data-config-new-create]')
  await sleep(1000)
  const closed = !(await js<boolean>(
    win,
    `Boolean(document.querySelector('[data-config-new-dialog]'))`
  ))
  return { opened, ...state, closed }
}

async function createChecks(
  ctx: CheckContext,
  shotDir: string,
  fixtures: Fixtures,
  userHome: string
): Promise<Check[]> {
  const { win } = ctx
  const skillDir = join(fixtures.workspace, '.claude', 'skills', 'helm-probe-skill')
  const skillFile = join(skillDir, 'SKILL.md')
  const namespaceDir = join(fixtures.workspace, '.claude', 'commands', 'helm-ns')
  const commandFile = join(namespaceDir, 'cmd.md')

  // Nothing is planted: the point of this group is that the *app* makes these,
  // so the pre-state has to be their absence - and it is asserted, because "the
  // file is there afterwards" passes trivially against a file that already was.
  rmSync(skillDir, { recursive: true, force: true })
  rmSync(namespaceDir, { recursive: true, force: true })
  const absentBefore = !existsSync(skillFile) && !existsSync(commandFile)

  await selectScope(win, fixtures.workspace)
  await refreshScope(win)

  const snapshotsBefore = countConfigSnapshots(ctx.services.store)
  const skillRun = await createThrough(win, 'skill', 'helm-probe-skill')
  // The pane as the create leaves it: the new file open in the editor, the `+`
  // beside the filter, and the two controls on the editor's header.
  const createdShots = await shootBothThemes(win, shotDir, 'config-new-created')

  // Read back with this file's own reader, parsed with the regex above.
  const skillBody = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : ''
  const skillName = frontmatterValue(skillBody, 'name')
  const skillDescription = frontmatterValue(skillBody, 'description')

  // The editor is opened on what was created, because every scaffold is a
  // placeholder whose text says what to replace.
  const editorHas = await js<string>(
    win,
    `(document.querySelector('textarea[data-config-editor]')?.value ?? '').slice(0, 400)`
  )

  const commandRun = await createThrough(win, 'command', 'helm-ns:cmd')
  const commandBody = existsSync(commandFile) ? readFileSync(commandFile, 'utf8') : ''

  // The same name again. Refused in the dialog, before anything is sent.
  const skillHashAfterFirst = sha256File(skillFile)
  const snapshotsAfterCreates = countConfigSnapshots(ctx.services.store)
  const collision = await createThrough(win, 'skill', 'helm-probe-skill')
  // The dialog is still open here, which is what makes this the shot of the
  // dialog itself - refusing, with the reason under the field.
  const collisionShots = await shootBothThemes(win, shotDir, 'config-new-dialog')
  await dismissDialog(win)

  // And a name the CLI could not address, refused the same way.
  const badName = await createThrough(win, 'skill', 'Not A Name')
  await dismissDialog(win)

  const checks: Check[] = [
    {
      id: 'CFG-12',
      criterion:
        'New scaffolds by kind; the name is validated against how the CLI addresses it and a collision is refused before anything is written',
      title:
        'A skill and a namespaced command were created through the dialog, and a repeat of each was refused with nothing written',
      ok:
        absentBefore &&
        // Both themes were actually on screen when they were photographed.
        createdShots.applied && collisionShots.applied &&
        skillRun.opened &&
        skillRun.closed &&
        // The dialog's own preview named the file that then appeared.
        skillRun.target === '.claude/skills/helm-probe-skill/SKILL.md' &&
        existsSync(skillFile) &&
        skillName === 'helm-probe-skill' &&
        (skillDescription ?? '').length > 20 &&
        editorHas.includes('description:') &&
        commandRun.closed &&
        existsSync(commandFile) &&
        (frontmatterValue(commandBody, 'description') ?? '').includes('/helm-ns:cmd') &&
        // Two files, two `create` rows, and nothing else.
        snapshotsAfterCreates === snapshotsBefore + 2 &&
        // Both refusals happen in the dialog: the button is disabled, a reason
        // is on screen, the dialog stays open, and nothing moved on disk.
        collision.createDisabled &&
        /already/i.test(collision.problem) &&
        !collision.closed &&
        badName.createDisabled &&
        badName.problem !== '' &&
        !badName.closed &&
        sha256File(skillFile) === skillHashAfterFirst &&
        countConfigSnapshots(ctx.services.store) === snapshotsAfterCreates,
      detail: {
        absentBeforeTheRun: absentBefore,
        skill: {
          previewedTarget: skillRun.target,
          onDisk: skillFile,
          frontmatterName: skillName,
          frontmatterDescriptionChars: (skillDescription ?? '').length,
          openedInTheEditor: editorHas.includes('description:')
        },
        command: {
          previewedTarget: commandRun.target,
          onDisk: commandFile,
          // `commands/helm-ns/cmd.md` is `/helm-ns:cmd`, which is the whole
          // point of a namespaced file and unguessable from a flat listing.
          description: frontmatterValue(commandBody, 'description')
        },
        snapshots: {
          before: snapshotsBefore,
          afterTwoCreates: snapshotsAfterCreates,
          afterTheTwoRefusals: countConfigSnapshots(ctx.services.store)
        },
        refusals: {
          collision: { disabled: collision.createDisabled, said: collision.problem },
          badName: { disabled: badName.createDisabled, said: badName.problem }
        },
        screenshots: [...createdShots.files, ...collisionShots.files],
        bothThemesActuallyRendered: createdShots.applied && collisionShots.applied
      },
      notes: [
        'The frontmatter is read back with a regex written in configcheck.ts, not with',
        'parseFrontmatter - the scaffold is produced by code that shares that parser, and a',
        'scaffold checked with its own parser proves nothing.',
        'Absence beforehand is asserted, because "the file is there afterwards" passes',
        'trivially against a file that was already there.'
      ]
    }
  ]

  // ---- the user scope, which is the one Helm otherwise only reads ----------
  /**
   * Creating in `~/.claude` and removing it again, with the directory around it
   * listed either side.
   *
   * The posture criterion made concrete: the user scope is writable through the
   * console and through nothing else, by the same guard and the same
   * snapshot-first path, and a run that exercises it leaves the tree as it
   * found it. Through the service rather than the window so the cleanup below
   * is unconditional.
   */
  const probeSkill = join(userHome, 'skills', 'helm-config-probe-only')
  const skillsBefore = listUnder(join(userHome, 'skills')).join(',')
  const takenAlready = existsSync(probeSkill)
  let userCreated = false
  let userRemoved = false
  let userScopeError: string | null = null
  try {
    if (!takenAlready) {
      const created = ctx.config.create({
        scopePath: userHome,
        kind: 'skill',
        name: 'helm-config-probe-only'
      })
      userCreated = created.ok && existsSync(join(probeSkill, 'SKILL.md'))
      userScopeError = created.error
      if (created.ok && created.path !== null) {
        const removed = ctx.config.remove({ scopePath: userHome, path: created.path })
        userRemoved = removed.ok && !existsSync(probeSkill)
        userScopeError = userScopeError ?? removed.error
      }
    }
  } finally {
    // The backstop, for the case where this process dies between the two. A
    // driver does not get to leave a directory in somebody's `~/.claude`.
    rmSync(probeSkill, { recursive: true, force: true })
  }
  const skillsAfter = listUnder(join(userHome, 'skills')).join(',')

  checks.push({
    id: 'CFG-12B',
    criterion: '`~/.claude` stays read-only apart from the console, and the posture is unchanged',
    title:
      'A skill created and removed in the real user scope left its skills directory listing identical',
    ok: !takenAlready && userCreated && userRemoved && skillsBefore === skillsAfter,
    detail: {
      scope: userHome,
      probe: probeSkill,
      nameWasFree: !takenAlready,
      created: userCreated,
      removedAgain: userRemoved,
      skillsListingBefore: skillsBefore === '' ? '(no skills directory)' : skillsBefore,
      skillsListingAfter: skillsAfter === '' ? '(no skills directory)' : skillsAfter,
      error: userScopeError
    },
    notes: [
      'The listing either side is this file’s own recursive readdirSync, so a create that',
      'touched anything but its own directory comes out as a different string.',
      'Every new path reaches the disk through the same assertWritable the editor’s save does,',
      'so the set of files Helm may write is what it was.'
    ]
  })

  rmSync(skillDir, { recursive: true, force: true })
  rmSync(namespaceDir, { recursive: true, force: true })
  return checks
}

// ---------------------------------------------------------------------------
// CFG-13: renaming
// ---------------------------------------------------------------------------

async function renameChecks(
  ctx: CheckContext,
  shotDir: string,
  fixtures: Fixtures
): Promise<Check[]> {
  const { win } = ctx
  const claude = join(fixtures.workspace, '.claude')
  const fromDir = join(claude, 'skills', 'helm-rename-me')
  const toDir = join(claude, 'skills', 'helm-renamed')
  const fromCommand = join(claude, 'commands', 'helm-old', 'thing.md')
  const toCommand = join(claude, 'commands', 'helm-new', 'thing.md')

  for (const dir of [fromDir, toDir, join(claude, 'commands', 'helm-old'), join(claude, 'commands', 'helm-new')]) {
    rmSync(dir, { recursive: true, force: true })
  }

  // Planted by this driver, not by the app. A skill *and* a file bundled beside
  // it, because "moves the directory rather than the SKILL.md" is the criterion
  // and a one-file skill cannot tell the two apart.
  const skillBody = '---\nname: helm-rename-me\ndescription: A probe skill.\n---\n# Rename me\n'
  const resourceBody = '# A resource this skill bundles\n\nHELMRENAMERESOURCE\n'
  mkdirSync(fromDir, { recursive: true })
  writeFileSync(join(fromDir, 'SKILL.md'), skillBody)
  writeFileSync(join(fromDir, 'reference.md'), resourceBody)
  mkdirSync(join(claude, 'commands', 'helm-old'), { recursive: true })
  writeFileSync(fromCommand, '# A probe command\n\nHELMRENAMECOMMAND\n')

  // The fixture has to be there and has to discriminate before any pass is
  // believed: two files in the skill, with different bytes.
  const plantedFiles = listUnder(fromDir)
  const fixtureOk =
    plantedFiles.join(',') === 'SKILL.md,reference.md' &&
    sha256(skillBody) !== sha256(resourceBody) &&
    existsSync(fromCommand)
  const skillHash = sha256(skillBody)
  const resourceHash = sha256(resourceBody)
  const commandHash = sha256File(fromCommand)

  await selectScope(win, fixtures.workspace)
  await refreshScope(win)

  const renameThrough = async (
    relPath: string,
    name: string
  ): Promise<{ opened: boolean; target: string; closed: boolean; disabled: boolean }> => {
    const picked = await click(win, `button[data-config-file="${cssEscape(relPath)}"]`)
    await pollJs(win, `document.querySelector('button[data-rename-config]')`, 10_000)
    await sleep(300)
    const disabled = await js<boolean>(
      win,
      `Boolean(document.querySelector('button[data-rename-config]')?.disabled)`
    )
    const opened =
      picked &&
      (await click(win, 'button[data-rename-config]')) &&
      (await pollJs(win, `document.querySelector('[data-config-rename-dialog]')`, 10_000))
    if (!opened) return { opened: false, target: '', closed: false, disabled }
    await setValue(win, 'input[data-config-rename-name]', name)
    await sleep(400)
    const target = await js<string>(
      win,
      `(document.querySelector('[data-config-rename-target]')?.textContent ?? '').replace(/^→\\s*/, '').trim()`
    )
    await click(win, 'button[data-config-rename-apply]')
    await sleep(1100)
    const closed = !(await js<boolean>(
      win,
      `Boolean(document.querySelector('[data-config-rename-dialog]'))`
    ))
    return { opened, target, closed, disabled }
  }

  const skillRun = await renameThrough('.claude/skills/helm-rename-me/SKILL.md', 'helm-renamed')
  const commandRun = await renameThrough('.claude/commands/helm-old/thing.md', 'helm-new:thing')

  // The dialog itself, opened again on the renamed skill and left open. Shot
  // rather than asserted - what it says is CFG-13's business, what it looks
  // like is nobody's until somebody looks.
  await click(win, `button[data-config-file="${cssEscape('.claude/skills/helm-renamed/SKILL.md')}"]`)
  await pollJs(win, `document.querySelector('button[data-rename-config]')`, 10_000)
  await click(win, 'button[data-rename-config]')
  await pollJs(win, `document.querySelector('[data-config-rename-dialog]')`, 10_000)
  await sleep(400)
  const shots = await shootBothThemes(win, shotDir, 'config-rename-dialog')
  await dismissDialog(win)

  // A file the CLI finds by its exact name cannot be renamed, and the control
  // says so rather than being missing.
  await click(win, `button[data-config-file="${cssEscape('.claude/settings.json')}"]`)
  await pollJs(win, `document.querySelector('button[data-rename-config]')`, 10_000)
  await sleep(300)
  const settingsRename = await js<{ disabled: boolean; title: string }>(
    win,
    `(() => {
      const el = document.querySelector('button[data-rename-config]');
      return { disabled: Boolean(el && el.disabled), title: el?.title ?? '' } })()`
  )

  const movedFiles = listUnder(toDir)
  const movedSkill = existsSync(join(toDir, 'SKILL.md'))
    ? readFileSync(join(toDir, 'SKILL.md'), 'utf8')
    : ''
  // A skill's `name` and its directory have to agree, so the one line that is
  // *expected* to differ is checked for differing, and the rest for not: the
  // body is compared with the `name:` line swapped back to what it was.
  const skillBodyUnchanged =
    sha256(movedSkill.replace(/^name: helm-renamed$/m, 'name: helm-rename-me')) === skillHash

  const ok =
    fixtureOk && shots.applied &&
    skillRun.closed &&
    skillRun.target === '.claude/skills/helm-renamed/SKILL.md' &&
    // The whole directory moved, keeping its layout, and the old one is gone.
    movedFiles.join(',') === 'SKILL.md,reference.md' &&
    frontmatterValue(movedSkill, 'name') === 'helm-renamed' &&
    skillBodyUnchanged &&
    // A file that declares no name is moved untouched.
    sha256File(join(toDir, 'reference.md')) === resourceHash &&
    !existsSync(fromDir) &&
    // A command's name is its path, so a rename crosses the namespace and the
    // directory it emptied goes with it.
    commandRun.closed &&
    existsSync(toCommand) &&
    sha256File(toCommand) === commandHash &&
    !existsSync(join(claude, 'commands', 'helm-old')) &&
    settingsRename.disabled &&
    settingsRename.title.length > 20

  for (const dir of [fromDir, toDir, join(claude, 'commands', 'helm-old'), join(claude, 'commands', 'helm-new')]) {
    rmSync(dir, { recursive: true, force: true })
  }

  return [
    {
      id: 'CFG-13',
      criterion:
        'Rename moves a skill’s directory rather than its SKILL.md, and renames a command across its namespace path',
      title:
        'A skill arrived with the file it bundles and its frontmatter name following it; a command crossed its namespace and the emptied one was pruned',
      ok,
      detail: {
        fixture: {
          planted: plantedFiles,
          discriminating: sha256(skillBody) !== sha256(resourceBody),
          ok: fixtureOk
        },
        skill: {
          previewedTarget: skillRun.target,
          filesAtTheNewName: movedFiles,
          frontmatterNameFollowed: frontmatterValue(movedSkill, 'name'),
          everythingElseInTheSkillMdUnchanged: skillBodyUnchanged,
          bundledFileHashMatches: sha256File(join(toDir, 'reference.md')) === resourceHash,
          oldDirectoryGone: !existsSync(fromDir)
        },
        command: {
          previewedTarget: commandRun.target,
          from: fromCommand,
          to: toCommand,
          bytesUnchanged: sha256File(toCommand) === commandHash,
          emptiedNamespacePruned: !existsSync(join(claude, 'commands', 'helm-old'))
        },
        settingsJson: settingsRename,
        screenshots: shots.files,
        bothThemesActuallyRendered: shots.applied
      },
      notes: [
        'The hashes are computed in configcheck.ts over the bytes it planted, so this is a claim',
        'about the file’s contents surviving the move rather than about the move being reported.',
        'The SKILL.md is the one file expected to differ, by exactly one line: a skill whose',
        'frontmatter name and whose directory disagree has been half-renamed. So the assertion',
        'is that the name followed *and* that swapping that line back reproduces the original',
        'hash - a rename that rewrote anything else would fail the second half.',
        'The bundled file is what makes the criterion checkable: a skill with one file in it',
        'cannot distinguish "moved the directory" from "moved the SKILL.md".',
        'settings.json is the converse - the CLI finds it by that exact name, so the control is',
        'disabled with the reason in its title rather than absent.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// CFG-14: deleting, and undoing it from the same history
// ---------------------------------------------------------------------------

async function deleteChecks(
  ctx: CheckContext,
  shotDir: string,
  fixtures: Fixtures
): Promise<Check[]> {
  const { win } = ctx
  const claude = join(fixtures.workspace, '.claude')
  const dir = join(claude, 'skills', 'helm-delete-me')
  rmSync(dir, { recursive: true, force: true })

  const skillBody = '---\nname: helm-delete-me\ndescription: A probe skill.\n---\n# Delete me\n'
  const resourceBody = '# Bundled\n\nHELMDELETERESOURCE\n'
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillBody)
  writeFileSync(join(dir, 'reference.md'), resourceBody)

  const planted = listUnder(dir)
  const fixtureOk =
    planted.join(',') === 'SKILL.md,reference.md' && sha256(skillBody) !== sha256(resourceBody)
  const skillHash = sha256(skillBody)
  const resourceHash = sha256(resourceBody)

  await selectScope(win, fixtures.workspace)
  await refreshScope(win)

  const picked = await click(
    win,
    `button[data-config-file="${cssEscape('.claude/skills/helm-delete-me/SKILL.md')}"]`
  )
  await pollJs(win, `document.querySelector('button[data-delete-config]')`, 10_000)
  await sleep(300)

  const snapshotsBefore = countConfigSnapshots(ctx.services.store)
  const dialogOpened =
    (await click(win, 'button[data-delete-config]')) &&
    (await pollJs(win, `document.querySelector('[data-config-delete-dialog]')`, 10_000))
  await sleep(400)

  // What the confirmation *says* it will remove, read off its own list. The
  // claim a destructive control makes has to be the thing it then does.
  const promised = await js<string[]>(
    win,
    `[...document.querySelectorAll('[data-config-delete-files] li')]
       .map((li) => (li.querySelector('span')?.textContent ?? '').trim())`
  )
  const saysRestorable = await js<string>(
    win,
    `(document.querySelector('[data-config-delete-dialog]')?.textContent ?? '')
       .replace(/\\s+/g, ' ').trim()`
  )
  const dialogShots = await shootBothThemes(win, shotDir, 'config-delete-confirm')
  // Cancel is what the keyboard would press, because the two answers do not
  // cost the same.
  const cancelFocused = await js<boolean>(
    win,
    `document.activeElement === document.querySelector('button[data-config-delete-cancel]')`
  )

  await click(win, 'button[data-config-delete-confirm]')
  await sleep(1200)

  const goneNow = !existsSync(dir)
  const snapshotsAfter = countConfigSnapshots(ctx.services.store)
  const noticeShown = await pollJs(win, `document.querySelector('[data-config-deleted-notice]')`, 10_000)
  const afterShots = await shootBothThemes(win, shotDir, 'config-deleted-notice')

  // Undo, which is `config:restore` over the rows the delete took - the same
  // per-file history the editor's version list restores from.
  const undone = await click(win, 'button[data-config-undo-delete]')
  await sleep(1500)

  const restored = listUnder(dir)
  const ok =
    fixtureOk && dialogShots.applied && afterShots.applied &&
    picked &&
    dialogOpened &&
    cancelFocused &&
    // Promised exactly the two files, and no others.
    promised.join(',') === '.claude/skills/helm-delete-me/SKILL.md,.claude/skills/helm-delete-me/reference.md' &&
    /Undo puts them back/i.test(saysRestorable) &&
    goneNow &&
    // One row per file, taken before anything came off the disk.
    snapshotsAfter === snapshotsBefore + 2 &&
    noticeShown &&
    undone &&
    restored.join(',') === 'SKILL.md,reference.md' &&
    sha256File(join(dir, 'SKILL.md')) === skillHash &&
    sha256File(join(dir, 'reference.md')) === resourceHash

  rmSync(dir, { recursive: true, force: true })

  return [
    {
      id: 'CFG-14',
      criterion: 'Delete is snapshotted first and restorable from the existing per-file history',
      title:
        'A skill’s two files were named in the confirmation, removed, and put back byte-identical from the rows the delete took',
      ok,
      detail: {
        fixture: { planted, discriminating: fixtureOk },
        confirmation: {
          promisedToRemove: promised,
          cancelHadFocus: cancelFocused,
          saysWhatBringsItBack: /Undo puts them back/i.test(saysRestorable)
        },
        removed: goneNow,
        snapshots: { before: snapshotsBefore, after: snapshotsAfter, expected: snapshotsBefore + 2 },
        undo: {
          stripShown: noticeShown,
          filesBack: restored,
          skillMdHashMatches: sha256File(join(dir, 'SKILL.md')) === skillHash,
          bundledFileHashMatches: sha256File(join(dir, 'reference.md')) === resourceHash
        },
        screenshots: [...dialogShots.files, ...afterShots.files],
        bothThemesActuallyRendered: dialogShots.applied && afterShots.applied
      },
      notes: [
        'The hashes are taken in configcheck.ts over the bytes it planted, before the delete, and',
        'again after the undo - so this is a claim about the exact prior bytes rather than about',
        'a file of the right name existing.',
        'Undo goes through config:restore over the rows the delete wrote, which is the same',
        'per-file history the editor’s version list restores from. It is not a fourth mechanism.',
        'The confirmation is compared against what was actually removed: a destructive control',
        'that names one set and acts on another is the failure this is here for.'
      ]
    }
  ]
}

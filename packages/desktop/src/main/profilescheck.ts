import { type BrowserWindow } from 'electron'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  createProfile,
  deleteProfile,
  findProfileByName,
  listProfiles,
  profileDraft,
  profileFromYaml,
  profileToYaml,
  readProfile,
  type Profile,
  type Project
} from '@helm/core'
import { screenshot, sleep, squash, stripAnsi, waitFor } from './bridge'
import type { Check } from './fidelity'
import { atPrompt, type Collector } from './sessionscheck'
import { shimRoot } from './paths'
import type { Services } from './services'
import type { SessionHost } from './sessions'

/**
 * The profile and overlay criteria, driven through the app the way a user
 * reaches them.
 *
 * This is the claim the whole product is contingent on: if a root-launched
 * session with overlays does not actually expose project skills, the premise is
 * wrong. The composition spike proved the mechanism headlessly with `-p`; what
 * is here is the first interactive proof, in a hosted TUI, from a profile the
 * driver built by clicking the real form.
 *
 * So the probes talk to a live model rather than asserting on argv alone. Argv
 * is checked too, because it is cheap and exact - but a composed session that
 * assembles the right flags and still cannot invoke a skill would pass an
 * argv-only check, and that is precisely the failure this check exists to rule
 * out.
 *
 * `pnpm profiles-check` -> helm-data/profiles-report.json
 */

export interface ProfilesContext {
  win: BrowserWindow
  services: Services
  sessions: SessionHost
}

/** Haiku throughout: these probes are about resolution, not reasoning, and the
 * driver waits on every one of them. */
const MODEL = 'haiku'

/** Distinctive enough that it cannot appear in the TUI by accident. */
const OPENING_TOKEN = 'HELM-OPENING-OK'
const OPENING_PROMPT = `Reply with exactly the token ${OPENING_TOKEN} and nothing else.`

const PROFILE_NAME = 'Overlay composition'
const FIXTURE_PROFILE = 'Skill refresh'
const FORM_PROFILE = 'Picker probe'
/** Stands in for a profile written before the two fields became pickers. */
const LEGACY_PROFILE = 'Unresolvable names'

// ---------------------------------------------------------------------------
// Talking to the renderer
// ---------------------------------------------------------------------------

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  return win.webContents.executeJavaScript(expression, true) as Promise<T>
}

async function clickByLabel(win: BrowserWindow, label: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = [...document.querySelectorAll('[aria-label]')]
        .find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!el) return false; el.click(); return true })()`
  )
}

async function clickButtonText(win: BrowserWindow, text: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent ?? '').includes(${JSON.stringify(text)}));
      if (!el) return false; el.click(); return true })()`
  )
}

/**
 * Sets a React-controlled field.
 *
 * Assigning `.value` updates the DOM node and nothing else: React tracks the
 * previous value on the element and skips the change it did not see happen. The
 * prototype's setter plus a bubbling `input` event is what makes React notice,
 * and it is the same path a keystroke takes.
 */
async function fill(win: BrowserWindow, label: string, value: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => {
      const el = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
      if (!el) return false;
      const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement : window.HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true })()`
  )
}

async function isChecked(win: BrowserWindow, label: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
      return Boolean(el && el.checked) })()`
  )
}

async function tabOrder(win: BrowserWindow): Promise<string[]> {
  return js<string[]>(
    win,
    `[...document.querySelectorAll('[role="tab"]')].map((t) => t.dataset.tab ?? '')`
  )
}

async function pollJs(win: BrowserWindow, expression: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await js<boolean>(win, `Boolean(${expression})`).catch(() => false)
    if (ok) return true
    await sleep(250)
  }
  return false
}

// ---------------------------------------------------------------------------
// Talking to a hosted session
// ---------------------------------------------------------------------------

/**
 * Answers the consent prompts a hosted session raises, for as long as it runs.
 *
 * Two families, and the second is why this exists rather than sessions-check's
 * startup-only version. Folder trust and MCP enablement happen once, at start.
 * **Skill consent happens every time a skill is invoked** - "Use skill
 * `<overlay>:<skill>`? 1. Yes / 2. Yes, and don't ask again / 3. No" - which is
 * exactly what these checks do on purpose. Left unanswered it does not fail
 * loudly; the session simply sits on the prompt, and the answer to the probe
 * arrives minutes later, during some later probe's window, which reads as the
 * composition being broken when it is not.
 *
 * Answered by Enter rather than by typing `1`: the caret already sits on Yes,
 * and Enter means the same thing whether or not the menu takes digits.
 * Occurrences are counted rather than matched, so a second prompt with the same
 * wording is still answered and an already-answered one is not answered twice.
 */
export function answerConsent(ctx: ProfilesContext, collector: Collector, ids: number[]): () => void {
  const answered = new Map<string, number>()
  const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length

  /**
   * A session's captured output is cumulative, so the gates answered earlier in
   * its life are still in it. Seeding the counts with what is already there is
   * what makes this "answer the gates from here on" rather than "answer every
   * gate this session has ever shown" - and the latter is not merely redundant:
   * the MCP gate is answered with Escape, which in a session that has since
   * reached its prompt cancels whatever the model is in the middle of.
   */
  const baseline = (id: number, kind: string, re: RegExp): void => {
    answered.set(`${kind}:${String(id)}`, count(squash(collector.output(id)), re))
  }
  for (const id of ids) {
    baseline(id, 'trust', /doyoutrust|trustthisfolder|quicksafetycheck/g)
    baseline(id, 'mcp', /mcpservers/g)
    baseline(id, 'consent', /doyouwanttoproceed/g)
  }

  const timer = setInterval(() => {
    for (const id of ids) {
      // Matched against `squash`ed output - lowercased, all whitespace removed.
      // The TUI positions text by moving the cursor rather than by emitting the
      // spaces between words, so the stream really does read
      // `quicksafetycheck:isthisaproject...`, and a pattern with a space in it
      // matches nothing. sessions-check's `/Do you trust/` survived only because
      // folders it launched against were already trusted.
      const text = squash(collector.output(id))
      // Wording moves between releases: 2.1.225 asks folder trust as "Quick
      // safety check: Is this a project you created or one you trust?" where an
      // earlier one asked "Do you trust the files in this folder?". Both are
      // listed rather than one replaced - a stale alternative costs nothing,
      // and an unanswered gate is a session that hangs to the timeout without
      // saying why.
      const gates: Array<[string, RegExp, string]> = [
        ['trust', /doyoutrust|trustthisfolder|quicksafetycheck/g, '\r'],
        ['mcp', /mcpservers/g, '\x1b'],
        ['consent', /doyouwanttoproceed/g, '\r']
      ]
      for (const [kind, re, keys] of gates) {
        const key = `${kind}:${String(id)}`
        const seen = count(text, re)
        if (seen > (answered.get(key) ?? 0)) {
          answered.set(key, seen)
          if (kind === 'trust') {
            /*
             * Confirming the trust gate means confirming the *right option*,
             * and which one is selected is not something to assume.
             *
             * Claude Code 2.1.259 opens this gate with `No, exit` selected -
             * the safe default, and the correct one for a person. A bare Enter
             * therefore answers **no**, the CLI exits, and the check that was
             * waiting for a prompt waits out its whole timeout and reports "the
             * session never reached a prompt" with no hint that it had killed
             * its own session. That is what CFG-9 and CFG-10 were doing, and
             * the tail in the report is what finally showed it.
             *
             * So the marker is read rather than the default guessed: `squash`
             * keeps the `❯`, which sits immediately before the selected label.
             * On `no` the selection is moved down first; on `yes` - or on a
             * screen where the marker cannot be found, which is the state a
             * reworded gate would produce - Enter alone, which is what this did
             * before and is no worse than it was.
             */
            const marker = text.lastIndexOf('❯')
            const selected = marker === -1 ? '' : text.slice(marker + 1, marker + 12)
            if (selected.startsWith('no')) ctx.sessions.input(id, '\x1b[B')
          }
          ctx.sessions.input(id, keys)
        }
      }
    }
  }, 400)
  return () => clearInterval(timer)
}

/**
 * Types a prompt into a live TUI and waits for the answer to contain `expect`.
 *
 * Compared against `squash`ed output because the TUI positions text without
 * emitting the spaces between words, so nothing about the whitespace in a
 * rendered answer is dependable. The text and the Enter go separately: sent as
 * one write, a long line arrives as a paste, which the composer treats
 * differently from typed input.
 */
export async function ask(
  ctx: ProfilesContext,
  collector: Collector,
  id: number,
  prompt: string,
  expect: string[],
  timeoutMs = 180_000
): Promise<{ ok: boolean; answer: string }> {
  const before = collector.output(id).length
  ctx.sessions.input(id, prompt)
  await sleep(600)
  ctx.sessions.input(id, '\r')

  const stopConsent = answerConsent(ctx, collector, [id])
  const wanted = expect.map((token) => squash(token))
  const seen = (): string => squash(collector.output(id).slice(before))
  const ok = await waitFor(() => wanted.every((token) => seen().includes(token)), timeoutMs)
  stopConsent()

  // The tail is what a person would have on screen; the whole stream is mostly
  // redraws of the composer.
  const answer = stripAnsi(collector.output(id).slice(before)).replace(/\s+/g, ' ').trim()
  return { ok, answer: answer.slice(-1200) }
}

/** Brings a session to the point where it will accept a prompt. */
export async function waitForPrompt(
  ctx: ProfilesContext,
  collector: Collector,
  id: number,
  timeoutMs = 120_000
): Promise<boolean> {
  // `answerConsent`, not sessions-check's startup-only helper: a profile
  // launched against a directory Claude Code has not seen before stops on the
  // trust gate, and this driver's fixture repo is new by construction.
  const stop = answerConsent(ctx, collector, [id])
  const ready = await waitFor(() => atPrompt(stripAnsi(collector.output(id))), timeoutMs)
  stop()
  await sleep(2500)
  return ready
}

/** The tail a person would have on screen, for a failure to be readable from. */
const tail = (collector: Collector, id: number, n = 900): string =>
  stripAnsi(collector.output(id)).replace(/\s+/g, ' ').trim().slice(-n)

// ---------------------------------------------------------------------------
// Fixtures for the composition criteria
// ---------------------------------------------------------------------------

/**
 * A harness the driver owns, with two overlay repos under it.
 *
 * This used to compose two of the user's own private repositories - the
 * user's own repositories - and that was a mistake twice over.
 *
 * It was fragile. Those directories are mutable and their `.claude/` contents
 * are gitignored. When both lost their `skills/`, `commands/` and `agents/` to
 * an early version of the shim teardown, PROF-4 did not go red: it read the two
 * `think` skills' headings off disk, got `''` for both, compared against
 * `SKILL1=` - a substring of any answer using the requested format - and
 * reported PASS while proving nothing.
 *
 * And it was wrong in principle. A regression check that depends on somebody's
 * working repositories breaks when they reorganise, cannot run on a second
 * machine, and - as here - can be silently defeated by a bug in the code it is
 * supposed to be checking.
 *
 * Both overlays define `think` with a *different* token, which is what makes
 * the same-named-skill criterion checkable at all.
 */
export interface ComposeFixtures {
  /** The harness root, and the composed session's cwd. */
  root: string
  alpha: string
  beta: string
  /** A fact that exists only in alpha's CLAUDE.md, for PROF-5. */
  alphaFact: string
  /**
   * A root of its own for the form probes, holding an agent and an `.mcp.json`.
   *
   * Separate from the compose harness, and outside the registered scan parent,
   * because no session is ever launched here. An `.mcp.json` at the composed
   * root would put an MCP enablement gate in front of the session PROF-2 opens
   * and start two servers nothing in this check wants running.
   */
  formRoot: string
  /** A root with no `.claude` at all, for the unresolved states. */
  emptyRoot: string
}

const FIXTURE_HARNESS = 'helm-profiles-harness'
const FIXTURE_ALPHA = 'helm-profiles-alpha'
const FIXTURE_BETA = 'helm-profiles-beta'

/**
 * An agent file, named the way `readConfigTree` names one: by its path under
 * `agents/`, not by the `name:` in its frontmatter. They are written to agree
 * here, so a probe that reads the filename is reading what a session addresses.
 */
function writeAgent(base: string, name: string): void {
  const dir = join(base, '.claude', 'agents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      "description: Probe agent used by Helm's profile check.",
      '---',
      '',
      'This agent exists to be offered by a picker. It is never launched.',
      ''
    ].join('\n')
  )
}

function writeComposeSkill(repo: string, name: string, token: string): void {
  const dir = join(repo, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: Probe skill used by Helm's profile check. Reports ${token}.`,
      '---',
      '',
      `# ${token}`,
      '',
      `This skill exists to be read back. Its token is ${token}.`,
      ''
    ].join('\n')
  )
}

export function buildComposeFixtures(dataDir: string): ComposeFixtures {
  const parent = join(dataDir, 'profiles-compose-fixtures')
  rmSync(parent, { recursive: true, force: true })

  const root = join(parent, FIXTURE_HARNESS)
  const alpha = join(root, 'repos', FIXTURE_ALPHA)
  const beta = join(root, 'repos', FIXTURE_BETA)
  const alphaFact = 'helm-profiles-build --alpha'

  // `harness.yaml` is what discovery keys on, and `repos/*` is where it looks
  // for the projects under it (`scan.ts`).
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'harness.yaml'),
    ['name: helm-profiles-harness', 'template: profiles-check', 'version: 0.0.0', ''].join('\n')
  )

  writeComposeSkill(alpha, 'think', 'HELMM3ALPHATHINK')
  writeComposeSkill(beta, 'think', 'HELMM3BETATHINK')
  // One more each, so a composed overlay is not a single file.
  writeComposeSkill(alpha, 'alpha-only', 'HELMM3ALPHAONLY')
  writeComposeSkill(beta, 'beta-only', 'HELMM3BETAONLY')

  // Carried by `--append-system-prompt-file`, which is the only thing that
  // carries it - neither `--plugin-dir` nor `--add-dir` does (PROF-5).
  writeFileSync(
    join(alpha, 'CLAUDE.md'),
    [
      `# ${FIXTURE_ALPHA}`,
      '',
      `The single command that builds this project is \`${alphaFact}\`.`,
      'Nothing else on this machine documents that command.',
      ''
    ].join('\n')
  )
  writeFileSync(
    join(beta, 'CLAUDE.md'),
    [`# ${FIXTURE_BETA}`, '', 'This project has no build command.', ''].join('\n')
  )

  // Read through `--add-dir` by PROF-6. The second line differs between them and
  // is long enough on both sides for `distinctLine` to choose it, so one answer
  // cannot satisfy both halves of that check.
  for (const [repo, marker] of [
    [alpha, 'ALPHA-SETTINGS-LINE-0001'],
    [beta, 'BETA-SETTINGS-LINE-0002']
  ] as const) {
    mkdirSync(join(repo, '.claude'), { recursive: true })
    writeFileSync(
      join(repo, '.claude', 'settings.local.json'),
      `${JSON.stringify({ helmM3Probe: marker }, null, 2)}\n`
    )
  }

  // Composed into the form probe, so the agent picker has a *namespaced* entry
  // in it - which is the prediction worth making, and the one a text box could
  // never have been typed correctly into.
  writeAgent(alpha, 'helm-overlay-agent')

  return { root, alpha, beta, alphaFact, ...buildFormFixtures(dataDir) }
}

/**
 * The two roots the form probes point at, neither of which is ever launched.
 *
 * `formRoot` is what the pickers should have something to offer for: one agent
 * of its own, two MCP servers in an `.mcp.json`. `emptyRoot` is the opposite -
 * a directory with no `.claude` and no `.mcp.json`, so a saved agent and a
 * saved server name have nowhere to resolve and the unresolved states are
 * reachable without inventing anything.
 */
function buildFormFixtures(dataDir: string): { formRoot: string; emptyRoot: string } {
  const formRoot = join(dataDir, 'profiles-form-fixture')
  const emptyRoot = join(dataDir, 'profiles-form-empty')
  rmSync(formRoot, { recursive: true, force: true })
  rmSync(emptyRoot, { recursive: true, force: true })
  mkdirSync(emptyRoot, { recursive: true })

  writeAgent(formRoot, 'helm-form-agent')
  // Two, so "the picker offers what is configured" is a claim about a list
  // rather than about a single row, and ticking one can be told from ticking
  // whatever happened to be there.
  writeFileSync(
    join(formRoot, '.mcp.json'),
    `${JSON.stringify(
      {
        mcpServers: {
          'helm-form-one': { command: 'node', args: ['-e', 'process.exit(0)'] },
          'helm-form-two': { command: 'node', args: ['-e', 'process.exit(0)'] }
        }
      },
      null,
      2
    )}\n`
  )

  return { formRoot, emptyRoot }
}

/**
 * Puts the fixture harness in front of discovery, through the app's own IPC.
 *
 * Not by calling `runScan` in the main process: the profile form renders
 * whatever the renderer was last told, so the scan has to be the one that emits
 * `discovery:updated`. `settings:write` then `discovery:scan` is the path the
 * "Add a folder" and rescan buttons take.
 *
 * Returns the scan roots as they were, for the caller to put back.
 */
async function registerFixtureRoot(win: BrowserWindow, root: string): Promise<string[]> {
  const current = await js<string[]>(
    win,
    `window.helm.invoke('settings:read').then((s) => s.scanRoots)`
  )
  // The user's roots are whatever is there *minus* this driver's own, so a run
  // that was killed before its `finally` - a timeout, a crash, Ctrl-C - is
  // repaired by the next one rather than compounded by it. Appending blind is
  // how the fixture root ended up in the list three times during development.
  const before = withoutFixtureRoot(current, root)
  await setScanRoots(win, [...before, root])
  return before
}

/** Case-insensitively, because these are Windows paths. */
function withoutFixtureRoot(roots: string[], root: string): string[] {
  return roots.filter((entry) => entry.toLowerCase() !== root.toLowerCase())
}

async function setScanRoots(win: BrowserWindow, roots: string[]): Promise<void> {
  await js<unknown>(
    win,
    `window.helm.invoke('settings:write', { scanRoots: ${JSON.stringify(roots)} })`
  )
  await js<unknown>(win, `window.helm.invoke('discovery:scan', { includeGit: false })`)
}

/**
 * Puts the user's scan roots back.
 *
 * Takes the roots to restore *and* the fixture root to strip, rather than
 * trusting the list it was handed: this runs in a `finally`, which is exactly
 * where the state is least certain.
 */
async function restoreScanRoots(
  win: BrowserWindow,
  roots: string[],
  fixtureRoot: string
): Promise<void> {
  try {
    await setScanRoots(win, withoutFixtureRoot(roots, fixtureRoot))
  } catch {
    // The window may already be gone if the run is being torn down. These are a
    // user setting, so this is worth attempting and not worth failing over.
  }
}

// ---------------------------------------------------------------------------
// Fixtures for the "edit a skill and relaunch" criterion
// ---------------------------------------------------------------------------

/**
 * A throwaway repo with one skill in it.
 *
 * The criterion is about editing a source repo's skill, and the source repos on
 * this machine are the user's real ones. Writing a probe into one of the user's own repositories
 * to prove a point about cache invalidation is not a thing a test gets to do,
 * so this criterion gets a repo the driver owns.
 */
function writeFixtureSkill(dir: string, token: string): void {
  const skill = join(dir, 'alpha', '.claude', 'skills', 'helm-probe')
  mkdirSync(skill, { recursive: true })
  writeFileSync(
    join(skill, 'SKILL.md'),
    [
      '---',
      'name: helm-probe',
      'description: Probe skill used by Helm’s profile check. Reports a token.',
      '---',
      '',
      `# ${token}`,
      '',
      `This skill exists to be read back. Its token is ${token}.`,
      ''
    ].join('\n')
  )
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

interface Fixtures {
  harness: Project
  alpha: Project
  beta: Project
  content: ComposeFixtures
}

/**
 * The fixture harness and its two repos, as *discovery* sees them.
 *
 * Matched on the paths the driver built rather than assumed, because the
 * profile form offers what discovery found - a check that reached around the
 * scan would not be driving the form.
 */
function pick(services: Services, content: ComposeFixtures): Fixtures | null {
  const projects = services.lastScan?.projects ?? []
  const at = (path: string): Project | undefined =>
    projects.find((p) => p.path.toLowerCase() === path.toLowerCase())

  const harness = at(content.root)
  const alpha = at(content.alpha)
  const beta = at(content.beta)
  if (!harness || harness.kind !== 'harness' || !alpha || !beta) return null
  return { harness, alpha, beta, content }
}

/**
 * `--only=fixture` and friends.
 *
 * Grouped rather than per-check, because these are a chain: PROF-2 launches the
 * profile PROF-1 built and PROF-3..PROF-7 all talk to the session PROF-2 opened. The
 * groups are the points where that chain genuinely breaks - which is what makes
 * them the useful thing to re-run while fixing one of them, given a full pass
 * spawns three real sessions and takes minutes.
 */
type Group = 'form' | 'compose' | 'fixture' | 'shims'
// `form` first: it spawns nothing, so `--only=form` is the seconds-long re-run
// while the profile dialog is being worked on.
const ALL_GROUPS: Group[] = ['form', 'compose', 'fixture', 'shims']

function selectedGroups(): Group[] {
  const arg = process.argv.find((a) => a.startsWith('--only='))
  if (!arg) return ALL_GROUPS
  const asked = arg.slice('--only='.length).split(',')
  const chosen = ALL_GROUPS.filter((group) => asked.includes(group))
  return chosen.length > 0 ? chosen : ALL_GROUPS
}

export async function runProfilesChecks(
  ctx: ProfilesContext,
  collector: Collector,
  shotDir: string,
  dataDir: string
): Promise<Check[]> {
  const checks: Check[] = []
  const { win } = ctx
  const groups = selectedGroups()
  const wants = (group: Group): boolean => groups.includes(group)
  if (groups.length < ALL_GROUPS.length) {
    console.log(`profiles-check: running only [${groups.join(', ')}]`)
  }

  // Wait for the app's own first scan to land before adding to it, so the roots
  // read back below are the user's real ones and not an empty default.
  await waitFor(() => ctx.services.lastScan !== null, 120_000)
  await pollJs(win, `document.querySelectorAll('aside button[title]').length >= 1`, 30_000)

  const content = buildComposeFixtures(dataDir)
  const originalRoots = await registerFixtureRoot(win, dirname(content.root))
  const scanned = await waitFor(() => pick(ctx.services, content) !== null, 120_000)
  await sleep(500)
  const fixtures = pick(ctx.services, content)

  if (!scanned || !fixtures) {
    await restoreScanRoots(win, originalRoots, dirname(content.root))
    checks.push({
      id: 'PROF-0',
      criterion: 'setup',
      title: 'Discovery found the fixture harness and both overlay repos',
      ok: false,
      detail: {
        fixtureRoot: content.root,
        scanned,
        found: (ctx.services.lastScan?.projects ?? []).map((p) => p.name)
      },
      notes: [
        'The overlays are a harness this driver builds under the app data directory, not the',
        'user’s repositories - see `buildComposeFixtures`.'
      ]
    })
    return checks
  }

  checks.push({
    id: 'PROF-0',
    criterion: 'setup',
    title: 'Discovery found the fixture harness and both overlay repos',
    ok: true,
    detail: {
      harness: fixtures.harness.path,
      overlays: [fixtures.alpha.path, fixtures.beta.path],
      skillsEach: [fixtures.alpha.inventory.skills, fixtures.beta.inventory.skills],
      scanRootsBefore: originalRoots
    },
    notes: [
      'Built by this driver and registered through the app’s own `settings:write` +',
      '`discovery:scan`, so the profile form offers them the way it offers any project.',
      'The user’s scan roots are put back at the end of the run.'
    ]
  })

  // Left over from an earlier run of this driver; the names are unique-indexed.
  for (const name of [PROFILE_NAME, FIXTURE_PROFILE, FORM_PROFILE, LEGACY_PROFILE]) {
    const existing = findProfileByName(ctx.services.store, name)
    if (existing) deleteProfile(ctx.services.store, existing.id)
  }

  try {
    if (wants('form')) {
      checks.push(...(await runFormChecks(ctx, shotDir, fixtures)))
    }
    if (wants('compose')) {
      checks.push(...(await runComposeChecks(ctx, collector, shotDir, fixtures)))
    }
    if (wants('fixture')) {
      checks.push(await runFixtureCheck(ctx, collector, dataDir))
    }
    if (wants('shims')) {
      checks.push(plantStaleShim())
    }
  } finally {
    // The user's scan roots are theirs. Restored whatever happened above,
    // including a driver that threw halfway through a probe.
    await restoreScanRoots(win, originalRoots, dirname(content.root))
  }
  return checks
}

/**
 * PROF-1 through PROF-7: one profile, built in the form, launched, and interrogated.
 *
 * These share a session on purpose. Composition is a property of a session, and
 * asking one session all five questions is both the cheaper thing and the
 * truer one - it is the session a person would have.
 */
async function runComposeChecks(
  ctx: ProfilesContext,
  collector: Collector,
  shotDir: string,
  fixtures: Fixtures
): Promise<Check[]> {
  const checks: Check[] = []
  const { win } = ctx
  const { harness, alpha, beta } = fixtures

  // -------------------------------------------------------------------------
  // PROF-1: build a profile through the real form
  // -------------------------------------------------------------------------
  const opened = await clickByLabel(win, 'New profile')
  await sleep(600)

  await fill(win, 'Profile name', PROFILE_NAME)
  await fill(win, 'Root directory', harness.path)
  await fill(win, 'Model', MODEL)
  await fill(win, 'Opening prompt', OPENING_PROMPT)
  await sleep(200)

  // Ticking "Compose" also ticks "Access" - composing a repo's skills while
  // denying its files produces skills that cannot do anything.
  await clickByLabel(win, `Compose ${alpha.name}`)
  await sleep(150)
  await clickByLabel(win, `Compose ${beta.name}`)
  await sleep(150)
  const accessAutoTicked =
    (await isChecked(win, `Grant access to ${alpha.name}`)) &&
    (await isChecked(win, `Grant access to ${beta.name}`))

  const editorShot = await screenshot(win, shotDir, 'profiles-profile-editor.png')
  await clickButtonText(win, 'Save profile')
  await sleep(800)

  const saved = findProfileByName(ctx.services.store, PROFILE_NAME)
  const rowPainted = await pollJs(
    win,
    `Boolean(document.querySelector('[data-profile="${String(saved?.id ?? -1)}"]'))`,
    5000
  )

  checks.push({
    id: 'PROF-1',
    criterion: 'Profile CRUD UI: create from scratch; profiles stored in SQLite',
    title: 'A profile built in the form is persisted and listed',
    ok:
      opened &&
      saved !== null &&
      saved.root === harness.path &&
      saved.overlays.length === 2 &&
      saved.access.length === 2 &&
      saved.model === MODEL &&
      saved.openingPrompt === OPENING_PROMPT &&
      accessAutoTicked &&
      rowPainted,
    detail: {
      profile: saved && profileDraft(saved),
      accessAutoTicked,
      rowPainted,
      screenshot: editorShot.file
    },
    notes: ['Driven through the dialog: fields set as keystrokes, checkboxes clicked.']
  })

  if (!saved) return checks

  // -------------------------------------------------------------------------
  // PROF-2: one click launches it into a tab, with the composed argv
  // -------------------------------------------------------------------------
  const before = ctx.sessions.list().length
  await js<boolean>(
    win,
    `(() => { const el = document.querySelector('[data-profile="${String(saved.id)}"]');
      if (!el) return false; el.click(); return true })()`
  )
  await waitFor(() => ctx.sessions.list().length > before, 60_000)
  const session = ctx.sessions.list().at(-1)

  /**
   * Armed the instant the process exists, before anything else is asserted.
   *
   * `answerConsent` seeds its counts from the output already in the buffer, so
   * that it answers the gates *from here on* rather than re-answering ones a
   * session has long since passed. That is right for a session mid-life and
   * wrong for one being born: a directory Claude Code has never opened raises
   * its trust and MCP gates within a second or two of spawning, and every
   * assertion below - the tab strip, the argv - takes longer than that. Arming
   * afterwards baselines the gates as already-answered and then waits three
   * minutes for a token the session cannot print until they are dismissed.
   *
   * This is the failure that appeared the moment these checks stopped composing
   * a directory the user had opened a hundred times. It stays armed through the
   * opening-prompt window and is released before the first `ask`, which arms
   * its own.
   */
  const stopGates =
    session === undefined ? (): void => undefined : answerConsent(ctx, collector, [session.id])

  await sleep(800)
  const tabs = await tabOrder(win)

  const argv = session?.argv ?? []
  const pluginDirs = argv.filter((_, i) => argv[i - 1] === '--plugin-dir')
  const memoryIndex = argv.indexOf('--append-system-prompt-file')
  const memoryFile = memoryIndex >= 0 ? argv[memoryIndex + 1] : undefined

  checks.push({
    id: 'PROF-2',
    criterion: 'One-click launch from the launcher into a tab; profile → argv builder',
    title: 'Clicking the profile composes the overlays and opens a session tab',
    ok:
      session !== undefined &&
      session.profileId === saved.id &&
      session.cwd === harness.path &&
      pluginDirs.length === 2 &&
      argv.includes('--add-dir') &&
      argv.includes('--model') &&
      memoryFile !== undefined &&
      argv.at(-1) === OPENING_PROMPT &&
      tabs.includes(`session:${String(session.id)}`),
    detail: {
      session: session && { id: session.id, name: session.name, cwd: session.cwd },
      argv,
      pluginDirs,
      memoryFile,
      tabs
    },
    notes: [
      'The opening prompt is last on the argv: --add-dir is variadic, and a positional',
      'reachable from it would be read as another directory rather than a prompt.'
    ]
  })

  if (!session) return checks

  // -------------------------------------------------------------------------
  // The composed session itself
  // -------------------------------------------------------------------------
  // The gate handler armed at spawn is still running, so this waits for the
  // composer rather than arming a second one - two handlers answering the same
  // gate would send Escape twice, and the second lands in a session that has
  // moved on and cancels whatever it is doing.
  const ready = await waitFor(
    () => atPrompt(stripAnsi(collector.output(session.id))),
    120_000
  )
  await sleep(2500)

  // PROF-3: the opening prompt fired without anyone typing it.
  const openingSeen = await waitFor(
    () => squash(collector.output(session.id)).includes(squash(OPENING_TOKEN)),
    180_000
  )
  stopGates()
  const sessionShot = await screenshot(win, shotDir, 'profiles-composed-session.png')

  checks.push({
    id: 'PROF-3',
    criterion: 'Opening prompt fires automatically after session start',
    title: 'The profile’s opening prompt was submitted without any typing',
    ok: ready && openingSeen,
    detail: {
      reachedPrompt: ready,
      token: OPENING_TOKEN,
      screenshot: sessionShot.file,
      tail: stripAnsi(collector.output(session.id)).replace(/\s+/g, ' ').trim().slice(-600)
    },
    notes: ['Nothing was written to this pty before the assertion; it came in on the argv.']
  })

  // PROF-4: skills from both overlays, including the same-named pair.
  //
  // `think` is defined in both fixture repos with a *different* token, which is
  // what makes it the discriminator: reporting both proves two distinct bodies
  // resolved, where a same-named skill resolving twice to one body would match
  // only one.
  const alphaThink = skillToken(join(alpha.path, '.claude', 'skills', 'think', 'SKILL.md'))
  const betaThink = skillToken(join(beta.path, '.claude', 'skills', 'think', 'SKILL.md'))

  /**
   * The probe is only evidence if the two tokens exist and differ.
   *
   * A reader that returns `''` for a missing file turns the expected token into
   * `SKILL1=` - a substring of any answer using the requested format - and the
   * check reports PASS having proved nothing. That is not hypothetical: this
   * check composed two of the user's own private repositories
   * until 2026-08-10, both lost their `.claude/skills` to an early version of
   * the shim teardown, and it went on reporting green afterwards.
   *
   * The fixtures below are now built by this driver, so tripping this guard
   * means the driver itself is broken rather than that somebody moved a repo.
   */
  const tokensUsable = alphaThink !== '' && betaThink !== '' && alphaThink !== betaThink

  const skills = tokensUsable
    ? await ask(
        ctx,
        collector,
        session.id,
        `Invoke the skill named ${overlayName(alpha)}:think, then invoke the skill named ` +
          `${overlayName(beta)}:think. Each skill body states a token. Then reply with exactly ` +
          `two lines: SKILL1=<the first skill's token> and SKILL2=<the second skill's token>.`,
        [`SKILL1=${alphaThink}`, `SKILL2=${betaThink}`]
      )
    : { ok: false, answer: 'the fixture skills carry no distinct tokens, so no answer is evidence' }

  checks.push({
    id: 'PROF-4',
    criterion:
      'A project skill invokes in a root-launched session; same-named skills in two overlays coexist',
    title: 'Both overlays’ `think` skills resolved under their own prefixes and both invoked',
    ok: tokensUsable && skills.ok,
    detail: {
      cwd: session.cwd,
      invocations: [`${overlayName(alpha)}:think`, `${overlayName(beta)}:think`],
      expected: { SKILL1: alphaThink, SKILL2: betaThink },
      tokensUsableAsEvidence: tokensUsable,
      answer: skills.answer
    },
    notes: [
      'The two bodies carry different tokens, so reporting both is proof of two distinct skills',
      'rather than one resolving twice. Spike A showed the namespacing; this shows it interactively.',
      'Asked for the token rather than the markdown heading: a model that answers `# TOKEN` has',
      'read the right file, and an equality check on the heading text calls that a failure.'
    ]
  })

  // PROF-5: the CLAUDE.md gap Spike A found, closed.
  //
  // The fact is written into the alpha fixture's CLAUDE.md by this driver and
  // exists nowhere else on the machine, so a correct answer can only have come
  // from that file reaching the session's context.
  const claudeMd = await ask(
    ctx,
    collector,
    session.id,
    'Without using any tools, answer only from the instructions already in your context: ' +
      `what single command builds the ${FIXTURE_ALPHA} project? ` +
      'Reply as BUILDCMD=<command>. If it is not in your context, reply BUILDCMD=NOT_IN_CONTEXT.',
    [`BUILDCMD=${fixtures.content.alphaFact}`]
  )

  checks.push({
    id: 'PROF-5',
    criterion: "The overlaid repos' CLAUDE.md instructions are present in the session",
    title: 'An instruction that exists only in an overlay’s CLAUDE.md is in context',
    ok: claudeMd.ok,
    detail: {
      expected: `BUILDCMD=${fixtures.content.alphaFact}`,
      from: join(alpha.path, 'CLAUDE.md'),
      answer: claudeMd.answer,
      memoryFile
    },
    notes: [
      'Carried by --append-system-prompt-file, not --add-dir. Measured against 2.1.225:',
      '--add-dir does not pull in an overlaid repo’s CLAUDE.md, whatever its help text suggests.',
      'The probe forbids tools, so a correct answer cannot have come from reading the file.'
    ]
  })

  // PROF-6: --add-dir actually grants the files.
  //
  // Deliberately not CLAUDE.md. Those are already in this session's context by
  // way of PROF-5, so a correct answer about one would prove nothing about
  // whether the file could be *read*. `settings.local.json` is in neither the
  // context nor any plugin, so the only way to report a line of it is to have
  // opened it.
  const settings = {
    a: join(alpha.path, '.claude', 'settings.local.json'),
    b: join(beta.path, '.claude', 'settings.local.json')
  }
  const distinct = distinctLine(settings.a, settings.b)
  const files =
    distinct === null
      ? { ok: false, answer: 'no line differs between the two settings files' }
      : await ask(
          ctx,
          collector,
          session.id,
          `Use the Read tool on ${settings.a} and on ${settings.b}. ` +
            `Reply with two lines: F1=<line ${String(distinct.line)} of the first file, verbatim> ` +
            `and F2=<line ${String(distinct.line)} of the second file, verbatim>.`,
          [distinct.a, distinct.b]
        )

  checks.push({
    id: 'PROF-6',
    criterion: 'Cross-repo file access works in the same session via --add-dir',
    title: 'A file in each overlay repo was read from a session rooted elsewhere',
    ok: files.ok,
    detail: {
      cwd: session.cwd,
      read: [settings.a, settings.b],
      expected: distinct,
      answer: files.answer
    },
    notes: [
      'Neither path is under the session’s working directory, and neither file is in',
      'context - so the line can only have come from a real read.',
      'The line index is chosen at runtime as the first one whose contents differ',
      'between the two files, so one answer cannot satisfy both.'
    ]
  })

  // -------------------------------------------------------------------------
  // PROF-7: YAML round trip
  // -------------------------------------------------------------------------
  const original = readProfile(ctx.services.store, saved.id)
  const yaml = original ? profileToYaml(profileDraft(original)) : ''
  const removed = deleteProfile(ctx.services.store, saved.id)
  const absent = findProfileByName(ctx.services.store, PROFILE_NAME) === null
  const reimported = yaml === '' ? null : createProfile(ctx.services.store, profileFromYaml(yaml))

  checks.push({
    id: 'PROF-7',
    criterion: 'Profile round-trips through YAML export → delete → import intact',
    title: 'A profile survives being written to YAML, deleted, and read back',
    ok:
      original !== null &&
      removed &&
      absent &&
      reimported !== null &&
      JSON.stringify(profileDraft(reimported)) === JSON.stringify(profileDraft(original)),
    detail: {
      yaml,
      deleted: removed,
      absentAfterDelete: absent,
      before: original && profileDraft(original),
      after: reimported && profileDraft(reimported)
    },
    notes: [
      'Paths under the root are written relative to it, so the file travels with the harness',
      'rather than hardcoding this machine.'
    ]
  })

  const remaining = listProfiles(ctx.services.store).find((p) => p.name === PROFILE_NAME)
  if (remaining) deleteProfile(ctx.services.store, remaining.id)

  return checks
}

// ---------------------------------------------------------------------------
// The form's two name pickers
// ---------------------------------------------------------------------------

/** An agent, as `readConfigTree` names one: its path under `agents/`, no `.md`. */
function agentNamesIn(base: string): string[] {
  try {
    return readdirSync(join(base, '.claude', 'agents'))
      .filter((entry) => entry.toLowerCase().endsWith('.md'))
      .map((entry) => entry.replace(/\.md$/i, ''))
      .sort()
  } catch {
    return []
  }
}

/** The keys of an `.mcp.json`'s `mcpServers`, parsed here rather than by Helm. */
function serverNamesIn(file: string): string[] {
  try {
    const doc: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const servers = (doc as { mcpServers?: unknown }).mcpServers
    return servers !== null && typeof servers === 'object' && !Array.isArray(servers)
      ? Object.keys(servers as Record<string, unknown>).sort()
      : []
  } catch {
    return []
  }
}

/** `document.querySelector` for one server's checkbox, as page-side JS. */
function serverBox(name: string): string {
  return `document.querySelector(${JSON.stringify(`input[aria-label="MCP server ${name}"]`)})`
}

/**
 * PROF-11 and PROF-12: the Agent and MCP fields are pickers over the effective
 * view, and they say what they do.
 *
 * Both were free text boxes and neither said anything. An agent name typed into
 * one saved whether or not a session would resolve it; an MCP name typed into
 * the other went into a field that never reaches the argv at all - `Profile.mcp`
 * is persisted and exported and nothing more (SPEC 4.2). So the questions a
 * person asked of those boxes - "will this be available", "will this resolve" -
 * had an answer Helm already computes and did not show.
 *
 * These two probes are about the prediction being the one the *files* support,
 * so every expected value is read out of a fixture this driver wrote and none
 * of it is compared against Helm's own answer.
 *
 * No sessions, no network, a few seconds. This is the group to re-run while
 * working on the dialog: `pnpm profiles-check --only=form`.
 */
async function runFormChecks(
  ctx: ProfilesContext,
  shotDir: string,
  fixtures: Fixtures
): Promise<Check[]> {
  const checks: Check[] = []
  const { win } = ctx
  const { alpha, content } = fixtures

  // The second reader: the fixture files, parsed here.
  const formAgents = agentNamesIn(content.formRoot)
  const alphaAgents = agentNamesIn(alpha.path)
  const servers = serverNamesIn(join(content.formRoot, '.mcp.json'))
  const overlayAgent = `${overlayName(alpha)}:${alphaAgents[0] ?? ''}`

  /**
   * A picker with nothing in it satisfies every "does not offer" test, and an
   * expected name of `''` is a substring of every option there could be. That
   * is the PROF-4 shape and it reported green for weeks, so the fixtures are
   * asserted before any answer from the form is believed.
   */
  const usable =
    formAgents.length === 1 &&
    alphaAgents.length === 1 &&
    servers.length === 2 &&
    new Set(servers).size === 2 &&
    [...formAgents, ...alphaAgents, ...servers].every((entry) => entry.trim() !== '')

  if (!usable) {
    checks.push({
      id: 'PROF-11',
      criterion: 'The profile form offers the agents and MCP servers the effective view predicts',
      title: 'The picker fixtures are not discriminating, so no answer would be evidence',
      ok: false,
      detail: { formRoot: content.formRoot, formAgents, alphaAgents, servers },
      notes: ['Written by `buildFormFixtures`, so this failing means the driver is broken.']
    })
    return checks
  }

  // -------------------------------------------------------------------------
  // PROF-11: what the two pickers offer, and what saving one writes
  // -------------------------------------------------------------------------
  const opened = await clickByLabel(win, 'New profile')
  await sleep(500)
  await fill(win, 'Profile name', FORM_PROFILE)

  // With no root there is nothing to predict *from*, and an empty picker that
  // said nothing would read as "this root has no servers" - a claim about the
  // user's disk made by a form that has not looked at it. The sentence is
  // asserted before the root is typed, because it is the only moment it shows.
  await fill(win, 'Root directory', '')
  await sleep(400)
  const beforeRoot = await js<string>(
    win,
    `(() => { const p = document.querySelector('[data-mcp-empty]');
       return p ? (p.textContent ?? '') : '' })()`
  )

  await fill(win, 'Root directory', content.formRoot)
  await sleep(200)
  // Composed, so the agent list has to carry a *namespaced* entry - the name a
  // free text box could never have been typed correctly into, since the prefix
  // is chosen by the shim builder rather than by the user.
  await clickByLabel(win, `Compose ${alpha.name}`)

  const populated = await pollJs(
    win,
    `(() => {
       const s = document.querySelector('select[aria-label="Agent"]');
       if (!s) return false;
       const values = [...s.options].map((o) => o.value);
       return values.includes(${JSON.stringify(overlayAgent)})
         && values.includes(${JSON.stringify(formAgents[0])})
         && Boolean(${serverBox(servers[0] ?? '')}) })()`,
    20_000
  )

  const shape = await js<{
    agentTag: string
    agentOptions: string[]
    offered: string[]
    boxTypes: string[]
    freeTextField: boolean
  }>(
    win,
    `(() => {
       const a = document.querySelector('[aria-label="Agent"]');
       const boxes = [...document.querySelectorAll('input[aria-label^="MCP server "]')];
       return {
         agentTag: a ? a.tagName : '',
         agentOptions: a && a.options ? [...a.options].map((o) => o.value) : [],
         offered: boxes.map((b) => (b.getAttribute('aria-label') ?? '').slice(11)).sort(),
         boxTypes: [...new Set(boxes.map((b) => b.type))],
         freeTextField: Boolean(document.querySelector('input[aria-label="MCP servers"]'))
       } })()`
  )

  await fill(win, 'Agent', overlayAgent)
  await sleep(150)
  await js<unknown>(win, `${serverBox(servers[0] ?? '')}.click()`)
  await sleep(150)
  // Scrolled to the two controls this check is about. The dialog is taller than
  // an 820px window, so a shot of it at rest is a picture of the fields above
  // them and no evidence of anything here.
  await js<unknown>(
    win,
    `(() => { const box = ${serverBox(servers[0] ?? '')};
       if (box) box.closest('fieldset').scrollIntoView({ block: 'end' }) })()`
  )
  await sleep(250)
  const pickerShot = await screenshot(win, shotDir, 'profiles-pickers.png')
  await clickButtonText(win, 'Save profile')
  await sleep(800)

  const saved = findProfileByName(ctx.services.store, FORM_PROFILE)

  checks.push({
    id: 'PROF-11',
    criterion: 'The profile form offers the agents and MCP servers the effective view predicts',
    title: 'Both fields are pickers over what resolves, and what is picked is what is stored',
    ok:
      opened &&
      populated &&
      /set a root/i.test(beforeRoot) &&
      shape.agentTag === 'SELECT' &&
      !shape.freeTextField &&
      shape.agentOptions.includes(overlayAgent) &&
      shape.agentOptions.includes(formAgents[0] ?? '') &&
      JSON.stringify(shape.offered) === JSON.stringify(servers) &&
      JSON.stringify(shape.boxTypes) === JSON.stringify(['checkbox']) &&
      saved !== null &&
      saved.agent === overlayAgent &&
      JSON.stringify(saved.mcp) === JSON.stringify([servers[0]]),
    detail: {
      root: content.formRoot,
      expected: { agents: [formAgents[0], overlayAgent], servers },
      offered: { agents: shape.agentOptions, servers: shape.offered },
      controls: { agent: shape.agentTag, boxes: shape.boxTypes, freeText: shape.freeTextField },
      withNoRoot: beforeRoot,
      populated,
      saved: saved && profileDraft(saved),
      screenshot: pickerShot.file
    },
    notes: [
      'The expected names are read from the fixture files by this driver - the agent from the',
      'filename `readConfigTree` addresses it by, the servers from `.mcp.json`’s own keys.',
      'The namespaced entry is the point: `<overlay>:<agent>` is chosen by the shim builder,',
      'so it is a prediction rather than a name anybody could have typed.',
      'Neither control accepts free text, which is asserted rather than assumed: the old',
      'comma-separated `MCP servers` input must not be in the document at all.'
    ]
  })

  // -------------------------------------------------------------------------
  // PROF-12: a saved name nothing resolves survives, and says so
  // -------------------------------------------------------------------------
  const ghostAgent = 'nowhere:helm-missing-agent'
  const ghostServer = 'helm-missing-server'
  const legacy = {
    name: LEGACY_PROFILE,
    root: content.emptyRoot,
    overlays: [],
    access: [],
    model: null,
    effort: null,
    permissionMode: null,
    agent: ghostAgent,
    mcp: [ghostServer],
    openingPrompt: null,
    pinnedOrder: null,
    target: null
  }

  // Through the app's own channel, not the store: this is a profile as the form
  // used to be able to write one, and it has to arrive in the list the same way.
  const legacyId = await js<number | null>(
    win,
    `window.helm.invoke('profile:save', { draft: ${JSON.stringify(legacy)}, id: null })
       .then((r) => (r.profile ? r.profile.id : null))`
  )
  const listed =
    legacyId !== null &&
    (await pollJs(win, `document.querySelector('[data-profile="${String(legacyId)}"]')`, 10_000))

  const editorOpened = listed && (await clickByLabel(win, `Edit ${LEGACY_PROFILE}`))
  const marked = await pollJs(
    win,
    `Boolean(document.querySelector('[data-agent-unresolved]')
       && document.querySelector('[data-mcp-unresolved]'))`,
    20_000
  )

  const shown = await js<{
    agentValue: string
    agentOption: string
    agentNote: string
    serverPill: string
    serverChecked: boolean
  }>(
    win,
    `(() => {
       const s = document.querySelector('select[aria-label="Agent"]');
       const note = document.querySelector('[data-agent-unresolved]');
       const pill = document.querySelector('[data-mcp-unresolved]');
       const box = ${serverBox(ghostServer)};
       return {
         agentValue: s ? s.value : '',
         agentOption: (s && s.selectedOptions[0] ? s.selectedOptions[0].textContent : '') ?? '',
         agentNote: (note ? note.textContent : '') ?? '',
         serverPill: pill ? (pill.getAttribute('data-mcp-unresolved') ?? '') : '',
         serverChecked: Boolean(box && box.checked)
       } })()`
  )

  await clickButtonText(win, 'Save changes')
  await sleep(800)
  const kept = legacyId === null ? null : readProfile(ctx.services.store, legacyId)

  checks.push({
    id: 'PROF-12',
    criterion: 'A saved agent or MCP server the root does not resolve is shown, by name, and kept',
    title: 'Names nothing resolves are marked unresolved and survive a save through the form',
    ok:
      editorOpened &&
      marked &&
      shown.agentValue === ghostAgent &&
      shown.agentOption.includes(ghostAgent) &&
      shown.agentOption.toLowerCase().includes('unresolved') &&
      shown.agentNote.includes(ghostAgent) &&
      shown.serverPill === ghostServer &&
      shown.serverChecked &&
      kept !== null &&
      kept.agent === ghostAgent &&
      JSON.stringify(kept.mcp) === JSON.stringify([ghostServer]),
    detail: {
      root: content.emptyRoot,
      wrote: { agent: ghostAgent, mcp: [ghostServer] },
      shown,
      kept: kept && profileDraft(kept)
    },
    notes: [
      'The root has no `.claude` and no `.mcp.json`, so neither name can resolve there and the',
      'unresolved state is reached without arranging anything.',
      'A profile may legitimately be written before the overlay that supplies its agent exists,',
      'so the requirement is that the name is *marked*, not that it is refused - and the save',
      'is asserted from the database, because a picker that dropped the value silently would',
      'look identical on screen the moment the dialog closed.'
    ]
  })

  for (const name of [FORM_PROFILE, LEGACY_PROFILE]) {
    const leftover = findProfileByName(ctx.services.store, name)
    if (leftover) deleteProfile(ctx.services.store, leftover.id)
  }

  return checks
}

/**
 * PROF-8: editing a source repo's skill, then relaunching.
 *
 * Against a fixture repo rather than the user's. The criterion requires editing
 * a source repo's skill, and the source repos on this machine are real ones -
 * writing a probe into a real repository to make a point about cache
 * invalidation is not something a check gets to do.
 */
async function runFixtureCheck(
  ctx: ProfilesContext,
  collector: Collector,
  dataDir: string
): Promise<Check> {
  const fixtureRoot = join(dataDir, 'profiles-fixtures')
  rmSync(fixtureRoot, { recursive: true, force: true })
  writeFixtureSkill(fixtureRoot, 'HELMPROBEALPHA')

  const fixtureProfile: Profile = createProfile(ctx.services.store, {
    name: FIXTURE_PROFILE,
    root: fixtureRoot,
    overlays: [join(fixtureRoot, 'alpha')],
    access: [join(fixtureRoot, 'alpha')],
    model: MODEL,
    effort: null,
    permissionMode: null,
    agent: null,
    mcp: [],
    openingPrompt: null,
    pinnedOrder: null,
    target: null
  })

  const firstRun = await probeFixture(ctx, collector, fixtureProfile.id, 'HELMPROBEALPHA')

  // The edit a person would make, in the source repo rather than in the shim.
  writeFixtureSkill(fixtureRoot, 'HELMPROBEBRAVO')
  const secondRun = await probeFixture(ctx, collector, fixtureProfile.id, 'HELMPROBEBRAVO')

  // The driver's own profile, not the user's.
  deleteProfile(ctx.services.store, fixtureProfile.id)

  return {
    id: 'PROF-8',
    criterion: 'Editing a source repo’s skill then relaunching the profile picks up the change',
    title: 'A relaunched profile loads the edited skill body, not the one it was built with',
    ok: firstRun.ok && secondRun.ok,
    detail: {
      fixture: fixtureRoot,
      first: { expected: 'HELMPROBEALPHA', ...firstRun },
      second: { expected: 'HELMPROBEBRAVO', ...secondRun }
    },
    notes: [
      'Against a fixture repo, not the user’s: the criterion requires editing a source repo,',
      'and writing a probe into a real repository to prove it is not something a check may do.',
      'The shim links rather than copies, so the second session sees the edit through the junction.',
      '`skillOnDisk` is read back *through* the shim, so a failure says whether it was the',
      'fixture or the link that was wrong.'
    ]
  }
}

/**
 * PROF-9: leave a stale shim for the next app start to sweep.
 *
 * The criterion is about what happens at startup, which cannot be asserted by
 * the process that already started. So this plants what a crash would have left
 * and `--shim-sweep` - a second, real app start - reports on it.
 */
function plantStaleShim(): Check {
  const planted = join(shimRoot, 'overlay-profiles-crashed')
  mkdirSync(join(planted, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(planted, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'profiles-crashed', version: '0.0.0' })
  )

  /*
   * A pid the machine really has finished with.
   *
   * The sweep no longer removes every stamped directory it finds - it removes
   * the ones whose owner is provably gone - so a planted stamp has to name an
   * owner that is provably gone, and inventing a number would plant either a
   * pid nothing ever had or, once in a while, a pid something now has. A
   * process spawned and waited on here is neither: it existed, it exited, and
   * the trap is exactly the crash the criterion is about.
   */
  const corpse = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true
  })

  // No junction in it: what is being tested is whether the sweep finds and
  // removes a stamped `overlay-*` directory, and planting a real link into a
  // real repo would put the user's files behind a deletion this check wants to
  // happen.
  writeFileSync(
    join(planted, '.helm-overlay.json'),
    JSON.stringify({
      name: 'profiles-crashed',
      projectPath: planted,
      mode: 'junction',
      linked: [],
      fingerprint: 'planted-by-profiles-check',
      builtAt: new Date().toISOString(),
      owners: [{ pid: corpse.pid, startedAt: new Date().toISOString() }]
    })
  )

  return {
    id: 'PROF-9',
    criterion: 'Stale shim dirs from crashed sessions are cleaned up on next app start',
    title: 'A shim left behind by a crash is planted for the next start to find',
    // A stamp naming a pid that never ran would be swept for the wrong reason,
    // and this check would go on passing after the owner rule stopped working.
    ok: corpse.pid !== undefined && corpse.status === 0,
    detail: { planted, shimRoot, ownerPid: corpse.pid ?? null, ownerExit: corpse.status },
    notes: [
      'This check only sets the trap. Whether it caught anything is decided by the',
      '--shim-sweep run that follows, and asserted by scripts/verify-shims.mjs.',
      'The owner on the stamp is a process that really ran and really exited, so the',
      'sweep removes it by establishing the owner is gone rather than by default.'
    ]
  }
}

/** Launches the fixture profile, asks its skill for its token, then closes. */
async function probeFixture(
  ctx: ProfilesContext,
  collector: Collector,
  profileId: number,
  token: string
): Promise<{
  ok: boolean
  answer: string
  argv: string[]
  overlays: string[]
  skillOnDisk: string
  reachedPrompt: boolean
}> {
  const launched = await ctx.sessions.launchProfile({ profileId, cols: 100, rows: 30 })
  const id = launched.session.id

  // Read back through the shim rather than from the source, so a failure says
  // which of the two - the fixture or the link - was not what it should be.
  const shimmed = join(shimRoot, 'overlay-alpha', 'skills', 'helm-probe', 'SKILL.md')
  let skillOnDisk: string
  try {
    skillOnDisk = readFileSync(shimmed, 'utf8').trim().split('\n').pop() ?? ''
  } catch (err) {
    skillOnDisk = `unreadable through the shim: ${err instanceof Error ? err.message : String(err)}`
  }

  const common = {
    argv: launched.session.argv,
    overlays: launched.overlays,
    skillOnDisk
  }

  const ready = await waitForPrompt(ctx, collector, id)
  if (!ready) {
    const why = tail(collector, id)
    await ctx.sessions.close({ id, force: true })
    await sleep(1500)
    return { ok: false, answer: `never reached a prompt. Last output: ${why}`, reachedPrompt: false, ...common }
  }

  const result = await ask(
    ctx,
    collector,
    id,
    'Invoke the skill named alpha:helm-probe, then reply with exactly ' +
      'TOKEN=<the first markdown H1 heading in that skill body>.',
    [`TOKEN=${token}`]
  )
  await ctx.sessions.close({ id, force: true })
  await sleep(1500)
  return { ...result, reachedPrompt: true, ...common }
}

const overlayName = (project: Project): string => project.name.toLowerCase()

/**
 * The token a fixture skill body declares.
 *
 * Asked for by name rather than as "the first H1 heading", which is what this
 * started as and which is not a stable thing to compare against: a model
 * answering `SKILL1=# HELMM3ALPHATHINK` has read the right file and quoted the
 * heading *including its hash*, and an equality check on the text calls that a
 * failure. A bare token has one form.
 *
 * Read from the file rather than from the constant it was written with, so the
 * comparison is still a claim about what is on disk.
 */
function skillToken(file: string): string {
  try {
    return /Its token is ([A-Z0-9]+)\./.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
  } catch {
    return ''
  }
}

/**
 * The first line number at which two files differ, with both versions.
 *
 * Computed rather than hardcoded so the probe keeps working when the user edits
 * either file, and so one answer cannot satisfy both halves of the check - the
 * two repos' settings files share a preamble, and asking for "the first 60
 * characters" of each got the same string twice.
 */
function distinctLine(
  fileA: string,
  fileB: string
): { line: number; a: string; b: string } | null {
  let a: string[]
  let b: string[]
  try {
    a = readFileSync(fileA, 'utf8').split(/\r?\n/)
    b = readFileSync(fileB, 'utf8').split(/\r?\n/)
  } catch {
    return null
  }

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = (a[i] ?? '').trim()
    const right = (b[i] ?? '').trim()
    // Long enough that echoing it is evidence, and different enough that
    // echoing one does not accidentally answer for the other.
    if (left.length >= 12 && right.length >= 12 && left !== right) {
      return { line: i + 1, a: left, b: right }
    }
  }
  return null
}

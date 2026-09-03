import type { BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createProfile, deleteProfile, findProfileByName, type Profile } from '@helm/core'
import { screenshot, sendKey, sleep, waitFor } from './bridge'
import type { Check } from './fidelity'
import type { CheckContext } from './sessionscheck'

/**
 * The editors: the overlay, the highlighting, and the editing behaviour.
 *
 * Everything here is driven through the **real window** against a fixture
 * harness the driver owns, and the run **never clicks Save** - HL-16 hashes the
 * fixture tree either side to say so. The point of that is not tidiness: this
 * milestone touches the one surface in Helm that writes into a `.claude` tree,
 * and a check that proves the editor works by writing through it would be
 * asserting the wrong thing about the wrong file.
 *
 * Four shapes in here are worth knowing before touching it.
 *
 * **The scroll claim is made twice, in two currencies.** The transform written
 * onto the layer stack is what the component *intended*; the underlay's own
 * bounding rectangle is where the browser actually put it. Asserting only the
 * first is asserting that a string was assembled correctly.
 *
 * **The parity comparator is made to fail first** (HL-2). Two computed styles
 * agreeing is exactly the comparison that also passes when both sides are
 * empty, so a font size is forced onto one layer and the same comparator has to
 * reject the pair it had just accepted. The trailing-newline half gets its own:
 * the pseudo-element that materialises the last line is switched off from a
 * stylesheet this driver injects, and the two heights have to *stop* matching.
 * That is TPL-1's rule applied per comparison, which is where PROF-4's failure
 * actually lives.
 *
 * **Latency is measured as frames, not milliseconds.** "Inside one frame" is a
 * discrete claim and a discrete instrument can make it: an `input` listener
 * this driver installs starts counting `requestAnimationFrame` callbacks and
 * stops at the first one where the underlay's text is the textarea's. One is a
 * pass; two is a frame in which the screen did not have the character the user
 * had already typed. Milliseconds are reported beside it because they are
 * interesting, but they are not what the criterion says.
 *
 * **Undo is asserted against the *previous user state*, not against emptiness.**
 * A naive implementation writes `.value` directly, which empties Chromium's
 * undo stack; the failure is that Ctrl+Z gives back a blank box or does
 * nothing. So HL-9 types a word, presses Tab (a programmatic edit), and
 * requires Ctrl+Z to give back the word.
 *
 * Costs: no `claude` sessions, no network, roughly two minutes. Writes only
 * inside its own data directory.
 *
 * `pnpm highlight-check` -> helm-data/highlight-report.json
 */

/** The groups `--only=` can name. The one authority for the list. */
const GROUPS = ['edit', 'parity', 'behaviour', 'latency', 'degrade', 'theme'] as const

const PROFILE_NAME = 'helm-highlight-fixtures'

/** Matches `WINDOW_THRESHOLD` in `CodeEditor.tsx`; the big fixture is over it. */
const BIG_LINES = 3000

// ---------------------------------------------------------------------------
// Talking to the renderer
// ---------------------------------------------------------------------------

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  try {
    return (await win.webContents.executeJavaScript(expression, true)) as T
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`renderer expression failed: ${detail}\n${expression.slice(0, 400)}`, {
      cause: err
    })
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
    await sleep(120)
  }
}

/** Sets a React-controlled field the way a keystroke and a paste both do. */
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

/**
 * Puts the caret somewhere and focuses the box.
 *
 * The `keyup` is not decoration. React's `onSelect` is synthesised from a
 * document-level `selectionchange` and a short list of input events; a `select`
 * Event dispatched by hand does not reach it, so the component's idea of where
 * the caret is stayed at wherever the last `setValue` left it - which showed up
 * as the current-line band sitting on the last line of the file. `keyup` is one
 * of the events the component itself listens for, so this arrives the way a
 * person's arrow key would.
 */
async function place(win: BrowserWindow, start: number, end = start): Promise<void> {
  await js<boolean>(
    win,
    `(() => { const el = document.querySelector('textarea[data-config-editor]');
      if (!el) return false; el.focus();
      el.setSelectionRange(${String(start)}, ${String(end)});
      el.dispatchEvent(new Event('select', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
      return true })()`
  )
  await sleep(80)
}

const editorValue = (win: BrowserWindow): Promise<string> =>
  js<string>(win, `document.querySelector('textarea[data-config-editor]')?.value ?? ''`)

async function showConsole(win: BrowserWindow): Promise<boolean> {
  if (!(await click(win, '[data-tab="config"]'))) {
    await click(win, 'aside button[data-open-config]')
  }
  return pollJs(win, `document.querySelector('select[data-config-scope]')`, 20_000)
}

/**
 * Picks a scope out of a `<select>` by path, matched case-insensitively.
 *
 * Windows disagrees with itself about the case of a drive letter and of every
 * component under it, so the string this driver built with `join` and the
 * string the app resolved are the same directory spelled two ways. Assigning
 * the driver's spelling silently selects nothing.
 */
async function selectScope(
  win: BrowserWindow,
  selector: string,
  scopePath: string
): Promise<boolean> {
  const ok = await js<boolean>(
    win,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const want = ${JSON.stringify(scopePath.toLowerCase())};
      const option = [...el.options].find((o) => o.value.toLowerCase() === want);
      if (!option) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(el, option.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true })()`
  )
  await sleep(600)
  return ok
}

/**
 * Opens a file in the console and puts it in the mode that shows a textarea.
 *
 * Polled at every step rather than slept through. The mode control does not
 * exist until the bytes have arrived, so a fixed pause here is a race that only
 * loses on a slow machine - which is the shape of a check that is red for
 * somebody else and green for whoever wrote it.
 */
async function openForEditing(
  win: BrowserWindow,
  relPath: string,
  mode: 'edit' | 'source'
): Promise<boolean> {
  const picked = await pollJs(
    win,
    `(() => { const row = [...document.querySelectorAll('button[data-config-file]')]
        .find((el) => el.dataset.configFile === ${JSON.stringify(relPath)});
      if (!row) return false; row.click(); return true })()`,
    20_000
  )
  if (!picked) return false
  if (!(await pollJs(win, `document.querySelector('button[data-config-mode="${mode}"]')`, 20_000))) {
    return false
  }
  await click(win, `button[data-config-mode="${mode}"]`)
  const ready = await pollJs(win, `document.querySelector('textarea[data-config-editor]')`, 20_000)
  if (ready) await sleep(250)
  return ready
}

/** What the console is showing, when something did not open and it matters why. */
async function consoleState(win: BrowserWindow): Promise<Record<string, unknown>> {
  return js<Record<string, unknown>>(
    win,
    `(() => ({
      scope: document.querySelector('select[data-config-scope]')?.value ?? null,
      files: [...document.querySelectorAll('button[data-config-file]')]
        .map((el) => el.dataset.configFile).slice(0, 40),
      modes: [...document.querySelectorAll('button[data-config-mode]')]
        .map((el) => el.dataset.configMode),
      hasTextarea: Boolean(document.querySelector('textarea[data-config-editor]'))
    }))()`
  )
}

/** A group that could not get to its fixture reports that, rather than throwing. */
function unopened(id: string, criterion: string, title: string, state: unknown): Check {
  return {
    id,
    criterion,
    title,
    ok: false,
    detail: { openedTheFixture: false, console: state },
    notes: ['The fixture never reached an editable state, so nothing below it was measured.']
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  root: string
  claude: string
  /** Prose with lines far wider than any pane. The `CLAUDE.md` scrollbar case. */
  instructions: string
  /** Structured, so wrap stays off and the pair rules have quotes to close. */
  settings: string
  /** Ends in newlines, for the height-parity claim. */
  trailing: string
  /** Over the windowing threshold. */
  big: string
  /** Over the highlighting ceiling. */
  huge: string
  note: string
}

/** ~90 characters of prose per line, so a line is wider than any pane. */
function proseLine(n: number): string {
  return `- Paragraph ${String(n)} runs on well past the width of the pane it is read in, which is the whole reason a file of prose has to wrap rather than scroll sideways.`
}

function buildFixtures(dataDir: string): Fixtures {
  const root = join(dataDir, 'highlight-fixtures')
  rmSync(root, { recursive: true, force: true })
  const claude = join(root, '.claude')
  mkdirSync(join(claude, 'rules'), { recursive: true })
  mkdirSync(join(claude, 'skills', 'big'), { recursive: true })
  mkdirSync(join(claude, 'skills', 'huge'), { recursive: true })
  mkdirSync(join(root, 'notes'), { recursive: true })
  writeFileSync(join(root, 'harness.yaml'), 'name: highlight-fixtures\n')

  // Beside `.claude/`, not inside it, which is where the CLI reads it from for
  // any scope but the user's - and therefore where the console lists it. The
  // first run of this driver put it in `.claude/` and every group failed on a
  // file that was never in the tree.
  const instructions = join(root, 'CLAUDE.md')
  // Long enough to scroll vertically with wrapping switched *off*, which the
  // scroll-sync probe needs: `scrollTop = 90` on a file that fits in the pane
  // clamps to 0, and an assertion about a scroll that never happened passes for
  // the wrong reason.
  writeFileSync(
    instructions,
    [
      '# Fixture instructions',
      '',
      ...Array.from({ length: 60 }, (_, i) => proseLine(i + 1)),
      '',
      '```json',
      '{ "a": 1 }',
      '```',
      ''
    ].join('\n')
  )

  // `settings.local.json` rather than `settings.json`: both are the settings
  // kind, and using the local one keeps the fixture off the name the config
  // console's own checks drive.
  const settings = join(claude, 'settings.local.json')
  writeFileSync(
    settings,
    `${JSON.stringify(
      {
        env: Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [
            `HELM_FIXTURE_${String(i)}`,
            `a value long enough that this line is wider than the pane and the box has to scroll sideways to show it ${String(i)}`
          ])
        ),
        permissions: { allow: ['Bash(echo:*)'], deny: [] }
      },
      null,
      2
    )}\n`
  )

  /*
   * Four newlines at the end, which is four line boxes a `<pre>` does not draw
   * on its own. The number is not one, because "off by exactly one" is the
   * shape a fudge factor also produces.
   *
   * Long enough to overflow the pane, and the lines are short enough not to
   * wrap. Both matter to how it is measured. `scrollHeight` on a textarea is
   * never less than the box, so on a file that fits, both layers report the
   * pane height and agree for a reason that has nothing to do with the last
   * line; and comparing two heights over *wrapped* text would be asserting the
   * wrap and the trailing newline at once, where only one of them is what this
   * probe is named for.
   */
  const trailing = join(claude, 'rules', 'trailing.md')
  writeFileSync(
    trailing,
    `${Array.from({ length: 200 }, (_, i) => `line ${String(i + 1)}`).join('\n')}\n\n\n\n`
  )

  const big = join(claude, 'skills', 'big', 'SKILL.md')
  writeFileSync(
    big,
    [
      '---',
      'name: big',
      'description: A fixture long enough that the underlay renders a window of it.',
      '---',
      '',
      ...Array.from({ length: BIG_LINES }, (_, i) => proseLine(i + 1))
    ].join('\n')
  )

  // Past `HIGHLIGHT_MAX_BYTES`, which is 512 KB.
  const huge = join(claude, 'skills', 'huge', 'SKILL.md')
  writeFileSync(
    huge,
    [
      '---',
      'name: huge',
      'description: A fixture past the highlighting ceiling.',
      '---',
      '',
      ...Array.from({ length: 6000 }, (_, i) => `${proseLine(i + 1)} ${'x'.repeat(60)}`)
    ].join('\n')
  )

  const note = join(root, 'notes', 'note.md')
  writeFileSync(note, '---\ntype: reference\n---\n\n# A fixture note\n\nSomething to edit.\n')

  return { root, claude, instructions, settings, trailing, big, huge, note }
}

/** Every byte under the fixture `.claude` tree, as one digest. */
function hashTree(dir: string): { files: number; digest: string } {
  const parts: string[] = []
  let files = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      files += 1
      parts.push(
        `${relative(dir, full)}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`
      )
    }
  }
  walk(dir)
  return { files, digest: createHash('sha256').update(parts.join('\n')).digest('hex') }
}

// ---------------------------------------------------------------------------

const round = (n: number): number => Math.round(n * 100) / 100

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

// ---------------------------------------------------------------------------

export async function runHighlightChecks(
  ctx: CheckContext,
  shotDir: string,
  dataDir: string,
  only?: readonly string[]
): Promise<Check[]> {
  const wanted = new Set<string>(only && only.length > 0 ? only : GROUPS)
  const checks: Check[] = []
  const { win, services } = ctx

  await waitFor(() => ctx.services.lastScan !== null, 120_000)
  const fixtures = buildFixtures(dataDir)
  const before = hashTree(fixtures.root)

  // The fixture harness is inside no scanned root, so it becomes a scope the
  // way a user's out-of-tree folder does: a profile points at it. Borrowed
  // wholesale from `contentcheck.ts`, which needed the same thing.
  const stale = findProfileByName(services.store, PROFILE_NAME)
  if (stale) deleteProfile(services.store, stale.id)
  const profile: Profile = createProfile(services.store, {
    name: PROFILE_NAME,
    root: fixtures.root,
    overlays: [],
    access: [],
    model: null,
    effort: null,
    permissionMode: null,
    agent: null,
    mcp: [],
    openingPrompt: null,
    pinnedOrder: null,
    target: null
  })

  const opened = await showConsole(win)
  await click(win, 'button[data-config-refresh]')
  await sleep(400)
  const offered = await pollJs(
    win,
    `[...document.querySelectorAll('select[data-config-scope] option')]
       .some((o) => o.value.toLowerCase() === ${JSON.stringify(fixtures.root.toLowerCase())})`,
    20_000
  )
  const scoped = offered && (await selectScope(win, 'select[data-config-scope]', fixtures.root))

  checks.push({
    id: 'HL-0',
    criterion: 'setup',
    title: 'The console opens on a fixture harness this driver owns',
    ok: opened && offered && scoped && statSync(fixtures.huge).size > 512 * 1024,
    detail: {
      root: fixtures.root,
      profileId: profile.id,
      offeredInTheSwitcher: offered,
      hugeBytes: statSync(fixtures.huge).size,
      bigLines: BIG_LINES,
      fixtureFiles: before.files
    },
    notes: [
      'Nothing outside this directory is opened, and nothing here is ever saved -',
      'HL-16 hashes the tree either side and requires it unchanged.'
    ]
  })

  const group = async (name: string, run: () => Promise<Check[]>): Promise<void> => {
    if (!wanted.has(name)) return
    checks.push(...(await run()))
  }

  await group('edit', () => editChecks(ctx, shotDir, fixtures))
  await group('parity', () => parityChecks(ctx, fixtures))
  await group('behaviour', () => behaviourChecks(ctx, shotDir, fixtures))
  await group('latency', () => latencyChecks(ctx, fixtures))
  await group('degrade', () => degradeChecks(ctx, fixtures))
  await group('theme', () => themeChecks(ctx, shotDir, fixtures))

  const after = hashTree(fixtures.root)
  checks.push({
    id: 'HL-16',
    criterion: 'the editor is not a second write path',
    title: 'The whole run left every fixture byte where it found it',
    ok: before.digest === after.digest && before.files === after.files,
    detail: { before, after },
    notes: [
      '`~/.claude` is Claude Code’s and the config console is the one exception, through a',
      'snapshotted write. Nothing in this milestone added a second one, and the way to say',
      'that is to drive every editing probe there is and then find the bytes untouched.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// HL-1, HL-15: the textarea contract and the overlay that sits under it
// ---------------------------------------------------------------------------

async function editChecks(
  ctx: CheckContext,
  shotDir: string,
  fixtures: Fixtures
): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []

  const opened = await openForEditing(win, 'CLAUDE.md', 'edit')
  if (!opened) {
    return [unopened('HL-1', 'the textarea contract survives', 'The config editor opens', await consoleState(win))]
  }
  await pollJs(win, `document.querySelector('[data-editor]')?.dataset.editorColoured === 'true'`, 15_000)

  const original = await editorValue(win)
  const typed = `${original}\nA line this driver typed.\n`
  const set = await setValue(win, 'textarea[data-config-editor]', typed)
  await sleep(400)

  const mirrored = await js<{
    value: number
    mirror: number
    equal: boolean
    spans: number
    coloured: number
    dirty: string | null
  }>(
    win,
    `(() => {
      const ta = document.querySelector('textarea[data-config-editor]');
      const mirror = document.querySelector('pre[data-editor-underlay]');
      const hl = document.querySelector('pre[data-editor-highlight]');
      return {
        value: ta ? ta.value.length : -1,
        mirror: mirror ? mirror.textContent.length : -1,
        equal: Boolean(ta && mirror && ta.value === mirror.textContent),
        spans: hl ? hl.querySelectorAll('span.line').length : -1,
        coloured: hl ? hl.querySelectorAll('span[style*="--shiki"]').length : -1,
        dirty: document.querySelector('[data-dirty]')?.dataset.dirty ?? null
      };
    })()`
  )

  /**
   * The scroll claim, in both currencies and in both wrap modes.
   *
   * `rectDelta` is the browser's answer and `transform` is the component's
   * intention. They are asserted separately because a transform written into a
   * style attribute is a string, and a string is not a position.
   */
  const scrollProbe = `(top, left) => new Promise((resolve) => {
    const ta = document.querySelector('textarea[data-config-editor]');
    const mirror = document.querySelector('pre[data-editor-underlay]');
    const layers = document.querySelector('.helm-editor-layers');
    ta.scrollTop = 0; ta.scrollLeft = 0;
    ta.dispatchEvent(new Event('scroll', { bubbles: true }));
    requestAnimationFrame(() => {
      const from = mirror.getBoundingClientRect();
      ta.scrollTop = top; ta.scrollLeft = left;
      ta.dispatchEvent(new Event('scroll', { bubbles: true }));
      requestAnimationFrame(() => {
        const to = mirror.getBoundingClientRect();
        const m = new DOMMatrixReadOnly(getComputedStyle(layers).transform);
        resolve({
          asked: { top: ta.scrollTop, left: ta.scrollLeft },
          rectDelta: { top: Math.round(to.top - from.top), left: Math.round(to.left - from.left) },
          transform: { x: Math.round(m.m41), y: Math.round(m.m42) },
          overflowsSideways: ta.scrollWidth > ta.clientWidth
        });
      });
    });
  })`

  type Scrolled = {
    asked: { top: number; left: number }
    rectDelta: { top: number; left: number }
    transform: { x: number; y: number }
    overflowsSideways: boolean
  }

  const soft = await js<Scrolled>(win, `(${scrollProbe})(90, 0)`)
  // The same file with wrapping switched off, so the horizontal axis has
  // somewhere to go.
  await click(win, 'button[data-config-wrap]')
  await sleep(300)
  const hard = await js<Scrolled>(win, `(${scrollProbe})(90, 60)`)
  await click(win, 'button[data-config-wrap]')
  await sleep(200)

  const shot = await screenshot(win, shotDir, 'editor-config.png')

  // Back to the bytes on disk, which is what "never saved" means for the draft
  // as much as for the file.
  await setValue(win, 'textarea[data-config-editor]', original)
  await sleep(300)
  const clean = await js<string | null>(
    win,
    `document.querySelector('[data-dirty]')?.dataset.dirty ?? null`
  )

  /**
   * Asserted against what the box *actually* scrolled to, not against what it
   * was asked for - and then separately that it was asked to move at all.
   * `scrollTop = 90` on a file that fits in the pane clamps to zero, and
   * "the underlay moved by exactly zero" is a comparison every broken overlay
   * in the world also passes.
   */
  const synced = (s: Scrolled, axes: 'vertical' | 'both'): boolean => {
    const moved = axes === 'both' ? s.asked.top > 0 && s.asked.left > 0 : s.asked.top > 0
    return (
      moved &&
      s.rectDelta.top === -s.asked.top &&
      s.rectDelta.left === -s.asked.left &&
      s.transform.y === -s.asked.top &&
      s.transform.x === -s.asked.left
    )
  }
  const syncedSoft = synced(soft, 'vertical') && soft.asked.left === 0
  const syncedHard = synced(hard, 'both')

  checks.push({
    id: 'HL-1',
    criterion: 'one shared editor; the textarea contract survives; the underlay follows it',
    title: 'The config editor is still a driven textarea, with an underlay that mirrors and tracks it',
    ok:
      opened &&
      set &&
      mirrored.equal &&
      mirrored.spans > 0 &&
      mirrored.coloured > 0 &&
      mirrored.dirty === 'true' &&
      clean === 'false' &&
      syncedSoft &&
      syncedHard &&
      hard.overflowsSideways,
    detail: { mirrored, soft, hard, dirtyAfterRevert: clean, screenshots: [shot.file] },
    notes: [
      'The value setter is the one ten existing check sites in configcheck.ts and',
      'contentcheck.ts use, so this is the same contract they depend on, exercised here.',
      'Two independent answers about the scroll: `rectDelta` is where the browser put the',
      'underlay, `transform` is what the component asked for. A string that reads right',
      'over an element that did not move fails the first and passes the second.'
    ]
  })

  // ---- the other surface -------------------------------------------------
  const contentOk = await contentEditorProbe(ctx, fixtures)
  checks.push(contentOk)

  return checks
}

/** HL-15: the same component, on the surface with the other data attribute. */
async function contentEditorProbe(ctx: CheckContext, fixtures: Fixtures): Promise<Check> {
  const { win } = ctx
  if (!(await click(win, '[data-tab="content"]'))) {
    await click(win, 'aside button[data-open-content]')
  }
  const viewer = await pollJs(win, `document.querySelector('select[data-content-scope]')`, 20_000)
  // Refresh *before* selecting. The switcher's options are read once when the
  // pane mounts, and this driver's fixture becomes a scope by way of a profile
  // it wrote after the window was already up - so the list on screen predates
  // it. `refresh` re-reads the scopes as well as the tree, which is exactly
  // what it is for.
  await click(win, 'button[data-content-refresh]')
  await pollJs(
    win,
    `[...document.querySelectorAll('select[data-content-scope] option')]
       .some((o) => o.value.toLowerCase() === ${JSON.stringify(fixtures.root.toLowerCase())})`,
    20_000
  )
  const inScope = await selectScope(win, 'select[data-content-scope]', fixtures.root)
  // A profile root is a *project* scope, and a project scope opens in the tree
  // view, where files arrive one `content:dir` at a time and the flat list of
  // `data-content-file` rows is empty. The curated view is the one that lists
  // them, and switching to it is what a reader would do.
  await click(win, '[data-content-view="curated"]')
  await sleep(800)
  const picked = await pollJs(
    win,
    `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
        .find((el) => el.dataset.contentFile === 'notes/note.md');
      if (!row) return false; row.click(); return true })()`,
    20_000
  )
  const tree = picked
    ? null
    : await js<string[]>(
        win,
        `[...document.querySelectorAll('button[data-content-file]')].map((el) => el.dataset.contentFile).slice(0, 40)`
      )
  await sleep(500)
  await click(win, 'button[data-content-mode="edit"]')
  const box = await pollJs(win, `document.querySelector('textarea[data-content-editor]')`, 15_000)
  await sleep(400)

  const original = await js<string>(
    win,
    `document.querySelector('textarea[data-content-editor]')?.value ?? ''`
  )
  await setValue(win, 'textarea[data-content-editor]', `${original}\nTyped by the driver.\n`)
  await sleep(400)
  const state = await js<{ equal: boolean; surface: string | null; spans: number }>(
    win,
    `(() => {
      const ta = document.querySelector('textarea[data-content-editor]');
      const mirror = document.querySelector('pre[data-editor-underlay]');
      const hl = document.querySelector('pre[data-editor-highlight]');
      return {
        equal: Boolean(ta && mirror && ta.value === mirror.textContent),
        surface: document.querySelector('[data-editor]')?.dataset.editorSurface ?? null,
        spans: hl ? hl.querySelectorAll('span.line').length : -1
      };
    })()`
  )
  await setValue(win, 'textarea[data-content-editor]', original)
  await sleep(300)

  // Back to the console, where every other group lives.
  if (!(await click(win, '[data-tab="config"]'))) {
    await click(win, 'aside button[data-open-config]')
  }
  await pollJs(win, `document.querySelector('select[data-config-scope]')`, 20_000)
  await selectScope(win, 'select[data-config-scope]', fixtures.root)

  return {
    id: 'HL-15',
    criterion: 'one shared editor; `data-content-editor` survives verbatim',
    title: 'The content viewer edits through the same component, under its own data attribute',
    ok:
      viewer && inScope && picked && box && state.equal && state.surface === 'content' && state.spans > 0,
    detail: { viewer, inScope, picked, box, ...state, treeWhenNotFound: tree },
    notes: [
      'Two surfaces, one component. The attribute is what contentcheck.ts queries and it is',
      'unchanged; `data-editor-surface` is how this driver tells which host it is looking at.'
    ]
  }
}

// ---------------------------------------------------------------------------
// HL-2: metrics, and the trailing newline
// ---------------------------------------------------------------------------

async function parityChecks(ctx: CheckContext, _fixtures: Fixtures): Promise<Check[]> {
  const { win } = ctx
  if (!(await openForEditing(win, 'CLAUDE.md', 'edit'))) {
    return [unopened('HL-2', 'the underlay is the textarea’s box', 'Metrics parity', await consoleState(win))]
  }
  await sleep(400)

  /** The properties the two layers have to agree on, read off both. */
  const compare = `() => {
    const ta = document.querySelector('textarea[data-config-editor]');
    const mirror = document.querySelector('pre[data-editor-underlay]');
    const hl = document.querySelector('pre[data-editor-highlight]');
    const read = (el) => {
      const s = getComputedStyle(el);
      return {
        font: s.font,
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing,
        tabSize: s.tabSize,
        padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(' '),
        border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].join(' '),
        whiteSpace: s.whiteSpace
      };
    };
    const a = read(ta), b = read(mirror), c = read(hl);
    const keys = Object.keys(a);
    return {
      textarea: a, mirror: b, highlight: c,
      mirrorDisagrees: keys.filter((k) => a[k] !== b[k]),
      highlightDisagrees: keys.filter((k) => a[k] !== c[k])
    };
  }`

  type Compared = {
    textarea: Record<string, string>
    mirror: Record<string, string>
    highlight: Record<string, string>
    mirrorDisagrees: string[]
    highlightDisagrees: string[]
  }

  const clean = await js<Compared>(win, `(${compare})()`)

  // The comparator is made to fail before its clean answer is believed. A font
  // size is forced onto one layer and the same function has to name it.
  await js<boolean>(
    win,
    `(() => { document.querySelector('pre[data-editor-underlay]').style.fontSize = '13px'; return true })()`
  )
  await sleep(120)
  const mutated = await js<Compared>(win, `(${compare})()`)
  await js<boolean>(
    win,
    `(() => { document.querySelector('pre[data-editor-underlay]').style.fontSize = ''; return true })()`
  )
  await sleep(120)
  const restored = await js<Compared>(win, `(${compare})()`)

  const checks: Check[] = [
    {
      id: 'HL-2',
      criterion: 'the underlay is the textarea’s box, measured rather than eyeballed',
      title: 'Font, padding, border, tab size and line height agree on every layer',
      ok:
        clean.mirrorDisagrees.length === 0 &&
        clean.highlightDisagrees.length === 0 &&
        mutated.mirrorDisagrees.length > 0 &&
        restored.mirrorDisagrees.length === 0 &&
        clean.textarea.font !== '',
      detail: { clean, mutatedRejected: mutated.mirrorDisagrees, restored: restored.mirrorDisagrees },
      notes: [
        'Two computed styles agreeing is also what two empty answers look like, so the',
        'comparator is run clean, then made to reject a layer whose font size was forced,',
        'then run clean again. TPL-1’s rule, applied to this comparison.',
        '`font` being non-empty is part of the claim: the shorthand is unrepresentable for',
        'some values and an empty string on both sides would compare equal.'
      ]
    }
  ]

  // ---- the trailing newline ----------------------------------------------
  if (!(await openForEditing(win, '.claude/rules/trailing.md', 'edit'))) {
    checks.push(
      unopened('HL-3', 'trailing-newline height parity', 'The trailing fixture opens', await consoleState(win))
    )
    return checks
  }
  await sleep(400)

  const heights = `() => {
    const ta = document.querySelector('textarea[data-config-editor]');
    const mirror = document.querySelector('pre[data-editor-underlay]');
    const hl = document.querySelector('pre[data-editor-highlight]');
    return {
      value: JSON.stringify(ta.value),
      textarea: ta.scrollHeight,
      mirror: mirror.scrollHeight,
      highlight: hl.scrollHeight
    };
  }`
  type Heights = { value: string; textarea: number; mirror: number; highlight: number }

  const withTrailing = await js<Heights>(win, `(${heights})()`)

  // Switch off the pseudo-element that materialises the last line, and require
  // the two heights to *stop* agreeing. Without this the parity claim is
  // satisfied by a `<pre>` that happens to be tall enough for another reason.
  await js<boolean>(
    win,
    `(() => { const s = document.createElement('style'); s.id = 'hl-no-trailing';
      s.textContent = '.helm-editor-mirror::after { content: none !important }';
      document.head.appendChild(s); return true })()`
  )
  await sleep(200)
  const withoutMateraliser = await js<Heights>(win, `(${heights})()`)
  await js<boolean>(
    win,
    `(() => { document.getElementById('hl-no-trailing')?.remove(); return true })()`
  )
  await sleep(200)
  const back = await js<Heights>(win, `(${heights})()`)

  checks.push({
    id: 'HL-3',
    criterion: 'trailing-newline height parity',
    title: 'A file ending in four newlines is the same height in the box and under it',
    ok:
      withTrailing.textarea === withTrailing.mirror &&
      withTrailing.textarea === withTrailing.highlight &&
      withoutMateraliser.mirror < withTrailing.mirror &&
      back.mirror === withTrailing.mirror,
    detail: { withTrailing, withoutMateraliser, back },
    notes: [
      'A `<pre>` lays out no box for the empty line after a final break and a textarea does,',
      'so the two disagree by a line for every file that ends the way every file should.',
      'The fix is a zero-width pseudo-element; it is switched off here and the heights have',
      'to stop matching, because "these two numbers are equal" is a comparison that also',
      'passes when nothing was being measured.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// HL-4 .. HL-10: the editing behaviour list, one probe per item
// ---------------------------------------------------------------------------

async function behaviourChecks(
  ctx: CheckContext,
  shotDir: string,
  _fixtures: Fixtures
): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []

  /** Types into the fixture from a known state and reads the result back. */
  const reset = async (text: string): Promise<void> => {
    await setValue(win, 'textarea[data-config-editor]', text)
    await sleep(200)
  }

  if (!(await openForEditing(win, '.claude/settings.local.json', 'source'))) {
    return [
      unopened('HL-4', 'the editing behaviour list', 'The behaviour fixture opens', await consoleState(win))
    ]
  }
  await sleep(400)
  const settingsOriginal = await editorValue(win)

  // ---- HL-4: Tab and Shift+Tab -------------------------------------------
  await reset('one\ntwo\nthree\n')
  await place(win, 0)
  await sendKey(win, 'Tab')
  const afterCaretTab = await editorValue(win)

  await place(win, 2, 9) // spans line 1 into line 2
  await sendKey(win, 'Tab')
  const afterBlockTab = await editorValue(win)

  await sendKey(win, 'Tab', ['shift'])
  const afterOutdent = await editorValue(win)

  checks.push({
    id: 'HL-4',
    criterion: 'Tab / Shift+Tab indent and outdent, selection-aware',
    title: 'Tab inserts the file kind’s indent at a caret and moves whole lines over a selection',
    ok:
      afterCaretTab === '  one\ntwo\nthree\n' &&
      afterBlockTab === '    one\n  two\nthree\n' &&
      afterOutdent === '  one\ntwo\nthree\n',
    detail: {
      indentUnit: '  (two spaces, which is what .json asks for)',
      afterCaretTab: JSON.stringify(afterCaretTab),
      afterBlockTab: JSON.stringify(afterBlockTab),
      afterOutdent: JSON.stringify(afterOutdent)
    },
    notes: [
      'The block case is the one that matters: a Tab that replaced the selection with a tab',
      'character would delete what the user had selected, and it is the default behaviour of',
      'the element this is built on.'
    ]
  })

  // ---- HL-5: Enter ---------------------------------------------------------
  await reset('    "a": 1\n')
  await place(win, 10)
  await sendKey(win, 'Enter')
  const afterEnter = await editorValue(win)

  await reset('  {}\n')
  await place(win, 3)
  await sendKey(win, 'Enter')
  const afterOpener = await editorValue(win)

  checks.push({
    id: 'HL-5',
    criterion: 'Enter keeps the indentation, one level deeper after an opener',
    title: 'Enter continues the line’s indentation and opens a block between a pair',
    ok: afterEnter === '    "a": 1\n    \n' && afterOpener === '  {\n    \n  }\n',
    detail: {
      afterEnter: JSON.stringify(afterEnter),
      betweenAPair: JSON.stringify(afterOpener)
    },
    notes: ['The second is the case that makes it feel like an editor rather than a box.']
  })

  // ---- HL-6: pairs ---------------------------------------------------------
  await reset('')
  await place(win, 0)
  await sendKey(win, '(')
  const afterOpen = await editorValue(win)
  const caretInside = await js<number>(
    win,
    `document.querySelector('textarea[data-config-editor]').selectionStart`
  )
  await sendKey(win, ')')
  const afterTypeOver = await editorValue(win)
  const caretAfter = await js<number>(
    win,
    `document.querySelector('textarea[data-config-editor]').selectionStart`
  )
  await place(win, 1)
  await sendKey(win, 'Backspace')
  const afterPairDelete = await editorValue(win)

  await reset('{}')
  await place(win, 1)
  await sendKey(win, '"', ['shift'])
  const afterQuote = await editorValue(win)

  // The same key in prose, where quotes must not close.
  await openForEditing(win, 'CLAUDE.md', 'edit')
  await sleep(400)
  const proseOriginal = await editorValue(win)
  await reset('word')
  await place(win, 4)
  await sendKey(win, '"', ['shift'])
  const proseQuote = await editorValue(win)
  await place(win, 5)
  await sendKey(win, '[')
  const proseBracket = await editorValue(win)
  await reset(proseOriginal)

  checks.push({
    id: 'HL-6',
    criterion: 'bracket and quote auto-close, type-over, delete-the-pair on backspace',
    title: 'A pair closes itself, is typed over rather than doubled, and comes off together',
    ok:
      afterOpen === '()' &&
      caretInside === 1 &&
      afterTypeOver === '()' &&
      caretAfter === 2 &&
      afterPairDelete === '' &&
      afterQuote === '{""}' &&
      proseQuote === 'word"' &&
      proseBracket === 'word"[]',
    detail: {
      afterOpen,
      caretInside,
      afterTypeOver,
      caretAfter,
      afterPairDelete: JSON.stringify(afterPairDelete),
      quoteInJson: afterQuote,
      quoteInProse: proseQuote,
      bracketInProse: proseBracket
    },
    notes: [
      'The prose pair is the interesting one. Auto-closing a quote in a `CLAUDE.md` turns',
      '`don’t` into `don’’t`, so quotes do not close in prose and brackets still do -',
      'which is what makes `[[wikilink]]` worth typing.'
    ]
  })

  // ---- HL-7: find, and go to line -----------------------------------------
  await openForEditing(win, '.claude/settings.local.json', 'source')
  await sleep(400)
  await reset('alpha beta\nalpha gamma\nALPHA delta\n')
  await place(win, 0)
  await sendKey(win, 'f', ['control'])
  await sleep(300)
  const barOpen = await js<boolean>(win, `Boolean(document.querySelector('input[data-editor-find]'))`)
  await setValue(win, 'input[data-editor-find]', 'alpha')
  await sleep(300)
  const found = await js<{ count: string | null; marks: number }>(
    win,
    `(() => ({
      count: document.querySelector('[data-editor-find-count]')?.dataset.editorFindCount ?? null,
      marks: document.querySelectorAll('pre[data-editor-underlay] mark').length
    }))()`
  )
  await click(win, '[data-editor-find-next]')
  await sleep(200)
  const first = await js<{ start: number; text: string; current: number }>(
    win,
    `(() => { const ta = document.querySelector('textarea[data-config-editor]');
      return { start: ta.selectionStart, text: ta.value.slice(ta.selectionStart, ta.selectionEnd),
        current: document.querySelectorAll('mark[data-editor-match-current="true"]').length }; })()`
  )
  await click(win, '[data-editor-find-prev]')
  await sleep(200)
  const back = await js<number>(
    win,
    `document.querySelector('textarea[data-config-editor]').selectionStart`
  )
  const findShot = await screenshot(win, shotDir, 'editor-find.png')
  await click(win, '[data-editor-find-close]')
  await sleep(200)

  await sendKey(win, 'g', ['control'])
  await sleep(300)
  const gotoOpen = await js<boolean>(win, `Boolean(document.querySelector('input[data-editor-goto]'))`)
  await setValue(win, 'input[data-editor-goto]', '3')
  await sleep(150)
  await js<boolean>(
    win,
    `(() => { const el = document.querySelector('input[data-editor-goto]');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true })()`
  )
  await sleep(300)
  const landed = await js<{ start: number; line: number }>(
    win,
    `(() => { const ta = document.querySelector('textarea[data-config-editor]');
      return { start: ta.selectionStart, line: ta.value.slice(0, ta.selectionStart).split('\\n').length }; })()`
  )

  checks.push({
    id: 'HL-7',
    criterion: 'Ctrl+F with a match count, next and previous, matches in the underlay; Ctrl+G',
    title: 'Find counts case-insensitively, steps both ways and paints its matches; go-to-line lands',
    ok:
      barOpen &&
      found.count === '3' &&
      found.marks === 3 &&
      first.text.toLowerCase() === 'alpha' &&
      first.current === 1 &&
      back === 0 &&
      gotoOpen &&
      landed.line === 3,
    detail: { barOpen, found, first, previousLandedAt: back, gotoOpen, landed, screenshots: [findShot.file] },
    notes: [
      'Three matches in three lines, one of them upper case, so the count is a claim about',
      'the search rather than about the string. The marks are counted in the underlay',
      'because that is where a match is painted - by wrapping the characters themselves,',
      'so nothing is measured and nothing can drift.'
    ]
  })

  // ---- HL-8: gutter and the current line ----------------------------------
  await reset('one\ntwo\nthree\nfour\n')
  await place(win, 6)
  await sleep(300)
  const gutter = await js<{
    numbers: number[]
    tops: number[]
    lineTops: number[]
    current: number[]
    band: { top: number; height: number } | null
    caretLineTop: number | null
  }>(
    win,
    `(() => {
      const base = document.querySelector('.helm-editor-layers').getBoundingClientRect().top;
      const cells = [...document.querySelectorAll('[data-editor-line-number]')];
      const lines = [...document.querySelectorAll('pre[data-editor-highlight] .line')];
      const band = document.querySelector('[data-editor-caret-line]');
      return {
        numbers: cells.map((el) => Number(el.dataset.editorLineNumber)),
        tops: cells.map((el) => Math.round(el.getBoundingClientRect().top - base)),
        lineTops: lines.map((el) => Math.round(el.getBoundingClientRect().top - base)),
        current: cells.filter((el) => el.dataset.editorCurrent === 'true')
          .map((el) => Number(el.dataset.editorLineNumber)),
        band: band ? { top: Math.round(band.getBoundingClientRect().top - base),
          height: Math.round(band.getBoundingClientRect().height) } : null,
        caretLineTop: lines[1] ? Math.round(lines[1].getBoundingClientRect().top - base) : null
      };
    })()`
  )

  // Wrapped, where a logical line is more than one row and an evenly spaced
  // gutter would be wrong from the first wrap down.
  await openForEditing(win, 'CLAUDE.md', 'edit')
  await sleep(500)
  const wrappedGutter = await js<{
    wrap: string | null
    aligned: boolean
    rows: Array<{ n: number; top: number; lineTop: number; height: number }>
    anyWrapped: boolean
  }>(
    win,
    `(() => {
      const base = document.querySelector('.helm-editor-layers').getBoundingClientRect().top;
      const cells = [...document.querySelectorAll('[data-editor-line-number]')];
      const lines = [...document.querySelectorAll('pre[data-editor-highlight] .line')];
      const lh = parseFloat(getComputedStyle(document.querySelector('textarea[data-config-editor]')).lineHeight);
      const rows = cells.map((el) => {
        const n = Number(el.dataset.editorLineNumber);
        const line = lines[n - 1];
        const r = line ? line.getBoundingClientRect() : null;
        return { n, top: Math.round(el.getBoundingClientRect().top - base),
          lineTop: r ? Math.round(r.top - base) : -1, height: r ? Math.round(r.height) : -1 };
      });
      return {
        wrap: document.querySelector('[data-editor]')?.dataset.editorWrap ?? null,
        aligned: rows.every((r) => Math.abs(r.top - r.lineTop) <= 1),
        anyWrapped: rows.some((r) => r.height > lh * 1.5),
        rows: rows.slice(0, 8)
      };
    })()`
  )

  checks.push({
    id: 'HL-8',
    criterion: 'a wrap-aware line-number gutter, and a current-line highlight',
    title: 'Every number sits on its own line box, wrapped lines included, and the band follows the caret',
    ok:
      gutter.numbers.length >= 4 &&
      gutter.current.length === 1 &&
      gutter.current[0] === 2 &&
      gutter.band !== null &&
      gutter.caretLineTop !== null &&
      gutter.band.top === gutter.caretLineTop &&
      wrappedGutter.wrap === 'on' &&
      wrappedGutter.anyWrapped &&
      wrappedGutter.aligned,
    detail: { plain: gutter, wrapped: wrappedGutter },
    notes: [
      'The numbers are checked against the *line boxes* rather than against an even',
      'multiple of the line height, because those two agree until something wraps - and',
      'the wrapped half of this probe refuses to run unless at least one line did.'
    ]
  })

  // ---- HL-9: undo ----------------------------------------------------------
  await openForEditing(win, '.claude/settings.local.json', 'source')
  await sleep(400)
  await reset('')
  await place(win, 0)
  // A word the user typed, key by key, so there is a real undo stack.
  for (const ch of 'hello') await sendKey(win, ch)
  const userState = await editorValue(win)
  await sendKey(win, 'Tab')
  const afterProgrammatic = await editorValue(win)
  await sendKey(win, 'z', ['control'])
  await sleep(250)
  const afterUndo = await editorValue(win)
  await sendKey(win, 'y', ['control'])
  await sleep(250)
  const afterRedo = await editorValue(win)
  const directWrites = await js<string | null>(
    win,
    `document.querySelector('[data-editor]')?.dataset.editorDirectWrites ?? null`
  )

  checks.push({
    id: 'HL-9',
    criterion: 'undo/redo integrity - every programmatic edit goes through `insertText`',
    title: 'Ctrl+Z after a programmatic edit gives back the previous user state, not an empty box',
    ok:
      userState === 'hello' &&
      afterProgrammatic === 'hello  ' &&
      afterUndo === 'hello' &&
      afterRedo === 'hello  ' &&
      directWrites === '0',
    detail: {
      userState,
      afterProgrammatic: JSON.stringify(afterProgrammatic),
      afterUndo: JSON.stringify(afterUndo),
      afterRedo: JSON.stringify(afterRedo),
      directWrites
    },
    notes: [
      'This is the one that breaks silently. Applying an edit by assigning `.value` empties',
      'Chromium’s undo stack, so Ctrl+Z gives back nothing at all - and every assertion',
      'about the *result* of the edit passes anyway. `data-editor-direct-writes` counts the',
      'times the component had to fall back to that, and zero is part of the claim.'
    ]
  })

  // ---- HL-10: wrap per file kind, and the toggle --------------------------
  await openForEditing(win, 'CLAUDE.md', 'edit')
  await sleep(500)
  const prose = await js<{ wrap: string | null; overflows: boolean }>(
    win,
    `(() => { const ta = document.querySelector('textarea[data-config-editor]');
      return { wrap: document.querySelector('[data-editor]')?.dataset.editorWrap ?? null,
        overflows: ta.scrollWidth > ta.clientWidth + 1 }; })()`
  )
  await click(win, 'button[data-config-wrap]')
  await sleep(300)
  const proseToggled = await js<{ wrap: string | null; overflows: boolean }>(
    win,
    `(() => { const ta = document.querySelector('textarea[data-config-editor]');
      return { wrap: document.querySelector('[data-editor]')?.dataset.editorWrap ?? null,
        overflows: ta.scrollWidth > ta.clientWidth + 1 }; })()`
  )
  await click(win, 'button[data-config-wrap]')
  await sleep(200)

  await openForEditing(win, '.claude/settings.local.json', 'source')
  await sleep(500)
  const structured = await js<{ wrap: string | null; overflows: boolean }>(
    win,
    `(() => { const ta = document.querySelector('textarea[data-config-editor]');
      return { wrap: document.querySelector('[data-editor]')?.dataset.editorWrap ?? null,
        overflows: ta.scrollWidth > ta.clientWidth + 1 }; })()`
  )
  await setValue(win, 'textarea[data-config-editor]', settingsOriginal)
  await sleep(300)

  checks.push({
    id: 'HL-10',
    criterion: 'wrap per file kind plus a per-file toggle; the CLAUDE.md scrollbar is gone',
    title: 'Prose wraps and has no sideways scroll; structure keeps its lines and scrolls',
    ok:
      prose.wrap === 'on' &&
      !prose.overflows &&
      proseToggled.wrap === 'off' &&
      proseToggled.overflows &&
      structured.wrap === 'off' &&
      structured.overflows,
    detail: { prose, proseToggled, structured },
    notes: [
      'The screenshot that started this milestone was a horizontal scrollbar under a',
      '`CLAUDE.md`. `overflows` is that scrollbar, as a number: the fixture’s lines are',
      'wider than any pane, so `false` here is the wrap doing its job rather than a file',
      'that happened to be narrow. The toggle is asserted by making it come back.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// HL-11, HL-12: the group the textarea decision is held up by
// ---------------------------------------------------------------------------

/**
 * Installs an `input` listener that counts frames to the glyph.
 *
 * The instrument is the driver's, not the app's: it starts a
 * `requestAnimationFrame` chain when the element reports input and stops at the
 * first callback where the underlay's text is what the textarea holds. One
 * frame means the character was on screen at the next paint. Two means there
 * was a frame in which it was not.
 */
const INSTRUMENT = `(() => {
  window.__hlLat = { samples: [] };
  const ta = document.querySelector('textarea[data-config-editor]');
  if (!ta) return false;
  if (ta.__hlOn) ta.removeEventListener('input', ta.__hlOn);
  ta.__hlOn = () => {
    const t0 = performance.now();
    let frames = 0;
    const tick = () => {
      frames += 1;
      // Whatever is painting glyphs right now. Above the size ceiling the
      // overlay is gone and the textarea paints its own text, so the layer to
      // interrogate is the textarea - and then "the screen shows what the box
      // holds" is true by construction and what is left to measure is when the
      // frame came around. Below it the mirror is the visible text and the two
      // can genuinely disagree, which is the window this is named for.
      const root = document.querySelector('[data-editor]');
      const plain = root !== null && root.dataset.editorPlain === 'true';
      const mirror = document.querySelector('pre[data-editor-underlay]');
      // Against the textarea's value *now*, not against a copy taken when the
      // event fired. Typing faster than a frame is the interesting case, and a
      // captured copy goes stale the moment the next key lands - which reads as
      // a keystroke that never arrived when what happened is that a later one
      // did.
      if (plain || (mirror && mirror.textContent === ta.value)) {
        window.__hlLat.samples.push({
          frames, ms: performance.now() - t0, chars: ta.value.length, plain
        });
        return;
      }
      if (frames > 20) {
        window.__hlLat.samples.push({ frames: -1, ms: performance.now() - t0, chars: ta.value.length });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  ta.addEventListener('input', ta.__hlOn);
  return true;
})()`

interface Sample {
  frames: number
  ms: number
  chars: number
  /** Whether the overlay was down, so the textarea itself was the glyph layer. */
  plain?: boolean
}

async function typeAndMeasure(
  win: BrowserWindow,
  text: string,
  perKeyMs: number
): Promise<{
  samples: Sample[]
  keystrokes: number
  worstFrames: number
  neverArrived: number
  p95ms: number
  worstMs: number
}> {
  await js<boolean>(win, INSTRUMENT)
  for (const ch of text) await sendKey(win, ch, [], perKeyMs)
  // Long enough that the slowest chain has resolved: 20 frames is the
  // instrument's own ceiling, and past it a sample is pushed as -1 rather than
  // left out. A missing sample and a failing one are different verdicts.
  await sleep(700)
  const samples = await js<Sample[]>(win, `window.__hlLat.samples`)
  const ms = samples.map((s) => s.ms)
  return {
    samples,
    keystrokes: samples.length,
    worstFrames: Math.max(...samples.map((s) => s.frames), 0),
    neverArrived: samples.filter((s) => s.frames === -1).length,
    p95ms: round(percentile(ms, 95)),
    worstMs: round(Math.max(...ms, 0))
  }
}

async function latencyChecks(ctx: CheckContext, _fixtures: Fixtures): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []

  const phrase = 'the quick brown fox'
  const sizes: Array<{ name: string; relPath: string; mode: 'edit' | 'source' }> = [
    { name: 'a 60-line CLAUDE.md', relPath: 'CLAUDE.md', mode: 'edit' },
    { name: `a ${String(BIG_LINES)}-line SKILL.md`, relPath: '.claude/skills/big/SKILL.md', mode: 'edit' },
    { name: 'a file past the highlighting ceiling', relPath: '.claude/skills/huge/SKILL.md', mode: 'edit' }
  ]

  const typed: Array<Record<string, unknown>> = []
  let everyKeystrokeInOneFrame = true
  for (const size of sizes) {
    const opened = await openForEditing(win, size.relPath, size.mode)
    await sleep(900)
    const original = await editorValue(win)

    // Two cadences, because they answer two questions. At 130 ms a key the
    // renderer finishes one keystroke before the next arrives, so the number is
    // the cost of *one* - which is what a person typing feels. At 30 ms the
    // keys arrive faster than a 464 KB file can be laid out, the queue backs
    // up, and the number is how far behind the frame that carries the glyph
    // ends up. Both are reported; only the frame count is asserted.
    await place(win, 0)
    const paced = await typeAndMeasure(win, phrase, 130)
    await setValue(win, 'textarea[data-config-editor]', original)
    await sleep(400)
    await place(win, 0)
    const burst = await typeAndMeasure(win, phrase, 30)
    await setValue(win, 'textarea[data-config-editor]', original)
    await sleep(300)

    for (const out of [paced, burst]) {
      if (out.worstFrames !== 1 || out.neverArrived !== 0 || out.keystrokes !== phrase.length) {
        everyKeystrokeInOneFrame = false
      }
    }
    if (!opened) everyKeystrokeInOneFrame = false

    typed.push({
      file: size.name,
      opened,
      chars: original.length,
      keysSent: phrase.length,
      overlayDown: paced.samples.some((s) => s.plain === true),
      paced: {
        keystrokesMeasured: paced.keystrokes,
        neverArrived: paced.neverArrived,
        worstFrames: paced.worstFrames,
        p95ms: paced.p95ms,
        worstMs: paced.worstMs
      },
      burst: {
        keystrokesMeasured: burst.keystrokes,
        neverArrived: burst.neverArrived,
        worstFrames: burst.worstFrames,
        p95ms: burst.p95ms,
        worstMs: burst.worstMs
      }
    })
  }

  checks.push({
    id: 'HL-11',
    criterion: 'no invisible-keystroke window at any file size',
    title: 'Every keystroke was on screen at the very next frame, at every size measured',
    ok: everyKeystrokeInOneFrame,
    detail: { measured: typed },
    notes: [
      '`worstFrames: 1` is the criterion. The instrument counts frames rather than',
      'milliseconds because "inside one frame" is a discrete claim, and the first',
      'requestAnimationFrame after an input event is up to 16.7 ms away for reasons that',
      'have nothing to do with this code.',
      '`keystrokesMeasured` has to equal `keysSent`. A sample that never resolves is left',
      'out of the set entirely, and a maximum over a set that is missing its worst member',
      'is the PROF-4 shape: a number that looks like a measurement of nothing going wrong.',
      'The milliseconds are a *measurement*, reported rather than asserted. `paced` is what',
      'a person typing feels; `burst` is 33 keys a second, where the renderer falls behind',
      'on a large file and the number is how far. The honest cost of a full-file underlay',
      'is in that gap: a text layer holding the whole file is laid out again on every',
      'keystroke. Nothing is ever late relative to a frame; the frame itself gets longer.'
    ]
  })

  // ---- colours arrive, scrolling holds, a paste does not block ------------
  if (!(await openForEditing(win, '.claude/skills/big/SKILL.md', 'edit'))) {
    checks.push(
      unopened('HL-12', 'colours arrive; windowing; scrolling', 'The big fixture opens', await consoleState(win))
    )
    return checks
  }
  await sleep(1200)
  const bigOriginal = await editorValue(win)

  await place(win, 60)
  /*
   * Timed in the renderer, frame by frame, rather than by polling from here.
   *
   * The claim is "colours arrive within about a quarter second of typing
   * stopping", and a poll from the main process with a 120 ms interval cannot
   * measure a 250 ms budget - it reports the poll granularity as much as the
   * thing. This watcher waits for the colour to go *stale* first, which is the
   * moment the keystroke landed, and then times until it comes back.
   */
  await js<boolean>(
    win,
    `(() => {
      window.__hlColour = null;
      const root = document.querySelector('[data-editor]');
      if (!root) return false;
      let wentStale = null;
      const tick = () => {
        const on = root.dataset.editorColoured === 'true';
        if (wentStale === null) { if (!on) wentStale = performance.now(); }
        else if (on) { window.__hlColour = performance.now() - wentStale; return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    })()`
  )
  await sendKey(win, 'z')
  const coloured = await pollJs(win, `window.__hlColour !== null`, 5_000)
  const colourMs = round(await js<number>(win, `window.__hlColour ?? -1`))

  const scroll = await js<{
    frames: number
    p50: number
    p95: number
    worst: number
    over32: number
    over50: number
    rendered: number
    lines: number
    windowed: string | null
  }>(
    win,
    `(() => new Promise((resolve) => {
      const ta = document.querySelector('textarea[data-config-editor]');
      ta.scrollTop = 0;
      const intervals = [];
      let last = performance.now();
      let n = 0;
      const step = () => {
        const now = performance.now();
        intervals.push(now - last);
        last = now;
        ta.scrollTop += 220;
        ta.dispatchEvent(new Event('scroll', { bubbles: true }));
        n += 1;
        if (n < 140 && ta.scrollTop + ta.clientHeight < ta.scrollHeight) requestAnimationFrame(step);
        else {
          const rest = intervals.slice(1).sort((a, b) => a - b);
          const at = (p) => rest[Math.min(rest.length - 1, Math.floor((p / 100) * rest.length))] ?? 0;
          const root = document.querySelector('[data-editor]');
          resolve({ frames: rest.length, p50: at(50), p95: at(95), worst: Math.max(...rest, 0),
            over32: rest.filter((x) => x > 32).length, over50: rest.filter((x) => x > 50).length,
            rendered: Number(root.dataset.editorRendered), lines: Number(root.dataset.editorLines),
            windowed: root.dataset.editorWindowed });
        }
      };
      requestAnimationFrame(step);
    }))()`
  )

  // A paste, then a keystroke on its heels. The text has to land instantly and
  // the key after it has to be in the very next frame.
  await js<boolean>(win, INSTRUMENT)
  const pasteStarted = Date.now()
  await setValue(win, 'textarea[data-config-editor]', `${bigOriginal}\n${bigOriginal}`)
  const pasteMs = Date.now() - pasteStarted
  await place(win, 0)
  await sendKey(win, 'q', [], 30)
  await sleep(200)
  const afterPaste = await js<Sample[]>(win, `window.__hlLat.samples`)
  await setValue(win, 'textarea[data-config-editor]', bigOriginal)
  await sleep(400)

  const keyAfterPaste = afterPaste[afterPaste.length - 1]

  checks.push({
    id: 'HL-12',
    criterion: 'colours arrive; visible-window rendering; scrolling holds; a paste is off the typing path',
    title: 'Colour lands within a quarter second, the underlay renders a window, and a paste blocks nothing',
    ok:
      coloured &&
      colourMs > 0 &&
      // The target is ~250 ms - the 110 ms debounce plus a round trip - and the
      // gate is looser than the target on purpose. This is measured on a
      // machine that is also running the app, and a check that goes red on a
      // busy afternoon teaches people to wave it past. The number is reported
      // either way, and it is the number to read rather than this bound.
      colourMs < 700 &&
      scroll.windowed === 'true' &&
      scroll.rendered < scroll.lines &&
      scroll.over50 <= 2 &&
      keyAfterPaste !== undefined &&
      keyAfterPaste.frames === 1,
    detail: {
      colourMs,
      colourArrived: coloured,
      scroll: {
        ...scroll,
        p50: round(scroll.p50),
        p95: round(scroll.p95),
        worst: round(scroll.worst)
      },
      paste: { bytes: bigOriginal.length * 2, setValueMs: pasteMs, keyAfterPaste }
    },
    notes: [
      'The 250 ms in the task is the debounce plus the round trip; the assertion is looser',
      'than the target on purpose, because it is measured on a machine that is also',
      'running the app, and a check that fails on a busy afternoon teaches people to',
      'ignore it. The number is reported either way.',
      '`rendered < lines` is the windowing: the coloured layer holds a slice, and the',
      'mirror underneath it still holds the whole file, which is what places the slice.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// HL-13: past the ceiling
// ---------------------------------------------------------------------------

async function degradeChecks(ctx: CheckContext, _fixtures: Fixtures): Promise<Check[]> {
  const { win } = ctx
  if (!(await openForEditing(win, '.claude/skills/huge/SKILL.md', 'edit'))) {
    return [
      unopened('HL-13', 'degrades above the size ceiling', 'The huge fixture opens', await consoleState(win))
    ]
  }
  await sleep(1500)

  const state = await js<{
    tooLarge: string | null
    highlighted: string | null
    plain: string | null
    footer: string | null
    footerTitle: string | null
    colouredSpans: number
    renderedLines: number
    mirrorChars: number
    gutterVisible: boolean
    textareaPaints: boolean
    chars: number
  }>(
    win,
    `(() => {
      const root = document.querySelector('[data-editor]');
      const hl = document.querySelector('pre[data-editor-highlight]');
      const ta = document.querySelector('textarea[data-config-editor]');
      const mirror = document.querySelector('pre[data-editor-underlay]');
      const gutter = document.querySelector('[data-editor-gutter]');
      const degraded = document.querySelector('[data-editor-degraded]');
      const colour = getComputedStyle(ta).color;
      return {
        tooLarge: root?.dataset.editorTooLarge ?? null,
        highlighted: root?.dataset.editorHighlighted ?? null,
        plain: root?.dataset.editorPlain ?? null,
        footer: degraded?.textContent ?? null,
        footerTitle: degraded?.getAttribute('title') ?? null,
        colouredSpans: hl ? hl.querySelectorAll('span[style*="--shiki"]').length : -1,
        renderedLines: hl ? hl.querySelectorAll('span.line').length : -1,
        mirrorChars: mirror ? mirror.textContent.length : -1,
        gutterVisible: gutter ? getComputedStyle(gutter).display !== 'none' : false,
        // The glyphs have to come from somewhere, and with the overlay gone it
        // is the textarea itself - which means its text must not be
        // transparent. That is the one thing this branch could get wrong and
        // still look plausible in every other assertion.
        textareaPaints: colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent',
        chars: ta.value.length
      };
    })()`
  )

  const original = await editorValue(win)
  await place(win, 0)
  await sendKey(win, 'x')
  await sleep(250)
  const roundTrip = await js<{ head: string }>(
    win,
    `(() => { const ta = document.querySelector('textarea[data-config-editor]');
      return { head: ta.value.slice(0, 3) }; })()`
  )
  await setValue(win, 'textarea[data-config-editor]', original)
  await sleep(300)

  return [
    {
      id: 'HL-13',
      criterion: 'everything degrades above the size ceiling rather than getting slow',
      title: 'Past the ceiling the overlay is gone, the textarea paints, and the footer says what is off',
      ok:
        state.tooLarge === 'true' &&
        state.highlighted === 'false' &&
        state.plain === 'true' &&
        state.colouredSpans === 0 &&
        state.renderedLines === 0 &&
        state.mirrorChars === 0 &&
        !state.gutterVisible &&
        state.textareaPaints &&
        state.footer !== null &&
        state.footerTitle !== null &&
        roundTrip.head.startsWith('x'),
      detail: { ...state, roundTrip, bytes: original.length },
      notes: [
        'The ceiling is the read views’ own, so a file that reads as plain text does not',
        'suddenly light up when you press Edit.',
        'What degrades is the whole overlay rather than only the colour, and that came out',
        'of this check rather than out of a design: with the underlay up, a keystroke into',
        'this fixture took 1,920 ms to reach the frame that painted it, because a layer',
        'holding 1.29 MB of wrapped prose is laid out again on every one. "Degrades rather',
        'than gets slow" is what the criterion says, so above the ceiling there is no',
        'second layer at all - and the gutter and the match painting go with it, because',
        'both are measured off line boxes nothing is drawing any more.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// HL-14: the theme
// ---------------------------------------------------------------------------

async function themeChecks(
  ctx: CheckContext,
  shotDir: string,
  _fixtures: Fixtures
): Promise<Check[]> {
  const { win, services } = ctx
  const startedOn = services.settings.theme

  if (!(await openForEditing(win, '.claude/settings.local.json', 'source'))) {
    return [unopened('HL-14', 'a theme flip needs no re-highlight', 'The theme fixture opens', await consoleState(win))]
  }
  await pollJs(win, `document.querySelector('[data-editor]')?.dataset.editorColoured === 'true'`, 15_000)

  /** One token's painted colour, in the editor and in a read view beside it. */
  const sample = `() => {
    const span = document.querySelector('pre[data-editor-highlight] span[style*="--shiki"]');
    return {
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      editor: span ? getComputedStyle(span).color : null,
      inlineLight: span ? span.style.getPropertyValue('--shiki-light') : null,
      inlineDark: span ? span.style.getPropertyValue('--shiki-dark') : null
    };
  }`
  type Sampled = {
    theme: string
    editor: string | null
    inlineLight: string | null
    inlineDark: string | null
  }

  const first = await js<Sampled>(win, `(${sample})()`)
  const firstShot = await screenshot(win, shotDir, `editor-theme-${first.theme}.png`)

  const flipped = first.theme === 'dark' ? 'light' : 'dark'
  await js<unknown>(
    win,
    `window.helm.invoke('settings:write', { theme: ${JSON.stringify(flipped)} })`
  )
  await sleep(700)
  const second = await js<Sampled>(win, `(${sample})()`)
  const secondShot = await screenshot(win, shotDir, `editor-theme-${second.theme}.png`)

  await js<unknown>(
    win,
    `window.helm.invoke('settings:write', { theme: ${JSON.stringify(startedOn)} })`
  )
  await sleep(500)
  const back = await js<Sampled>(win, `(${sample})()`)

  return [
    {
      id: 'HL-14',
      criterion: 'a theme flip needs no re-highlight; `defaultColor` unchanged',
      title: 'The underlay recolours from the properties it was already carrying',
      ok:
        first.editor !== null &&
        second.editor !== null &&
        first.theme !== second.theme &&
        first.editor !== second.editor &&
        back.editor === first.editor &&
        first.inlineLight !== '' &&
        first.inlineDark !== '',
      detail: { first, second, back, screenshots: [firstShot.file, secondShot.file] },
      notes: [
        'Both themes are in the markup as `--shiki-light` and `--shiki-dark`, which is what',
        '`defaultColor: false` produces and what contentcheck.ts’s CONT probe requires of the',
        'read views. Asserting the inline properties are present as well as the computed',
        'colour is what distinguishes "the stylesheet picked a side" from "something else',
        'happened to change the colour".',
        'The theme is put back before this returns; the run borrows a copy of the database,',
        'but the window is the real one.'
      ]
    }
  ]
}

import { net, type BrowserWindow, type WebFrameMain } from 'electron'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import {
  CURATED_SKIPPED_DIRS,
  countConfigSnapshots,
  createProfile,
  deleteProfile,
  findProfileByName,
  type ContentFile,
  type Profile
} from '@helm/core'
import { screenshot, sleep, waitFor } from './bridge'
import { artifactConsoleEntries, artifactRoots, clearArtifactConsole } from './content'
import type { Check } from './fidelity'
import type { CheckContext } from './sessionscheck'

/**
 * The content-viewer criteria, driven through the app the way a reader reaches
 * it.
 *
 * The discipline is history-check's and config-check's: nothing is asserted
 * against Helm's own answer alone. Every count is checked against a second
 * read written in this file, and the second read shares no code with the thing
 * it checks - a regex
 * scan of the source beside the remark pipeline, a `readdirSync` walk beside
 * the tree scanner, a hand-built name index beside the wikilink resolver, a
 * plain `indexOf` loop beside the search. A parser agreeing with itself proves
 * nothing.
 *
 * Two criteria are *measurements* rather than assertions, and are reported as
 * numbers whether or not they pass:
 *
 *   - Search latency, as p50 and p95 over the real corpus, measured in the
 *     renderer so the IPC round trip is inside the number.
 *   - Scroll smoothness on a long document, as frame intervals recorded by
 *     `requestAnimationFrame` while the pane is actually scrolling.
 *
 * And one criterion is about a *sandbox*, which cannot be checked by trusting
 * the flags that were passed to build it. The artifact frame is interrogated
 * from inside - `typeof require`, the origin it ended up with, whether a remote
 * fetch resolves - through `WebFrameMain.executeJavaScript`, which reaches an
 * opaque-origin frame that the window hosting it cannot touch.
 *
 * `pnpm content-check` -> helm-data/content-report.json
 */

const PROFILE_NAME = 'Content fixtures'
/** The fixture *project*, which has to be a second scope for the tree probes. */
const PROJECT_PROFILE_NAME = 'Content fixture project'

const GROUPS = ['browse', 'scope', 'render', 'links', 'artifact', 'search', 'edit', 'scroll'] as const
type Group = (typeof GROUPS)[number]

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

const HTML = /\.(html|htm)$/i

const SKIP = new Set([
  'repos',
  'node_modules',
  '.git',
  'out',
  'dist',
  'build',
  'coverage',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  '.turbo',
  '.vite',
  'bin',
  'obj',
  'vendor',
  'site-packages',
  '.pytest_cache',
  '.mypy_cache',
  '.idea',
  '.vs',
  '.vscode',
  'env',
  '.svn',
  '.hg'
])

/**
 * Every file under a directory, walked naively.
 *
 * **No extension filter**, and that is the change the scope split forced. This
 * reader used to keep only files ending in a content extension, because the
 * pane did; the pane now lists every file inside a root it offers, so a reader
 * that still filtered would report a hundred "listed but not on disk" rows
 * against a pane that was right.
 *
 * The absence of the filter is what makes this second read strong. "Every file
 * under this directory" needs no list of extensions to be maintained beside the
 * one in `roots.ts`, so the two cannot drift - the only way for them to
 * disagree is for one of them to be wrong about the disk.
 */
function walkEveryFile(dir: string, base: string, into: string[], depth = 0): void {
  if (depth > 7) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.isSymbolicLink()) continue
      if (SKIP.has(entry.name.toLowerCase())) continue
      walkEveryFile(path, base, into, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    into.push(relative(base, path).split(sep).join('/'))
  }
}

/**
 * What a markdown source contains, counted with regular expressions.
 *
 * Fenced regions are removed first and inline code spans after, because a note
 * about markdown - and this vault has several - contains `| a | b |` and
 * `[[wikilink]]` inside code fences that are not a table and not a link. The
 * pipeline reaches the same conclusion through an mdast walk; the point of this
 * one is that it gets there by a different road.
 */
interface SourceCounts {
  tables: number
  taskItems: number
  taskItemsChecked: number
  codeBlocks: number
  /**
   * Whether `codeBlocks` is a number this reader is willing to stand behind.
   *
   * False where a fence opens four or more columns in. CommonMark measures a
   * block's indentation *relative to whatever contains it*, so at that depth
   * the same three backticks are a nested fence inside a list item or a literal
   * line inside an indented code block depending on container state a line
   * scanner does not track - and deciding it would mean writing a second
   * CommonMark implementation, which is the one thing an independent second
   * reader must not be. So it declines instead, and CONT-2 reports how often.
   *
   * Measured over 538 markdown files outside this vault: every other count
   * agreed with the renderer exactly, and 15 files - 2.8% - declined this one.
   */
  codeBlocksClaimed: boolean
  wikilinks: number
  headings: number
  frontmatterKeys: string[]
}

/**
 * A GFM row's cells: one optional leading and trailing pipe dropped, then split
 * on the pipes that are not escaped.
 *
 * Written out because "does this line look like a table" cannot be asked of a
 * whole line. `| `test_connection` | `GET v1/` | - |` is a body row, and with
 * its code spans taken out it reads `|  |  | - |` - which is nothing but pipes,
 * spaces and a dash, and matched the delimiter pattern this check used to use.
 * Two of those in one note counted as two extra tables, and CONT-2 called the
 * renderer wrong for painting the one table that is actually there.
 *
 * By cells the answer is unambiguous: a delimiter cell may not be empty, and
 * that alone is the whole of the difference.
 */
function rowCells(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return []
  const inner = trimmed.replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim())
}

function countSource(source: string): SourceCounts {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''))

  // Frontmatter, split off by hand.
  const frontmatterKeys: string[] = []
  let start = 0
  if ((lines[0] ?? '').trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if ((lines[i] ?? '').trim() === '---' || (lines[i] ?? '').trim() === '...') {
        start = i + 1
        break
      }
    }
    for (const line of lines.slice(1, Math.max(start - 1, 1))) {
      const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(line)
      if (match?.[1] !== undefined) frontmatterKeys.push(match[1])
    }
  }

  /**
   * A blockquote's marker is not part of the line it carries.
   *
   * GFM renders a table, a heading and a task item inside a `>` quote exactly
   * as it renders them outside one, and this reader used to see `> |---|---|`
   * as prose - so a quoted table was invisible to it and CONT-2 called the
   * renderer wrong for painting one. Found on a corpus outside this vault; two
   * files there carry a table inside a quote.
   */
  const body = lines.slice(start).map((line) => line.replace(/^(\s*>)+\s?/, ''))

  /**
   * Fenced regions out, remembering how many there were.
   *
   * The fence's *length* is tracked, not just its character. CommonMark says a
   * closing fence must be at least as long as the one that opened it, and this
   * vault contains a four-backtick block with three-backtick blocks inside it -
   * a scanner that closed on the first ``` ends the outer block early and then
   * miscounts everything after it. That is not a hypothetical: it is what this
   * check disagreed with the renderer about, and the renderer was right.
   *
   * The opener is matched at **any** indentation rather than CommonMark's three
   * columns, because a fence nested in a list item is indented to that item's
   * content column and is still a fence. Reading those as prose is worse than
   * over-reading them: their contents leak into `prose`, and a `[[…]]` in a
   * shell snippet then counts as a wikilink that the renderer never painted.
   * Where that over-reading might itself be wrong, `codeBlocksClaimed` says so.
   */
  const kept: string[] = []
  let fence: string | null = null
  let fenceLength = 0
  let fenceIndent = 0
  let codeBlocks = 0
  let codeBlocksClaimed = true
  for (const line of body) {
    const opener = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence === null && opener?.[2] !== undefined) {
      // A backtick fence's info string may not contain a backtick.
      if (opener[2][0] === '`' && (opener[3] ?? '').includes('`')) {
        kept.push(line)
        continue
      }
      fence = opener[2][0] ?? '`'
      fenceLength = opener[2].length
      fenceIndent = (opener[1] ?? '').length
      if (fenceIndent >= 4) codeBlocksClaimed = false
      codeBlocks++
      continue
    }
    if (fence !== null) {
      const closer = new RegExp(`^(\\s*)\\${fence}{${String(fenceLength)},}\\s*$`)
      const closed = closer.exec(line)
      if (closed && (closed[1] ?? '').length <= fenceIndent + 3) fence = null
      continue
    }
    kept.push(line)
  }
  // An indented code block is a code block too; the pipeline counts one for
  // each `<pre><code>` it emits.
  let indented = 0
  let inIndented = false
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i] ?? ''
    const blank = line.trim() === ''
    const isIndented = /^(\t| {4})/.test(line)
    const previousBlank = i === 0 || (kept[i - 1] ?? '').trim() === ''
    if (!inIndented && isIndented && previousBlank && !/^\s*[-*+]|^\s*\d+\./.test(line)) {
      inIndented = true
      indented++
    } else if (inIndented && !isIndented && !blank) {
      inIndented = false
    }
  }

  const prose = kept.map((line) => line.replace(/`[^`\n]*`/g, ''))

  let tables = 0
  for (let i = 1; i < prose.length; i++) {
    // A delimiter row under a header row is what makes a GFM table, and GFM
    // wants every cell of it to be dashes with optional colons - never empty -
    // and as many cells as the header above it.
    const cells = rowCells(prose[i] ?? '')
    if (cells.length === 0 || !cells.every((cell) => /^:?-+:?$/.test(cell))) continue
    if (rowCells(prose[i - 1] ?? '').length !== cells.length) continue
    tables++
    // Then past the body, so a row of literal dashes inside a table cannot be
    // read as the header of a second one.
    while (
      i + 1 < prose.length &&
      (prose[i + 1] ?? '').trim() !== '' &&
      (prose[i + 1] ?? '').includes('|')
    ) {
      i++
    }
  }

  let taskItems = 0
  let taskItemsChecked = 0
  for (const line of prose) {
    const match = /^\s*[-*+]\s+\[([ xX])\]/.exec(line)
    if (!match) continue
    taskItems++
    if ((match[1] ?? ' ').toLowerCase() === 'x') taskItemsChecked++
  }

  const wikilinks = (prose.join('\n').match(/(?<!!)\[\[[^\][\n]+\]\]/g) ?? []).length
  const headings = prose.filter((line) => /^#{1,6}\s+\S/.test(line)).length

  return {
    tables,
    taskItems,
    taskItemsChecked,
    codeBlocks: codeBlocks + indented,
    codeBlocksClaimed,
    wikilinks,
    headings,
    frontmatterKeys
  }
}

/** Every wikilink target in a file, by name, with no resolver involved. */
function wikilinkTargets(source: string): string[] {
  const withoutFences = source.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  const out: string[] = []
  for (const match of withoutFences.matchAll(/\[\[([^\][\n]+)\]\]/g)) {
    const raw = match[1] ?? ''
    const target = raw.split('|')[0]?.split('#')[0]?.trim() ?? ''
    if (target !== '') out.push(target)
  }
  return out
}

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

async function showViewer(win: BrowserWindow): Promise<boolean> {
  if (!(await click(win, '[data-tab="content"]'))) {
    await click(win, 'aside button[data-open-content]')
  }
  return pollJs(win, `document.querySelector('select[data-content-scope]')`, 20_000)
}

/**
 * Points the switcher at a scope, and refuses to continue if it did not move.
 *
 * It also puts the pane on the **curated** view, because every probe in this
 * file that opens a file does it by clicking a `[data-content-file]` row and
 * those rows exist in one of the two modes. That is not a detail: the fixture
 * harness reaches the switcher through a *profile*, which registers it as a
 * project, and a project defaults to the tree - so the artifact probes were
 * clicking for rows that were never going to be there and reporting
 * `opened: false` rather than anything about artifacts. The three probes that
 * are about the tree ask for it by name, immediately after this.
 */
async function selectScope(
  win: BrowserWindow,
  path: string,
  /** `keep` leaves the mode alone - for the one probe that is *about* the default. */
  mode: 'curated' | 'keep' = 'curated'
): Promise<void> {
  await setValue(win, 'select[data-content-scope]', path)
  await sleep(600)
  const landed = await js<string>(
    win,
    `document.querySelector('select[data-content-scope]')?.value ?? ''`
  )
  if (landed.toLowerCase() !== path.toLowerCase()) {
    throw new Error(
      `the content scope switcher has no option for ${path} - it is showing ${landed || '(nothing)'}`
    )
  }
  if (mode === 'curated') await click(win, '[data-content-view="curated"]')
  await pollJs(win, `document.querySelector('[data-content-status]')`, 10_000)
  await sleep(400)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  root: string
  notes: string
  bigNote: string
  /** A long, wide, indented source file - CONT-16 needs one to exist. */
  bigSource: string
  artifact: string
  hostile: string
  secret: string
  /** A repository the driver owns, for the tree view. Has a real `.gitignore`. */
  project: string
  /** Whether `git init` worked, so the gitignore claims can be believed. */
  projectIsRepo: boolean
}

/** ~20,000 words of prose, so the criterion can be measured as it is written. */
function buildLongNote(): string {
  const words = [
    'the',
    'report',
    'centre',
    'redesign',
    'measured',
    'against',
    'a',
    'session',
    'because',
    'prediction',
    'without',
    'evidence',
    'is',
    'decoration',
    'and',
    'the',
    'snapshot',
    'goes',
    'first'
  ]
  const lines: string[] = ['---', 'type: reference', 'date: 2026-08-10', 'tags: [helm, fixture, scroll]', '---', '', '# A long document', '']
  let count = 0
  let section = 0
  while (count < 20_000) {
    section++
    lines.push(`## Section ${String(section)}`, '')
    for (let p = 0; p < 6; p++) {
      const sentence: string[] = []
      for (let w = 0; w < 60; w++) sentence.push(words[(count + w) % words.length] ?? 'word')
      count += 60
      lines.push(`${sentence.join(' ')}.`, '')
    }
    lines.push('| measure | value | budget |', '| --- | --- | --- |', `| section | ${String(section)} | n/a |`, '')
    lines.push('```ts', `const section${String(section)}: number = ${String(section)}`, '```', '')
    count += 12
  }
  return lines.join('\n')
}

/**
 * A harness the driver owns, so the destructive checks are destructive to
 * nothing that matters.
 *
 * The one exception is the save round trip, which is run against a *real* note
 * in the user's vault as well - a criterion about preserving frontmatter is
 * worth very little if the only frontmatter it preserves was written by the
 * check that reads it back. That copy is backed up and hash-verified; see
 * `editChecks`.
 */
function buildFixtures(dataDir: string): Fixtures {
  const root = join(dataDir, 'content-fixtures')
  rmSync(root, { recursive: true, force: true })

  const notes = join(root, 'notes')
  mkdirSync(notes, { recursive: true })
  mkdirSync(join(root, 'context'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'lessons'), { recursive: true })
  writeFileSync(join(root, 'harness.yaml'), 'name: content-fixtures\n')
  writeFileSync(join(root, 'context', 'map.yaml'), 'repos: []\n')
  writeFileSync(join(root, 'docs', 'SPEC.md'), '# Fixture spec\n\nNothing to see.\n')

  writeFileSync(
    join(notes, 'alpha.md'),
    [
      '---',
      'type: journal',
      'date: 2026-08-10',
      'tags: [helm, fixture]',
      '---',
      '',
      '# Alpha',
      '',
      'A resolved link to [[beta]] and a broken one to [[never-written]].',
      'A tag: #helm-content-fixture and an alias [[beta|the other note]].',
      '',
      '## A table',
      '',
      '| measure | value |',
      '| --- | --- |',
      '| one | 1 |',
      '| two | 2 |',
      '',
      '## A task list',
      '',
      '- [x] done',
      '- [ ] not done',
      '- [ ] also not done',
      '',
      '## Code',
      '',
      '```ts',
      'const answer: number = 42',
      '```',
      '',
      '```powershell',
      'Get-ChildItem -Recurse',
      '```',
      '',
      '> [!warning] A callout',
      '> With a body.',
      '',
      'Inline `[[not a link]]` must stay literal.',
      ''
    ].join('\n')
  )
  writeFileSync(
    join(notes, 'beta.md'),
    ['---', 'type: reference', 'date: 2026-08-09', 'tags: [helm]', '---', '', '# Beta', '', 'HELMM6UNIQUETOKEN lives here, once.', ''].join('\n')
  )

  const bigNote = join(notes, 'long-document.md')
  writeFileSync(bigNote, buildLongNote())

  /**
   * A source file long enough to scroll and wide enough to wrap, for CONT-16.
   *
   * Planted rather than found. The scope a check runs in is not guaranteed to
   * hold a long source file, and CONT-16's first run said exactly that - it
   * failed with "none found", which is honest and is not the failure it exists
   * to report. Indented deliberately, so the wrapped half of that probe has
   * continuation rows with something to hang from.
   */
  const bigSource = join(root, 'tools', 'fixture-long-source.ts')
  mkdirSync(dirname(bigSource), { recursive: true })
  writeFileSync(
    bigSource,
    Array.from({ length: 900 }, (_, i) => {
      const depth = '  '.repeat((i % 4) + 1)
      return `${depth}export const entry${String(i)} = { id: ${String(i)}, note: 'a deliberately long line so this file is wider than any pane it is read in, which is what gives the wrapped half of CONT-16 something to measure', tail: ${String(i)} }`
    }).join('\n')
  )

  // A benign artifact: self-contained, silent, and it says so in the DOM so the
  // frame check has something to read back.
  const artifact = join(root, 'lessons', 'artifact.html')
  writeFileSync(
    artifact,
    `<!doctype html><html><head><meta charset="utf-8"><title>Fixture artifact</title>
<style>body{font:14px/1.5 system-ui;margin:2rem;color:#222}h1{font-size:1.3rem}</style></head>
<body><h1 id="heading">HELMM6ARTIFACT</h1><p id="out">pending</p>
<p id="links">A resolved link to [[beta]] and a broken one to [[never-written]].</p>
<script>document.getElementById('out').textContent = 'ran'</script></body></html>
`
  )

  // A hostile one: everything an artifact must not be able to do, attempted.
  const hostile = join(root, 'lessons', 'hostile.html')
  writeFileSync(
    hostile,
    `<!doctype html><html><head><meta charset="utf-8"><title>Hostile artifact</title></head>
<body><h1>HELMM6HOSTILE</h1>
<img id="remote" src="https://example.com/should-not-load.png" alt="">
<script>
  window.__helmProbe = {
    require: typeof require,
    process: typeof process,
    module: typeof module,
    helm: typeof window.helm,
    origin: String(window.origin),
    isTop: window.top === window
  }
  window.__helmFetch = fetch('https://example.com/').then(() => 'resolved').catch((e) => 'rejected: ' + e.name)
  try { window.__helmTop = String(window.top.location.href) } catch (e) { window.__helmTop = 'blocked: ' + e.name }
</script></body></html>
`
  )

  const secret = join(root, 'secret-outside-the-artifact.txt')
  writeFileSync(secret, 'HELMM6SECRETTHATMUSTNOTBESERVED\n')

  /**
   * The pair the discovery rule is drawn by.
   *
   * `tools/` holds nothing but scripts and must become a root; `screenshots/`
   * holds nothing but bytes and must not. Planting only the first would pass a
   * rule that offered every directory on the disk, so both are here and CONT-12
   * asserts both directions.
   */
  mkdirSync(join(root, 'tools'), { recursive: true })
  writeFileSync(join(root, 'tools', 'rep-payload.py'), '# Rebuild the payload\nimport json, sys\n')
  writeFileSync(join(root, 'tools', 'sweep.ps1'), 'Get-ChildItem -Recurse | Measure-Object\n')
  mkdirSync(join(root, 'screenshots'), { recursive: true })
  writeFileSync(join(root, 'screenshots', 'one.png'), 'not a real png, and that is fine')

  // A binary inside a root that *is* offered. Listed, greyed, not hidden - the
  // other half of "the kind decides how it opens, not whether it is shown".
  writeFileSync(join(notes, 'diagram.png'), 'not a real png either')

  /**
   * A repository the driver owns, for the tree view.
   *
   * A real `git init` and a real `.gitignore`, because the claim under test is
   * that *the repository* decides what is ignored. `secrets/` is in no built-in
   * list, so a pass here cannot be Helm's fallback answering under another
   * name - CONT-14 asserts the fallback disagrees before believing the rest.
   */
  const project = join(dataDir, 'content-fixture-project')
  rmSync(project, { recursive: true, force: true })
  mkdirSync(join(project, 'src', 'util'), { recursive: true })
  mkdirSync(join(project, 'node_modules', 'left-pad'), { recursive: true })
  mkdirSync(join(project, 'dist'), { recursive: true })
  mkdirSync(join(project, 'secrets'), { recursive: true })
  mkdirSync(join(project, 'assets'), { recursive: true })
  // An empty named root, for the project-in-curated cross case: it must stay on
  // the list and say it is empty.
  mkdirSync(join(project, 'docs'), { recursive: true })
  writeFileSync(join(project, '.gitignore'), 'node_modules/\ndist/\nsecrets/\n')
  writeFileSync(join(project, 'README.md'), '# Fixture project\n\nHELMM6PROJECT lives here.\n')
  writeFileSync(join(project, 'package.json'), '{ "name": "content-fixture-project" }\n')
  writeFileSync(join(project, 'LICENSE'), 'All rights reserved.\n')
  writeFileSync(join(project, 'src', 'index.ts'), 'export const answer = 42\n')
  writeFileSync(join(project, 'src', 'util', 'helpers.ts'), 'export const noop = (): void => {}\n')
  writeFileSync(join(project, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(project, 'dist', 'bundle.js'), 'console.log(1)\n')
  writeFileSync(join(project, 'secrets', 'token.txt'), 'not a real secret\n')
  writeFileSync(join(project, 'assets', 'logo.png'), 'not a real png')

  const git = spawnSync('git', ['init', '-q'], { cwd: project, windowsHide: true })
  const projectIsRepo = git.error === undefined && git.status === 0

  return { root, notes, bigNote, bigSource, artifact, hostile, secret, project, projectIsRepo }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[at] ?? 0
}

const round = (value: number): number => Math.round(value * 100) / 100

// ---------------------------------------------------------------------------

export async function runContentChecks(
  ctx: CheckContext,
  shotDir: string,
  dataDir: string,
  only?: readonly string[]
): Promise<Check[]> {
  const wanted = new Set<string>(only && only.length > 0 ? only : GROUPS)
  const checks: Check[] = []
  const { win, services } = ctx

  /**
   * Everything the window logged during the run.
   *
   * Two buckets, because they answer different questions: the artifact's own
   * console is criterion 3, and the app's is "did rendering a hundred real
   * notes throw anywhere". Both are collected from the same event, separated by
   * the source URL.
   */
  const appConsole: Array<{ level: string; message: string; source: string }> = []
  win.webContents.on('console-message', (event) => {
    const source = event.sourceId
    if (source.startsWith('helm-content:')) return
    if (event.level !== 'error' && event.level !== 'warning') return
    appConsole.push({ level: event.level, message: event.message, source })
  })

  /**
   * The first scan has to have landed before anything asks which project is the
   * harness. It is kicked off when the renderer reports ready and this driver
   * starts in the same turn, so without this the answer is "there are no
   * projects" - which is not a failure, it is a race.
   */
  await waitFor(() => ctx.services.lastScan !== null, 120_000)

  const fixtures = buildFixtures(dataDir)

  // The fixture harness is not inside any scanned root, so it becomes a scope
  // the way a user's out-of-tree folder would: a profile points at it.
  const asProfile = (name: string, root: string): Profile => {
    const stale = findProfileByName(services.store, name)
    if (stale) deleteProfile(services.store, stale.id)
    return createProfile(services.store, {
      name,
      root,
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
  }
  const profile = asProfile(PROFILE_NAME, fixtures.root)
  const projectProfile = asProfile(PROJECT_PROFILE_NAME, fixtures.project)

  const harness = (services.lastScan?.projects ?? []).find((p) => p.kind === 'harness')
  // A real project scope, for the half of CONT-12 that is about what a *kind*
  // decides. Found by kind rather than by name, so it is whatever this machine
  // has rather than something written down here.
  const realProject = (services.lastScan?.projects ?? []).find((p) => p.kind !== 'harness')

  const opened = await showViewer(win)
  await click(win, 'button[data-content-refresh]')
  await sleep(600)
  const offersFixture = await pollJs(
    win,
    `[...document.querySelectorAll('select[data-content-scope] option')]
       .some((o) => o.value.toLowerCase() === ${JSON.stringify(fixtures.root.toLowerCase())})`,
    20_000
  )

  checks.push({
    id: 'CONT-0',
    criterion: 'setup',
    title: 'The viewer opens, finds the dev harness, and offers the fixture harness as a scope',
    ok: opened && offersFixture && harness !== undefined && existsSync(fixtures.bigNote),
    detail: {
      harness: harness?.path ?? null,
      fixtures: fixtures.root,
      fixtureProject: fixtures.project,
      fixtureProjectIsRepo: fixtures.projectIsRepo,
      profileId: profile.id,
      projectProfileId: projectProfile.id,
      offeredInTheSwitcher: offersFixture
    },
    notes: [
      'The user’s harness is the corpus criterion 1 is about; the fixture harness is where',
      'anything destructive happens. Both are reached through the switcher.'
    ]
  })

  const group = async (name: Group, run: () => Promise<Check[]>): Promise<void> => {
    if (!wanted.has(name)) return
    try {
      checks.push(...(await run()))
    } catch (err) {
      checks.push({
        id: `CONT-${name.toUpperCase()}-THREW`,
        criterion: name,
        title: `The ${name} group threw before it could assert anything`,
        ok: false,
        detail: { error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) },
        notes: ['The groups after this one still ran; this is one group’s failure, not the run’s.']
      })
    }
  }

  try {
    await group('scope', async () => [
      ...(harness
        ? await modeChecks(ctx, shotDir, harness.path, realProject?.path ?? null, fixtures)
        : []),
      ...(await curationChecks(ctx, fixtures)),
      ...(await treeChecks(ctx, shotDir, fixtures))
    ])
    if (harness) {
      await group('browse', () => browseChecks(ctx, shotDir, harness.path))
      await group('render', () => renderChecks(ctx, shotDir, harness.path, appConsole))
      await group('links', () => linkChecks(ctx, shotDir, harness.path, fixtures))
      await group('search', () => searchChecks(ctx, harness.path))
      await group('edit', () => editChecks(ctx, shotDir, harness.path, dataDir))
      await group('scroll', () => scrollChecks(ctx, shotDir, harness.path, fixtures))
    } else {
      checks.push({
        // audit: optional - the branch for a machine with no harness vault, so
        // a healthy run on one that has a vault does not produce it.
        id: 'CONT-NO-HARNESS',
        criterion: 'setup',
        title: 'Discovery found no harness, so the criteria about the real vault could not run',
        ok: false,
        detail: { projects: (services.lastScan?.projects ?? []).map((p) => p.name) },
        notes: ['Add ~/.harness/dev as a scan root and re-run.']
      })
    }
    await group('artifact', () => artifactChecks(ctx, shotDir, fixtures, harness?.path ?? null))
  } finally {
    for (const name of [PROFILE_NAME, PROJECT_PROFILE_NAME]) {
      const made = findProfileByName(services.store, name)
      if (made) deleteProfile(services.store, made.id)
    }
  }

  return checks
}

// ---------------------------------------------------------------------------
// CONT-1: the file browser
// ---------------------------------------------------------------------------

async function browseChecks(ctx: CheckContext, shotDir: string, harnessPath: string): Promise<Check[]> {
  const { win, content } = ctx

  const tree = content.tree(harnessPath, true)

  /**
   * What the pane's own roots say should be on the list.
   *
   * The comparison is now in two halves, because the pane makes two claims and
   * they fail differently. **Which directories are offered** is curation, and
   * it is asserted against a fixture the driver planted in `CONT-12`, where the
   * answer is known. **Which files are inside an offered one** is not a
   * judgement at all - it is every file - and that is what this compares, by
   * walking exactly the directories the pane named and keeping everything.
   *
   * So a pane that offered the wrong directories fails CONT-12, and a pane that
   * offered the right ones and then hid a file inside them fails here. The old
   * single comparison could not tell those apart, and its filter meant it could
   * not see the second one at all.
   */
  const truth = new Set<string>()
  for (const root of tree.roots) {
    if (root.relPath === '') {
      // The scope's own top-level files, which are not recursive.
      for (const entry of readdirSync(root.path, { withFileTypes: true })) {
        if (entry.isFile()) truth.add(entry.name.toLowerCase())
      }
      continue
    }
    const found: string[] = []
    walkEveryFile(root.path, harnessPath, found)
    for (const rel of found) truth.add(rel.toLowerCase())
  }

  const fromPane = new Set(tree.files.map((file) => file.relPath.toLowerCase()))
  const missing = [...truth].filter((rel) => !fromPane.has(rel))
  const extra = [...fromPane].filter((rel) => !truth.has(rel))

  await selectScope(win, harnessPath)
  await click(win, '[data-content-view="curated"]')
  await sleep(500)
  const painted = await js<Array<{ relPath: string; kind: string }>>(
    win,
    `[...document.querySelectorAll('button[data-content-file]')].map((el) => ({
      relPath: el.dataset.contentFile, kind: el.dataset.contentKind }))`
  )
  const shot = await screenshot(win, shotDir, 'content-browse.png')

  const named = ['notes', 'context', '.claude/skills', 'docs']
  const rootRels = tree.roots.map((root) => root.relPath)
  const namedPresent = named.filter((rel) => rootRels.includes(rel))

  // The walk has to have found something to compare, or "no disagreements" is
  // what an empty set reports too.
  const discriminating = truth.size > 20

  return [
    {
      id: 'CONT-1',
      criterion: 'File browser scoped to the selected project/harness: notes/, context/, .claude/skills/, docs/',
      title: 'Every file inside an offered root is listed, matched against an independent walk',
      ok:
        discriminating &&
        missing.length === 0 &&
        extra.length === 0 &&
        namedPresent.length === 4 &&
        painted.length === tree.files.length &&
        painted.some((row) => row.kind === 'markdown') &&
        painted.some((row) => row.kind === 'html'),
      detail: {
        scope: harnessPath,
        pane: tree.files.length,
        independentWalk: truth.size,
        missingFromThePane: missing.slice(0, 20),
        listedButNotOnDisk: extra.slice(0, 20),
        roots: tree.roots.map(
          (root) => `${root.relPath || '(scope root)'}=${String(root.files)} ${root.offer}`
        ),
        namedRootsFound: namedPresent,
        kindsOnScreen: [...new Set(painted.map((row) => row.kind))].sort(),
        paintedRows: painted.length,
        walkMs: tree.tookMs,
        screenshot: shot.file
      },
      notes: [
        'The second read is a plain readdirSync recursion in contentcheck.ts over the directories',
        'the pane named, with no extension filter of any kind - so it cannot drift from the kind',
        'table in roots.ts, and the only way to disagree is to be wrong about the disk.',
        'The four named roots are asserted by name because the criterion names them.',
        'Which directories are offered is CONT-12’s claim, against a fixture with a known answer.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// CONT-12 / CONT-13 / CONT-14: the scope split
// ---------------------------------------------------------------------------

/**
 * A screenshot, or the reason there is not one.
 *
 * `capturePage` goes through Chromium's compositor and can fail for reasons
 * that have nothing to do with the pane - on this machine, several Electron
 * apps sharing a GPU is enough, and it rejects with a bare `UnknownVizError`
 * and no stack. That took a whole group's assertions down with it, which is the
 * wrong trade: the PNG is evidence for a person to look at, not a step in any
 * claim these probes make. A missing one is recorded and the assertions stand.
 */
async function tryShot(
  win: BrowserWindow,
  dir: string,
  name: string
): Promise<{ file: string | null; error: string | null }> {
  try {
    const shot = await screenshot(win, dir, name)
    return { file: shot.file, error: null }
  } catch (err) {
    return { file: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** What the header's mode control and its caption are saying, right now. */
async function readMode(win: BrowserWindow): Promise<{
  view: string
  caption: string
  count: string
}> {
  return js(
    win,
    `(() => {
      const on = [...document.querySelectorAll('[data-content-view]')]
        .find((el) => el.getAttribute('aria-pressed') === 'true');
      return {
        view: on ? on.dataset.contentView : '',
        caption: (document.querySelector('[data-content-view-rule]')?.textContent ?? '').trim(),
        count: (document.querySelector('[data-content-count]')?.textContent ?? '').trim()
      }
    })()`
  )
}

/**
 * CONT-12: the scope kind picks the default, and nothing else.
 *
 * Two claims that fail differently. The **default** is read off the real
 * harness and a real project, because "kind picks it" is a claim about
 * discovery's own answer for the kind. The **cross case** is exercised on the
 * driver's own fixtures - the one the mock never draws, where every frame is
 * harness+Curated or project+Tree and switching the mode switches the scope
 * with it.
 */
async function modeChecks(
  ctx: CheckContext,
  shotDir: string,
  harnessPath: string,
  projectPath: string | null,
  fixtures: Fixtures
): Promise<Check[]> {
  const { win } = ctx

  // `keep`, because this is the one probe the mode is the subject of: forcing
  // it here would read back the driver's own click and call it the default.
  await selectScope(win, harnessPath, 'keep')
  const harnessDefault = await readMode(win)

  let projectDefault: { view: string; caption: string; count: string } | null = null
  if (projectPath !== null) {
    await selectScope(win, projectPath, 'keep')
    projectDefault = await readMode(win)
  }

  // The cross case, on fixtures. A project read as a vault, then a harness
  // walked as a tree.
  await selectScope(win, fixtures.project)
  await click(win, '[data-content-view="curated"]')
  await sleep(700)
  const projectCurated = await readMode(win)
  const emptyRoot = await js<{ listed: boolean; saysEmpty: boolean; offer: string }>(
    win,
    `(() => {
      const head = document.querySelector('[data-content-section="docs"]');
      return {
        listed: Boolean(head),
        saysEmpty: Boolean(document.querySelector('[data-content-root-empty="docs"]')),
        offer: head ? head.dataset.contentRootOffer : ''
      }
    })()`
  )
  const curatedShot = await tryShot(win, shotDir, 'content-project-curated.png')

  await selectScope(win, fixtures.root)
  await click(win, '[data-content-view="tree"]')
  await sleep(700)
  const harnessTree = await readMode(win)
  const harnessTreeEntries = await js<string[]>(
    win,
    `[...document.querySelectorAll('[data-content-tree-entry]')].map((el) => el.dataset.contentTreeEntry)`
  )
  const treeShot = await tryShot(win, shotDir, 'content-harness-tree.png')

  return [
    {
      id: 'CONT-12',
      criterion:
        'A harness opens curated and a project opens on a tree; both modes work from either kind, and the kind only picks the default',
      title: 'The default follows the scope kind, and the cross case works in both directions',
      ok:
        harnessDefault.view === 'curated' &&
        harnessDefault.caption.includes('harness default') &&
        (projectDefault === null ||
          (projectDefault.view === 'tree' && projectDefault.caption.includes('project default'))) &&
        projectCurated.view === 'curated' &&
        emptyRoot.listed &&
        emptyRoot.saysEmpty &&
        emptyRoot.offer === 'named' &&
        harnessTree.view === 'tree' &&
        harnessTreeEntries.includes('notes') &&
        harnessTreeEntries.includes('tools'),
      detail: {
        harness: { scope: harnessPath, ...harnessDefault },
        project: projectDefault === null ? 'no project scope on this machine' : { scope: projectPath, ...projectDefault },
        projectAsCurated: { scope: fixtures.project, ...projectCurated, emptyNamedRoot: emptyRoot },
        harnessAsTree: { scope: fixtures.root, ...harnessTree, topLevel: harnessTreeEntries.length },
        screenshots: [curatedShot.file, treeShot.file],
        screenshotErrors: [curatedShot.error, treeShot.error].filter(Boolean)
      },
      notes: [
        'The caption is read as text rather than inferred from the mode: "harness default - curated',
        'roots" is the thing that stops the rule being invisible, and a caption that had stopped',
        'saying it would leave the control passing with nothing on screen to explain it.',
        'The empty named root is asserted on the fixture project, where the driver made docs/ and',
        'put nothing in it - so "listed and says empty" has a known answer.'
      ]
    }
  ]
}

/**
 * CONT-13: curation decides directories, never files.
 *
 * Against the fixture harness, where the driver planted the discriminating
 * pair itself: `tools/` holding nothing but scripts, `screenshots/` holding
 * nothing but bytes. Asserting only the first would pass a rule that offered
 * every directory there is.
 */
async function curationChecks(ctx: CheckContext, fixtures: Fixtures): Promise<Check[]> {
  const { win, content } = ctx

  // The fixtures have to be there and have to discriminate before any of this
  // is worth reading - the PROF-4 shape, where a missing file made every
  // answer match.
  const planted = {
    sourceOnly: existsSync(join(fixtures.root, 'tools', 'rep-payload.py')),
    bytesOnly: existsSync(join(fixtures.root, 'screenshots', 'one.png')),
    binaryInsideARoot: existsSync(join(fixtures.notes, 'diagram.png'))
  }

  await selectScope(win, fixtures.root)
  await click(win, '[data-content-view="curated"]')
  await sleep(700)

  const tree = content.tree(fixtures.root, true)
  const roots = new Map(tree.roots.map((root) => [root.relPath, root]))
  const painted = await js<Array<{ relPath: string; kind: string }>>(
    win,
    `[...document.querySelectorAll('button[data-content-file]')].map((el) => ({
      relPath: el.dataset.contentFile, kind: el.dataset.contentKind }))`
  )
  const onScreen = new Map(painted.map((row) => [row.relPath.toLowerCase(), row.kind]))

  return [
    {
      id: 'CONT-13',
      criterion:
        'Curated roots list every file; source opens as source, binary is listed rather than hidden; a source-only directory is a found root',
      title: 'A directory of nothing but scripts is a root, one of nothing but bytes is not',
      ok:
        planted.sourceOnly &&
        planted.bytesOnly &&
        planted.binaryInsideARoot &&
        roots.get('tools')?.offer === 'discovered' &&
        !roots.has('screenshots') &&
        onScreen.get('tools/rep-payload.py') === 'source' &&
        onScreen.get('tools/sweep.ps1') === 'source' &&
        onScreen.get('notes/diagram.png') === 'binary' &&
        !onScreen.has('screenshots/one.png'),
      detail: {
        fixturesPlanted: planted,
        roots: tree.roots.map((root) => `${root.relPath || '(scope root)'}=${String(root.files)} ${root.offer}`),
        toolsRows: painted.filter((row) => row.relPath.startsWith('tools/')),
        binaryRow: painted.find((row) => row.relPath === 'notes/diagram.png') ?? null,
        screenshotsOffered: roots.has('screenshots')
      },
      notes: [
        'Both directions, deliberately. `tools/` proves source counts as content; `screenshots/`',
        'proves binary still does not, which is what stops the rule from offering every directory',
        'on the disk. `notes/diagram.png` is the third claim: inside a root that *is* offered,',
        'even a binary is listed - the kind decides how a file opens, not whether it is shown.'
      ]
    }
  ]
}

/**
 * CONT-14: the project tree - lazy, complete, and ignoring what the repository
 * ignores.
 *
 * Laziness is asserted the only way it can be: by looking for rows that must
 * not exist yet, expanding, and looking again. A tree that had walked eagerly
 * and hidden the rows would fail the first half; one that never read the
 * directory fails the second.
 */
async function treeChecks(ctx: CheckContext, shotDir: string, fixtures: Fixtures): Promise<Check[]> {
  const { win } = ctx

  await selectScope(win, fixtures.project)
  await click(win, '[data-content-view="tree"]')
  await sleep(900)

  const readRows = async (): Promise<Array<{ rel: string; kind: string; ignored: string }>> =>
    js(
      win,
      `[...document.querySelectorAll('[data-content-tree-entry]')].map((el) => ({
        rel: el.dataset.contentTreeEntry,
        kind: el.dataset.contentKind,
        ignored: el.dataset.contentIgnored
      }))`
    )

  const before = await readRows()
  await click(win, '[data-content-tree-entry="src"]')
  await sleep(900)
  const after = await readRows()

  /**
   * The shot, and the scope it is a shot *of*.
   *
   * Taken here rather than at the end, and paired with a read of the switcher
   * in the same moment, because the first run of this probe wrote a PNG of a
   * different scope mid-transition and reported green beside it. A screenshot
   * nobody can tie to the assertion it illustrates is the `PROF-4` shape with
   * a picture attached.
   */
  const shot = await tryShot(win, shotDir, 'content-project-tree.png')
  const shotScope = await js<string>(
    win,
    `document.querySelector('select[data-content-scope]')?.value ?? ''`
  )

  const badged = await js<string[]>(
    win,
    `[...document.querySelectorAll('[data-content-tree-entry][data-content-ignored="true"]')]
       .map((el) => (el.textContent ?? '').includes('IGNORED') ? el.dataset.contentTreeEntry : '')
       .filter(Boolean)`
  )
  const source = await js<string>(
    win,
    `document.querySelector('[data-content-tree]')?.dataset.contentTree ?? ''`
  )
  const caption = await js<string>(
    win,
    `(document.querySelector('[data-content-tree]')?.lastElementChild?.textContent ?? '').trim()`
  )
  const count = await js<string>(
    win,
    `(document.querySelector('[data-content-count="tree"]')?.textContent ?? '').trim()`
  )

  // The independent read: what is actually in the fixture's top level, and what
  // git itself says about it - asked through the driver's own spawn rather than
  // through the code under test.
  const onDisk = readdirSync(fixtures.project, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => entry.name)
  const gitSays = new Set<string>()
  if (fixtures.projectIsRepo) {
    const probe = spawnSync(
      'git',
      ['check-ignore', ...onDisk.map((name) => name)],
      { cwd: fixtures.project, encoding: 'utf8', windowsHide: true }
    )
    for (const line of (probe.stdout ?? '').split(/\r?\n/)) {
      if (line.trim() !== '') gitSays.add(line.trim().replace(/\/$/, ''))
    }
  }

  /**
   * The discriminator: `secrets/` is in no built-in list.
   *
   * "gitignore respected" is also what a run that quietly fell back would
   * report about `node_modules/` and `dist/`, because those are in Helm's own
   * list too. `secrets/` is in neither list, so its being greyed can only have
   * come from the repository - and this asserts the list really does not hold
   * it, rather than taking that on trust from the name.
   */
  const notInHelmsList = !CURATED_SKIPPED_DIRS.has('secrets')

  const listed = new Set(before.map((row) => row.rel))
  const ignoredOnScreen = new Set(before.filter((row) => row.ignored === 'true').map((row) => row.rel))

  return [
    {
      id: 'CONT-14',
      criterion:
        'The project tree lists every file, reads directories lazily on expand, and shows what .gitignore ignores rather than hiding it',
      title: 'Every top-level entry is a row, `src/` is read only when opened, and git decides the greying',
      ok:
        fixtures.projectIsRepo &&
        gitSays.size > 0 &&
        onDisk.every((name) => listed.has(name)) &&
        listed.size === onDisk.length &&
        // Lazy: nothing under `src/` before the click, everything after it.
        before.every((row) => !row.rel.startsWith('src/')) &&
        after.some((row) => row.rel === 'src/index.ts') &&
        after.some((row) => row.rel === 'src/util') &&
        // The repository's own answer, not Helm's list.
        [...gitSays].every((name) => ignoredOnScreen.has(name)) &&
        ignoredOnScreen.has('secrets') &&
        badged.includes('node_modules') &&
        badged.includes('dist') &&
        source === 'gitignore' &&
        caption.includes('.gitignore respected') &&
        count.includes('ignored') &&
        notInHelmsList &&
        // The shot is of the thing that was asserted, not of whatever the
        // window happened to be showing by the time it was taken.
        shotScope.toLowerCase() === fixtures.project.toLowerCase() &&
        // Unsupported kinds are rows, not omissions.
        listed.has('LICENSE'),
      detail: {
        project: fixtures.project,
        isRepo: fixtures.projectIsRepo,
        secretsIsInHelmsOwnList: !notInHelmsList,
        scopeTheScreenshotShows: shotScope,
        onDisk,
        listed: [...listed],
        ignoredOnScreen: [...ignoredOnScreen],
        gitCheckIgnoreSaid: [...gitSays],
        badgedIgnored: badged,
        beforeExpandingSrc: before.filter((row) => row.rel.startsWith('src')).map((row) => row.rel),
        afterExpandingSrc: after.filter((row) => row.rel.startsWith('src/')).map((row) => row.rel),
        ignoreSource: source,
        captionUnderTheTree: caption,
        headerCount: count,
        screenshot: shot.file,
        screenshotError: shot.error
      },
      notes: [
        'The ignore set is compared against this driver’s own `git check-ignore` spawn, which is',
        'the world rather than a second opinion - Helm and the check are both asking git, and if',
        'they disagree one of them is passing the wrong paths.',
        'gitSays.size > 0 is the discrimination guard: on a machine with no git the whole claim',
        'is vacuous, and this fails rather than reporting green over nothing.',
        '`secrets/` is in no built-in skip list, so its being ignored can only have come from the',
        'repository - which is what separates this from the fallback passing under another name.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// CONT-2 / CONT-3: every note in the vault, rendered through the window
// ---------------------------------------------------------------------------

interface PaintedDoc {
  path: string
  ok: boolean
  bodyChars: number
  tables: number
  taskItems: number
  taskItemsChecked: number
  codeBlocks: number
  highlighted: number
  callouts: number
  wikilinks: number
  broken: number
  chips: number
  rawFrontmatter: boolean
}

async function renderChecks(
  ctx: CheckContext,
  shotDir: string,
  harnessPath: string,
  appConsole: Array<{ level: string; message: string; source: string }>
): Promise<Check[]> {
  const { win, content } = ctx
  const tree = content.tree(harnessPath, true)
  const markdown = tree.files.filter((file) => file.kind === 'markdown')

  await selectScope(win, harnessPath)
  const consoleBefore = appConsole.length

  /**
   * Clicks every row and reads what painted.
   *
   * Done inside one renderer expression rather than as a hundred round trips:
   * a click is a React state change and an IPC request, so the loop has to wait
   * for the body whose `data-content-path` is the file it asked for - which is
   * the same wait either way, and doing it here saves a hundred crossings of
   * the process boundary.
   */
  const painted = await js<PaintedDoc[]>(
    win,
    `(async () => {
      const wanted = ${JSON.stringify(markdown.map((file) => ({ path: file.path, relPath: file.relPath })))};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = [];
      for (const file of wanted) {
        const row = [...document.querySelectorAll('button[data-content-file]')]
          .find((el) => el.dataset.contentFile === file.relPath);
        if (!row) { out.push({ path: file.path, ok: false, bodyChars: 0, tables: 0, taskItems: 0,
          taskItemsChecked: 0, codeBlocks: 0, highlighted: 0, callouts: 0, wikilinks: 0, broken: 0,
          chips: 0, rawFrontmatter: false }); continue; }
        row.click();
        let body = null;
        for (let i = 0; i < 120; i++) {
          const candidate = document.querySelector('[data-content-body]');
          if (candidate && candidate.dataset.contentPath === file.path && candidate.innerHTML !== '') {
            body = candidate; break;
          }
          await sleep(25);
        }
        if (!body) { out.push({ path: file.path, ok: false, bodyChars: 0, tables: 0, taskItems: 0,
          taskItemsChecked: 0, codeBlocks: 0, highlighted: 0, callouts: 0, wikilinks: 0, broken: 0,
          chips: 0, rawFrontmatter: false }); continue; }
        const text = body.textContent ?? '';
        const chipsEl = document.querySelector('[data-frontmatter-chips]');
        out.push({
          path: file.path,
          ok: true,
          bodyChars: text.length,
          tables: body.querySelectorAll('table').length,
          taskItems: body.querySelectorAll('input[type=checkbox]').length,
          taskItemsChecked: body.querySelectorAll('input[type=checkbox]:checked').length,
          codeBlocks: body.querySelectorAll('pre').length,
          highlighted: body.querySelectorAll('pre.shiki span[style*="--shiki-dark"]').length > 0
            ? body.querySelectorAll('pre[data-language]:not([data-language="text"])').length : 0,
          callouts: body.querySelectorAll('[data-callout]').length,
          wikilinks: body.querySelectorAll('a.wikilink').length,
          broken: body.querySelectorAll('a.wikilink-broken').length,
          chips: chipsEl ? Number(chipsEl.dataset.frontmatterChips) : 0,
          // The failure this criterion is really about: a document that shows
          // its own YAML block as the first paragraph.
          rawFrontmatter: /^\\s*---\\s*\\n\\s*(type|date|tags|name|description)\\s*:/.test(text)
        });
      }
      return out;
    })()`
  )

  const consoleErrors = appConsole.slice(consoleBefore)

  /**
   * The evidence shot is chosen rather than whatever happened to be last.
   *
   * The document with the most tables, code blocks and checkboxes in it is the
   * one worth looking at, because it is the one where a rendering mistake would
   * show. Picking it by count means the screenshot stays the strongest example
   * as the vault changes, instead of being whichever file sorts last today.
   */
  const richest = [...painted]
    .filter((doc) => doc.ok)
    .sort(
      (a, b) =>
        b.tables * 3 + b.codeBlocks * 2 + b.taskItems - (a.tables * 3 + a.codeBlocks * 2 + a.taskItems)
    )[0]
  if (richest) {
    const row = markdown.find((file) => file.path === richest.path)
    if (row) {
      await js<boolean>(
        win,
        `(() => { const el = [...document.querySelectorAll('button[data-content-file]')]
            .find((e) => e.dataset.contentFile === ${JSON.stringify(row.relPath)});
          if (!el) return false; el.click(); return true })()`
      )
      await pollJs(
        win,
        `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(row.path)}`,
        15_000
      )
      await sleep(500)
    }
  }
  /**
   * The list markers, read out of the computed style.
   *
   * Tailwind's preflight sets `list-style: none` on every `ul` and `ol` in the
   * document, which is right for an app built out of lists and silently wrong
   * for a rendered note - the bullets vanish and a list reads as a paragraph
   * with strange line breaks. Nothing about the HTML says so, which is why this
   * is asserted against `getComputedStyle` rather than against the markup.
   */
  const markers = await js<{ ul: string | null; ol: string | null; task: string | null }>(
    win,
    `(() => {
      const read = (sel) => { const el = document.querySelector(sel);
        return el ? getComputedStyle(el).listStyleType : null };
      return { ul: read('[data-content-body] ul:not(.contains-task-list)'),
        ol: read('[data-content-body] ol'),
        task: read('[data-content-body] ul.contains-task-list') };
    })()`
  )

  const shot = await screenshot(win, shotDir, 'content-rendered.png')

  /**
   * The document with callouts in it, in both themes.
   *
   * Two screenshots rather than one because the code blocks carry *both*
   * palettes as CSS custom properties and the stylesheet picks a side from the
   * `dark` class - which is a claim that is only worth anything if somebody has
   * looked at the light one. The theme is changed through `settings:write`,
   * which is the path the toggle in the tab strip takes.
   */
  const withCallouts = markdown.find(
    (file) => (readFileSync(file.path, 'utf8').match(/^>\s*\[!/gm) ?? []).length > 0
  )
  const themeShots: string[] = []
  let calloutsPainted = 0
  if (withCallouts) {
    await js<boolean>(
      win,
      `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
          .find((el) => el.dataset.contentFile === ${JSON.stringify(withCallouts.relPath)});
        if (!row) return false; row.click(); return true })()`
    )
    await pollJs(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(withCallouts.path)}`,
      15_000
    )
    await sleep(500)
    calloutsPainted = await js<number>(
      win,
      `document.querySelectorAll('[data-content-body] [data-callout]').length`
    )
    themeShots.push((await screenshot(win, shotDir, 'content-callouts-dark.png')).file)

    await js<unknown>(win, `window.helm.invoke('settings:write', { theme: 'light' })`)
    await pollJs(win, `!document.documentElement.classList.contains('dark')`, 10_000)
    await sleep(700)
    themeShots.push((await screenshot(win, shotDir, 'content-callouts-light.png')).file)
    await js<unknown>(win, `window.helm.invoke('settings:write', { theme: 'dark' })`)
    await pollJs(win, `document.documentElement.classList.contains('dark')`, 10_000)
    await sleep(400)
  }

  // ---- against the driver's own read of the same files --------------------
  const byPath = new Map(painted.map((doc) => [doc.path, doc]))
  const disagreements: Array<Record<string, unknown>> = []
  /** Files whose code-block count `countSource` declined to claim; see `SourceCounts`. */
  const codeBlocksUnclaimed: string[] = []
  const totals = {
    files: markdown.length,
    tables: 0,
    taskItems: 0,
    codeBlocks: 0,
    highlighted: 0,
    callouts: 0,
    withTables: 0,
    withTasks: 0,
    withCode: 0,
    withChips: 0
  }

  for (const file of markdown) {
    const doc = byPath.get(file.path)
    const source = readFileSync(file.path, 'utf8')
    const expected = countSource(source)
    if (!doc?.ok) {
      disagreements.push({ file: file.relPath, reason: 'never painted' })
      continue
    }
    totals.tables += doc.tables
    totals.taskItems += doc.taskItems
    totals.codeBlocks += doc.codeBlocks
    totals.highlighted += doc.highlighted
    totals.callouts += doc.callouts
    if (doc.tables > 0) totals.withTables++
    if (doc.taskItems > 0) totals.withTasks++
    if (doc.codeBlocks > 0) totals.withCode++
    if (doc.chips > 0) totals.withChips++

    const problems: string[] = []
    if (doc.rawFrontmatter) problems.push('rendered its frontmatter as text')
    if (doc.tables !== expected.tables) {
      problems.push(`tables: DOM ${String(doc.tables)}, source ${String(expected.tables)}`)
    }
    if (doc.taskItems !== expected.taskItems) {
      problems.push(`task items: DOM ${String(doc.taskItems)}, source ${String(expected.taskItems)}`)
    }
    if (doc.taskItemsChecked !== expected.taskItemsChecked) {
      problems.push(
        `checked items: DOM ${String(doc.taskItemsChecked)}, source ${String(expected.taskItemsChecked)}`
      )
    }
    if (!expected.codeBlocksClaimed) codeBlocksUnclaimed.push(file.relPath)
    else if (doc.codeBlocks !== expected.codeBlocks) {
      problems.push(`code blocks: DOM ${String(doc.codeBlocks)}, source ${String(expected.codeBlocks)}`)
    }
    // Frontmatter that exists must become chips, and the number of them must be
    // the number of top-level keys the block declares.
    if (expected.frontmatterKeys.length > 0 && doc.chips === 0) {
      problems.push(`frontmatter has ${String(expected.frontmatterKeys.length)} keys and no chips`)
    }
    if (problems.length > 0) disagreements.push({ file: file.relPath, problems })
  }

  const painting = painted.filter((doc) => doc.ok).length
  const rawAnywhere = painted.filter((doc) => doc.rawFrontmatter).map((doc) => doc.path)

  return [
    {
      id: 'CONT-2',
      criterion:
        'Every existing note in the dev harness vault (60+ files) renders correctly: frontmatter chips, tables, checkboxes, code highlighting',
      title: `All ${String(markdown.length)} markdown files in the vault were opened through the window and agreed with a regex read of their own source`,
      ok:
        markdown.length >= 60 &&
        painting === markdown.length &&
        disagreements.length === 0 &&
        rawAnywhere.length === 0 &&
        consoleErrors.length === 0 &&
        totals.withTables > 0 &&
        totals.withTasks > 0 &&
        totals.withCode > 0 &&
        totals.highlighted > 0 &&
        totals.callouts > 0 &&
        calloutsPainted > 0 &&
        markers.ul === 'disc' &&
        (markers.task === null || markers.task === 'none') &&
        // The one exemption in this criterion is not allowed to become the
        // criterion. A vault where a fifth of the files decline the count is
        // one where this reader has stopped measuring rather than one with
        // unusual markdown, and that is a red line, not a footnote.
        codeBlocksUnclaimed.length * 5 < markdown.length,
      detail: {
        scope: harnessPath,
        markdownFiles: markdown.length,
        painted: painting,
        disagreements,
        codeBlocksUnclaimed,
        filesShowingRawFrontmatter: rawAnywhere,
        consoleErrorsDuringThePass: consoleErrors,
        totals,
        calloutsIn: withCallouts?.relPath ?? null,
        calloutsPainted,
        listMarkers: markers,
        screenshots: [shot.file, ...themeShots]
      },
      notes: [
        'Every file is clicked in the list and read back out of the DOM - `table`,',
        '`input[type=checkbox]`, `pre[data-language]`, `[data-callout]`,',
        '`[data-frontmatter-chips]` - not out of the render result.',
        'The expected counts come from `countSource` in this file: fenced regions removed, then',
        'a regex per feature. It shares no code with remark, and it disagrees with the DOM when',
        'either of them is wrong.',
        '`codeBlocksUnclaimed` lists the files where that reader declined to count code blocks',
        'rather than guess at a fence indented into a list item - named rather than skipped, and',
        'capped at a fifth of the vault so the exemption cannot swallow the criterion.',
        'Console errors are collected from the window for the whole pass, so a note that threw',
        'while rendering fails this check even if the DOM it left behind looks plausible.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// CONT-4: wikilinks
// ---------------------------------------------------------------------------

async function linkChecks(
  ctx: CheckContext,
  shotDir: string,
  harnessPath: string,
  fixtures: Fixtures
): Promise<Check[]> {
  const { win, content } = ctx
  const tree = content.tree(harnessPath, true)
  const markdown = tree.files.filter((file) => file.kind === 'markdown')

  /**
   * An index built by hand: basename without extension, lower-cased.
   *
   * This is the whole of Obsidian's rule for a bare `[[name]]`, written out
   * here rather than borrowed from `buildWikiIndex` - borrowing it would make
   * the check and the thing it checks the same function.
   */
  const names = new Set(markdown.map((file) => basename(file.path).replace(/\.[^.]+$/, '').toLowerCase()))
  const paths = new Set(markdown.map((file) => file.relPath.toLowerCase().replace(/\.[^./]+$/, '')))

  let expectedTotal = 0
  let expectedBroken = 0
  const expectedBrokenTargets: string[] = []
  const filesWithLinks: ContentFile[] = []
  for (const file of markdown) {
    const targets = wikilinkTargets(readFileSync(file.path, 'utf8'))
    if (targets.length > 0) filesWithLinks.push(file)
    for (const target of targets) {
      expectedTotal++
      const needle = target.toLowerCase().replace(/\\/g, '/')
      const resolved =
        paths.has(needle) ||
        paths.has(needle.replace(/\.[^./]+$/, '')) ||
        names.has(needle.split('/').at(-1) ?? needle)
      if (!resolved) {
        expectedBroken++
        expectedBrokenTargets.push(target)
      }
    }
  }

  // ---- and what the pipeline said ----------------------------------------
  let actualTotal = 0
  let actualBroken = 0
  for (const file of markdown) {
    const doc = await content.document(harnessPath, file.path)
    actualTotal += doc.rendered?.counts.wikilinks ?? 0
    actualBroken += doc.rendered?.counts.brokenWikilinks ?? 0
  }

  /** How the two kinds of link are actually painted, read where each occurs. */
  const readLinkStyle = async (which: 'live' | 'broken'): Promise<Record<string, string> | null> =>
    js<Record<string, string> | null>(
      win,
      `(() => {
        const el = document.querySelector(${
          which === 'broken'
            ? `'[data-content-body] a.wikilink-broken'`
            : `'[data-content-body] a.wikilink:not(.wikilink-broken)'`
        });
        if (!el) return null;
        const s = getComputedStyle(el);
        return { color: s.color, borderBottomStyle: s.borderBottomStyle,
          borderBottomColor: s.borderBottomColor };
      })()`
    )

  /**
   * CONT-3's corpus is the fixture harness, not the vault.
   *
   * The claim is about the *viewer* - a click navigates, and a broken link is
   * painted differently from a live one - and settling it needs one document
   * holding both kinds at once, so the two computed styles come from the same
   * stylesheet in the same theme. The vault supplied that by accident until it
   * stopped: a note written one evening had a single broken link and no live
   * one, `liveStyle` came back null, and the criterion went red over what
   * somebody had typed in a text editor. A check that goes red for a reason
   * unrelated to what it measures gets waved past, and then so does the day it
   * goes red for a real one.
   *
   * CONT-2 and CONT-4 keep the whole vault. Breadth is what those two are for,
   * and it earns its keep - CONT-4's two parsers disagreeing by exactly one is
   * what found the renderer dropping a wikilink whose alias remark had parsed.
   */
  const fixtureMarkdown = content.tree(fixtures.root, true).files.filter(
    (file) => file.kind === 'markdown'
  )
  const fixtureNames = new Set(
    fixtureMarkdown.map((file) => basename(file.path).replace(/\.[^.]+$/, '').toLowerCase())
  )
  const resolvesInFixture = (target: string): boolean =>
    fixtureNames.has(target.toLowerCase().split('/').at(-1) ?? '')

  /**
   * And the fixture is made to prove it discriminates before it is believed.
   *
   * Without this the probe reports the `PROF-4` shape: a document with no live
   * link yields `liveStyle: null`, `visiblyDifferent` is false because there
   * was nothing to differ from, and the report says the styling is wrong when
   * what is wrong is the subject.
   */
  const source = fixtureMarkdown.find((file) => {
    const targets = wikilinkTargets(readFileSync(file.path, 'utf8'))
    return targets.some(resolvesInFixture) && targets.some((t) => !resolvesInFixture(t))
  })
  const fixtureIsDiscriminating = source !== undefined

  let liveStyle: Record<string, string> | null = null
  let navigated: Record<string, unknown> = { attempted: false }
  if (source) {
    await selectScope(win, fixtures.root)
    await js<boolean>(
      win,
      `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
          .find((el) => el.dataset.contentFile === ${JSON.stringify(source.relPath)});
        if (!row) return false; row.click(); return true })()`
    )
    await pollJs(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(source.path)}`,
      15_000
    )
    await sleep(400)

    const target = await js<string | null>(
      win,
      `document.querySelector('[data-content-body] a.wikilink[data-wikilink-path]')?.dataset.wikilinkPath ?? null`
    )
    liveStyle = await readLinkStyle('live')
    await js<boolean>(
      win,
      `(() => { const a = document.querySelector('[data-content-body] a.wikilink[data-wikilink-path]');
        if (!a) return false; a.click(); return true })()`
    )
    const landed = await pollJs(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(target ?? '')}`,
      15_000
    )
    await sleep(400)
    const nowShowing = await js<string | null>(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath ?? null`
    )
    navigated = {
      attempted: true,
      from: source.relPath,
      linkPointedAt: target,
      landedOnIt: landed,
      paneIsNowShowing: nowShowing,
      targetExistsOnDisk: target !== null && existsSync(target)
    }
  }

  // The broken ones have to look different, and the difference has to be in the
  // computed style rather than in a class name nobody styled. Read back in the
  // document navigation just landed on, which is the same scope and theme.
  const brokenFile = source
  let styling: Record<string, unknown> = { attempted: false }
  if (brokenFile) {
    await js<boolean>(
      win,
      `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
          .find((el) => el.dataset.contentFile === ${JSON.stringify(brokenFile.relPath)});
        if (!row) return false; row.click(); return true })()`
    )
    await pollJs(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(brokenFile.path)}`,
      15_000
    )
    await sleep(400)
    liveStyle ??= await readLinkStyle('live')
    styling = {
      attempted: true,
      inFile: brokenFile.relPath,
      broken: await readLinkStyle('broken'),
      live: liveStyle,
      brokenCount: await js<number>(
        win,
        `document.querySelectorAll('[data-content-body] a.wikilink-broken').length`
      ),
      badge: await js<string | null>(
        win,
        `document.querySelector('[data-broken-links]')?.dataset.brokenLinks ?? null`
      )
    }
  }

  // Taken here rather than at the end of the group, so the PNG is of the
  // document the two styles were read from instead of whatever CONT-11 left up.
  const shot = await screenshot(win, shotDir, 'content-wikilinks.png')

  /**
   * An `https://` link in a note, and the two halves of what happens to it.
   *
   * The click is checked by watching whether the document's own handler
   * cancelled the event - `will-navigate` is prevented and the window-open
   * handler denies, so a link this pane does not intercept is a link that does
   * nothing at all, silently. The listener bubbles from `window`, so it runs
   * after the pane's and sees the decision rather than making it.
   *
   * The refusal is checked directly, with a `file:` URL. That is the half that
   * matters: `shell.openExternal` on a local path is a way to run a program,
   * and a note is content. The accepting half is deliberately *not* exercised -
   * a check that opens a browser window is a check nobody runs twice.
   */
  const withExternal = markdown.find((file) =>
    /\]\(https:\/\//.test(readFileSync(file.path, 'utf8'))
  )
  if (withExternal) {
    // Back to the vault: CONT-3 left the pane on the fixture harness.
    await selectScope(win, harnessPath)
    await js<boolean>(
      win,
      `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
          .find((el) => el.dataset.contentFile === ${JSON.stringify(withExternal.relPath)});
        if (!row) return false; row.click(); return true })()`
    )
    await pollJs(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(withExternal.path)}`,
      15_000
    )
    await sleep(400)
  }
  const externalLink = await js<{ found: boolean; href: string; intercepted: boolean }>(
    win,
    `(async () => {
      const a = document.querySelector('[data-content-body] a[href^="https://"]');
      if (!a) return { found: false, href: '', intercepted: false };
      let intercepted = false;
      const watch = (ev) => { intercepted = ev.defaultPrevented };
      window.addEventListener('click', watch);
      a.click();
      window.removeEventListener('click', watch);
      return { found: true, href: a.getAttribute('href'), intercepted };
    })()`
  )
  const refusedFileUrl = await js<{ opened: boolean }>(
    win,
    `window.helm.invoke('shell:openExternal', { url: 'file:///C:/Windows/win.ini' })`
  )

  const brokenStyle = styling['broken'] as { color?: string; borderBottomStyle?: string } | null
  const visiblyDifferent =
    brokenStyle != null &&
    liveStyle != null &&
    brokenStyle.color !== liveStyle.color &&
    brokenStyle.borderBottomStyle !== liveStyle.borderBottomStyle

  return [
    {
      id: 'CONT-3',
      criterion: '[[wikilink]] navigation works between notes; broken links visibly distinct',
      title: fixtureIsDiscriminating
        ? 'Clicking a wikilink opened the note it names, and a broken one is a different colour and a dashed rule'
        : 'No fixture note holds both a live wikilink and a broken one, so this criterion has no discriminating subject',
      ok:
        fixtureIsDiscriminating &&
        navigated['landedOnIt'] === true &&
        navigated['targetExistsOnDisk'] === true &&
        visiblyDifferent &&
        Number(styling['brokenCount'] ?? 0) > 0,
      detail: {
        scope: fixtures.root,
        fixtureIsDiscriminating,
        fixtureNotes: fixtureMarkdown.length,
        navigation: navigated,
        brokenStyling: styling,
        visiblyDifferent,
        screenshot: shot.file
      },
      notes: [
        'The subject is the fixture harness this driver writes, not the vault: the two styles',
        'have to be read out of one document for the comparison to mean anything, and which',
        'vault notes happen to hold both kinds of link is not a fact about Helm.',
        'The fixture is required to discriminate before the comparison is believed - a note with',
        'no live link yields `liveStyle: null` and a false verdict about the styling.',
        'The two styles are read with `getComputedStyle` after the document painted, so this is',
        'a claim about what the reader sees rather than about which class was applied.',
        'A broken link is warm-toned and dashed rather than red: in this vault an unresolved',
        'link marks a note worth writing, which is not an error.'
      ]
    },
    {
      id: 'CONT-11',
      criterion: 'A link in a note goes somewhere; a link that is not a link goes nowhere',
      title: 'An https link is intercepted rather than left inert, and a file: URL is refused',
      ok: externalLink.found && externalLink.intercepted && refusedFileUrl.opened === false,
      detail: { inFile: withExternal?.relPath ?? null, externalLink, fileUrlRefused: refusedFileUrl },
      notes: [
        'Without the interception an `https://` link in a note does nothing: `will-navigate` is',
        'prevented and `setWindowOpenHandler` denies, so the click is swallowed silently.',
        'Only the refusal is exercised end to end. Opening the accepting half would open a',
        'browser window on the user’s desktop every time this check runs.'
      ]
    },
    {
      id: 'CONT-4',
      criterion: '[[wikilink]] resolution across the vault',
      title: 'Every wikilink in the vault resolves the same way a hand-built name index resolves it',
      ok: expectedTotal > 0 && actualTotal === expectedTotal && actualBroken === expectedBroken,
      detail: {
        pipeline: { links: actualTotal, broken: actualBroken },
        independentIndex: { links: expectedTotal, broken: expectedBroken },
        brokenTargets: [...new Set(expectedBrokenTargets)].sort(),
        filesWithLinks: filesWithLinks.length
      },
      notes: [
        'The second index is a `Set` of basenames built in contentcheck.ts, and the second link scan',
        'is a regex over the source with fenced and inline code removed. Neither borrows from',
        '`buildWikiIndex` or from the remark transform.',
        'The broken targets are listed rather than only counted, because the value of this',
        'criterion is knowing *which* notes are unwritten.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// CONT-5 / CONT-6: the artifact frame
// ---------------------------------------------------------------------------

/** The frame an artifact is rendered in, found among the window's subframes. */
function artifactFrame(win: BrowserWindow): WebFrameMain | null {
  const walk = (frame: WebFrameMain): WebFrameMain | null => {
    if (frame.url.startsWith('helm-content:')) return frame
    for (const child of frame.frames) {
      const found = walk(child)
      if (found) return found
    }
    return null
  }
  try {
    return walk(win.webContents.mainFrame)
  } catch {
    return null
  }
}

async function openArtifact(
  ctx: CheckContext,
  scopePath: string,
  relPath: string
): Promise<{ opened: boolean; frame: WebFrameMain | null }> {
  const { win } = ctx
  await selectScope(win, scopePath)
  const clicked = await js<boolean>(
    win,
    `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
        .find((el) => el.dataset.contentFile === ${JSON.stringify(relPath)});
      if (!row) return false; row.click(); return true })()`
  )
  if (!clicked) return { opened: false, frame: null }
  await pollJs(win, `document.querySelector('iframe[data-artifact-frame]')?.src`, 20_000)
  await sleep(1200)
  return { opened: true, frame: artifactFrame(win) }
}

async function artifactChecks(
  ctx: CheckContext,
  shotDir: string,
  fixtures: Fixtures,
  harnessPath: string | null
): Promise<Check[]> {
  const { win } = ctx
  const checks: Check[] = []

  /**
   * The criterion, against an artifact the **driver planted**.
   *
   * This used to be asserted against a file out of the developer's own vault,
   * and it broke twice for the same reason: the corpus was a directory other
   * people write to. First it took the newest HTML file, which a design tool
   * made a 36 KB fragment with no `<title>` and no heading; narrowing it to
   * "a file that claims to be a document" made that instance go away without
   * touching the fault. A probe whose corpus is somebody's working directory
   * will keep going red for reasons that are not about the code, and each time
   * it will look exactly like a regression - there is a closed ClickUp task
   * about this same surface doing this same thing.
   *
   * So the claim is made about `lessons/artifact.html`, which this file writes:
   * a title, a heading, inline CSS and an inline script that mutates the DOM.
   * That exercises the whole path - the protocol, the frame, scripts running
   * under the sandbox, and the console staying quiet - over bytes the check
   * owns, so the only thing that can turn it red is Helm.
   *
   * It now also guards the wikilink bootstrap the protocol injects into every
   * artifact: that script runs in this document, and anything it threw would
   * arrive in the same console this asserts is clean.
   *
   * The real vault is still read, in `CONT-5b`, and is still worth reading -
   * see the note there for what it does and does not claim.
   */
  clearArtifactConsole()
  const planted = await openArtifact(ctx, fixtures.root, 'lessons/artifact.html')
  const plantedRendered = planted.frame
    ? await planted.frame
        .executeJavaScript(
          `({ title: document.title, headings: document.querySelectorAll('h1,h2,h3').length,
              ran: document.getElementById('out')?.textContent ?? null,
              text: (document.body?.innerText ?? '').length,
              // The fixture's own marker, read back out of the laid-out text.
              // This is what "rendered" means here - see the note below.
              marker: (document.body?.innerText ?? '').includes('HELMM6ARTIFACT'),
              painted: document.body ? document.body.scrollHeight : 0 })`
        )
        .catch(() => null)
    : null
  await sleep(700)
  const plantedLogged = artifactConsoleEntries()
  const plantedShot = await tryShot(win, shotDir, 'content-artifact-planted.png')

  const plantedShape = plantedRendered as {
    title?: string
    headings?: number
    ran?: string | null
    marker?: boolean
    painted?: number
  } | null
  const plantedErrors = plantedLogged.filter(
    (entry) => entry.level === 'error' || entry.level === 'warning'
  )

  checks.push({
    id: 'CONT-5',
    criterion: 'An HTML artifact opens rendered, sandboxed, with no console errors',
    title: 'A planted artifact rendered in the frame, ran its script, and logged nothing',
    ok:
      planted.opened &&
      planted.frame !== null &&
      // The fixture has to be there and be discriminating before any of this
      // means anything: it declares a title, a heading and a script whose
      // effect is readable back out of the DOM.
      readFileSync(fixtures.artifact, 'utf8').includes('HELMM6ARTIFACT') &&
      plantedShape?.title === 'Fixture artifact' &&
      (plantedShape.headings ?? 0) > 0 &&
      // "Rendered" is the fixture's own marker read back out of the *laid-out
      // text*, not a height threshold. The height one was inherited from when
      // this probe measured a real lesson page and was calibrated for it: a
      // 409-byte fixture is legitimately about 100px tall, so `> 200` failed a
      // document that had rendered perfectly. Inflating the fixture to clear
      // the number would have been fitting the fixture to the test. The marker
      // is the stronger claim anyway - it says the bytes on disk reached the
      // DOM and were laid out as text, which a blank or unloaded document
      // cannot fake at any height.
      plantedShape.marker === true &&
      (plantedShape.painted ?? 0) > 0 &&
      // The inline script ran, which is what says the sandbox allows scripts
      // rather than that the document merely parsed.
      plantedShape.ran === 'ran' &&
      plantedErrors.length === 0,
    detail: {
      file: fixtures.artifact,
      bytesOnDisk: statSync(fixtures.artifact).size,
      frameUrl: planted.frame?.url ?? null,
      rendered: plantedRendered,
      consoleEntries: plantedLogged,
      screenshot: plantedShot.file,
      screenshotError: plantedShot.error
    },
    notes: [
      'Against a fixture this file writes, deliberately. The same claim used to be made about',
      'a file from the developer’s vault and went red twice for reasons that were not about',
      'Helm - a corpus other people write to is not a fixture, however real it is.',
      'The console is read from the main process, which is the only place it can be read - the',
      'frame has an opaque origin, so the window hosting it cannot reach its console.',
      '"Rendered" is the fixture’s own marker token read back out of the laid-out text inside',
      'the frame, so a document that loaded but painted nothing still fails; `ran` is the',
      'inline script’s own effect, so one that parsed but was not allowed to execute fails too.',
      'This also covers the wikilink bootstrap the protocol injects: it runs in this document,',
      'and anything it threw would land in the console asserted clean here.'
    ]
  })

  // ---- CONT-5b: the same thing, over a file Helm did not write -------------

  /**
   * A real artifact out of the real vault, reported rather than gated.
   *
   * Worth keeping and worth *not* asserting on. A planted fixture can only
   * contain what the driver thought to write, and the one thing a real artifact
   * has that a fixture never will is surprises - so this still opens one, and
   * the report names it and says what came back.
   *
   * What it asserts is the half that is about **Helm**: that a file the check
   * did not write can be served and framed at all. What it does not assert is
   * anything about that file's *contents* - no heading count, no height, no
   * console threshold - because those are facts about somebody else's file, and
   * gating on them is precisely the thing that made this probe go red twice for
   * reasons that were not about the code.
   *
   * That is not a check softened until it cannot fail: the criterion is carried
   * whole by `CONT-5` above, against bytes this file owns. This is additional
   * coverage, and it fails when the protocol cannot serve a real file.
   */
  const realArtifact =
    harnessPath !== null
      ? ctx.content
          .tree(harnessPath, true)
          .files.find((file) => file.kind === 'html' && HTML.test(file.path))
      : undefined

  if (realArtifact) {
    clearArtifactConsole()
    const real = await openArtifact(ctx, harnessPath ?? '', realArtifact.relPath)
    const realRendered = real.frame
      ? await real.frame
          .executeJavaScript(
            `({ title: document.title, headings: document.querySelectorAll('h1,h2,h3').length,
                text: (document.body?.innerText ?? '').length,
                painted: document.body ? document.body.scrollHeight : 0 })`
          )
          .catch(() => null)
      : null
    await sleep(700)
    const realLogged = artifactConsoleEntries()
    const realShot = await tryShot(win, shotDir, 'content-artifact-real.png')

    checks.push({
      id: 'CONT-5b',
      criterion: 'An HTML artifact opens rendered, sandboxed, with no console errors',
      title: `A real artifact from the vault (${realArtifact.relPath}) was served and framed`,
      ok: real.opened && real.frame !== null,
      detail: {
        file: realArtifact.path,
        bytesOnDisk: statSync(realArtifact.path).size,
        frameUrl: real.frame?.url ?? null,
        rendered: realRendered,
        // Reported, not asserted. A real artifact that logs is a fact about
        // that file; the console claim is CONT-5's, over a document this check
        // wrote.
        consoleEntries: realLogged,
        screenshot: realShot.file,
        screenshotError: realShot.error
      },
      notes: [
        'The one probe here that opens a file Claude actually produced, kept for exactly that.',
        'It asserts only that Helm could serve and frame it - what is *inside* somebody else’s',
        'file is reported and never gated on, because gating on it is what made this go red',
        'twice for reasons that had nothing to do with the code.',
        'A reader comparing runs should read `rendered` and `consoleEntries` here as findings',
        'about the vault, not as a verdict on Helm.'
      ]
    })
  } else if (harnessPath !== null) {
    // Said out loud rather than skipped, so nobody infers coverage that is not
    // there - `PROF-4` is what happens when nobody is told.
    checks.push({
      id: 'CONT-5b',
      criterion: 'An HTML artifact opens rendered, sandboxed, with no console errors',
      title: 'This harness holds no HTML at all, so nothing real was opened',
      ok: true,
      detail: { scope: harnessPath },
      notes: [
        'Not a failure: a harness legitimately holds no generated report. The criterion is',
        'carried by CONT-5 against a planted artifact either way; this only means the extra',
        'coverage over a real one did not happen on this machine.'
      ]
    })
  }

  // ---- and the sandbox itself, interrogated from inside --------------------
  clearArtifactConsole()
  const { opened, frame } = await openArtifact(ctx, fixtures.root, 'lessons/hostile.html')
  const probe = frame
    ? await frame
        .executeJavaScript(
          `(async () => ({
            ...window.__helmProbe,
            fetch: await window.__helmFetch,
            top: window.__helmTop,
            remoteImage: document.getElementById('remote')?.naturalWidth ?? -1,
            cookies: (() => { try { return document.cookie } catch (e) { return 'blocked' } })(),
            storage: (() => { try { localStorage.setItem('x','1'); return 'allowed' } catch (e) { return 'blocked' } })()
          }))()`
        )
        .catch((err: unknown) => ({ error: String(err) }))
    : null
  await sleep(500)
  const hostileConsole = artifactConsoleEntries()
  const hostileShot = await screenshot(win, shotDir, 'content-artifact-sandbox.png')

  const p = (probe ?? {}) as Record<string, unknown>
  const nodeAbsent =
    p['require'] === 'undefined' && p['process'] === 'undefined' && p['module'] === 'undefined'
  const bridgeAbsent = p['helm'] === 'undefined'
  const opaque = String(p['origin'] ?? '') === 'null'
  const fetchBlocked = String(p['fetch'] ?? '').startsWith('rejected')
  const topBlocked = String(p['top'] ?? '').startsWith('blocked')
  const remoteImageBlocked = Number(p['remoteImage'] ?? -1) === 0

  // ---- and the protocol's own containment ---------------------------------
  const roots = artifactRoots()
  const token = roots.find((entry) => entry.file.toLowerCase() === fixtures.hostile.toLowerCase())?.token
  let traversal: Record<string, unknown> = { attempted: false }
  if (token !== undefined) {
    /**
     * Two spellings of the same attack, because they fail in different places.
     *
     * `%2e%2e/` is decoded and *normalised away by the URL parser* before the
     * handler is reached - `helm-content` is a standard scheme, so Chromium
     * collapses dot segments and the token itself is popped off the path. The
     * request arrives naming no token at all, which is a 404. Worth asserting,
     * but it proves the parser rather than the guard.
     *
     * `%2e%2e%2f` survives, because `%2f` is never decoded during
     * canonicalisation. The handler receives one segment, decodes it itself,
     * and `../../secret` reaches `resolve()` - which is precisely the input the
     * containment check exists for, and the only way to actually exercise it.
     */
    const secret = encodeURIComponent(basename(fixtures.secret))
    const normalised = `helm-content://artifact/${token}/%2e%2e/%2e%2e/${secret}`
    const encoded = `helm-content://artifact/${token}/%2e%2e%2f%2e%2e%2f${secret}`
    const sibling = `helm-content://artifact/${token}/artifact.html`
    try {
      const byParser = await net.fetch(normalised)
      const byGuard = await net.fetch(encoded)
      const allowed = await net.fetch(sibling)
      const leaked = `${await byParser.text().catch(() => '')}${await byGuard.text().catch(() => '')}`
      traversal = {
        attempted: true,
        secretOnDisk: fixtures.secret,
        normalisedByTheUrlParser: { url: normalised, status: byParser.status },
        refusedByTheContainmentCheck: { url: encoded, status: byGuard.status },
        eitherLeakedTheSecret: leaked.includes('HELMM6SECRET'),
        siblingStatus: allowed.status,
        siblingIsServed: allowed.status === 200,
        csp: allowed.headers.get('content-security-policy')
      }
    } catch (err) {
      traversal = { attempted: true, error: String(err) }
    }
  }

  const csp = String(traversal['csp'] ?? '')
  const cspHasNoNetwork =
    csp.includes("default-src 'none'") &&
    csp.includes("connect-src 'none'") &&
    !/https?:/.test(csp)

  checks.push({
    id: 'CONT-6',
    criterion: 'HTML files render in a sandboxed webview (no node, no remote content)',
    title: 'The frame reports no Node, an opaque origin, a rejected fetch, and a blocked remote image; the protocol refuses to leave the artifact’s directory',
    ok:
      opened &&
      frame !== null &&
      nodeAbsent &&
      bridgeAbsent &&
      opaque &&
      fetchBlocked &&
      topBlocked &&
      remoteImageBlocked &&
      (traversal['refusedByTheContainmentCheck'] as { status?: number } | undefined)?.status === 403 &&
      (traversal['normalisedByTheUrlParser'] as { status?: number } | undefined)?.status === 404 &&
      traversal['eitherLeakedTheSecret'] === false &&
      traversal['siblingIsServed'] === true &&
      cspHasNoNetwork,
    detail: {
      frameUrl: frame?.url ?? null,
      insideTheFrame: probe,
      assertions: {
        nodeAbsent,
        preloadBridgeAbsent: bridgeAbsent,
        opaqueOrigin: opaque,
        fetchRejected: fetchBlocked,
        topWindowUnreachable: topBlocked,
        remoteImageBlocked
      },
      protocol: traversal,
      contentSecurityPolicy: csp,
      consoleEntries: hostileConsole,
      screenshot: hostileShot.file
    },
    notes: [
      'This is the sandbox asserted rather than the flags trusted. Every value comes from',
      '`WebFrameMain.executeJavaScript` *inside* the frame - which reaches an opaque-origin',
      'document that the window hosting it cannot touch - and the fixture actively tries each',
      'thing it must not be able to do.',
      'The frame is expected to log CSP violations here; they are the evidence, not a failure.',
      'CONT-5 is where "no console errors" is measured, against a real artifact.',
      'The traversal is tried twice. `%2e%2e/` is normalised away by the URL parser and never',
      'reaches the handler, which is a 404 and proves the parser. `%2e%2e%2f` survives - `%2f`',
      'is never decoded during canonicalisation - and is what actually reaches `resolve()`, so',
      'the 403 is the containment check refusing rather than the URL never arriving.'
    ]
  })

  // ---- CONT-15: wikilinks inside a rendered artifact -----------------------

  /**
   * A `[[wikilink]]` in an HTML artifact, from inside the frame to the note it
   * opens.
   *
   * The whole path is exercised because every part of it is unusual. The
   * brackets are rewritten by a bootstrap the *protocol handler* injected, in a
   * document with an opaque origin that this window cannot read; the click is
   * carried out by `postMessage`, the only channel a sandboxed frame has; and
   * the target is resolved by the main process, because the frame is
   * deliberately told which names resolve and no paths at all.
   *
   * So the assertions are: the bracket became an anchor, the broken one is
   * marked and is *not* the same as the live one, the frame holds no path, and
   * clicking it lands the pane on the note.
   */
  clearArtifactConsole()
  const link = await openArtifact(ctx, fixtures.root, 'lessons/artifact.html')
  const inFrame = link.frame
    ? await link.frame
        .executeJavaScript(
          `({
             live: document.querySelectorAll('a[data-helm-wikilink="beta"]').length,
             broken: document.querySelectorAll('a.helm-wikilink-broken').length,
             brokenTarget: document.querySelector('a.helm-wikilink-broken')?.dataset.helmWikilink ?? null,
             stillLiteral: (document.body.innerText || '').includes('[[beta]]'),
             // Nothing in the frame may carry a filesystem path. The table it
             // was given is names to booleans, and this is what says so.
             pathsInTheDocument: /[A-Za-z]:\\\\\\\\|helm-data/.test(document.documentElement.outerHTML)
           })`
        )
        .catch(() => null)
    : null

  let landedOn: string | null = null
  if (link.frame && inFrame !== null) {
    await link.frame
      .executeJavaScript(`document.querySelector('a[data-helm-wikilink="beta"]')?.click(), 1`)
      .catch(() => undefined)
    await pollJs(win, `document.querySelector('[data-content-body]')?.dataset.contentPath`, 15_000)
    await sleep(500)
    landedOn = await js<string | null>(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath ?? null`
    )
  }

  const frameShape = inFrame as {
    live?: number
    broken?: number
    brokenTarget?: string | null
    stillLiteral?: boolean
    pathsInTheDocument?: boolean
  } | null
  const expectedTarget = join(fixtures.notes, 'beta.md')

  checks.push({
    id: 'CONT-15',
    criterion: 'The wikilink index resolves inside rendered HTML as well as markdown',
    title: 'A `[[wikilink]]` in an artifact is a link, and clicking it opens the note',
    ok:
      link.opened &&
      link.frame !== null &&
      // The fixture has to carry both, or "one link, no broken ones" would also
      // be what a bootstrap that never ran reports.
      readFileSync(fixtures.artifact, 'utf8').includes('[[beta]]') &&
      readFileSync(fixtures.artifact, 'utf8').includes('[[never-written]]') &&
      existsSync(expectedTarget) &&
      (frameShape?.live ?? 0) === 1 &&
      (frameShape?.broken ?? 0) === 1 &&
      frameShape?.brokenTarget === 'never-written' &&
      frameShape.stillLiteral === false &&
      frameShape.pathsInTheDocument === false &&
      landedOn?.toLowerCase() === expectedTarget.toLowerCase(),
    detail: {
      artifact: fixtures.artifact,
      insideTheFrame: frameShape,
      clickLandedOn: landedOn,
      expected: expectedTarget,
      artifactConsole: artifactConsoleEntries().map((entry) => `${entry.level}: ${entry.message}`)
    },
    notes: [
      'Read from inside the frame through WebFrameMain, which is the only reader that can - the',
      'document has an opaque origin, so the window hosting it cannot see into it at all.',
      '`pathsInTheDocument` is the security half: the bootstrap is given names and booleans, and',
      'a regression that started injecting resolved paths would hand a filesystem layout to code',
      'Helm did not write. The broken link is asserted separately from the live one so that a',
      'bootstrap which linked everything, or nothing, fails rather than half-passing.'
    ]
  })

  return checks
}

// ---------------------------------------------------------------------------
// CONT-7: search, measured
// ---------------------------------------------------------------------------

async function searchChecks(ctx: CheckContext, harnessPath: string): Promise<Check[]> {
  const { win, content } = ctx
  const tree = content.tree(harnessPath, true)
  const markdown = tree.files.filter((file) => file.kind === 'markdown')

  /**
   * The corpus, read again here, so the expected counts are this file's own.
   *
   * Every file, not just the ones whose text is read: **names are matched for
   * every kind**, and a counter holding only the bodies would expect fewer hits
   * than the pane honestly returns for any term matching an artifact's or a
   * data file's name.
   *
   * The set whose *bodies* are read is written out here in this file's own
   * words rather than taken from the result, because a reader that asked the
   * pane what it searched and then agreed with it would be measuring nothing.
   * The result carries the same list, and `bodyKindsAgree` below checks the two
   * against each other - so widening the search in `core` turns this red and a
   * person decides, instead of the expectation quietly following the code.
   */
  const BODY_KINDS = ['markdown', 'data', 'text', 'source']

  /**
   * And the size ceiling, which is part of the same rule.
   *
   * "A single file large enough to be a database dump is not prose" - a file
   * over this is carried by name and its bytes are not read. Stated here in
   * this file's own words for the same reason the kind list is, and it is not
   * hypothetical: this harness holds a 29 MB `tools/password-hunt-results.txt`,
   * and a reader without the ceiling expected 42,745 matches for "the" against
   * the 10,043 the pane honestly found.
   */
  const BODY_MAX_BYTES = 4 * 1024 * 1024

  const corpus = tree.files.map((file) => ({
    file,
    text:
      BODY_KINDS.includes(file.kind) && file.size <= BODY_MAX_BYTES
        ? readFileSync(file.path, 'utf8')
        : ''
  }))

  const countOccurrences = (needle: string): { files: number; matches: number } => {
    const lower = needle.toLowerCase()
    let files = 0
    let matches = 0
    for (const entry of corpus) {
      const text = entry.text.toLowerCase()
      let at = text.indexOf(lower)
      let n = 0
      while (at >= 0) {
        n++
        at = text.indexOf(lower, at + lower.length)
      }
      const named =
        entry.file.relPath.toLowerCase().includes(lower) ||
        entry.file.title.toLowerCase().includes(lower)
      if (n > 0 || named) files++
      matches += n
    }
    return { files, matches }
  }

  /**
   * Terms drawn from the corpus itself, plus terms that are in none of it.
   *
   * A latency figure taken only from words that match is a figure taken from
   * early exits; a search that finds nothing still has to read every byte, and
   * that is the slow case the budget has to cover.
   */
  const terms = [
    'schema',
    'snapshot',
    'the',
    'claude',
    'wikilink',
    'migration',
    'release',
    'session',
    'overlay',
    'harness',
    'report',
    'shim',
    'resume',
    'settings',
    'e',
    'zzzznotinthecorpus',
    'qqqqqqqq',
    'helm',
    'spike',
    'terminal'
  ]

  await selectScope(win, harnessPath)

  /**
   * Measured in the renderer, around `window.helm.invoke`.
   *
   * That is the number the criterion is about: a search that takes 2 ms in the
   * main process and 300 ms to arrive is a 300 ms search. Each term is run
   * several times and every sample is kept, so the percentiles are over
   * repetitions as well as over terms.
   */
  const samples = await js<Array<{ term: string; ms: number; files: number; matches: number; cold: boolean; mainMs: number }>>(
    win,
    `(async () => {
      const terms = ${JSON.stringify(terms)};
      const scopePath = ${JSON.stringify(harnessPath)};
      const out = [];
      for (let round = 0; round < 5; round++) {
        for (const term of terms) {
          const started = performance.now();
          const result = await window.helm.invoke('content:search', { scopePath, query: term });
          const ms = performance.now() - started;
          out.push({ term, ms, files: result.hits.length, matches: result.totalMatches,
            cold: result.cold, mainMs: result.tookMs });
        }
      }
      return out;
    })()`
  )

  const warm = samples.filter((sample) => !sample.cold)
  const cold = samples.filter((sample) => sample.cold)
  const times = warm.map((sample) => sample.ms)
  const p50 = round(percentile(times, 50))
  const p95 = round(percentile(times, 95))
  const worst = round(Math.max(...times, 0))

  /**
   * How many *files* a result may carry.
   *
   * The hit list is bounded - a hundred-thousand-match term must not paint a
   * row per file - and the pane says so on screen with "More files matched than
   * are listed". `totalMatches` is not bounded, which is why the match counts
   * below are compared unconditionally and the file counts are compared against
   * the bound.
   *
   * This started mattering when the corpus grew to include data, text and
   * source: "the" now matches 225 files where it used to match fewer than 200,
   * so the cap began to bite and a reader that did not model it called a
   * correct result wrong.
   */
  const MAX_HIT_FILES = 200

  const wrong: Array<Record<string, unknown>> = []
  for (const term of terms) {
    const sample = warm.find((entry) => entry.term === term) ?? samples.find((entry) => entry.term === term)
    if (!sample) continue
    const expected = countOccurrences(term)
    const expectedFiles = Math.min(expected.files, MAX_HIT_FILES)
    if (sample.matches !== expected.matches || sample.files !== expectedFiles) {
      wrong.push({
        term,
        pane: { files: sample.files, matches: sample.matches },
        independentCount: expected,
        expectedFilesAfterTheCap: expectedFiles
      })
    }
  }

  // And through the box, so the number on screen is the number measured.
  //
  // Polled rather than slept at. A fixed wait was racing the search - the box
  // debounces, then main answers, and this read landed on "Searching…" often
  // enough once the corpus grew. `[data-search-scope]` is painted only when a
  // result has arrived, so it is the thing to wait for.
  await setValue(win, 'input[data-content-search]', 'geofenc')
  await pollJs(win, `document.querySelector('[data-search-scope]')`, 20_000)
  await sleep(200)
  const throughTheBox = await js<{
    status: string
    rows: number
    tookAttr: string | null
    scopeAttr: string | null
  }>(
    win,
    `(() => ({
      status: (document.querySelector('[data-content-status]')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      rows: document.querySelectorAll('button[data-content-hit]').length,
      tookAttr: document.querySelector('[data-search-took]')?.dataset.searchTook ?? null,
      scopeAttr: document.querySelector('[data-search-scope]')?.dataset.searchScope ?? null
    }))()`
  )

  /**
   * What the pane says it read, against what this file assumed it read.
   *
   * Two independent statements of one rule, compared. This is what keeps the
   * corpus above honest: it is written out here rather than derived, so it can
   * be wrong - and this is the line that says so when it is.
   */
  const reportedBodyKinds = (throughTheBox.scopeAttr ?? '').split(',').filter((kind) => kind !== '')
  const bodyKindsAgree =
    reportedBodyKinds.length === BODY_KINDS.length &&
    [...reportedBodyKinds].sort().join(',') === [...BODY_KINDS].sort().join(',')
  await setValue(win, 'input[data-content-search]', '')
  await sleep(400)

  return [
    {
      id: 'CONT-7',
      criterion: 'Search finds text across notes and skill files in <200ms',
      title: `p50 ${String(p50)} ms, p95 ${String(p95)} ms over ${String(times.length)} searches of ${String(markdown.length)} files`,
      ok:
        times.length > 0 &&
        p95 < 200 &&
        wrong.length === 0 &&
        throughTheBox.rows > 0 &&
        bodyKindsAgree &&
        // The status row has to *say* what was searched, which is the half of
        // this criterion that is not about speed.
        /text in \d+, names in \d+/.test(throughTheBox.status),
      detail: {
        scope: harnessPath,
        filesSearched: markdown.length,
        bodyKinds: { thisFileExpects: BODY_KINDS, thePaneReports: reportedBodyKinds },
        bytes: corpus.reduce((n, entry) => n + entry.text.length, 0),
        samples: times.length,
        p50,
        p95,
        worst,
        budgetMs: 200,
        firstSearchInAColdScope: cold.map((sample) => ({ term: sample.term, ms: round(sample.ms) })),
        mainProcessP95: round(percentile(warm.map((sample) => sample.mainMs), 95)),
        disagreementsWithAnIndependentCount: wrong,
        throughTheBox,
        perTerm: terms.map((term) => {
          const forTerm = warm.filter((sample) => sample.term === term).map((sample) => sample.ms)
          return { term, p50: round(percentile(forTerm, 50)), samples: forTerm.length }
        })
      },
      notes: [
        'Measured in the renderer around `window.helm.invoke`, so the IPC round trip is inside',
        'the number. Five rounds over twenty terms, including two that match nothing - a miss',
        'has to read every byte, and is the slow case the budget must cover.',
        'The first search in a scope reads the corpus off disk and is reported separately',
        'rather than being dropped: it is a real thing that happens, but it is not what the',
        'criterion is about.',
        'Match counts are checked against an `indexOf` loop written in this file over its own',
        'read of the same files.',
        'Which kinds have their *bodies* read is stated here and compared against what the pane',
        'reports, so widening the search in core turns this red rather than quietly moving the',
        'expectation with it. Names are matched for every kind, always.',
        'The status row is required to say what was searched: that is the second half of the',
        'criterion, and a search that answered correctly while saying nothing about its own',
        'scope is the thing this pane was rebuilt to stop.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// CONT-8: editing a real note
// ---------------------------------------------------------------------------

async function editChecks(
  ctx: CheckContext,
  shotDir: string,
  harnessPath: string,
  dataDir: string
): Promise<Check[]> {
  const { win, content, services } = ctx
  const tree = content.tree(harnessPath, true)

  /**
   * A real note from the user's vault, chosen deterministically and asserted to
   * be worth choosing.
   *
   * The criterion is that a save *preserves frontmatter exactly*, and a note
   * whose frontmatter this check wrote itself would preserve it trivially. So
   * this picks the first note in `notes/` - by path, so it does not change with
   * mtimes - that declares at least three top-level keys, and fails outright if
   * there is no such note rather than quietly proving nothing.
   */
  const candidates = tree.files
    .filter((file) => file.kind === 'markdown' && file.root === 'notes')
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
  const note = candidates.find((file) => countSource(readFileSync(file.path, 'utf8')).frontmatterKeys.length >= 3)

  if (!note) {
    return [
      {
        id: 'CONT-8',
        criterion: 'Editing a note and saving preserves frontmatter exactly and snapshots the prior version',
        title: 'No note in the vault has three frontmatter keys, so the check has no discriminating fixture',
        ok: false,
        detail: { candidates: candidates.length, scope: harnessPath },
        notes: ['A check that reads an expected value out of a fixture must assert the fixture is there.']
      }
    ]
  }

  const before = readFileSync(note.path, 'utf8')
  const beforeHash = sha256(before)
  const backup = join(dataDir, 'content-note.backup.md')
  copyFileSync(note.path, backup)

  const frontmatterBefore = before.slice(0, before.indexOf('\n---', 4) + 4)
  const keysBefore = countSource(before).frontmatterKeys
  const snapshotsBefore = countConfigSnapshots(services.store)

  const marker = `\n<!-- helm content probe ${String(Date.now())} -->\n`
  const edited = `${before.replace(/\n*$/, '\n')}${marker}`

  let outcome: Record<string, unknown>
  try {
    await selectScope(win, harnessPath)
    await js<boolean>(
      win,
      `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
          .find((el) => el.dataset.contentFile === ${JSON.stringify(note.relPath)});
        if (!row) return false; row.click(); return true })()`
    )
    await pollJs(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(note.path)}`,
      15_000
    )
    await sleep(300)

    const chips = await js<{ count: number; keys: string[] }>(
      win,
      `(() => {
        const row = document.querySelector('[data-frontmatter-chips]');
        return { count: row ? Number(row.dataset.frontmatterChips) : 0,
          keys: [...document.querySelectorAll('[data-chip]')].map((el) => el.dataset.chip) };
      })()`
    )

    // Into the split editor, through the toggle a reader would use.
    await click(win, 'button[data-content-mode="edit"]')
    await pollJs(win, `document.querySelector('textarea[data-content-editor]')`, 10_000)
    await sleep(400)

    await setValue(win, 'textarea[data-content-editor]', edited)
    await sleep(500)
    const dirtyBeforeSave = await js<boolean>(
      win,
      `document.querySelector('[data-content-dirty]')?.dataset.contentDirty === 'true'`
    )
    // The split preview must have redrawn from the draft, not from the file.
    const previewShowsDraft = await pollJs(
      win,
      `(document.querySelector('[data-content-body]')?.textContent ?? '').length > 0`,
      8_000
    )
    const editorShot = await screenshot(win, shotDir, 'content-editor.png')

    const saved = await click(win, 'button[data-content-save]')
    await sleep(1400)

    const after = readFileSync(note.path, 'utf8')
    const frontmatterAfter = after.slice(0, after.indexOf('\n---', 4) + 4)
    const keysAfter = countSource(after).frontmatterKeys
    const snapshots = content.snapshots(harnessPath, note.path)
    const newest = snapshots[0]
    const snapshotsAfter = countConfigSnapshots(services.store)

    // Back to how it was, out of the snapshot the save produced.
    let restored = false
    let restoredHashMatches = false
    if (newest) {
      const result = content.restore(newest.id, note.path)
      restored = result.ok
      restoredHashMatches = sha256File(note.path) === beforeHash
    }

    outcome = {
      file: note.path,
      frontmatterKeys: keysBefore,
      chipRow: chips,
      dirtyBeforeSave,
      previewRedrew: previewShowsDraft,
      saved,
      wroteTheMarker: after.includes(marker.trim()),
      frontmatterByteIdentical: frontmatterBefore === frontmatterAfter,
      frontmatterKeysAfter: keysAfter,
      snapshotTaken: newest !== undefined,
      snapshotRecordedTheOriginalHash: newest?.contentHash === beforeHash,
      snapshotRowsAdded: snapshotsAfter - snapshotsBefore,
      restored,
      restoredHashMatches,
      screenshots: [editorShot.file]
    }
  } finally {
    // Whatever happened above, the user's note goes back. Through the plain
    // copy rather than the snapshot table, because this has to work even when
    // the failure was in the snapshot table.
    if (sha256File(note.path) !== beforeHash && existsSync(backup)) {
      writeFileSync(note.path, readFileSync(backup))
    }
  }

  return [
    {
      id: 'CONT-8',
      criterion: 'Editing a note and saving preserves frontmatter exactly and snapshots the prior version',
      title: `${note.relPath} was edited through the split editor; its frontmatter came back byte for byte and the prior version is in the snapshot table`,
      ok:
        outcome['saved'] === true &&
        outcome['dirtyBeforeSave'] === true &&
        outcome['wroteTheMarker'] === true &&
        outcome['frontmatterByteIdentical'] === true &&
        outcome['snapshotTaken'] === true &&
        outcome['snapshotRecordedTheOriginalHash'] === true &&
        outcome['snapshotRowsAdded'] === 1 &&
        outcome['restored'] === true &&
        outcome['restoredHashMatches'] === true &&
        (outcome['chipRow'] as { count?: number } | undefined)?.count !== 0,
      detail: { ...outcome, backup, independentPreEditHash: beforeHash, finalHash: sha256File(note.path) },
      notes: [
        'A real note in the user’s vault, not a fixture: the criterion is about preserving',
        'frontmatter somebody else wrote. It is backed up first, restored from the snapshot the',
        'save produced, and hash-verified against a sha256 taken in this file before anything',
        'was typed.',
        'The snapshot is the same table and the same code path the config console writes through -',
        '`writeSnapshottedFile`, with a content guard instead of a config one - so "the prior',
        'version is snapshotted" is a property of the mechanism rather than of this feature.'
      ]
    },
    {
      id: 'CONT-9',
      criterion: 'The content viewer may not write outside content',
      title: 'The write path refuses a path outside the scope, inside repos/, and with a non-content extension',
      ok: await (async () => {
        const refusals = [
          join(harnessPath, 'repos', 'any-repo', 'notes', 'x.md'),
          join(harnessPath, 'notes', 'x.exe'),
          join(dataDir, 'outside-every-scope.md')
        ]
        for (const path of refusals) {
          try {
            content.write({ scopePath: harnessPath, path, content: 'x', expectedHash: null, reason: 'edit' })
            return false
          } catch {
            // Refused, which is the point.
          }
          if (existsSync(path)) return false
        }
        return true
      })(),
      detail: {
        refused: [
          `${harnessPath}\\repos\\...  (a nested repository is its own scope)`,
          `${harnessPath}\\notes\\x.exe  (not a file the viewer reads)`,
          `${dataDir}\\outside-every-scope.md  (outside the scope named in the request)`
        ]
      },
      notes: [
        'The guard is the only thing the content viewer adds to that write. Everything else - the snapshot, the',
        'conflict check, the refusal to rewrite a binary - is shared code, so this is the part',
        'that needs its own check.'
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// CONT-10: scrolling a long document, measured
// ---------------------------------------------------------------------------

interface SourceScrollHold {
  file: string
  waitedMs: number
  scrolledTo: number
  afterUnwrapped: number
  sameNodeUnwrapped: boolean
  wrappedScrolledTo: number
  afterWrapped: number
  sameNodeWrapped: boolean
  innerHtmlWrites: number
}

/**
 * Scroll a source file, wait, and see whether it is still there - unwrapped and
 * wrapped. See CONT-16 for what this is guarding.
 *
 * The file is found by opening candidates and measuring, because the row in the
 * list carries no size and a path written down here would name a short file on
 * a machine that is not this one.
 */
async function sourceScrollHolds(
  ctx: CheckContext,
  fixtures: Fixtures
): Promise<SourceScrollHold | null> {
  const { win } = ctx
  const WAIT_MS = 9000

  // The planted file first, then whatever else the scope happens to hold. The
  // fixture is what makes this probe able to run at all; the fallback is so a
  // scope that has moved on still gets measured rather than skipped.
  const planted = relative(fixtures.root, fixtures.bigSource).split(sep).join('/')
  const found = await js<string[]>(
    win,
    `[...document.querySelectorAll('[data-content-file]')]
       .map((el) => el.dataset.contentFile || '')
       .filter((p) => /\\.(json|ya?ml|mjs|cjs|js|ts|tsx|py|ps1|sh|css|log|toml|ini)$/i.test(p))`
  ).catch(() => [] as string[])
  const candidates = [planted, ...found.filter((p) => p !== planted)]

  for (const file of candidates.slice(0, 14)) {
    const opened = await js<boolean>(
      win,
      `(() => {
         const el = [...document.querySelectorAll('[data-content-file]')]
           .find((b) => b.dataset.contentFile === ${JSON.stringify(file)})
         if (!el) return false
         el.click()
         return true
       })()`
    ).catch(() => false)
    if (!opened) continue
    if (!(await pollJs(win, `document.querySelector('[data-content-source] pre')`, 8000))) continue
    await sleep(350)

    // Armed: the block is scrolled, and every write to the injected subtree is
    // counted from here so the cause is reported beside the symptom.
    const armed = await js<number>(
      win,
      `(() => {
         const view = document.querySelector('.source-view')
         const pre = view && view.querySelector('pre')
         if (!pre || pre.scrollHeight <= pre.clientHeight + 200) return 0
         pre.scrollTop = 600
         window.__contScroll = { view, pre, writes: 0 }
         const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')
         Object.defineProperty(view, 'innerHTML', {
           configurable: true,
           get() { return desc.get.call(this) },
           set(v) { window.__contScroll.writes += 1; desc.set.call(this, v) }
         })
         return pre.scrollTop
       })()`
    ).catch(() => 0)
    if (armed === 0) continue

    await sleep(WAIT_MS)

    const unwrapped = await js<{ top: number; same: boolean }>(
      win,
      `(() => {
         const pre = document.querySelector('[data-content-source] pre')
         return { top: pre ? pre.scrollTop : -1, same: pre === window.__contScroll.pre }
       })()`
    ).catch(() => ({ top: -1, same: false }))

    // Now the same claim with wrapping on, which is the other half of the report.
    const wrappedTo = await js<number>(
      win,
      `(() => {
         const b = document.querySelector('[data-content-wrap]')
         if (b && b.getAttribute('aria-pressed') === 'false') b.click()
         const pre = document.querySelector('[data-content-source] pre')
         if (!pre) return 0
         pre.scrollTop = 500
         window.__contScroll.pre2 = pre
         return pre.scrollTop
       })()`
    ).catch(() => 0)

    await sleep(WAIT_MS)

    const wrapped = await js<{ top: number; same: boolean; writes: number }>(
      win,
      `(() => {
         const pre = document.querySelector('[data-content-source] pre')
         return {
           top: pre ? pre.scrollTop : -1,
           same: pre === window.__contScroll.pre2,
           writes: window.__contScroll.writes
         }
       })()`
    ).catch(() => ({ top: -1, same: false, writes: -1 }))

    return {
      file,
      waitedMs: WAIT_MS,
      scrolledTo: armed,
      afterUnwrapped: unwrapped.top,
      sameNodeUnwrapped: unwrapped.same,
      wrappedScrolledTo: wrappedTo,
      afterWrapped: wrapped.top,
      sameNodeWrapped: wrapped.same,
      innerHtmlWrites: wrapped.writes
    }
  }
  return null
}

async function scrollChecks(
  ctx: CheckContext,
  shotDir: string,
  harnessPath: string,
  fixtures: Fixtures
): Promise<Check[]> {
  const { win, content } = ctx

  /**
   * Scrolls the document one frame at a time and records the intervals.
   *
   * `requestAnimationFrame` is the honest instrument here: it fires when the
   * compositor is ready for the next frame, so an interval of 16.7 ms is a
   * frame that made it and 50 ms is three that did not. Scrolling by a fixed
   * amount per frame means the work per frame is the work a real wheel gesture
   * causes.
   */
  const measure = async (path: string): Promise<Record<string, unknown>> => {
    await pollJs(
      win,
      `document.querySelector('[data-content-body]')?.dataset.contentPath === ${JSON.stringify(path)}`,
      30_000
    )
    await sleep(600)
    const frames = await js<{ frames: number[]; height: number; words: number }>(
      win,
      `(() => new Promise((resolve) => {
        const el = document.querySelector('[data-content-scroll]');
        if (!el) { resolve({ frames: [], height: 0, words: 0 }); return; }
        el.scrollTop = 0;
        const frames = [];
        let last = performance.now();
        let n = 0;
        const step = () => {
          const now = performance.now();
          frames.push(now - last);
          last = now;
          el.scrollTop += 140;
          n++;
          if (n < 150 && el.scrollTop + el.clientHeight < el.scrollHeight) {
            requestAnimationFrame(step);
          } else {
            resolve({ frames, height: el.scrollHeight,
              words: Number(document.querySelector('[data-content-words]')?.dataset.contentWords ?? 0) });
          }
        };
        requestAnimationFrame(step);
      }))()`
    )
    // The first interval is the gap between the request and the first frame,
    // not a frame that was rendered; dropping it stops a scheduling artefact
    // from becoming the worst number in the set.
    const intervals = frames.frames.slice(1)
    return {
      path,
      words: frames.words,
      scrollHeight: frames.height,
      frames: intervals.length,
      p50: round(percentile(intervals, 50)),
      p95: round(percentile(intervals, 95)),
      worst: round(Math.max(...intervals, 0)),
      framesOver32ms: intervals.filter((ms) => ms > 32).length,
      framesOver50ms: intervals.filter((ms) => ms > 50).length
    }
  }

  const results: Array<Record<string, unknown>> = []

  // ---- the largest real note in the vault ---------------------------------
  // Picked by size rather than by filename. A filename written down here is
  // one machine's, and `if (named)` means the day that note is renamed this
  // measurement silently stops happening - the check would keep passing with
  // one fewer piece of evidence behind it. The largest note is always there
  // and is the harder render besides.
  const named = content
    .tree(harnessPath, true)
    .files.filter((file) => file.relPath.toLowerCase().endsWith('.md'))
    .sort((a, b) => b.size - a.size)[0]

  if (named) {
    await selectScope(win, harnessPath)
    await js<boolean>(
      win,
      `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
          .find((el) => el.dataset.contentFile === ${JSON.stringify(named.relPath)});
        if (!row) return false; row.click(); return true })()`
    )
    results.push({ ...(await measure(named.path)), which: 'the largest note in the vault', bytes: named.size })
  }

  // ---- and one that is actually 20,000 words ------------------------------
  await selectScope(win, fixtures.root)
  await js<boolean>(
    win,
    `(() => { const row = [...document.querySelectorAll('button[data-content-file]')]
        .find((el) => el.dataset.contentFile === 'notes/long-document.md');
      if (!row) return false; row.click(); return true })()`
  )
  results.push({
    ...(await measure(fixtures.bigNote)),
    which: 'a synthesised 20,000-word note',
    bytes: statSync(fixtures.bigNote).size
  })

  const shot = await screenshot(win, shotDir, 'content-long-note.png')
  const budgetMs = 32
  const worstP95 = Math.max(...results.map((result) => Number(result['p95'] ?? 0)))

  const held = await sourceScrollHolds(ctx, fixtures)

  return [
    {
      /**
       * CONT-16: a source file stays where it was scrolled to.
       *
       * This exists because of a bug that every other check in this file was
       * blind to. The source view injects shiki's HTML with
       * `dangerouslySetInnerHTML`, and React re-applies that when the *object*
       * it is handed differs rather than when the markup does - so a fresh
       * `{ __html }` per render rebuilt the block on every render of the pane.
       * Measured: three writes of a byte-identical 50,108-character string in
       * twelve idle seconds.
       *
       * Nothing noticed for as long as the *wrapper* owned the scrollbar, since
       * React never touches it. The moment the block itself became the scroll
       * container - which is what puts its horizontal scrollbar at the bottom of
       * the pane instead of the bottom of the file - a rebuilt element meant
       * `scrollTop` went back to 0, and reading down a file was interrupted
       * every few seconds by a jump to the top.
       *
       * So the probe waits rather than measuring an instant: the failure is not
       * visible in any single frame, only in what has happened several seconds
       * later. It asserts the node's identity as well as the offset, because
       * "still at 600" and "rebuilt, and something scrolled it back" are
       * different facts and only one of them is this fixed.
       *
       * The positive control is the scroll itself: a probe whose `scrolledTo`
       * came back 0 would be measuring a block with nothing to scroll, and the
       * assertion requires it to have moved before it can require it to have
       * stayed.
       */
      id: 'CONT-16',
      criterion: 'A source file stays where it was scrolled to, wrapped or not',
      title:
        held === null
          ? 'no source file long enough to scroll was found in this scope'
          : `${held.file}: ${String(held.scrolledTo)}px, still ${String(held.afterUnwrapped)}px unwrapped and ${String(held.afterWrapped)}px wrapped after ${String(held.waitedMs)}ms`,
      ok:
        held !== null &&
        held.scrolledTo > 0 &&
        held.afterUnwrapped === held.scrolledTo &&
        held.sameNodeUnwrapped &&
        held.wrappedScrolledTo > 0 &&
        held.afterWrapped === held.wrappedScrolledTo &&
        held.sameNodeWrapped &&
        held.innerHtmlWrites === 0,
      detail: held === null ? { measured: false } : { ...held },
      notes: [
        'Both states, because the report that found this said "wrap on or off".',
        '`innerHtmlWrites` counts writes to the injected subtree while nothing is',
        'happening. It is the cause rather than the symptom, and it is the number that',
        'goes wrong first: a rebuild is what loses the position.'
      ]
    },
    {
      id: 'CONT-10',
      criterion: 'A 20k-word note (the report-center redesign note) scrolls smoothly',
      title: `p95 frame interval ${String(round(worstP95))} ms across both documents`,
      ok: results.length > 0 && worstP95 <= budgetMs && results.every((r) => Number(r['frames'] ?? 0) > 40),
      detail: {
        budgetMs,
        documents: results,
        note: named
          ? {
              file: named.path,
              bytes: named.size,
              measuredWords: results.find((r) => r['which'] === 'the note the criterion names')?.['words'] ?? null
            }
          : null,
        screenshot: shot.file
      },
      notes: [
        'The note the criterion names is 21,116 *bytes* - about 2,670 words, not 20,000. That',
        'is a discrepancy in the criterion, not a shortfall in the note, so both are measured:',
        'the named file, and a synthesised document that really is 20,000 words.',
        'Frame intervals come from `requestAnimationFrame` while the pane is scrolling 140px',
        'per frame. The budget is 32 ms - two frames at 60 Hz - because a p95 under that is a',
        'scroll with no visible stutter in it.'
      ]
    }
  ]
}

import { app, nativeTheme, type BrowserWindow } from 'electron'
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { readSettings, type AppSettings } from '@helm/core'
import {
  drag,
  readPointerTrace,
  screenshot,
  sendKey,
  sendMouse,
  sleep,
  tracePointer,
  typeText,
  type PointerTrace
} from './bridge'
import type { Check } from './fidelity'
import type { CheckContext } from './sessionscheck'
import { answerPicker } from './packagingcheck'
import { pointReleases, releasesAsked } from './update'

/**
 * The settings pane, driven through the real window.
 *
 * The discipline is the one every check here follows: nothing is believed on
 * Helm's word. Beside every assertion about the UI there is a read this file
 * makes for itself, and for a setting the honest second read is the database -
 * opened here as its **own read-only connection to the file on disk**, not
 * through `services.store`, which is the handle the app just wrote through. A
 * value that has reached the file is a value a restart will find; a value the
 * app is holding in memory is not.
 *
 * Three things cannot be settled by reading a row at all:
 *
 *   Persistence. "It survives a restart" cannot be asserted by the process that
 *   set it - it never restarted. So this driver parks four settings on values
 *   the defaults could not have produced and `scripts/run-settings.mjs` starts
 *   the app again to read them back, exactly the way `usage-check` does.
 *
 *   The side effects. A theme that writes a row and repaints nothing is a
 *   broken setting, so the theme check reads the class on `<html>`, the token
 *   CSS actually resolved, and the colour Electron was handed for the Window
 *   Controls Overlay - captured by wrapping `setTitleBarOverlay` on the window
 *   itself, so it is the argument the platform got rather than Helm's account
 *   of it. Removing a scan root is checked against the *next scan's* project
 *   set, not against the list of roots.
 *
 *   The rejection. "An invalid write does not persist" is exactly the shape of
 *   assertion CLAUDE.md warns about: a probe that can pass because nothing ever
 *   persists proves nothing. So every rejection case is preceded by a valid
 *   write of the same key through the same channel, which must land - if the
 *   control does not persist, the case is discarded rather than passed.
 *
 * `pnpm settings-check` -> helm-data/settings-report.json
 */

const GROUPS = [
  'pane',
  'claude',
  'roots',
  'pins',
  'appearance',
  'accessors',
  'updates',
  'validation',
  'terminal',
  'content',
  'github',
  // Last on purpose. It swaps `USERPROFILE` for the length of the group, and
  // on Windows `os.homedir()` is derived from that variable - so anything that
  // reads a home while it is swapped would read the fixture. See the group.
  'wsl'
] as const
type Group = (typeof GROUPS)[number]

/**
 * The built-in font stack, written out again rather than imported from
 * `terminal.ts`.
 *
 * This is the check's own statement of what "the default stack" is, and the
 * whole of the font rule is that a user's family goes in *front* of it rather
 * than instead of it. Importing the constant would make the assertion "the code
 * agrees with itself".
 */
const DEFAULT_FONT_STACK = '"Cascadia Mono", "Consolas", monospace'

/** Terminal defaults this driver expects a fresh install to be at. Same reason. */
const DEFAULT_TERMINAL = {
  fontSize: 14,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000
} as const

/**
 * The content viewer's wrap defaults, written out here for the same reason.
 *
 * Off, following the config editor rather than the prose one, and a four-column
 * hang. The content group writes these back before it measures anything: the
 * validation group parks both keys on values of its own on the way past, and a
 * check runs against a *copy of the real database*, so neither "off" nor "four"
 * is a state this driver may assume it inherited.
 */
const DEFAULT_CONTENT_WRAP = { wrap: false, indent: 4 } as const

/**
 * The hang the content group sets and then measures, in columns.
 *
 * One constant rather than a 7 in the setter and another in the expected
 * geometry: those two numbers being the same number is the whole of S-12c's
 * second half.
 */
const WRAP_INDENT_COLUMNS = 7

/**
 * The project shell's own bounds, restated here rather than imported.
 *
 * The same reason `DEFAULT_FONT_STACK` is written out: importing
 * `PROJECT_SHELL_HEIGHT_PCT` would make "the pane stops at half" a claim
 * checked against the constant the pane stops at, which is the code agreeing
 * with itself. The floor is a pixel figure because that is what the pane
 * actually enforces - a percentage cannot say "still a usable terminal".
 */
const SHELL_HEIGHT_BOUNDS = { min: 10, max: 50, default: 30 } as const
const SHELL_MIN_PX = 180

/** The session split's bounds, written out for the reason above. */
const SPLIT_BOUNDS = { min: 20, max: 80, default: 45 } as const

/**
 * The shells this driver goes looking for itself, and the arguments it expects
 * each to be launched with.
 *
 * Its own table, not `pterm.ts`'s. The bug the per-shell table replaces was a
 * substring test that gave `-NoLogo` to anything whose *path* contained `pwsh`
 * or `powershell`, so a second opinion about which flags belong to which
 * program is the point.
 */
const EXPECTED_SHELL_ARGS: Record<string, string[]> = {
  'pwsh.exe': ['-NoLogo'],
  'powershell.exe': ['-NoLogo'],
  'cmd.exe': [],
  'wsl.exe': [],
  'bash.exe': []
}

/**
 * The shells that must actually stay running once launched.
 *
 * `wsl.exe` is deliberately not among them: it exists on any machine with the
 * optional component installed and exits immediately when no distribution is,
 * which is a fact about this machine rather than about Helm's arguments.
 */
const MUST_SURVIVE = ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'bash.exe']

/**
 * What the pane paints in a fact it has no value for.
 *
 * Written out again rather than imported from the component: this is the
 * check's own statement of what "nothing to show" looks like, and if the pane
 * starts painting something else the two disagree, which is the point.
 */
const NOTHING = '-'

// ---------------------------------------------------------------------------
// The driver's own reads
// ---------------------------------------------------------------------------

/**
 * One setting, read out of the database file by this driver.
 *
 * A separate connection, opened read-only for the length of one query. Reading
 * through `services.store` would be reading the app's own handle - the same
 * object that just performed the write - and would pass just as happily if
 * nothing had ever been committed.
 *
 * `undefined` means there is no row at all, which is a different fact from a
 * row holding `null` and is why this does not collapse the two.
 */
function rowValue(dbFile: string, key: keyof AppSettings): unknown {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (row === undefined) return undefined
    try {
      return JSON.parse(row.value)
    } catch {
      return { unparseable: row.value }
    }
  } finally {
    db.close()
  }
}

/**
 * The same row, uninterpreted - the characters actually in the column.
 *
 * For the assertion "this did not move", where `rowValue`'s parse is a
 * softening: two instants a millisecond apart parse to two different strings
 * and compare unequal, but so would a rewrite of the same instant in a
 * different shape, and it is the *write* that S-18 is looking for. Comparing
 * the stored text catches a row that was written again with the same value.
 */
function rawRow(dbFile: string, key: keyof AppSettings): string | undefined {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  } finally {
    db.close()
  }
}

/**
 * Every path in the discovery cache, read by this driver's own connection.
 *
 * The `projects` table rather than `app_settings`, and it is a different claim
 * from the settings one: a root can leave the setting and leave the tree while
 * its rows sit in the cache, and those rows are what the launcher paints from
 * before the first scan of the next start lands. "Removed" that leaves them
 * behind is removed until you restart.
 */
function cachedProjectPaths(dbFile: string): string[] {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  try {
    return (db.prepare('SELECT path FROM projects').all() as Array<{ path: string }>).map(
      (row) => row.path
    )
  } finally {
    db.close()
  }
}

/** Every settings row, the same way. */
function allRows(dbFile: string): Record<string, unknown> {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare('SELECT key, value FROM app_settings').all() as Array<{
      key: string
      value: string
    }>
    const out: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value)
      } catch {
        out[row.key] = { unparseable: row.value }
      }
    }
    return out
  } finally {
    db.close()
  }
}

/** What a program says about itself, asked of it directly. */
function versionOf(exe: string): string | null {
  try {
    const isScript = /\.(cmd|bat)$/i.test(exe)
    const out = isScript
      ? execFileSync(process.env['COMSPEC'] ?? 'cmd.exe', ['/c', exe, '--version'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 20_000
        })
      : execFileSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    return out.trim()
  } catch {
    return null
  }
}

/** `where.exe <name>`, which is what a person would type to find out. */
function whereIs(name: string): string[] {
  try {
    return execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
  } catch {
    return []
  }
}

const whereClaude = (): string[] => whereIs('claude')

/**
 * Where this driver looks for a shell that is not on `PATH`.
 *
 * Its own sweep of its own list of places, for the reason
 * `EXPECTED_SHELL_ARGS` is its own table: importing `pwshLocations` would make
 * S-12 assert that `pterm.ts` agrees with itself. Written from the same two
 * facts and not from the same code - the Store's launcher lives under
 * `%LOCALAPPDATA%\Microsoft\WindowsApps`, an MSI install under
 * `%ProgramFiles%\PowerShell\<major>`, and Git for Windows keeps a bash in
 * `bin\` while putting only `cmd\` on `PATH`.
 *
 * `lstat` rather than `existsSync`, and that is not a style choice: an
 * app-execution alias is a reparse point `stat` cannot follow, so `existsSync`
 * answers false for a launcher that plainly works. A driver using the obvious
 * test here would have reported the shell as absent and agreed with the bug.
 */
function installedOffPath(name: string): string[] {
  const found: string[] = []
  const there = (path: string): boolean => {
    try {
      lstatSync(path)
      return true
    } catch {
      return false
    }
  }
  const programFiles = [process.env['ProgramW6432'], process.env['ProgramFiles']].filter(
    (base): base is string => base !== undefined && base !== ''
  )
  if (name === 'pwsh.exe') {
    for (const base of programFiles) {
      const root = join(base, 'PowerShell')
      let majors: string[]
      try {
        majors = readdirSync(root).filter((entry) => /^\d+$/.test(entry))
      } catch {
        majors = []
      }
      for (const major of majors.sort((a, b) => Number(b) - Number(a))) {
        const exe = join(root, major, 'pwsh.exe')
        if (there(exe)) found.push(exe)
      }
    }
    const local = process.env['LOCALAPPDATA']
    if (local !== undefined && local !== '') {
      const alias = join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe')
      if (there(alias)) found.push(alias)
    }
  }
  if (name === 'bash.exe') {
    for (const base of programFiles) {
      const exe = join(base, 'Git', 'bin', 'bash.exe')
      if (there(exe)) found.push(exe)
    }
  }
  return found
}

/** What Windows says a live process actually is. */
function imageNameOf(pid: number): string | null {
  try {
    const out = execFileSync(
      'tasklist.exe',
      ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 }
    )
    const first = out.split(/\r?\n/).find((line) => line.startsWith('"'))
    return first?.split('","')[0]?.replace(/^"/, '') ?? null
  } catch {
    return null
  }
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** `#12131f` -> `rgb(18, 19, 31)`, so a hex and a computed colour can be compared. */
function hexToRgb(hex: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const digits = match?.[1]
  if (digits === undefined) return null
  const channel = (at: number): string => String(Number.parseInt(digits.slice(at, at + 2), 16))
  return `rgb(${channel(0)}, ${channel(2)}, ${channel(4)})`
}

// ---------------------------------------------------------------------------
// Talking to the window
// ---------------------------------------------------------------------------

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  try {
    return (await win.webContents.executeJavaScript(expression, true)) as T
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`renderer expression failed: ${detail}\n${expression}`, { cause: err })
  }
}

const q = (selector: string): string => JSON.stringify(selector)

async function click(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector(${q(selector)});
      if (!el) return false; el.click(); return true })()`
  )
}

async function exists(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(win, `Boolean(document.querySelector(${q(selector)}))`)
}

async function text(win: BrowserWindow, selector: string): Promise<string> {
  return js<string>(win, `(document.querySelector(${q(selector)})?.textContent ?? '').trim()`)
}

async function attr(win: BrowserWindow, selector: string, name: string): Promise<string | null> {
  return js<string | null>(
    win,
    `(document.querySelector(${q(selector)})?.getAttribute(${q(name)}) ?? null)`
  )
}

async function disabled(win: BrowserWindow, selector: string): Promise<boolean | null> {
  return js<boolean | null>(
    win,
    `(() => { const el = document.querySelector(${q(selector)});
      return el === null ? null : Boolean(el.disabled) })()`
  )
}

/**
 * An expression finding the element whose `data-<name>` is exactly `value`.
 *
 * Not a CSS attribute selector, because the values here are Windows paths and
 * CSS reads a backslash as an escape: in `[data-settings-root="D:\proj\x"]` the
 * `\p` is an identity escape, so the selector matches an element whose
 * attribute reads `D:projx` - and `\a` would be a hex escape rather than a
 * letter at all. Comparing the attribute in JavaScript has no such rules.
 */
const byData = (name: string, value: string): string =>
  `[...document.querySelectorAll('[data-${name}]')].find((el) => el.getAttribute('data-${name}') === ${JSON.stringify(value)})`

async function clickByData(win: BrowserWindow, name: string, value: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = ${byData(name, value)}; if (!el) return false; el.click(); return true })()`
  )
}

async function pollJs(win: BrowserWindow, expression: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await js<boolean>(win, `Boolean(${expression})`).catch(() => false)
    if (ok) return true
    if (Date.now() > deadline) return false
    await sleep(200)
  }
}

/**
 * A sidebar row, clicked by the path in its `title`.
 *
 * Matched in JavaScript rather than by a CSS attribute selector for the reason
 * `byData` gives: these are Windows paths, and a backslash in a selector is an
 * escape.
 */
async function clickProject(win: BrowserWindow, path: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = [...document.querySelectorAll('aside button[title]')]
        .find((b) => b.title === ${JSON.stringify(path)});
      if (!el) return false; el.click(); return true })()`
  )
}

/**
 * Close a project's tab, the way a person does: the X beside it.
 *
 * A group that opens a project pane has to close it again, and the reason is
 * not tidiness. A project tab holds a **project shell**, which lives in
 * `pterms.ts` outside React and outlives every render - so a pane left open is
 * a pty still in the registry when a later group counts terminals.
 *
 * That is how `S-22` broke `S-10`: two panes opened here, two shells left
 * behind, and `shells.length === 2` was 4 by the time the terminal group asked.
 * `S-10` was right and the app was right; this is the probe that was wrong. The
 * same shape is on record in the `checks` skill - "S-10 was counting terminals
 * it never started" - from the last time inherited workspace state reached it.
 *
 * Matched in JavaScript rather than by a CSS attribute selector, like
 * `clickProject` above: `data-tab` carries a Windows path and a backslash in a
 * selector is an escape.
 */
async function closeProjectTab(win: BrowserWindow, path: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const tab = [...document.querySelectorAll('[role="tab"]')]
        .find((t) => t.dataset.tab === 'project:' + ${JSON.stringify(path)});
      const close = tab?.parentElement?.querySelector('button[aria-label^="Close "]');
      if (!close) return false; close.click(); return true })()`
  ).catch(() => false)
}

/** Focus a field, replace what is in it, and commit with Enter. Real keystrokes. */
async function typeInto(win: BrowserWindow, selector: string, text: string): Promise<boolean> {
  const focused = await js<boolean>(
    win,
    `(() => { const el = document.querySelector(${q(selector)});
      if (!el) return false; el.focus(); el.select(); return true })()`
  )
  if (!focused) return false
  await typeText(win, text)
  await sendKey(win, 'Return')
  return true
}

/**
 * Empty a field, with a real keystroke.
 *
 * `typeInto(win, sel, '')` cannot do this: it selects what is there and then
 * types nothing, which leaves the selection and the value exactly where they
 * were. A field that stays filled is a filter that stays applied, and every
 * assertion made after it is then about a filtered tree.
 */
async function clearField(win: BrowserWindow, selector: string): Promise<boolean> {
  const focused = await js<boolean>(
    win,
    `(() => { const el = document.querySelector(${q(selector)});
      if (!el) return false; el.focus(); el.select(); return true })()`
  )
  if (!focused) return false
  await sendKey(win, 'Backspace')
  return true
}

/**
 * Set a `<select>` and let React hear about it.
 *
 * Whether the value took is decided **before** the event is dispatched. React
 * flushes a discrete event synchronously, so by the time `dispatchEvent`
 * returns the component has already re-rendered from props that the write has
 * not come back and changed yet - which puts the old value back on the element.
 * Reading it afterwards reports a failure for a selection that worked.
 */
async function chooseOption(
  win: BrowserWindow,
  selector: string,
  value: string
): Promise<{ found: boolean; offered: boolean; set: boolean }> {
  return js<{ found: boolean; offered: boolean; set: boolean }>(
    win,
    `(() => { const el = document.querySelector(${q(selector)});
      if (!el) return { found: false, offered: false, set: false };
      const wanted = ${JSON.stringify(value)};
      const offered = [...el.options].some((o) => o.value === wanted);
      el.value = wanted;
      const set = el.value === wanted;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, offered, set } })()`
  )
}

/**
 * This driver's own answer to "does this machine have that font".
 *
 * Written here rather than shared with the pane, because the pane's hint is one
 * of the things under test. Same principle, different code: a probe string is
 * laid out with the family in front of two fallbacks and again with each
 * fallback alone, and a family that resolves is one that changes a width.
 */
function driverSeesFont(win: BrowserWindow, family: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;left:-9999px;white-space:pre;font-size:72px';
      probe.textContent = 'MWMWiill 0123';
      document.body.appendChild(probe);
      const at = (stack) => { probe.style.fontFamily = stack; return probe.getBoundingClientRect().width };
      const family = ${JSON.stringify(family)};
      const answer = ['monospace', 'serif'].some(
        (f) => at('"' + family + '", ' + f) !== at(f)
      );
      probe.remove();
      return answer })()`
  )
}

/** One live terminal, as the renderer's inspector reports it. */
interface TerminalReport {
  key: string
  fontFamily: string
  fontSize: number
  cursorStyle: string
  cursorBlink: boolean
  scrollback: number
  cols: number
  rows: number
  screen: { width: number; height: number } | null
  attached: boolean
}

interface TerminalSnapshot {
  prefs: Record<string, unknown>
  sessions: TerminalReport[]
  shells: Array<TerminalReport & { path: string; shell: string }>
}

const terminalSnapshot = (win: BrowserWindow): Promise<TerminalSnapshot> =>
  js<TerminalSnapshot>(win, `window.__helmTerminals()`)

/**
 * The driver's own measurement of a monospace cell, made in the window.
 *
 * A canvas of this file's making, with a font string this file composed - so
 * "the terminal is drawing at 20px in Consolas" is checked against a
 * measurement Helm had no part in rather than against Helm's own arithmetic.
 */
function measureCell(win: BrowserWindow, size: number, stack: string): Promise<CellMeasurement> {
  return js<CellMeasurement>(
    win,
    `(() => {
      const size = ${JSON.stringify(size)};
      const stack = ${JSON.stringify(stack)};
      const c = document.createElement('canvas').getContext('2d');
      c.font = size + 'px ' + stack;
      const m = c.measureText('W');
      const span = document.createElement('span');
      span.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:pre;'
        + 'font-kerning:none;line-height:normal;font-size:' + size + 'px;font-family:' + stack;
      span.textContent = 'W'.repeat(32);
      document.body.appendChild(span);
      const r = span.getBoundingClientRect();
      span.remove();
      return {
        canvasWidth: m.width,
        canvasBox: m.fontBoundingBoxAscent + m.fontBoundingBoxDescent,
        spanWidth: r.width / 32,
        spanHeight: r.height,
        dpr: window.devicePixelRatio
      } })()`
  )
}

/**
 * A cell measured two ways by this driver.
 *
 * `span*` is how xterm's own `CharSizeService` does it - a `white-space: pre`
 * element in the document, whose width is divided by the number of characters
 * in it - so that is the number the terminal's painted geometry is checked
 * against. The canvas figures are here because `estimateGrid` uses a canvas
 * (there is no terminal to measure yet when it runs), and the difference
 * between the two is the whole reason a pre-spawn estimate can be off.
 */
interface CellMeasurement {
  canvasWidth: number
  canvasBox: number
  spanWidth: number
  spanHeight: number
  dpr: number
}

/** Every project path the sidebar tree is currently showing. */
async function sidebarPaths(win: BrowserWindow): Promise<string[]> {
  return js<string[]>(
    win,
    `[...document.querySelectorAll('aside button[title]')].map((b) => b.title)`
  )
}

/**
 * The sidebar as the pins group needs to read it, in one pass.
 *
 * `rows` is every **launchable** project row, lower-cased - the things
 * `aside nav button[title]` reaches, which is exactly what every driver here
 * and in `design-shot` means by "a project row". Counting over that list is
 * what says a pinned project is printed once rather than twice, and a path
 * absent from it is a path nothing on screen offers to start a session in.
 *
 * `pinned` is what the Pinned section holds, taken from the stars' own
 * `data-pin-project` rather than from the rows, because the section's
 * unresolvable entries are deliberately not rows.
 *
 * One expression rather than four calls: these have to describe the same frame,
 * and four round trips through `executeJavaScript` can straddle a re-render.
 */
interface PinState {
  /** Whether a Pinned section is on screen at all. */
  section: boolean
  rows: string[]
  pinned: string[]
  /** The unresolvable row, when the caller asked about one. */
  goneRow: { badge: boolean; launchable: boolean } | null
}

async function pinState(win: BrowserWindow, gonePath?: string): Promise<PinState> {
  return js<PinState>(
    win,
    `(() => {
      const section = document.querySelector('[data-pinned-section]')
      const want = ${JSON.stringify((gonePath ?? '').toLowerCase())}
      const rows = [...document.querySelectorAll('aside nav button[title]')]
        .map((b) => b.title.toLowerCase())
      const pinned = section
        ? [...section.querySelectorAll('[data-pin-project]')]
            .map((el) => el.getAttribute('data-pin-project') || '')
        : []
      let goneRow = null
      if (want !== '' && section) {
        const star = [...section.querySelectorAll('[data-pin-project]')]
          .find((el) => (el.getAttribute('data-pin-project') || '').toLowerCase() === want)
        // The row is the star's parent: a <div> when the folder has gone and a
        // <button> would be the bug. "Launchable" is asked of the row itself
        // rather than of a selector, so it is the DOM that answers.
        const row = star ? star.parentElement : null
        if (row) {
          goneRow = {
            badge: (row.textContent || '').toLowerCase().includes('folder gone'),
            launchable:
              row.tagName === 'BUTTON' || row.querySelector('button[title]') !== null
          }
        }
      }
      return { section: section !== null, rows, pinned, goneRow }
    })()`
  )
}

/**
 * A settings write sent by hand through the real channel.
 *
 * The same route the pane's own controls take - preload, contract, handler -
 * so a rejection here is the rejection a caller would actually get. Resolved
 * either way: whether it was refused is the thing being measured.
 */
async function sendWrite(
  win: BrowserWindow,
  patch: Record<string, unknown>
): Promise<{ accepted: boolean; error: string }> {
  return js<{ accepted: boolean; error: string }>(
    win,
    `window.helm.invoke('settings:write', ${JSON.stringify(patch)})
       .then(() => ({ accepted: true, error: '' }))
       .catch((err) => ({ accepted: false, error: String(err && err.message ? err.message : err) }))`
  )
}

/**
 * The project shell island, its handle, the column they share, and the grid
 * the terminal in it is at - all measured in one read, so the box and the grid
 * describe the same instant.
 *
 * `screen` and `container` are the two halves of "the grid matches its box":
 * `.xterm-screen` is exactly `rows` cells tall, and the element it sits in is
 * what `FitAddon` measures. The difference between them can only be less than
 * one cell, and a terminal still describing an old box is where that stops
 * being true.
 */
interface ShellPaneReading {
  pane: { top: number; bottom: number; height: number; left: number; width: number }
  handle: { top: number; height: number }
  column: { top: number; bottom: number; height: number }
  /** The percentage the pane was rendered with, off its own `data-` hook. */
  pct: number
  rows: number
  cols: number
  /** `.xterm-screen`, which is `rows` cells tall and nothing else. */
  screen: number
  /** The box the fit is measured against. */
  container: number
}

async function readShellPane(win: BrowserWindow, path: string): Promise<ShellPaneReading | null> {
  return js<ShellPaneReading | null>(
    win,
    `(() => {
      const pane = document.querySelector('[data-project-shell]')
      const handle = document.querySelector('[role="separator"][aria-orientation="horizontal"]')
      if (!pane || !handle || !pane.parentElement) return null
      const box = (el) => {
        const b = el.getBoundingClientRect()
        return { top: b.top, bottom: b.bottom, height: b.height, left: b.left, width: b.width }
      }
      const term = window.__helmTerminals().shells.find(
        (s) => s.path.toLowerCase() === ${JSON.stringify(path.toLowerCase())} && s.attached
      )
      const screen = pane.querySelector('.xterm-screen')
      const holder = pane.querySelector('.xterm')
      return {
        pane: box(pane),
        handle: box(handle),
        column: box(pane.parentElement),
        pct: Number(pane.dataset.projectShell),
        rows: term ? term.rows : -1,
        cols: term ? term.cols : -1,
        screen: screen ? screen.getBoundingClientRect().height : -1,
        container: holder && holder.parentElement
          ? holder.parentElement.getBoundingClientRect().height
          : -1
      }
    })()`
  ).catch(() => null)
}

/**
 * Count what main broadcasts, not what the window believes it sent.
 *
 * `settings:changed` is emitted once per accepted `settings:write`, so this is
 * the honest witness for "one write for the whole gesture" - the claim that
 * separates a drag that saves its answer from a drag that saves sixty of them.
 * Subscribed through the real bridge; the returned detach is kept so the tap
 * comes off again.
 */
async function armSettingsCounter(win: BrowserWindow): Promise<void> {
  await js<string>(
    win,
    `(() => {
      if (window.__settingsWrites) window.__settingsWrites.off()
      const seen = { n: 0, values: [], off: () => undefined }
      seen.off = window.helm.on('settings:changed', (s) => {
        seen.n++
        seen.values.push(s.projectShellHeightPct)
      })
      window.__settingsWrites = seen
      return 'armed'
    })()`
  )
}

const readSettingsCounter = (win: BrowserWindow): Promise<{ n: number; values: number[] }> =>
  js<{ n: number; values: number[] }>(
    win,
    `({ n: window.__settingsWrites.n, values: window.__settingsWrites.values })`
  )

const disarmSettingsCounter = (win: BrowserWindow): Promise<void> =>
  js<void>(
    win,
    `(() => { if (window.__settingsWrites) { window.__settingsWrites.off(); delete window.__settingsWrites } })()`
  )

/** Opens the settings pane if it is not already the pane on screen. */
async function openSettings(win: BrowserWindow): Promise<boolean> {
  if (await exists(win, '[data-settings-pane]')) return true
  await click(win, '[data-open-settings]')
  return pollJs(win, `document.querySelector('[data-settings-pane]')`, 10_000)
}

/** Whether the planted source file could be got on screen, and how far it got. */
interface SourceOpened {
  scopeOffered: boolean
  scopeChosen: boolean
  rowClicked: boolean
  rendered: boolean
}

/**
 * Put the content group's planted source file on screen, from a closed pane.
 *
 * Called from a closed pane on purpose. `contentWrap` is the *default* a
 * document takes when it mounts - the header's toggle overrides it per file
 * afterwards - so a pane that was already open when the setting changed is a
 * pane holding the answer to a different question. Closing and reopening is
 * what makes "it opened wrapped because the settings say so" a claim about the
 * settings.
 *
 * The scope is chosen rather than inherited, and the view is put on curated:
 * the file list is what carries `[data-content-file]`, and which of the two
 * modes a scope opens in depends on whether it is a harness or a project.
 */
async function openPlantedSource(
  win: BrowserWindow,
  scopePath: string,
  relPath: string
): Promise<SourceOpened> {
  const out: SourceOpened = {
    scopeOffered: false,
    scopeChosen: false,
    rowClicked: false,
    rendered: false
  }

  await click(win, '[data-open-content]')
  if (!(await pollJs(win, `document.querySelector('select[data-content-scope]')`, 15_000))) {
    return out
  }
  // The option itself may still be arriving: the switcher is built from the
  // last scan, and the root this scope lives under was added moments ago.
  await pollJs(
    win,
    `[...document.querySelectorAll('select[data-content-scope] option')]
       .some((o) => o.value.toLowerCase() === ${JSON.stringify(scopePath.toLowerCase())})`,
    30_000
  )

  const picked = await chooseOption(win, 'select[data-content-scope]', scopePath)
  out.scopeOffered = picked.offered
  out.scopeChosen = picked.set
  await sleep(700)
  await click(win, '[data-content-view="curated"]')
  await pollJs(win, `document.querySelector('[data-content-status]')`, 15_000)
  await sleep(500)

  out.rowClicked = await pollJs(
    win,
    `(() => {
       const el = [...document.querySelectorAll('[data-content-file]')]
         .find((b) => b.dataset.contentFile === ${JSON.stringify(relPath)})
       if (!el) return false
       el.click()
       return true
     })()`,
    20_000
  )
  if (!out.rowClicked) return out

  out.rendered = await pollJs(
    win,
    `document.querySelector('.source-view .line')`,
    15_000
  )
  await sleep(500)
  return out
}

/** The geometry of the source block on screen, in pixels it measured itself. */
interface SourceGeometry {
  wrapAttr: string | null
  togglePressed: string | null
  clientWidth: number
  scrollWidth: number
  /** `.line` spans seen, and how many of them are more than one visual row. */
  linesSeen: number
  wrappedLines: number
  tallestLinePx: number
  /** Columns of leading whitespace on the line the hang was measured on, or -1. */
  indentColumns: number
  /** How far the continuation row starts past the line's own code, or -1. */
  hangPx: number
  charPx: number
}

/**
 * Measure how the source block on screen is laid out.
 *
 * Geometry, deliberately, and the same function is run in both states so that
 * the two answers have to disagree. "It wrapped" is `scrollWidth` back at
 * `clientWidth` with lines taller than one row; "it hung" is the second visual
 * row of a line starting further right than the line's own code. A `data-wrap`
 * attribute would report all of that whether or not any of it happened, which
 * is why the attribute is read *beside* the pixels rather than instead of them.
 *
 * `charPx` is one character of the block's **own** font, measured by a ruler
 * injected into it, so an expected hang is in the unit the browser resolved
 * `ch` with rather than a guess about the stylesheet.
 */
async function measureSource(win: BrowserWindow): Promise<SourceGeometry | null> {
  return js<SourceGeometry | null>(
    win,
    `(() => {
       const view = document.querySelector('.source-view')
       const pre = document.querySelector('[data-content-source] pre')
       const toggle = document.querySelector('[data-content-wrap]')
       if (!view || !pre) return null
       const ruler = document.createElement('span')
       ruler.textContent = '0'.repeat(100)
       ruler.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'
       pre.appendChild(ruler)
       const charPx = ruler.getBoundingClientRect().width / 100
       ruler.remove()

       const indentCols = (el) => {
         const m = /--line-indent:(\\d+)ch/.exec(el.getAttribute('style') || '')
         return m ? Number(m[1]) : 0
       }
       const preLeft = pre.getBoundingClientRect().left
       const lines = [...view.querySelectorAll('.line')]
       let wrappedLines = 0
       let tallest = 0
       let found = null
       for (const line of lines) {
         const height = line.getBoundingClientRect().height
         if (height > tallest) tallest = height
         // One visual row of this face is about 19px, so 25 is comfortably
         // between "one row" and "two" without being a claim about either.
         if (height < 25) continue
         wrappedLines++
         if (found) continue
         const range = document.createRange()
         range.selectNodeContents(line)
         const rows = new Map()
         for (const r of range.getClientRects()) {
           if (!r.width) continue
           const top = Math.round(r.top)
           const x = Math.round(r.left - preLeft)
           if (!rows.has(top) || rows.get(top) > x) rows.set(top, x)
         }
         const xs = [...rows.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])
         if (xs.length < 2) continue
         found = { xs, cols: indentCols(line) }
       }
       return {
         wrapAttr: view.getAttribute('data-wrap'),
         togglePressed: toggle ? toggle.getAttribute('aria-pressed') : null,
         clientWidth: pre.clientWidth,
         scrollWidth: pre.scrollWidth,
         linesSeen: lines.length,
         wrappedLines,
         tallestLinePx: Math.round(tallest * 10) / 10,
         indentColumns: found ? found.cols : -1,
         hangPx: found ? Math.round(found.xs[1] - (found.xs[0] + found.cols * charPx)) : -1,
         charPx: Math.round(charPx * 100) / 100
       }
     })()`
  ).catch(() => null)
}

/** Shut the content tab, so the next open is a mount rather than a re-render. */
async function closeContentTab(win: BrowserWindow): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const tab = [...document.querySelectorAll('[role="tab"]')]
        .find((t) => t.dataset.tab === 'content');
      const close = tab?.parentElement?.querySelector('button[aria-label^="Close "]');
      if (!close) return false; close.click(); return true })()`
  ).catch(() => false)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  dir: string
  /** A scan root with one project under it. Added, and left for phase two. */
  rootA: string
  /** A scan root with two projects under it. Added, then removed. */
  rootB: string
  aProjects: string[]
  bProjects: string[]
  /** A program that answers `--version` with 9.9.9 and nothing else. */
  stubCli: string
  /**
   * A `gh` that is installed and not signed in: it answers `--version`, fails
   * `auth status`, and refuses every fetch with gh's own sign-in sentence -
   * all three, because a signed-out machine does all three and the verdict is
   * drawn from the last of them. Which is how the "run gh auth login" sentence
   * is provoked on a machine where gh *is* signed in.
   */
  ghStub: string
  /** A scan root for the terminal group, with two projects to open shells in. */
  termRoot: string
  termProjects: string[]
  /**
   * A scan root for the pins group, holding **two** harnesses.
   *
   * Two, because the claim the section makes is that it is flat and
   * cross-harness: one harness would let a Pinned section that had merely
   * re-labelled a group pass. `pinProjects` are the repos inside them, in the
   * order the harnesses were built.
   */
  pinRoot: string
  pinProjects: string[]
  /** A path under `pinRoot` that was never created. Pinnable, never found. */
  pinGone: string
  /**
   * A scan root for the content group, holding one harness with one source
   * file in it - long lines, and every line indented.
   *
   * `wrapScope` is the harness, which is what the content viewer's scope
   * switcher offers; `wrapSourceRel` is the planted file as the file list
   * addresses it, relative to the scope and slash-separated.
   */
  wrapRoot: string
  wrapScope: string
  wrapSource: string
  wrapSourceRel: string
  /**
   * A folder somebody would add meaning *this one*: subdirectories, and not a
   * project among them. The shape the folder-root bug turned into four rows.
   *
   * `leafChildren` is what the old rule would have listed, and S-22 asserts it
   * is non-empty before believing "exactly one row" - a folder with nothing in
   * it would pass that claim without discriminating anything.
   */
  leafRoot: string
  leafChildren: string[]
}

function buildFixtures(dataDir: string): Fixtures {
  const dir = join(dataDir, 'settings-fixtures')
  rmSync(dir, { recursive: true, force: true })

  const rootA = join(dir, 'root a')
  const rootB = join(dir, 'root-b')
  const termRoot = join(dir, 'root-term')
  const aProjects = [join(rootA, 'alpha one')]
  const bProjects = [join(rootB, 'beta-one'), join(rootB, 'beta-two')]
  const termProjects = [join(termRoot, 'term one'), join(termRoot, 'term-two')]
  // A path with a space in it on purpose: Windows-first, and every path Helm
  // stores has to survive one.
  for (const path of [...aProjects, ...bProjects, ...termProjects]) {
    mkdirSync(join(path, '.claude'), { recursive: true })
  }

  // Two harnesses - a folder is one exactly when it holds a `harness.yaml`,
  // which is the whole definition - with one repo each, so a pin taken out of
  // one of them can be seen sitting beside a pin taken out of the other.
  const pinRoot = join(dir, 'root pins')
  const pinProjects: string[] = []
  for (const harness of ['pin harness one', 'pin-harness-two']) {
    const home = join(pinRoot, harness)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'harness.yaml'), `name: ${harness}\n`)
    const repo = join(home, 'repos', `${harness} repo`)
    mkdirSync(join(repo, '.claude'), { recursive: true })
    pinProjects.push(repo)
  }
  // Deliberately not created. This is the pinned path whose folder has gone.
  const pinGone = join(pinRoot, 'pin harness one', 'repos', 'unplugged drive')

  /**
   * A harness of the content group's own, with a source file planted in it.
   *
   * S-12c used to pick a file **by shape** out of whatever scope the content
   * viewer happened to open on, and on this machine it found none: it reported
   * "no source file in this scope could be measured", which is honest and is
   * not the failure it exists to report. `content-check` met the same wall
   * writing CONT-16 and answered it the same way, and the comment there is the
   * argument - "the scope a check runs in is not guaranteed to hold a long
   * source file". So the file is planted, and the probe reads it out of a scope
   * it made.
   *
   * Two properties are what make it a fixture rather than a file. Every line is
   * far wider than any pane it can be read in, so **not** wrapping is a
   * measurable state and not just an absence; and every line carries leading
   * whitespace of its own, varying, so the hanging indent is measured from the
   * line's own indentation the way `--line-indent` intends rather than from the
   * block's edge, where a hang of zero would look the same as a hang that
   * worked. `.ts` because the source view's geometry lives on shiki's `.line`
   * spans, and a file with no grammar falls back to a plain `<pre>` with none.
   */
  const wrapRoot = join(dir, 'root wrap')
  const wrapScope = join(wrapRoot, 'wrap harness')
  const wrapSourceRel = 'tools/wrapping-fixture.ts'
  const wrapSource = join(wrapScope, ...wrapSourceRel.split('/'))
  mkdirSync(join(wrapSource, '..'), { recursive: true })
  writeFileSync(join(wrapScope, 'harness.yaml'), 'name: wrap harness\n')
  writeFileSync(
    wrapSource,
    Array.from({ length: 200 }, (_, i) => {
      const depth = '  '.repeat((i % 4) + 1)
      return `${depth}export const entry${String(i)} = { id: ${String(i)}, note: 'a deliberately long line, wider than any pane this file can be read in, so that whether it wrapped is a question the geometry can answer rather than one an attribute claims', tail: ${String(i)} }`
    }).join('\n')
  )

  // A tool directory, with a space in its name like the rest of these. Nothing
  // in it carries `.git`, `.claude` or a `CLAUDE.md`, which is what makes it a
  // folder rather than a folder *of* projects - and what the four rows in the
  // bug report were.
  const leafRoot = join(dir, 'leaf tool')
  const leafChildren = ['data', 'src', 'tests'].map((name) => join(leafRoot, name))
  for (const path of leafChildren) mkdirSync(path, { recursive: true })
  writeFileSync(join(leafRoot, 'pyproject.toml'), '[project]\nname = "leaf tool"\n')

  const stubDir = join(dir, 'stub')
  mkdirSync(stubDir, { recursive: true })
  const stubCli = join(stubDir, 'claude.cmd')
  writeFileSync(stubCli, '@echo off\r\nif "%1"=="--version" echo 9.9.9 (Claude Code)\r\n')

  const ghStub = join(stubDir, 'gh.cmd')
  writeFileSync(
    ghStub,
    [
      '@echo off',
      'if "%1"=="--version" (',
      '  echo gh version 9.9.9 ^(fixture^)',
      '  echo https://github.com/cli/cli',
      '  exit /b 0',
      ')',
      'if "%1"=="auth" (',
      '  echo You are not logged into any GitHub hosts. 1>&2',
      '  exit /b 1',
      ')',
      // What a real signed-out `gh` prints for `pr list`, and it has to be the
      // real sentence rather than a plausible one: the sign-in verdict is drawn
      // from the **fetch** now, not from the `auth status` exit code above, so a
      // stub that invented its own wording would exercise the "some other
      // failure" branch and prove nothing about the signed-out path it is here
      // to provoke.
      'echo To get started with GitHub CLI, please run: gh auth login. 1>&2',
      'exit /b 4',
      ''
    ].join('\r\n')
  )

  return {
    dir,
    rootA,
    rootB,
    aProjects,
    bProjects,
    stubCli,
    ghStub,
    termRoot,
    termProjects,
    pinRoot,
    pinProjects,
    pinGone,
    wrapRoot,
    wrapScope,
    wrapSource,
    wrapSourceRel,
    leafRoot,
    leafChildren
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface SettingsCheckResult {
  checks: Check[]
  /** What the run left in the database for the restart phase to find. */
  parked: Partial<AppSettings>
}

export async function runSettingsChecks(
  ctx: CheckContext,
  shotDir: string,
  dataDir: string,
  only?: readonly string[]
): Promise<SettingsCheckResult> {
  const wanted = new Set<string>(only && only.length > 0 ? only : GROUPS)
  const run = (group: Group): boolean => wanted.has(group)
  const checks: Check[] = []
  const { win, services, usage } = ctx
  const dbFile = services.store.file

  const fixtures = buildFixtures(dataDir)

  /**
   * Everything as it was before this driver touched it, written down before
   * anything is changed. The restart phase puts these back: this runs against
   * the real database, because the claim under test is about the real one.
   */
  const asFound = readSettings(services.store)
  /**
   * Anything of this driver's own is scrubbed out of what gets restored: a run
   * that was killed before its restore leaves a fixture root or a stub CLI
   * behind, and carrying those forward would let them accumulate one per run.
   * What is put back is the user's settings, not the last run's leftovers.
   */
  const mine = (path: string | null): boolean =>
    path !== null && path.toLowerCase().startsWith(fixtures.dir.toLowerCase())
  const original: AppSettings = {
    ...asFound,
    scanRoots: asFound.scanRoots.filter((root) => !mine(root)),
    // Same scrub, same reason: the pins group pins fixture projects, and a run
    // killed before its restore would otherwise hand the user's settings a pin
    // on a directory this driver is about to delete.
    pinnedProjects: asFound.pinnedProjects.filter((path) => !mine(path)),
    claudePath: mine(asFound.claudePath) ? null : asFound.claudePath
  }
  writeFileSync(join(dataDir, 'settings-original.json'), JSON.stringify(original, null, 2))

  /**
   * The executable to park in `claudePath`, decided now.
   *
   * Now, because the validation group writes a stub into that setting on its
   * way past, and anything asked afterwards - `findClaudeExecutable` included -
   * would answer with the stub. `where.exe` first: parking a real program means
   * a restore that somehow does not happen leaves the app working.
   */
  const claudeForPark = whereClaude()[0] ?? original.claudePath

  /**
   * The colour Electron was handed for the window controls, captured at the
   * source. Wrapping the method on the instance means what is recorded is the
   * argument the platform received - not a value read back out of Helm.
   */
  const overlayCalls: Array<{ color: string; symbolColor: string }> = []
  const realSetOverlay = win.setTitleBarOverlay.bind(win)
  win.setTitleBarOverlay = (options: Electron.TitleBarOverlay): void => {
    overlayCalls.push({
      color: String(options.color ?? ''),
      symbolColor: String(options.symbolColor ?? '')
    })
    realSetOverlay(options)
  }

  await sleep(800)

  // -------------------------------------------------------------------------
  // S-0: this check started from the app's own defaults, not the developer's
  // -------------------------------------------------------------------------
  //
  // Ungated by `--only=`, because every group below is standing on it.
  //
  // The seed strips `workspaceTabs` and `windowBounds` from a check's copy of
  // the database (scripts/isolate.mjs). Before it did, this driver started with
  // whatever the developer had left open and however big they had left the
  // window - eight panes and 1757x946 on the machine where that was found -
  // and two probes failed for that reason alone while being right about the
  // app. A check that fails for a reason unrelated to what it measures gets
  // waved past, and then so does the day it fails for a real one.
  //
  // This exists so that if the strip ever comes back, **one** probe goes red
  // and names the cause, instead of S-1 and S-10 going red and looking like
  // bugs in Ctrl+Tab and in terminal attachment.
  {
    const bounds = win.getBounds()
    const stripAtStart = await js<string[]>(
      win,
      `[...document.querySelectorAll('[role="tab"][data-tab]')].map((t) => t.dataset.tab ?? '')`
    )
    checks.push({
      id: 'S-0',
      criterion: 'A check starts from the app’s defaults, not from where the developer left it',
      title: 'No workspace tabs and no saved window bounds came through in the seeded database',
      ok:
        asFound.workspaceTabs === null &&
        asFound.windowBounds === null &&
        stripAtStart.length === 0 &&
        bounds.width === 1280 &&
        bounds.height === 820,
      detail: {
        workspaceTabsRow: asFound.workspaceTabs,
        windowBoundsRow: asFound.windowBounds,
        tabsOnScreenAtStart: stripAtStart,
        window: { width: bounds.width, height: bounds.height },
        expectedWindow: { width: 1280, height: 820 }
      },
      notes: [
        'Both rows are read from the settings this process actually loaded, and',
        'the strip is read off the screen - the row being absent and no tab',
        'being painted are two different claims and both are made.',
        '1280x820 is `createWindow`’s default and the width designshot.ts',
        'computes a pane’s worth from. It was photographing 1757 wide.',
        '`firstRunCompletedAt` is deliberately still carried through: clearing',
        'it would start every check in the first-run pane.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-1: the gear opens it, every group renders, Ctrl+Tab reaches it
  // -------------------------------------------------------------------------
  if (run('pane')) {
    const gearThere = await exists(win, '[data-open-settings]')
    const paneBefore = await exists(win, '[data-settings-pane]')

    await click(win, '[data-open-settings]')
    const opened = await pollJs(win, `document.querySelector('[data-settings-pane]')`, 10_000)
    await sleep(400)

    const groups = await js<string[]>(
      win,
      `[...document.querySelectorAll('[data-settings-group]')].map((el) => el.dataset.settingsGroup)`
    )
    const tabSelected = await attr(win, '[role="tab"][data-tab="settings"]', 'aria-selected')
    const controls = await js<Record<string, boolean>>(
      win,
      `({
         claudePath: Boolean(document.querySelector('[data-settings-claude-path]')),
         locate: Boolean(document.querySelector('[data-settings-locate]')),
         clear: Boolean(document.querySelector('[data-settings-clear-claude]')),
         addRoot: Boolean(document.querySelector('[data-settings-add-root]')),
         theme: Boolean(document.querySelector('[data-settings-theme]')),
         usage: Boolean(document.querySelector('[data-settings-usage]')),
         appVersion: Boolean(document.querySelector('[data-settings-app-version]')),
         latestVersion: Boolean(document.querySelector('[data-settings-latest-version]')),
         updateOutcome: Boolean(document.querySelector('[data-settings-update-outcome]')),
         updateCheck: Boolean(document.querySelector('[data-settings-update-check]')),
         updateNow: Boolean(document.querySelector('[data-settings-update-now]')),
         releases: Boolean(document.querySelector('[data-settings-releases]')),
         terminalFont: Boolean(document.querySelector('[data-settings-terminal-font]')),
         terminalSize: Boolean(document.querySelector('[data-settings-terminal-size]')),
         terminalCursor: Boolean(document.querySelector('[data-settings-terminal-cursor]')),
         terminalBlink: Boolean(document.querySelector('[data-settings-terminal-blink]')),
         terminalScrollback: Boolean(document.querySelector('[data-settings-terminal-scrollback]')),
         terminalShell: Boolean(document.querySelector('[data-settings-terminal-shell]')),
         terminalPreview: Boolean(document.querySelector('[data-settings-terminal-preview]')),
         ghPath: Boolean(document.querySelector('[data-settings-gh-path]')),
         ghLocate: Boolean(document.querySelector('[data-settings-gh-locate]')),
         ghClear: Boolean(document.querySelector('[data-settings-clear-gh]')),
         prPoll: Boolean(document.querySelector('[data-settings-pr-poll]')),
         prStale: Boolean(document.querySelector('[data-settings-pr-stale]')),
         // The block, not the count beside it: the count is only there when a
         // github.com repository has been found, and this check runs on
         // whatever machine it runs on.
         prRepos: Boolean(document.querySelector('[data-settings-pr-repos]')),
         prPrompt: Boolean(document.querySelector('[data-settings-pr-prompt]')),
         prPromptReset: Boolean(document.querySelector('[data-settings-pr-prompt-reset]')),
         prCheckout: Boolean(document.querySelector('[data-settings-pr-checkout]')),
         // The browser pane's three preferences: where the pane may go, whether
         // Claude may drive it, and whether Claude is held to this machine when
         // the pane is not. The two browser keys beside them in the database -
         // the recent addresses and the per-project ones - are state, and
         // internalLeaked below is what says they are not here.
         browserReach: Boolean(document.querySelector('[data-settings-browser-reach]')),
         browserMcp: Boolean(document.querySelector('[data-settings-browser-mcp]')),
         browserMcpLocal: Boolean(document.querySelector('[data-settings-browser-mcp-local]')),
         // The other family the one endpoint serves, and the other tick that
         // decides whether a route exists.
         sessionMcp: Boolean(document.querySelector('[data-settings-session-mcp]'))
       })`
    )
    // Internal state is not a preference, and the pane must not have grown a
    // row for any of them while nobody was looking.
    const internalLeaked = await js<boolean>(
      win,
      `/windowBounds|firstRunCompletedAt|workspaceTabs|browserRecentUrls|browserProjectUrls/.test(document.querySelector('[data-settings-pane]')?.textContent ?? '')`
    )

    /**
     * The expected group list, and the three ways it can be wrong, named apart.
     *
     * The list stays written out by hand - it is this driver's own statement of
     * what the pane holds, and one read off the pane would agree with itself.
     * What it does not have to stay is *ambiguous when it fails*: this list has
     * gone stale four times, once per group that arrived (`archive`, `content`,
     * `templates`, `browser`), and each time the report said only that a
     * string comparison failed. "A group this driver has never heard of" and "a
     * group that has stopped rendering" are opposite findings - the first is a
     * list to update, the second is the bug this probe exists for - and they
     * are separated here rather than left to whoever reads the red line.
     */
    const EXPECTED_GROUPS = [
      'claude',
      'workspace',
      'templates',
      'appearance',
      'content',
      'browser',
      'sessions',
      // `wsl` sits with those two because what it changes is whether either
      // family of tools reaches a session hosted in a distribution at all.
      'wsl',
      'updates',
      'terminal',
      'archive',
      'github'
    ]
    const groupsUnexpected = groups.filter((name) => !EXPECTED_GROUPS.includes(name))
    const groupsMissing = EXPECTED_GROUPS.filter((name) => !groups.includes(name))
    const groupsReordered =
      groupsUnexpected.length === 0 &&
      groupsMissing.length === 0 &&
      groups.join(',') !== EXPECTED_GROUPS.join(',')

    const shot = await screenshot(win, shotDir, 'settings-1-pane.png')

    // Two more workspace tabs, so the ring is three long and a cycle through it
    // is a claim about cycling.
    //
    // The driver builds the ring rather than inheriting one. Until the seed
    // learned to strip `workspaceTabs` (scripts/isolate.mjs) this phase started
    // with whatever panes the developer had left open - eight of them on the
    // machine where that was found - and the assertion below was one press of
    // Ctrl+Tab expecting to arrive back at Settings. That only ever held for a
    // ring of exactly two, so it failed on a populated strip while being
    // perfectly true about the app.
    //
    // Three, not two, because a two-ring cannot tell these apart: cycling
    // forward, cycling backward, and toggling between the last two tabs. All
    // three land on Settings from History and only one of them is what the
    // handler claims to do.
    await click(win, '[data-open-history]')
    const historyUp = await pollJs(
      win,
      `document.querySelector('[role="tab"][data-tab="history"][aria-selected="true"]')`,
      10_000
    )
    await click(win, '[data-open-pulls]')
    const pullsUp = await pollJs(
      win,
      `document.querySelector('[role="tab"][data-tab="pulls"][aria-selected="true"]')`,
      10_000
    )

    /**
     * The ring, read off the strips rather than assumed.
     *
     * The handler cycles the workspace strip and then the session strip, so a
     * session open during this phase would be part of the ring. There is none -
     * sessions belong to the `terminal` group - and that is asserted rather than
     * relied on, because a phase that silently grew a session would otherwise
     * turn this into a cycle over a different ring and still report a number.
     */
    const strips = await js<{ workspace: string[]; sessions: string[] }>(
      win,
      `(() => {
         const ids = [...document.querySelectorAll('[role="tab"][data-tab]')]
           .map((t) => t.dataset.tab ?? '')
         return {
           workspace: ids.filter((id) => !id.startsWith('session:')),
           sessions: ids.filter((id) => id.startsWith('session:'))
         }
       })()`
    )

    // Back to Settings, so the cycle starts somewhere known.
    await click(win, '[role="tab"][data-tab="settings"]')
    await sleep(300)

    // Ctrl+Tab is sent as a real keystroke through Chromium, not simulated by
    // clicking the tab: the handler is bound in capture on the window.
    const visited: string[] = []
    for (let i = 0; i < strips.workspace.length; i++) {
      await sendKey(win, 'Tab', ['control'])
      await sleep(250)
      visited.push(
        await js<string>(
          win,
          `document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab ?? ''`
        )
      )
    }

    // One full lap: every tab once, in strip order, ending where it started.
    const expectedRing = ['settings', 'history', 'pulls']
    const expectedLap = ['history', 'pulls', 'settings']
    const ringAsBuilt = strips.workspace.join(',') === expectedRing.join(',')
    const cycledWholeRing = visited.join(',') === expectedLap.join(',')
    const noSessionsInRing = strips.sessions.length === 0
    const paneAfterCycle = await exists(win, '[data-settings-pane]')

    checks.push({
      id: 'S-1',
      criterion: 'Gear in the title bar opens the Settings tab; every group renders',
      title:
        'The gear opens a Settings pane with every group, and Ctrl+Tab walks the whole tab ring back to it',
      ok:
        gearThere &&
        !paneBefore &&
        opened &&
        tabSelected === 'true' &&
        // Every group, in order. The list is spelled out rather than counted so
        // that a group added, removed or reordered all fail here - `archive`
        // arrived with the transcript archive and this went stale, which nobody
        // saw because the probe was already red for the inherited tab strip.
        //
        // It went stale three more times the same way: `content` arrived with
        // the content viewer's wrapping settings, `templates` with in-app
        // template authoring, and `browser` with the integrated browser's reach
        // posture. Each one left this red, and a probe that is already red is a
        // probe nothing reads - which is the whole failure mode the paragraph
        // above describes, repeating. What is different now is that the report
        // says which of the three happened; see `EXPECTED_GROUPS`.
        groups.join(',') === EXPECTED_GROUPS.join(',') &&
        Object.values(controls).every(Boolean) &&
        !internalLeaked &&
        historyUp &&
        pullsUp &&
        noSessionsInRing &&
        ringAsBuilt &&
        cycledWholeRing &&
        paneAfterCycle,
      detail: {
        gearInTitleBar: gearThere,
        paneBeforeClick: paneBefore,
        groups,
        // Named apart, because "this driver's list is stale" and "a group has
        // stopped rendering" are opposite findings behind one string mismatch.
        groupsExpected: EXPECTED_GROUPS,
        groupsOnScreenThisDriverDoesNotKnow: groupsUnexpected,
        groupsThisDriverExpectedAndDidNotFind: groupsMissing,
        groupsReordered,
        tabSelected,
        controlsPresent: controls,
        internalKeysOnScreen: internalLeaked,
        secondTabOpened: historyUp,
        thirdTabOpened: pullsUp,
        // The strip as built, so a failure says what the ring was rather than
        // only that a press landed somewhere unexpected. That is the line that
        // would have identified the inherited-tabs bug on sight.
        ringAsBuilt: strips.workspace,
        sessionsInRing: strips.sessions,
        ctrlTabVisitedInOrder: visited,
        ctrlTabExpected: expectedLap,
        screenshot: shot.file
      },
      notes: [
        'The pane does not exist in the DOM until the gear is clicked, so its',
        'absence beforehand is what makes the click evidence of anything.',
        'Ctrl+Tab is sent as a real keystroke through Chromium, not simulated by',
        'clicking the tab: the handler is bound in capture on the window.',
        'One full lap of a three-tab ring, asserted tab by tab. A two-tab ring',
        'cannot distinguish forward, backward and toggle - all three would pass.',
        'The strip is built by this phase and starts empty, because the seed',
        'strips `workspaceTabs` from a check’s copy of the database. A driver',
        'that inherits the developer’s panes measures a different ring on every',
        'machine - see scripts/isolate.mjs.',
        '`windowBounds` and `firstRunCompletedAt` are state rather than',
        'preferences, and the pane is checked for not having grown a row for them.',
        'The expected group list is written out here rather than read off the',
        'pane, which would be the pane agreeing with itself. It has gone stale',
        'four times, so the detail names the three cases apart: a group on',
        'screen this driver does not know is a list to update, a group it',
        'expected and did not find is the failure this exists for, and the same',
        'ten in a different order is a third thing again.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-2: the CLI is viewable, settable and clearable after first run
  // -------------------------------------------------------------------------
  if (run('claude')) {
    await openSettings(win)
    await sleep(300)

    /**
     * Start from "no override", whatever the database happened to hold.
     *
     * This runs against the real profile, and a previous run of this driver
     * parks one on purpose - so clearing first is what makes the rest of the
     * group mean the same thing on every run. It is also the button under test,
     * exercised from the state a user who has picked an executable is in.
     */
    const overrideAtStart = rowValue(dbFile, 'claudePath')
    if (overrideAtStart !== null && overrideAtStart !== undefined) {
      await click(win, '[data-settings-clear-claude]')
      await pollJs(
        win,
        `window.helm.invoke('setup:status').then((s) => s.source === 'discovered')`,
        20_000
      )
      await sleep(600)
    }

    // What the pane says, and what the executable says when asked directly.
    const paintedPath = await text(win, '[data-settings-claude-path]')
    const paintedVersion = await text(win, '[data-settings-claude-version]')
    const onPath = whereClaude()
    const directVersion = paintedPath === NOTHING ? null : versionOf(paintedPath)
    // `where.exe` is the answer a person would get by typing it, and Helm's
    // discovery is supposed to arrive at the same executable.
    const agreesWithPath =
      onPath.length === 0 ||
      onPath.some((entry) => entry.toLowerCase() === paintedPath.toLowerCase())
    const clearDisabledBefore = await disabled(win, '[data-settings-clear-claude]')

    // Pick a stub by hand, through the same handler the picker calls.
    answerPicker('file', fixtures.stubCli)
    await click(win, '[data-settings-locate]')
    const overrideShown = await pollJs(
      win,
      `(document.querySelector('[data-settings-claude-path]')?.textContent ?? '')
        .includes(${JSON.stringify('claude.cmd')})`,
      20_000
    )
    await sleep(500)

    const overriddenPath = await text(win, '[data-settings-claude-path]')
    const overriddenVersion = await text(win, '[data-settings-claude-version]')
    const stubSays = versionOf(fixtures.stubCli)
    const rowAfterPick = rowValue(dbFile, 'claudePath')
    const clearDisabledAfter = await disabled(win, '[data-settings-clear-claude]')
    // The override has to reach `setup:status`, which is where every other
    // surface asks what the CLI is.
    const statusAfterPick = await js<{ path: string | null; source: string | null }>(
      win,
      `window.helm.invoke('setup:status')`
    )
    const shot = await screenshot(win, shotDir, 'settings-2-claude-override.png')

    await click(win, '[data-settings-clear-claude]')
    const cleared = await pollJs(
      win,
      `!(document.querySelector('[data-settings-claude-path]')?.textContent ?? '')
        .includes(${JSON.stringify('claude.cmd')})`,
      20_000
    )
    await sleep(500)
    const rowAfterClear = rowValue(dbFile, 'claudePath')
    const restoredPath = await text(win, '[data-settings-claude-path]')
    const statusAfterClear = await js<{ path: string | null; source: string | null }>(
      win,
      `window.helm.invoke('setup:status')`
    )

    checks.push({
      id: 'S-2',
      criterion: 'The Claude CLI override is viewable, settable and clearable after first run',
      title: 'The pane shows what the CLI actually is, takes an override, and gives it back',
      ok:
        paintedPath !== '' &&
        paintedPath !== NOTHING &&
        directVersion !== null &&
        paintedVersion === directVersion &&
        agreesWithPath &&
        clearDisabledBefore === true &&
        overrideShown &&
        overriddenPath === fixtures.stubCli &&
        stubSays !== null &&
        overriddenVersion === stubSays &&
        rowAfterPick === fixtures.stubCli &&
        clearDisabledAfter === false &&
        statusAfterPick.path === fixtures.stubCli &&
        statusAfterPick.source === 'setting' &&
        cleared &&
        rowAfterClear === null &&
        restoredPath === paintedPath &&
        statusAfterClear.source === 'discovered',
      detail: {
        overrideFoundAtStart: overrideAtStart ?? null,
        painted: { path: paintedPath, version: paintedVersion },
        askedTheExecutableDirectly: directVersion,
        whereExeSays: onPath,
        paintedPathIsTheOneOnPath: agreesWithPath,
        clearDisabledWithNoOverride: clearDisabledBefore,
        afterPicking: {
          painted: { path: overriddenPath, version: overriddenVersion },
          stubSaysDirectly: stubSays,
          databaseRow: rowAfterPick,
          setupStatus: statusAfterPick,
          clearEnabled: clearDisabledAfter === false
        },
        afterClearing: {
          databaseRow: rowAfterClear,
          painted: restoredPath,
          setupStatus: statusAfterClear
        },
        screenshot: shot.file
      },
      notes: [
        'The version on screen is compared with what the executable answers when',
        'this driver runs it, and the path against `where.exe claude` - Helm is',
        'not asked twice.',
        'Any override already in the database is cleared first, because this runs',
        'against the real profile and a previous run parks one on purpose.',
        'The override is a real program on disk answering 9.9.9, picked through',
        'the same `setup:locateClaude` handler the picker calls, and the value is',
        'read back out of the database file rather than out of the app.',
        'This is the gap the pane closes: before it, `claudePath` was reachable',
        'only during first run, so a wrong pick was permanent.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-3: scan roots can be added and removed - `roots:remove` gets its caller
  // -------------------------------------------------------------------------
  if (run('roots')) {
    await openSettings(win)
    await sleep(300)

    const rootsBefore = rowValue(dbFile, 'scanRoots') as string[] | undefined
    const projectsBefore = await sidebarPaths(win)

    for (const root of [fixtures.rootA, fixtures.rootB]) {
      answerPicker('directory', root)
      await click(win, '[data-settings-add-root]')
      await pollJs(win, byData('settings-root', root), 20_000)
    }
    // The scan the addition kicked off has to land before the tree means
    // anything.
    await pollJs(
      win,
      `[...document.querySelectorAll('aside button[title]')]
        .filter((b) => b.title.toLowerCase().startsWith(${JSON.stringify(
          fixtures.rootB.toLowerCase()
        )})).length === 2`,
      45_000
    )
    await sleep(600)

    const rootsAfterAdd = rowValue(dbFile, 'scanRoots') as string[] | undefined
    const projectsAfterAdd = await sidebarPaths(win)
    const bShownBefore = projectsAfterAdd.filter((path) =>
      path.toLowerCase().startsWith(fixtures.rootB.toLowerCase())
    )
    const shot = await screenshot(win, shotDir, 'settings-3-roots.png')

    // Remove one, through the row's own button.
    const removed = await clickByData(win, 'settings-remove-root', fixtures.rootB)
    const rowGone = await pollJs(win, `!${byData('settings-root', fixtures.rootB)}`, 15_000)
    const treeShrank = await pollJs(
      win,
      `[...document.querySelectorAll('aside button[title]')]
        .every((b) => !b.title.toLowerCase().startsWith(${JSON.stringify(
          fixtures.rootB.toLowerCase()
        )}))`,
      45_000
    )
    await sleep(600)

    const rootsAfterRemove = rowValue(dbFile, 'scanRoots') as string[] | undefined
    const projectsAfterRemove = await sidebarPaths(win)
    const aStillShown = projectsAfterRemove.filter((path) =>
      path.toLowerCase().startsWith(fixtures.rootA.toLowerCase())
    )

    const lower = (list: string[] | undefined): string[] =>
      (list ?? []).map((entry) => entry.toLowerCase())

    checks.push({
      id: 'S-3',
      criterion: 'Scan roots can be added AND removed from the pane',
      title: 'Two roots added, one removed, and the next scan lost exactly its projects',
      ok:
        lower(rootsAfterAdd).includes(fixtures.rootA.toLowerCase()) &&
        lower(rootsAfterAdd).includes(fixtures.rootB.toLowerCase()) &&
        // The fixture has to be discriminating: unless the removed root was
        // actually contributing projects, losing them proves nothing.
        bShownBefore.length === fixtures.bProjects.length &&
        removed &&
        rowGone &&
        treeShrank &&
        !lower(rootsAfterRemove).includes(fixtures.rootB.toLowerCase()) &&
        lower(rootsAfterRemove).includes(fixtures.rootA.toLowerCase()) &&
        aStillShown.length === fixtures.aProjects.length &&
        projectsAfterRemove.length === projectsAfterAdd.length - fixtures.bProjects.length,
      detail: {
        rootsBefore,
        rootsAfterAdd,
        rootsAfterRemove,
        fixtureProjects: { rootA: fixtures.aProjects, rootB: fixtures.bProjects },
        sidebarProjectCounts: {
          before: projectsBefore.length,
          afterAdd: projectsAfterAdd.length,
          afterRemove: projectsAfterRemove.length
        },
        removedRootsProjectsWhileScanned: bShownBefore,
        keptRootsProjectsAfterwards: aStillShown,
        screenshot: shot.file
      },
      notes: [
        'The `roots:remove` channel has had a handler since first run landed and no',
        'all. This is the caller, and the row is read out of the database file.',
        'Removal is checked against the next scan rather than against the list of',
        'roots: the setting exists to change what Helm looks at, so the tree',
        'losing exactly the removed roots two projects is the thing worth proving.',
        'The fixture is asserted to have been contributing those projects first.',
        'Both fixture roots contain a path with a space in it - Windows-first.'
      ]
    })

    // -----------------------------------------------------------------------
    // S-22: the folder you add is the row you get, and its own pane takes it
    // back out
    // -----------------------------------------------------------------------
    //
    // Two failures in one report, and they are asserted end to end here rather
    // than one level down, because both of them were invisible one level down:
    // `scan` was doing exactly what it said, the setting held exactly the path
    // that was picked, and what the user got was four rows named after a Python
    // source tree and no way to be rid of them.
    //
    // The fixture has to discriminate. `leafChildren` is what the old rule
    // listed, so it is asserted non-empty first: a folder with nothing under it
    // would satisfy "exactly one row" while proving nothing at all.
    const leafSubdirs = readdirSync(fixtures.leafRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(fixtures.leafRoot, entry.name).toLowerCase())

    answerPicker('directory', fixtures.leafRoot)
    await click(win, '[data-settings-add-root]')
    await pollJs(win, byData('settings-root', fixtures.leafRoot), 20_000)
    await pollJs(
      win,
      `[...document.querySelectorAll('aside nav button[title]')]
        .some((b) => b.title.toLowerCase() === ${JSON.stringify(fixtures.leafRoot.toLowerCase())})`,
      45_000
    )
    await sleep(600)

    const leafRows = (await sidebarPaths(win)).filter((path) =>
      path.toLowerCase().startsWith(fixtures.leafRoot.toLowerCase())
    )

    // The pane, and the control that is only on it because this project is a
    // root. The converse matters as much: the same pane opened on a project
    // that is *inside* a root must not offer it, or "the panel is on every
    // pane" would pass this.
    const paneOpened = await clickProject(win, fixtures.leafRoot)
    await pollJs(win, `document.querySelector('[data-project-panel="scan-root"]')`, 15_000)
    const removeOnRoot = await js<boolean>(
      win,
      `document.querySelector('[data-project-remove-root]') !== null`
    ).catch(() => false)
    const leafShot = await screenshot(win, shotDir, 'settings-22-scanned-folder.png')

    const insideRoot = fixtures.aProjects[0] ?? ''
    await clickProject(win, insideRoot)
    await pollJs(win, `document.querySelector('[data-project-pane]')`, 15_000)
    await sleep(400)
    const removeOnChild = await js<boolean>(
      win,
      `document.querySelector('[data-project-remove-root]') !== null`
    ).catch(() => true)

    // Back to the folder, and out through its own button.
    await clickProject(win, fixtures.leafRoot)
    await pollJs(win, `document.querySelector('[data-project-remove-root]')`, 15_000)
    const cachedBefore = cachedProjectPaths(dbFile).filter((path) =>
      path.toLowerCase().startsWith(fixtures.leafRoot.toLowerCase())
    )
    const removedFromPane = await click(win, '[data-project-remove-root]')
    const leafRowGone = await pollJs(
      win,
      `[...document.querySelectorAll('aside nav button[title]')]
        .every((b) => !b.title.toLowerCase().startsWith(${JSON.stringify(
          fixtures.leafRoot.toLowerCase()
        )}))`,
      45_000
    )
    await sleep(800)

    const rootsAfterPaneRemove = rowValue(dbFile, 'scanRoots') as string[] | undefined
    const cachedAfter = cachedProjectPaths(dbFile).filter((path) =>
      path.toLowerCase().startsWith(fixtures.leafRoot.toLowerCase())
    )

    // The workspace goes back to how this group found it. Opening a project
    // pane starts a project shell that outlives every render, so a pane left
    // open here is a pty in the registry when a later group counts them - which
    // is exactly how this probe broke `S-10`. See `closeProjectTab`.
    //
    // The leaf root's own tab is already gone: removing a folder drops it from
    // discovery and the pane goes with it. `insideRoot` is the one this group
    // has to put back, and the close is asserted rather than fired and
    // forgotten, since a cleanup that silently did nothing is how the next
    // group inherits the same problem.
    const tidiedUp = await closeProjectTab(win, insideRoot)
    await sleep(500)
    const panesLeftOpen = await js<string[]>(
      win,
      `[...document.querySelectorAll('[role="tab"]')]
        .map((t) => t.dataset.tab ?? '')
        .filter((id) => id.startsWith('project:') &&
          id.toLowerCase().includes(${JSON.stringify(
            fixtures.dir.toLowerCase()
          )}))`
    ).catch(() => ['<unreadable>'])

    checks.push({
      id: 'S-22',
      criterion: 'A folder added as a root is itself the row, and its pane can remove it',
      title: `One row for a folder with ${String(leafSubdirs.length)} subdirectories, removed again from its own pane`,
      ok:
        leafSubdirs.length > 1 &&
        leafRows.length === 1 &&
        leafRows[0]?.toLowerCase() === fixtures.leafRoot.toLowerCase() &&
        paneOpened &&
        removeOnRoot &&
        !removeOnChild &&
        cachedBefore.length === 1 &&
        removedFromPane &&
        leafRowGone &&
        !(rootsAfterPaneRemove ?? []).some(
          (root) => root.toLowerCase() === fixtures.leafRoot.toLowerCase()
        ) &&
        cachedAfter.length === 0 &&
        // The folder is still there. Removal is a change to a setting and
        // nothing else, and the panel says so in those words.
        existsSync(fixtures.leafRoot) &&
        leafSubdirs.every((path) => existsSync(path)) &&
        // And this group left the workspace as it found it.
        tidiedUp &&
        panesLeftOpen.length === 0,
      detail: {
        leafRoot: fixtures.leafRoot,
        subdirectoriesTheOldRuleWouldHaveListed: leafSubdirs,
        sidebarRowsForIt: leafRows,
        removeControl: { onTheRoot: removeOnRoot, onAProjectInsideARoot: removeOnChild },
        cachedRows: { before: cachedBefore, after: cachedAfter },
        rootsAfterPaneRemove,
        stillOnDisk: existsSync(fixtures.leafRoot),
        leftTheWorkspaceAsItFoundIt: { closedTheProjectPane: tidiedUp, panesLeftOpen },
        screenshot: leafShot.file
      },
      notes: [
        'The reported bug: a folder added as a scan root listed its subdirectories',
        'and never itself. The fixture is a directory of three ordinary folders,',
        'asserted to exist first - "exactly one row" over an empty folder is a',
        'claim about nothing.',
        'Removal goes through the button on the project pane, and the verdict is',
        'read from the database file by this driver: the setting lost the root,',
        'and the `projects` rows under it - what the launcher paints from before',
        'the next scan lands - are gone with it. Both are asserted to have been',
        'there beforehand.',
        'The folder and every subdirectory are still on disk afterwards, which is',
        'what the panel promises in the words next to the button.',
        'The two project panes this opens are closed again before it returns. A',
        'project tab holds a shell that outlives every render, so a pane left',
        'open is a pty a later group counts - which is how this probe broke S-10',
        'the first time it ran in a full pass.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-19: pinned projects - the star, the section, and the pin that outlives
  // its folder
  // -------------------------------------------------------------------------
  if (run('pins')) {
    await openSettings(win)
    await sleep(300)

    /**
     * From no pins at all, whatever this machine had.
     *
     * The same move S-13 opens with - "the group is only meaningful from a
     * known state" - and here it is load-bearing rather than tidy. A check runs
     * against a copy of the real database (`scripts/isolate.mjs`), and
     * `pinnedProjects` is a preference somebody made, so it comes across; on
     * the machine this was found on, eight projects were already pinned. Every
     * count below is an absolute one - "two pins", "three once the unresolvable
     * one is written", "one after unpinning" - and against an inherited list
     * they were all counting the user's pins plus this group's. Worse, the
     * fixture's own discriminator went with them: "no Pinned section before
     * anything is pinned" cannot be asserted on a machine that arrives with a
     * Pinned section.
     *
     * Counting the delta instead was the other option and is the weaker one: it
     * would pass a section that had also quietly grown a row. Clearing first
     * keeps every count exact. The user's list comes back with `original` in
     * phase two, and `original` has this driver's own paths scrubbed out of it
     * already.
     */
    const pinsAsFound = rowValue(dbFile, 'pinnedProjects') as string[] | undefined
    const pinsCleared = await sendWrite(win, { pinnedProjects: [] })
    await sleep(500)
    const pinsAtStart = rowValue(dbFile, 'pinnedProjects') as string[] | undefined

    // A root of this group's own, so `--only=pins` is a run that means
    // something. Two harnesses under it, because "flat and cross-harness" is
    // the claim and one harness cannot distinguish it from a renamed group.
    answerPicker('directory', fixtures.pinRoot)
    await click(win, '[data-settings-add-root]')
    await pollJs(win, byData('settings-root', fixtures.pinRoot), 20_000)
    const scanned = await pollJs(
      win,
      `[...document.querySelectorAll('aside nav button[title]')]
        .filter((b) => b.title.toLowerCase().startsWith(${JSON.stringify(
          fixtures.pinRoot.toLowerCase()
        )})).length >= ${String(fixtures.pinProjects.length)}`,
      45_000
    )
    await sleep(600)

    const [first, second] = fixtures.pinProjects
    const beforeAnyPin = await pinState(win)

    // The star, pressed on the row the project is on. Not `settings:write`:
    // the claim is about the affordance, and a driver that wrote the setting
    // by hand would pass on a star that does nothing.
    const pinnedFirst = await clickByData(win, 'pin-project', first ?? '')
    await pollJs(win, `document.querySelector('[data-pinned-section]')`, 10_000)
    await sleep(400)
    const afterFirst = await pinState(win)
    const rowFirst = rowValue(dbFile, 'pinnedProjects') as string[] | undefined

    const pinnedSecond = await clickByData(win, 'pin-project', second ?? '')
    await sleep(500)
    const afterSecond = await pinState(win)
    const rowBoth = rowValue(dbFile, 'pinnedProjects') as string[] | undefined

    // The pin whose folder is not there. Written through the channel rather
    // than clicked, because there is no row to click - which is the whole
    // condition. Both real pins are re-sent with it, so this is one edit and
    // the state afterwards is "three pins, one of them unresolvable".
    const goneWrite = await sendWrite(win, {
      pinnedProjects: [...(rowBoth ?? []), fixtures.pinGone]
    })
    await sleep(600)
    const afterGone = await pinState(win, fixtures.pinGone)
    const rowWithGone = rowValue(dbFile, 'pinnedProjects') as string[] | undefined
    const shotPinned = await screenshot(win, shotDir, 'settings-19-pinned.png')

    // A rescan, through the sidebar's own button. It replaces the tree the
    // section resolves against, so "the pins are still there afterwards" is a
    // claim about two stores staying out of each other's way - the list is in
    // `app_settings` and the projects are in `projects` - and that is worth a
    // scan rather than an argument. The unresolvable one is the interesting
    // half: a scan is exactly the moment something could decide to tidy away a
    // path it did not find.
    const rescanned = await click(win, 'aside button[aria-label="Rescan all roots"]')
    await sleep(500)
    await pollJs(
      win,
      `!document.querySelector('aside button[aria-label="Rescan all roots"]').disabled`,
      45_000
    )
    await sleep(600)
    const afterRescan = await pinState(win, fixtures.pinGone)
    const rowAfterRescan = rowValue(dbFile, 'pinnedProjects') as string[] | undefined

    // The filter. A pinned section that ignored it would sit above the tree
    // still showing what the query just excluded.
    const needle = (second ?? '').split(/[\\/]+/).pop() ?? ''
    await typeInto(win, 'aside input[aria-label="Filter projects"]', needle)
    await sleep(500)
    const whileFiltering = await pinState(win)
    const filterCleared = await clearField(win, 'aside input[aria-label="Filter projects"]')
    await sleep(500)
    const afterFilter = await pinState(win)

    // Off again, through the settings pane's own list this time - the second
    // surface the setting has, and the one a stale pin is cleared from.
    await openSettings(win)
    await sleep(300)
    const goneListedInPane = await js<boolean>(
      win,
      `Boolean(${byData('settings-pinned', fixtures.pinGone)})`
    )
    const unpinnedGone = await clickByData(win, 'settings-unpin', fixtures.pinGone)
    await sleep(500)
    const unpinnedFirst = await clickByData(win, 'settings-unpin', first ?? '')
    await sleep(600)
    const afterUnpin = await pinState(win)
    const rowAfterUnpin = rowValue(dbFile, 'pinnedProjects') as string[] | undefined

    // And this group's root back out, so the tree it leaves is the tree it
    // found. The pins on its projects go with `original` in phase two.
    await clickByData(win, 'settings-remove-root', fixtures.pinRoot)
    await sleep(800)

    const lower = (list: readonly string[] | undefined): string[] =>
      (list ?? []).map((entry) => entry.toLowerCase())
    const onceInTree = (state: PinState, path: string): boolean =>
      state.rows.filter((row) => row === path.toLowerCase()).length === 1

    checks.push({
      id: 'S-19',
      criterion: 'A project can be pinned, appears once, and keeps its pin when its folder goes',
      title: 'The star lifts a project out of its harness; a pin whose folder has gone says so and offers no launch',
      ok:
        scanned &&
        // The known state this group is counted from. Without it every count
        // below is the user's pins plus this group's - see `pinsAsFound`.
        pinsCleared.accepted &&
        (pinsAtStart ?? []).length === 0 &&
        // The fixture has to discriminate: unless both projects started inside
        // their harness groups, "it moved to the Pinned section" proves nothing.
        beforeAnyPin.section === false &&
        onceInTree(beforeAnyPin, first ?? '') &&
        onceInTree(beforeAnyPin, second ?? '') &&
        pinnedFirst &&
        pinnedSecond &&
        // The database file, read through this driver's own connection.
        lower(rowFirst).includes((first ?? '').toLowerCase()) &&
        lower(rowBoth).length === 2 &&
        // Once each, and in the section rather than in the group. Two harnesses
        // apart, in one flat list.
        afterSecond.section &&
        afterSecond.pinned.length === 2 &&
        onceInTree(afterSecond, first ?? '') &&
        onceInTree(afterSecond, second ?? '') &&
        lower(afterSecond.pinned).includes((first ?? '').toLowerCase()) &&
        lower(afterSecond.pinned).includes((second ?? '').toLowerCase()) &&
        // The pin that outlived its folder: kept, painted, said out loud, and
        // with nothing on it that could start a session in a directory that is
        // not there.
        goneWrite.accepted &&
        lower(rowWithGone).includes(fixtures.pinGone.toLowerCase()) &&
        lower(afterGone.pinned).includes(fixtures.pinGone.toLowerCase()) &&
        afterGone.goneRow?.badge === true &&
        afterGone.goneRow.launchable === false &&
        !afterGone.rows.includes(fixtures.pinGone.toLowerCase()) &&
        // And a scan does not disturb any of it, the unresolvable one included.
        rescanned &&
        afterRescan.pinned.length === 3 &&
        lower(rowAfterRescan).length === 3 &&
        afterRescan.goneRow?.badge === true &&
        afterRescan.goneRow.launchable === false &&
        onceInTree(afterRescan, first ?? '') &&
        onceInTree(afterRescan, second ?? '') &&
        // Filtered like everything else. One pin matches the needle, the other
        // does not, and the unresolvable one does not either.
        whileFiltering.pinned.length === 1 &&
        lower(whileFiltering.pinned).includes((second ?? '').toLowerCase()) &&
        // And the filter is a filter rather than a deletion: clearing it brings
        // all three back. Without this the assertions after it would be about a
        // tree that is still filtered, which is what the first run of this
        // check actually was.
        filterCleared &&
        afterFilter.pinned.length === 3 &&
        // And off again, from the pane.
        goneListedInPane &&
        unpinnedGone &&
        unpinnedFirst &&
        lower(rowAfterUnpin).length === 1 &&
        lower(rowAfterUnpin).includes((second ?? '').toLowerCase()) &&
        onceInTree(afterUnpin, first ?? ''),
      detail: {
        fixture: {
          root: fixtures.pinRoot,
          projects: fixtures.pinProjects,
          neverCreated: fixtures.pinGone,
          scanFound: scanned
        },
        startedFrom: {
          pinsInTheSeededDatabase: pinsAsFound ?? [],
          clearedThroughSettingsWrite: pinsCleared,
          rowAfterClearing: pinsAtStart ?? []
        },
        beforeAnyPin,
        afterFirstStar: { state: afterFirst, databaseRow: rowFirst },
        afterSecondStar: { state: afterSecond, databaseRow: rowBoth },
        withAGoneFolder: {
          write: goneWrite,
          databaseRow: rowWithGone,
          state: afterGone,
          screenshot: shotPinned.file
        },
        afterARescan: { pressed: rescanned, state: afterRescan, databaseRow: rowAfterRescan },
        filter: { typed: needle, state: whileFiltering, cleared: filterCleared, afterClearing: afterFilter },
        afterUnpinning: {
          goneWasListedInThePane: goneListedInPane,
          state: afterUnpin,
          databaseRow: rowAfterUnpin
        }
      },
      notes: [
        'The group clears `pinnedProjects` first and asserts it is empty. A',
        'check runs against a copy of the real database and a pin is a real',
        'preference, so it comes across: every count here is an exact one, and',
        'without the clear they were all the user`s pins plus this group`s.',
        'Pinned through the star on the row, not through `settings:write`: the',
        'setting is only half of this and the affordance is the other half.',
        'Every value is then read back out of the database file through this',
        'driver`s own read-only connection, beside the DOM assertion.',
        'Two harnesses in the fixture, because a flat cross-harness section and',
        'a renamed group look identical when there is only one group.',
        '"Appears once" is counted over every row in the tree, since printing a',
        'pinned project in both places is the failure the section cannot afford.',
        'The unresolvable pin is written rather than clicked because there is no',
        'row to click - that is the condition. What is asserted about it is that',
        'the entry survives, that the row says `folder gone`, and that the row',
        'is not a button: it carries no `title`, so no selector that reaches a',
        'launchable project row reaches it.',
        'Then a real rescan, because "the pins survive one" is a claim about the',
        'settings row and the projects table staying out of each other`s way -',
        'and a scan is the moment a path nothing found could get tidied away.',
        'Whether the pin survives a *restart* is S-9`s, from the parked value.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-4: theme, and the repaint it has to cause
  // -------------------------------------------------------------------------
  if (run('appearance')) {
    await openSettings(win)
    await sleep(300)

    const observed: Array<Record<string, unknown>> = []
    let everyThemeApplied = true

    for (const theme of ['dark', 'light'] as const) {
      overlayCalls.length = 0
      const label = theme === 'dark' ? 'Dark theme' : 'Light theme'
      const clicked = await click(
        win,
        `[data-settings-theme] button[aria-label=${q(label)}]`
      )
      await pollJs(
        win,
        `document.documentElement.classList.contains('dark') === ${String(theme === 'dark')}`,
        10_000
      )
      await sleep(700)

      const painted = await js<{ dark: boolean; canvas: string; scheme: string; checked: string }>(
        win,
        `(() => {
           const style = getComputedStyle(document.documentElement);
           const chosen = document.querySelector('[data-settings-theme] button[aria-checked="true"]');
           return {
             dark: document.documentElement.classList.contains('dark'),
             canvas: style.getPropertyValue('--helm-bg').trim(),
             scheme: document.documentElement.style.colorScheme,
             checked: chosen ? chosen.getAttribute('aria-label') : ''
           } })()`
      )
      const row = rowValue(dbFile, 'theme')
      const overlay = overlayCalls.at(-1) ?? null
      // The colour the platform was handed has to be the canvas the page is
      // actually painting - two sources, compared as one value.
      const overlayMatchesCanvas =
        overlay !== null &&
        painted.canvas !== '' &&
        overlay.color.toLowerCase() === painted.canvas.toLowerCase()

      const ok =
        clicked &&
        painted.dark === (theme === 'dark') &&
        painted.scheme === theme &&
        painted.checked === label &&
        row === theme &&
        nativeTheme.themeSource === theme &&
        overlayMatchesCanvas
      if (!ok) everyThemeApplied = false

      observed.push({
        theme,
        clicked,
        htmlHasDarkClass: painted.dark,
        colorScheme: painted.scheme,
        canvasTokenCssResolved: painted.canvas,
        canvasAsRgb: hexToRgb(painted.canvas),
        overlayHandedToElectron: overlay,
        overlayMatchesCanvas,
        databaseRow: row,
        nativeThemeSource: nativeTheme.themeSource,
        paneShowsChecked: painted.checked,
        ok
      })
      await screenshot(win, shotDir, `settings-4-theme-${theme}.png`)
    }

    checks.push({
      id: 'S-4',
      criterion: 'Theme is settable from the pane, and the choice takes effect',
      title: 'Both themes flip the document class, repaint the window controls, and write the row',
      ok: everyThemeApplied,
      detail: { observed },
      notes: [
        'Three independent witnesses per theme: the class Chromium has on',
        '<html>, the colour Electron was handed for the Window Controls Overlay',
        '- captured by wrapping `setTitleBarOverlay` on the window itself - and',
        'the row in the database file.',
        'The overlay colour is compared against the `--helm-bg` token as the',
        'stylesheet resolved it, so "the buttons match the canvas" is measured',
        'rather than assumed from a table in the source.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-5: usage display, including the mode that may not be offered yet
  // -------------------------------------------------------------------------
  if (run('appearance')) {
    // Which modes may be offered is a function of whether the index has an
    // estimate, so drive it to completion first rather than racing it.
    let passes = 0
    let indexed
    do {
      indexed = usage.index.pass()
      passes++
    } while (!indexed.caughtUp && passes < 200)
    const snapshot = usage.refresh()
    await sleep(700)
    await openSettings(win)
    await sleep(300)

    const hasEstimate = snapshot.spend != null
    const costDisabled = await disabled(win, '[data-settings-usage="cost"]')
    const costTitle = await attr(win, '[data-settings-usage="cost"]', 'title')

    const walked: Array<Record<string, unknown>> = []
    const modes = hasEstimate ? (['off', 'cost', 'percent'] as const) : (['off', 'percent'] as const)
    let everyModeApplied = true

    for (const mode of modes) {
      await click(win, `[data-settings-usage=${q(mode)}]`)
      const reached = await pollJs(
        win,
        `document.querySelector('[data-usage-segment]')?.dataset.usageSegment === ${q(mode)}`,
        10_000
      )
      await sleep(400)
      const row = rowValue(dbFile, 'usageDisplay')
      const segmentText = await text(win, '[data-usage-segment]')
      const checked = await attr(win, `[data-settings-usage=${q(mode)}]`, 'aria-checked')
      const ok = reached && row === mode && checked === 'true'
      if (!ok) everyModeApplied = false
      walked.push({ mode, statusBarFollowed: reached, databaseRow: row, segmentText, checked, ok })
    }

    await screenshot(win, shotDir, 'settings-5-usage.png')

    checks.push({
      id: 'S-5',
      criterion: 'Usage display is settable from the pane, honouring the offerable rule',
      title: 'Each offered mode reaches the status bar and the database; cost is offered only when it can be filled',
      ok:
        everyModeApplied &&
        costDisabled === !hasEstimate &&
        (hasEstimate || (costTitle ?? '').includes('index has caught up')),
      detail: {
        indexPasses: passes,
        indexHasEstimate: hasEstimate,
        costSegmentDisabled: costDisabled,
        costSegmentTitle: costTitle,
        walked
      },
      notes: [
        'The status bar is the side effect: each mode is confirmed on the segment',
        'a person actually looks at, not only in the row.',
        '`cost` is greyed out with the reason in its title until the transcript',
        'index has an estimate - the same rule the segment cycles by, from the',
        'same function, so the two cannot drift apart.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-6: the quick accessors still work, and the pane follows them
  // -------------------------------------------------------------------------
  if (run('accessors')) {
    await openSettings(win)
    await sleep(300)

    // The title bar's toggle - the one outside the pane.
    const before = await attr(win, '[data-settings-theme]', 'data-settings-theme')
    const target = before === 'dark' ? 'Light theme' : 'Dark theme'
    const targetTheme = target === 'Dark theme' ? 'dark' : 'light'
    const clickedToggle = await click(
      win,
      `.app-drag [role="radiogroup"][aria-label="Theme"] button[aria-label=${q(target)}]`
    )
    const paneFollowedTheme = await pollJs(
      win,
      `document.querySelector('[data-settings-theme]')?.dataset.settingsTheme === ${q(targetTheme)}`,
      10_000
    )
    await sleep(400)
    const themeRow = rowValue(dbFile, 'theme')

    // The status bar's segment - a click cycles it, and the pane has to agree
    // with wherever it landed.
    const usageBefore = await attr(win, '[data-usage-segment]', 'data-usage-segment')
    const clickedSegment = await click(win, '[data-usage-segment]')
    await sleep(700)
    const usageAfter = await attr(win, '[data-usage-segment]', 'data-usage-segment')
    const paneUsage = await attr(win, '[data-settings-usage][aria-checked="true"]', 'data-settings-usage')
    const usageRow = rowValue(dbFile, 'usageDisplay')

    // The release check's tick, driven where it lives. Off and on again, so
    // what is observed is the box changing the row in both directions rather
    // than a default that happened to match.
    const updateBefore = rowValue(dbFile, 'updateCheck')
    const tickedOff = await click(win, '[data-settings-update-check] input')
    await sleep(500)
    const updateOffRow = rowValue(dbFile, 'updateCheck')
    const tickedOn = await click(win, '[data-settings-update-check] input')
    await sleep(500)
    const updateOnRow = rowValue(dbFile, 'updateCheck')
    // Booleans, not the strings they are stored as: `rowValue` parses the
    // column, so `app_settings` holding the text `false` reads back here as
    // `false`. Comparing against `'false'` failed on a row that was correct.
    const updateTogglesBothWays =
      tickedOff && tickedOn && updateOffRow === false && updateOnRow === true

    checks.push({
      id: 'S-6',
      criterion: 'The existing quick accessors keep working and stay in sync with the pane',
      title: 'The title bar toggle and the status bar segment write through, and the pane follows both',
      ok:
        clickedToggle &&
        paneFollowedTheme &&
        themeRow === targetTheme &&
        clickedSegment &&
        usageAfter !== null &&
        usageAfter !== usageBefore &&
        paneUsage === usageAfter &&
        usageRow === usageAfter &&
        updateTogglesBothWays,
      detail: {
        theme: { before, clicked: target, paneFollowed: paneFollowedTheme, databaseRow: themeRow },
        usage: {
          segmentBefore: usageBefore,
          segmentAfter: usageAfter,
          paneShows: paneUsage,
          databaseRow: usageRow
        },
        updateCheck: {
          rowBefore: updateBefore,
          afterUntick: updateOffRow,
          afterRetick: updateOnRow,
          bothClicksLanded: tickedOff && tickedOn
        }
      },
      notes: [
        'Both accessors are clicked where they live - the title bar strip and the',
        'status bar - with the settings pane open behind them, so "stays in sync"',
        'is observed rather than inferred from both writing the same channel.',
        'The segment is cycled rather than set, which is also what proves the',
        'cycle still exists now that the setting has a home.',
        'The release-check tick is driven off *and back on*, because a single',
        'click landing on the value it already held would report a pass from a',
        'control that does nothing.',
        'What is asserted here is the setting, not the request. Whether a launch',
        'actually asks GitHub is a claim about the network and about a throttle',
        'measured in days, and a check that made it would be a check that fails',
        'on an aeroplane.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-14 to S-18: the Updates group, and the check a person asks for
  // -------------------------------------------------------------------------
  //
  // All five run against `pointReleases` - the seam in `update.ts` that swaps
  // the *source* of the tag rather than the address it is fetched from. A
  // function and not a URL, because pointing this at a second address would
  // mean this driver standing up an HTTP server, and "the app has no inbound
  // listener anywhere in it" is a claim worth keeping true. Swapping the source
  // also produces the one thing the network cannot be asked for on demand: a
  // newer release, an older one, and a failure, in that order, on a machine
  // that is online.
  //
  // The seam is restored in a `finally`, so a phase that throws does not leave
  // a later one asking a fixture.
  if (run('updates')) {
    /**
     * This driver's own count of how many times Helm asked, kept in the closure
     * beside the source rather than read out of `update.ts`.
     *
     * `releasesAsked()` answers the same question and is asserted against this
     * one at every step. It is `update.ts`'s counter of its own behaviour, so on
     * its own it would be the code agreeing with itself; this one is incremented
     * by the function Helm actually called, which is a fact about the call and
     * not about the bookkeeping around it. Two counters that disagree is a
     * finding either way.
     */
    let askedHere = 0

    /** A source that answers with a tag, optionally taking its time about it. */
    const answering =
      (tag: string, delayMs = 0) =>
      async (): Promise<string> => {
        askedHere += 1
        if (delayMs > 0) await sleep(delayMs)
        return tag
      }

    /** A source that cannot answer, which is what being offline looks like here. */
    const refusing = (reason: string) => async (): Promise<string> => {
      askedHere += 1
      await sleep(50)
      throw new Error(reason)
    }

    /** Wait on this driver's own counter, not on anything the window says. */
    const waitAsked = async (n: number, timeoutMs = 20_000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs
      while (askedHere < n && Date.now() < deadline) await sleep(100)
      return askedHere >= n
    }

    const outcomeState = (): Promise<string | null> =>
      attr(win, '[data-settings-update-outcome]', 'data-settings-update-outcome')
    const outcomeSentence = (): Promise<string> => text(win, '[data-settings-update-outcome]')
    /** The tone, which every group's verdict carries under the same name. */
    const outcomeTone = (): Promise<string | null> =>
      attr(win, '[data-settings-update-outcome]', 'data-settings-verdict')

    /**
     * One press of Check now against a source of this driver's choosing.
     *
     * The gate is `waitAsked`, not the attribute on screen: two drives in a row
     * can legitimately land on the same outcome, and polling for a value that is
     * already there would report a pass for a button that did nothing. Only once
     * this driver's own source has been entered is the answer on screen known to
     * be *this* drive's, and the attribute is read after that.
     */
    interface Drive {
      clicked: boolean
      asked: boolean
      askedHere: number
      askedThere: number
      settled: boolean
      state: string | null
      tone: string | null
      sentence: string
      latestFact: string
      releasesPresent: boolean
      releasesDisabled: boolean | null
      releasesTitle: string | null
    }

    const drive = async (source: () => Promise<string>, expected: string): Promise<Drive> => {
      pointReleases(source)
      askedHere = 0
      const clicked = await click(win, '[data-settings-update-now]')
      const asked = await waitAsked(1)
      const settled = await pollJs(
        win,
        `document.querySelector('[data-settings-update-outcome]')?.dataset.settingsUpdateOutcome === ${q(expected)}`,
        20_000
      )
      await sleep(250)
      return {
        clicked,
        asked,
        askedHere,
        askedThere: releasesAsked(),
        settled,
        state: await outcomeState(),
        tone: await outcomeTone(),
        sentence: await outcomeSentence(),
        latestFact: await text(win, '[data-settings-latest-version]'),
        releasesPresent: await exists(win, '[data-settings-releases]'),
        releasesDisabled: await disabled(win, '[data-settings-releases]'),
        releasesTitle: await attr(win, '[data-settings-releases]', 'title')
      }
    }

    /**
     * What this build says it is, asked of Electron rather than read off the
     * pane. The pane's number came the long way round - `app:info` over IPC and
     * into React - so the two agreeing is a round trip proved rather than a
     * value restated.
     */
    const runningVersion = app.getVersion()
    /** A tag no release will ever carry, so `newer` cannot be a coincidence. */
    const HIGH_TAG = 'v99.9.9'
    /** A reason no network stack produces, so finding it in the sentence means it was carried. */
    const REFUSAL = 'the settings-check fixture refused on purpose'

    const updateCheckAtPhaseStart = rowValue(dbFile, 'updateCheck')

    try {
      await openSettings(win)
      await sleep(400)

      const paintedVersion = await text(win, '[data-settings-app-version]')

      // -----------------------------------------------------------------------
      // A positive control for `disabled()`, before anything is believed about
      // a button *not* being disabled.
      //
      // "The button was not disabled" is exactly the assertion that passes when
      // the probe is broken: a selector that matches nothing, or a helper that
      // always answered false, would report every control on the pane as live.
      // So the button is first caught in the one state where it genuinely is
      // disabled - mid-flight - by pointing the source at something slow enough
      // for this driver to look while it is still in the air.
      // -----------------------------------------------------------------------
      pointReleases(answering(HIGH_TAG, 2000))
      askedHere = 0
      const clickedSlow = await click(win, '[data-settings-update-now]')
      await sleep(500)
      const nowDisabledInFlight = await disabled(win, '[data-settings-update-now]')
      const outcomeInFlight = await outcomeState()
      // Release notes is deliberately not disabled by a check being in progress:
      // it opens a page, it does not ask GitHub anything.
      const releasesDisabledInFlight = await disabled(win, '[data-settings-releases]')
      await waitAsked(1)
      await pollJs(
        win,
        `document.querySelector('[data-settings-update-outcome]')?.dataset.settingsUpdateOutcome !== 'checking'`,
        20_000
      )
      await sleep(250)
      const nowDisabledAtRest = await disabled(win, '[data-settings-update-now]')

      // -----------------------------------------------------------------------
      // S-14: unthrottled, twice in a row
      // -----------------------------------------------------------------------
      pointReleases(answering(HIGH_TAG))
      askedHere = 0
      const askedAtStart = releasesAsked()

      const clickedOnce = await click(win, '[data-settings-update-now]')
      const reachedOne = await waitAsked(1)
      const settledOne = await pollJs(
        win,
        `document.querySelector('[data-settings-update-outcome]')?.dataset.settingsUpdateOutcome === 'newer'`,
        20_000
      )
      await sleep(300)
      const afterOneThere = releasesAsked()
      const afterOneHere = askedHere

      const clickedTwice = await click(win, '[data-settings-update-now]')
      const reachedTwo = await waitAsked(2)
      await sleep(400)
      const afterTwoThere = releasesAsked()
      const afterTwoHere = askedHere
      const twiceState = await outcomeState()
      const twiceSentence = await outcomeSentence()

      const shotUpdates = await screenshot(win, shotDir, 'settings-14-updates.png')

      checks.push({
        id: 'S-14',
        criterion: 'A manual check runs on demand and is never throttled, including twice in a row',
        title: 'Check now asks GitHub every time it is pressed - two presses, two requests',
        ok:
          clickedOnce &&
          clickedTwice &&
          reachedOne &&
          reachedTwo &&
          settledOne &&
          // The counter is live before anything is concluded from it moving.
          askedAtStart === 0 &&
          afterOneThere === 1 &&
          afterOneHere === 1 &&
          // The whole check: two, not one. A throttle would leave this at 1.
          afterTwoThere === 2 &&
          afterTwoHere === 2 &&
          twiceState === 'newer' &&
          twiceSentence.includes('99.9.9') &&
          twiceSentence.includes(runningVersion),
        detail: {
          runningVersion,
          fixtureTag: HIGH_TAG,
          asked: {
            atStart: { updateTs: askedAtStart, driver: 0 },
            afterFirstPress: { updateTs: afterOneThere, driver: afterOneHere },
            afterSecondPress: { updateTs: afterTwoThere, driver: afterTwoHere }
          },
          clicks: { first: clickedOnce, second: clickedTwice },
          firstSettledOnNewer: settledOne,
          outcomeAfterTwo: twiceState,
          sentenceAfterTwo: twiceSentence,
          screenshot: shotUpdates.file
        },
        notes: [
          'Two counters, not one. `releasesAsked()` is `update.ts` counting its',
          'own calls; the other is incremented inside the function Helm actually',
          'invoked, which this driver wrote. They are asserted equal at every',
          'step, so a bookkeeping bug in either is a failure rather than a pass.',
          'The count is checked at zero before the first press and at one after',
          'it, so "it went to two" is read off a counter already shown to move.',
          'One is the number a throttled channel would report, which is what',
          'makes two the discriminating value rather than merely a large one.',
          'The tag is 99.9.9 - no release carries it, so `newer` cannot be a',
          'coincidence, and the sentence is checked for naming both versions',
          'rather than only for existing.'
        ]
      })

      // -----------------------------------------------------------------------
      // S-15: it works with the setting off, and pressing it does not turn it on
      // -----------------------------------------------------------------------
      const updateRowBefore = rowValue(dbFile, 'updateCheck')
      let turnedOff = true
      if (updateRowBefore !== false) {
        turnedOff = await click(win, '[data-settings-update-check] input')
        await sleep(600)
      }
      const rowWhenOff = rowValue(dbFile, 'updateCheck')
      const tickShowsOff = await attr(win, '[data-settings-update-check]', 'data-settings-update-check')
      // The button, read in the state the criterion is about: the automatic
      // check off, and Check now still live.
      const nowDisabledWhileOff = await disabled(win, '[data-settings-update-now]')

      const offDrive = await drive(answering(HIGH_TAG), 'newer')
      const rowAfterManualCheck = rowValue(dbFile, 'updateCheck')
      const tickAfterManualCheck = await attr(
        win,
        '[data-settings-update-check]',
        'data-settings-update-check'
      )

      checks.push({
        id: 'S-15',
        criterion:
          'A manual check works with `updateCheck` off, and pressing it does not turn the setting on',
        title:
          'With the launch check off, Check now is still live, still gets an answer, and leaves the setting off',
        ok:
          rowWhenOff === false &&
          tickShowsOff === 'false' &&
          // Not disabled by the setting - and the probe that says so has been
          // made to answer `true` for the same button moments earlier.
          nowDisabledWhileOff === false &&
          nowDisabledInFlight === true &&
          nowDisabledAtRest === false &&
          clickedSlow &&
          outcomeInFlight === 'checking' &&
          releasesDisabledInFlight === false &&
          offDrive.clicked &&
          offDrive.asked &&
          offDrive.settled &&
          offDrive.state === 'newer' &&
          offDrive.sentence !== '' &&
          // Unchanged by the press, in the row and on the tick.
          rowAfterManualCheck === false &&
          tickAfterManualCheck === 'false',
        detail: {
          settingRow: {
            atPhaseStart: updateCheckAtPhaseStart,
            beforeThisCheck: updateRowBefore,
            turnedOffHere: turnedOff,
            whenOff: rowWhenOff,
            afterPressingCheckNow: rowAfterManualCheck
          },
          tickAttribute: { whenOff: tickShowsOff, afterPressingCheckNow: tickAfterManualCheck },
          checkNowButton: {
            disabledWhileSettingOff: nowDisabledWhileOff,
            disabledMidFlight: nowDisabledInFlight,
            disabledAtRest: nowDisabledAtRest,
            outcomeMidFlight: outcomeInFlight,
            releasesDisabledMidFlight: releasesDisabledInFlight
          },
          drive: offDrive
        },
        notes: [
          'The probe is made to fail first. "Not disabled" is the assertion that',
          'passes when a selector matches nothing, so the same button is caught',
          'disabled mid-flight - against a source told to take two seconds - and',
          'live again afterwards, before "not disabled while the setting is off"',
          'is believed of the identical selector.',
          'The setting is read out of the database file through this driver’s own',
          'read-only connection, before and after the press, and off the tick in',
          'the pane. A press that quietly re-enabled the launch check would move',
          'one or the other.',
          'This is the criterion the channel comment states: `updateCheck`',
          'governs whether Helm asks by itself, not whether the user may.',
          'Release notes is checked for staying live during the check, because it',
          'opens a page rather than asking GitHub anything.'
        ]
      })

      // -----------------------------------------------------------------------
      // S-16 and S-17: the three outcomes, and the link that survives all of them
      // -----------------------------------------------------------------------
      const newerDrive = await drive(answering(HIGH_TAG), 'newer')
      // A tag equal to the running build: `isNewer` is strict, so this is the
      // up-to-date state rather than a lower number pretending to be one.
      const currentDrive = await drive(answering(`v${runningVersion}`), 'current')
      const offlineDrive = await drive(refusing(REFUSAL), 'unreachable')

      const sentences = [newerDrive.sentence, currentDrive.sentence, offlineDrive.sentence]
      const nonEmpty = sentences.every((s) => s.trim() !== '')
      const distinct = new Set(sentences).size === 3
      const offlineFollowUp = await text(win, '[data-settings-update-offline]')

      checks.push({
        id: 'S-16',
        criterion:
          'All three outcomes render as sentences; “could not ask” names the reason and does not read as a failure of Helm',
        title:
          'Newer, up to date and could-not-ask each render a distinct sentence, and the offline one names its reason without a warning tone',
        ok:
          newerDrive.asked &&
          currentDrive.asked &&
          offlineDrive.asked &&
          newerDrive.settled &&
          currentDrive.settled &&
          offlineDrive.settled &&
          newerDrive.state === 'newer' &&
          currentDrive.state === 'current' &&
          offlineDrive.state === 'unreachable' &&
          // The three are non-empty and no two are the same string. A helper
          // that returned '' three times would satisfy neither.
          nonEmpty &&
          distinct &&
          // Each names what it is about.
          newerDrive.sentence.includes('99.9.9') &&
          newerDrive.sentence.includes(runningVersion) &&
          currentDrive.sentence.includes(runningVersion) &&
          offlineDrive.sentence.includes(REFUSAL) &&
          // Tones: up to date is settled, could-not-ask is not a warning.
          currentDrive.tone === 'ok' &&
          offlineDrive.tone !== 'warn' &&
          offlineDrive.tone === 'todo' &&
          newerDrive.tone !== 'warn' &&
          // The quieter line pointing at the link that still works.
          offlineFollowUp !== '' &&
          // The version fact follows the answer rather than the last good one.
          newerDrive.latestFact === '99.9.9' &&
          currentDrive.latestFact === runningVersion &&
          offlineDrive.latestFact === NOTHING &&
          paintedVersion === runningVersion,
        detail: {
          runningVersion,
          paneSaysVersion: paintedVersion,
          refusalPlanted: REFUSAL,
          sentences: {
            newer: newerDrive.sentence,
            current: currentDrive.sentence,
            unreachable: offlineDrive.sentence
          },
          allNonEmpty: nonEmpty,
          allDistinct: distinct,
          tones: {
            newer: newerDrive.tone,
            current: currentDrive.tone,
            unreachable: offlineDrive.tone
          },
          latestFact: {
            newer: newerDrive.latestFact,
            current: currentDrive.latestFact,
            unreachable: offlineDrive.latestFact
          },
          offlineFollowUpLine: offlineFollowUp,
          drives: { newer: newerDrive, current: currentDrive, unreachable: offlineDrive }
        },
        notes: [
          'The three sentences are asserted **distinct from each other** before',
          'anything is concluded from any one of them. A reader that returned an',
          'empty string three times, or a component that painted one sentence in',
          'every state, is the failure this catches - and it is the failure',
          'CLAUDE.md records PROF-4 dying of.',
          'The reason is a string no network stack produces, planted by this',
          'driver and looked for in what the pane rendered, so "names the reason"',
          'is carriage proved end to end rather than a plausible sentence.',
          'The tone is the judgement: could-not-ask is `todo`, never `warn`.',
          'Offline is an expected answer - nothing is broken and nothing is known',
          'to be out of date - and a warning triangle would be Helm blaming the',
          'network for a question Helm asked on its own initiative.',
          'The Latest fact is read in all three: it must follow the answer that',
          'just came back, including emptying when that answer carried no',
          'version, rather than keeping a number nothing just measured.',
          'The version on screen is compared with `app.getVersion()` asked here,',
          'which is the `app:info` round trip through IPC and React proved rather',
          'than restated.'
        ]
      })

      checks.push({
        id: 'S-17',
        criterion: 'The releases link is reachable when up to date and when offline',
        title: 'Release notes is present and live in both the up-to-date and the could-not-ask state',
        ok:
          currentDrive.releasesPresent &&
          currentDrive.releasesDisabled === false &&
          offlineDrive.releasesPresent &&
          offlineDrive.releasesDisabled === false &&
          // It points somewhere, rather than merely existing.
          (currentDrive.releasesTitle ?? '').startsWith('https://') &&
          currentDrive.releasesTitle === offlineDrive.releasesTitle &&
          // The same helper answered `true` for a genuinely disabled control in
          // this run, so `false` here is a reading and not a default.
          nowDisabledInFlight === true,
        detail: {
          upToDate: {
            present: currentDrive.releasesPresent,
            disabled: currentDrive.releasesDisabled,
            title: currentDrive.releasesTitle
          },
          couldNotAsk: {
            present: offlineDrive.releasesPresent,
            disabled: offlineDrive.releasesDisabled,
            title: offlineDrive.releasesTitle
          },
          disabledProbeProvedItCanSayTrue: nowDisabledInFlight,
          alsoLiveWhileAskingGitHub: releasesDisabledInFlight === false
        },
        notes: [
          'These two states are the whole reason the URL comes from `app:info`',
          'and not from a check’s result: up to date and could-not-ask are',
          'exactly the cases that produce no URL to render, and they are also the',
          'two where somebody most wants to go and look for themselves.',
          'The title is asserted to be an https address and to be the same one in',
          'both states, so this is a link to a place rather than a button that',
          'happens to be enabled.',
          '`disabled()` is trusted here only because it was made to answer `true`',
          'earlier in this same run, on this same button.'
        ]
      })

      // -----------------------------------------------------------------------
      // S-18: a manual check does not move the launch check's throttle
      // -----------------------------------------------------------------------
      //
      // The row is first written through the ordinary channel and read back, for
      // the reason every rejection case in S-7 is preceded by a valid write:
      // "the row did not change" is also what a key nothing can write would
      // report, and a stamp that is simply absent would sit unchanged through
      // anything.
      const SENTINEL = '2001-02-03T04:05:06.000Z'
      const plantedStamp = await sendWrite(win, { lastUpdateCheckAt: SENTINEL })
      await sleep(600)
      const stampBefore = rawRow(dbFile, 'lastUpdateCheckAt')
      const plantLanded = stampBefore === JSON.stringify(SENTINEL)

      const manualDrives: Drive[] = []
      manualDrives.push(await drive(answering(HIGH_TAG), 'newer'))
      manualDrives.push(await drive(answering(`v${runningVersion}`), 'current'))
      manualDrives.push(await drive(refusing(REFUSAL), 'unreachable'))
      await sleep(600)

      const stampAfter = rawRow(dbFile, 'lastUpdateCheckAt')

      checks.push({
        id: 'S-18',
        criterion: 'A manual check does not write `lastUpdateCheckAt`',
        title: 'Three manual checks leave the launch throttle’s timestamp byte-for-byte unmoved',
        ok:
          plantedStamp.accepted &&
          plantLanded &&
          manualDrives.every((d) => d.clicked && d.asked && d.settled) &&
          stampAfter === stampBefore &&
          // Including the successful ones: a stamp written only on success would
          // still be a stamp a manual check wrote.
          manualDrives.filter((d) => d.state !== 'unreachable').length === 2,
        detail: {
          sentinelWrittenThroughSettingsWrite: SENTINEL,
          writeAccepted: plantedStamp.accepted,
          writeError: plantedStamp.error,
          rawColumnBefore: stampBefore,
          rawColumnAfter: stampAfter,
          plantLanded,
          outcomesDriven: manualDrives.map((d) => d.state),
          manualDrives
        },
        notes: [
          'The row is planted through `settings:write` and read back first, so',
          'the key is shown to be writable and this driver’s reader shown to see',
          'a write, before "it did not change" is worth anything. An absent stamp',
          'would sit unchanged through anything at all.',
          'Read as the raw column text rather than through the JSON parse, which',
          'is what makes it byte-for-byte: a rewrite of the same instant in a',
          'different shape is still a write, and it is the write this is looking',
          'for.',
          'Three checks and not one, and two of them succeed - the throttle is',
          'stamped after a *successful* answer (`maybeCheckForUpdate`), so a',
          'manual check that wrote it would write it on exactly those two.',
          'The throttle belongs to the launch check, which is what earns the app',
          'the right to ask on its own. A manual press moving it would let a',
          'person pressing a button silently buy Helm another day of not asking.'
        ]
      })
    } finally {
      // Back to the real GitHub, whatever happened above: a later phase must not
      // inherit a fixture, and neither must the rest of this app's life.
      pointReleases(null)
      // And the setting back to where the run found it. S-15 turns it off on
      // purpose; leaving it off would park a value nothing here meant to park,
      // and `original` is the boolean the restore is going to write anyway.
      await sendWrite(win, { updateCheck: original.updateCheck })
      await sleep(400)
    }
  }

  // -------------------------------------------------------------------------
  // S-7: runtime validation rejects malformed values for every key
  // -------------------------------------------------------------------------
  if (run('validation')) {
    const now = readSettings(services.store)

    /**
     * One case per key of `AppSettings`, **enforced by the compiler**.
     *
     * A mapped type rather than an array, and the shape is deliberately the one
     * `SETTING_VALIDATORS` uses next door, for the reason that map uses it: a
     * key added to the interface without an entry here does not compile. This
     * table is hand-written - it has to be, since the whole probe is a second
     * opinion about what a bad value looks like - and a hand-written list that
     * has to be *remembered* goes stale. It did: `contentWrap` and
     * `contentWrapIndent` arrived with the content viewer's wrapping and
     * nothing here noticed, so two validated keys sat unprobed while
     * `everyKeyCovered` reported it as one `false` buried in a probe that takes
     * minutes to reach. The failure is the same one `PROF-4` is on record for,
     * one level up: a table that quietly stopped covering what it claims to.
     *
     * Now `pnpm typecheck` says so - in a second, in CI, before the app starts.
     * `everyKeyCovered` below stays as the runtime half and is not redundant:
     * the type is a claim about the interface, and that is a claim about the
     * object `readSettings` actually handed back.
     */
    const cases: { [K in keyof AppSettings]: { good: AppSettings[K]; bad: unknown; why: string } } =
      {
        theme: { good: 'light', bad: 'purple', why: 'not one of the three preferences' },
        usageDisplay: { good: 'off', bad: 'dollars', why: 'not one of the three modes' },
        scanRoots: {
          good: [fixtures.rootA],
          bad: ['projects/alpha'],
          why: 'a relative path resolves against whatever the cwd happens to be'
        },
        pinnedProjects: {
          good: [fixtures.pinProjects[0] ?? fixtures.rootA],
          // Two spellings of one path. Windows compares paths case-insensitively
          // and so does the sidebar, so this would print one project as two rows
          // in a section where un-pinning either takes both away.
          bad: [fixtures.rootA, fixtures.rootA.toUpperCase()],
          why: 'one project under two spellings is a pin that cannot be taken off'
        },
        claudePath: {
          good: fixtures.stubCli,
          bad: 'claude',
          why: 'a bare name is not an executable Helm can hand to a pty'
        },
        windowBounds: {
          good: now.windowBounds ?? { width: 1280, height: 820 },
          bad: { width: 'wide', height: 820 },
          why: 'a width that is not a number reaches BrowserWindow'
        },
        workspaceTabs: {
          good: { panes: [{ kind: 'project', path: fixtures.rootA }], activeId: 'history' },
          bad: { panes: [{ kind: 'project' }], activeId: null },
          why: 'a project pane with no path is a tab that restores pointing nowhere'
        },
        firstRunCompletedAt: {
          good: '2026-08-11T00:00:00.000Z',
          bad: 'soon',
          why: 'not a timestamp anything can order'
        },
        terminalFontFamily: {
          good: 'Consolas',
          bad: 'Consolas; color: red',
          why: 'xterm puts this in an inline style, where a semicolon ends the declaration'
        },
        terminalFontSize: {
          good: 16,
          bad: 200,
          why: 'a grid two columns wide is not a terminal any TUI can lay out in'
        },
        terminalCursorStyle: {
          good: 'bar',
          bad: 'beam',
          why: 'not one of the three shapes xterm draws'
        },
        terminalCursorBlink: {
          good: false,
          bad: 'false',
          why: 'the string is truthy, so it would switch blinking on'
        },
        terminalScrollback: {
          good: 5000,
          bad: 5_000_000,
          why: 'a line is about a kilobyte of cell data, per pane'
        },
        terminalShell: {
          good: now.terminalShell ?? whereIs('cmd.exe')[0] ?? null,
          bad: 'cmd.exe',
          why: 'a bare name is resolved against whatever PATH Helm was started with'
        },
        projectShellHeightPct: {
          good: 40,
          // Above the ceiling rather than below the floor, because the ceiling is
          // the half of this bound somebody asked for: past 50 the project pane
          // is the smaller part of the page it names.
          bad: 51,
          why: 'the project pane may not be given less than half of its own page'
        },
        sessionSplitPct: {
          good: 60,
          // Either bound would do here - neither side of this divider is the
          // subordinate one - so the floor, which is the one a drag reaches by
          // pushing the sessions column shut.
          bad: 19,
          why: 'below the floor the divider itself enforces'
        },
        contentWrap: {
          // Not the default, so the control write is a change rather than a
          // no-op, and the same shape `terminalCursorBlink` is rejected in: a
          // hand-edited row arrives as a string, and `'false'` is truthy.
          good: true,
          bad: 'false',
          why: 'the string is truthy, so a row that reads as off would open every source file wrapped'
        },
        contentWrapIndent: {
          good: 8,
          // Below the floor rather than above the ceiling, because this is the
          // end with a silent failure behind it. The hang is
          // `padding-left: calc(--line-indent + --source-wrap-indent)` with the
          // negation as `text-indent`, so a negative indent computes a negative
          // padding - which is invalid, dropped by the parser, and leaves the
          // positive `text-indent` standing on its own. The continuation rows
          // then start *left* of the code they belong to: the exact failure the
          // per-line indent was added to prevent, arriving as a setting.
          bad: -4,
          why: 'a negative hang computes an invalid padding, which is dropped, and hangs the continuation rows the wrong way'
        },
        transcriptArchiveMaxBytes: {
          good: 512 * 1024 * 1024,
          // Not "too small" - the floor is deliberately a kilobyte so a check can
          // drive eviction. Too *large* is the interesting rejection: this bounds
          // how much of the user's `helm.db` one feature may take, and an
          // unbounded archive is the state the whole ceiling exists to prevent.
          bad: 1024 ** 4,
          why: 'a terabyte is not a ceiling, and a ceiling is the point of the key'
        },
        ghPath: {
          good: whereIs('gh.exe')[0] ?? fixtures.stubCli,
          bad: 'gh',
          why: 'a bare name is not an executable Helm can run for a fetch'
        },
        prPollMinutes: {
          good: 15,
          bad: 1,
          why: 'a one-minute sweep is one gh per remote against the user’s own rate limit'
        },
        prStaleDays: {
          good: 7,
          // Not "too small" - zero is legal and means no split at all. Past the
          // ceiling is the interesting rejection: at four months the cutoff has
          // stopped being a statement about attention.
          bad: 120,
          why: 'a cutoff past a quarter is sorting by archaeology rather than by attention'
        },
        prIgnoredRepos: {
          good: ['acme/widget'],
          // Two spellings of one repository. The matcher is case-insensitive, so
          // this would behave as one entry while presenting as two rows - a tick
          // that cannot be cleared because clearing one leaves the other.
          bad: ['acme/widget', 'ACME/Widget'],
          why: 'one repository under two spellings is a checkbox that will not stay unticked'
        },
        prReviewPrompt: {
          good: '/code-review {number}',
          bad: '   ',
          why: 'an empty template makes the review button start an ordinary session'
        },
        prCheckout: {
          good: 'none',
          bad: 'worktree',
          why: 'a mode that is planned and not built would silently do nothing'
        },
        prReviewModel: {
          good: 'opus',
          bad: '--model',
          why: 'this becomes an argv word, and a flag written into it is a second flag'
        },
        prReviewEffort: {
          good: 'high',
          bad: 'maximum',
          why: 'the five levels are the CLI’s own, and a sixth would be rejected by it'
        },
        updateCheck: {
          good: false,
          bad: 'false',
          why: 'a string that reads as a boolean is the shape a hand-edited row arrives in'
        },
        lastUpdateCheckAt: {
          good: '2026-08-11T20:04:06.641Z',
          bad: 'never',
          why: 'an unparseable instant compares NaN against the throttle, so it would mean “never ask again” rather than “ask now”'
        },
        browserReach: {
          good: 'local',
          bad: 'none',
          why: 'a reach mode nothing recognises would fall through every branch of the one function the whole pane is gated on'
        },
        browserMcp: {
          good: false,
          // The same rejection `updateCheck` has, and for the sharper reason: a
          // row hand-edited into this string is truthy, so it would **start** the
          // inbound listener while the pane read it as off.
          bad: 'false',
          why: 'a string that reads as a boolean would open a port the pane says is shut'
        },
        browserMcpLocalOnly: {
          good: true,
          bad: 'true',
          why: 'the same, pointing the other way: a truthy string would confine the agent while the pane read it as unconfined'
        },
        sessionMcp: {
          good: false,
          // The third boolean that decides whether a route exists, and the same
          // rejection for the same reason: `'false'` is truthy.
          bad: 'false',
          why: 'a string that reads as a boolean would serve one session’s work to another while the pane said it was off'
        },
        browserRecentUrls: {
          good: ['http://localhost:3000/'],
          bad: ['localhost:3000'],
          why: 'a row in the address dropdown that is not an absolute URL is a row that does nothing when clicked'
        },
        browserProjectUrls: {
          good: { [fixtures.rootA.toLowerCase()]: 'http://localhost:5173/' },
          bad: { [fixtures.rootA]: 'http://localhost:5173/' },
          why: 'a key that is not lower-cased is a project whose remembered address is never found again, the same trap pinnedProjects has'
        }
      }

    // The runtime half of the same claim. The type above is about
    // `AppSettings`; this is about the object `readSettings` returned, and a key
    // present in one and not the other is a key nothing proves is validated.
    const entries = Object.entries(cases) as Array<
      [keyof AppSettings, { good: unknown; bad: unknown; why: string }]
    >
    const covered = entries.map(([key]) => key).sort()
    const everyKey = Object.keys(now).sort()
    const everyKeyCovered = covered.join(',') === everyKey.join(',')

    const results: Array<Record<string, unknown>> = []
    let allRejected = true
    let allControlsLanded = true

    for (const [key, testCase] of entries) {
      // The control first. Without it, "the row did not change" is also what a
      // channel that writes nothing at all would report.
      const control = await sendWrite(win, { [key]: testCase.good })
      await sleep(250)
      const afterGood = rowValue(dbFile, key)
      const controlLanded =
        control.accepted && JSON.stringify(afterGood) === JSON.stringify(testCase.good)
      if (!controlLanded) allControlsLanded = false

      const attempt = await sendWrite(win, { [key]: testCase.bad })
      await sleep(250)
      const afterBad = rowValue(dbFile, key)
      const rejected =
        !attempt.accepted &&
        attempt.error.includes(key) &&
        JSON.stringify(afterBad) === JSON.stringify(testCase.good)
      if (!rejected) allRejected = false

      results.push({
        key,
        why: testCase.why,
        control: { wrote: testCase.good, accepted: control.accepted, rowAfter: afterGood, landed: controlLanded },
        rejection: {
          wrote: testCase.bad,
          accepted: attempt.accepted,
          error: attempt.error.replace(/^Error: /, '').slice(0, 200),
          rowAfter: afterBad,
          rejected
        }
      })
    }

    // A patch is one edit: a good key travelling with a bad one lands neither.
    await sendWrite(win, { theme: 'dark' })
    await sleep(250)
    const mixed = await sendWrite(win, { theme: 'light', usageDisplay: 'dollars' })
    await sleep(250)
    const themeAfterMixed = rowValue(dbFile, 'theme')
    const partial = mixed.accepted || themeAfterMixed !== 'dark'

    // And the tolerance the file header promises is still there: a key this
    // build does not know is ignored, not rejected.
    const unknownKey = await sendWrite(win, { theme: 'light', somethingLater: 'whatever' })
    await sleep(250)
    const themeAfterUnknown = rowValue(dbFile, 'theme')
    const unknownStored = allRows(dbFile)['somethingLater']

    checks.push({
      id: 'S-7',
      criterion: 'Runtime validation rejects malformed values for every key; unknown keys still tolerated',
      title: 'A hand-sent bad write for every key is refused and changes nothing; every good one lands',
      ok:
        everyKeyCovered &&
        allControlsLanded &&
        allRejected &&
        !partial &&
        unknownKey.accepted &&
        themeAfterUnknown === 'light' &&
        unknownStored === undefined,
      detail: {
        keysProbed: covered,
        keysInAppSettings: everyKey,
        everyKeyCovered,
        cases: results,
        patchIsOneEdit: {
          wrote: { theme: 'light', usageDisplay: 'dollars' },
          accepted: mixed.accepted,
          themeAfter: themeAfterMixed,
          expectedThemeAfter: 'dark',
          partiallyApplied: partial
        },
        unknownKeyTolerated: {
          accepted: unknownKey.accepted,
          themeAfter: themeAfterUnknown,
          storedUnknownRow: unknownStored ?? null
        }
      },
      notes: [
        'Every write is sent from the renderer through the real `settings:write`',
        'channel, so what is measured is what a caller would actually get.',
        'Each key is probed twice, valid first: a rejection test whose valid case',
        'never lands cannot tell a working validator from a channel that writes',
        'nothing - the same trap PROF-4 fell into.',
        'Reads are tolerant and writes are strict on purpose. A row from another',
        'build is a fact about the past; a malformed write is a bug happening now,',
        'and before this it reached `nativeTheme.themeSource`.',
        'The table of cases is a `Record<keyof AppSettings, ...>`, so a setting',
        'added later without a case here does not compile - the same enforcement',
        '`SETTING_VALIDATORS` gets, and it fires in `pnpm typecheck` rather than',
        'here. It is checked against the keys of the settings object at run time',
        'as well, which is the claim the type cannot make.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-10 to S-12: the terminal settings
  // -------------------------------------------------------------------------
  if (run('terminal')) {
    /**
     * Every resize the main process actually put through to a pty, captured at
     * the source by wrapping the host objects the IPC handlers call.
     *
     * This is the second half of "the pane refit": a terminal whose options
     * changed but whose grid was never re-reported leaves the child process
     * drawing into a box that no longer exists. `applyFit` reports only when
     * the answer changed, and that is exactly what these counts measure.
     */
    const sessionResizes: Array<{ id: number; cols: number; rows: number }> = []
    const shellResizes: Array<{ id: number; cols: number; rows: number }> = []
    const realSessionResize = ctx.sessions.resize.bind(ctx.sessions)
    const realShellResize = ctx.pterm.resize.bind(ctx.pterm)
    ctx.sessions.resize = (id, cols, rows) => {
      sessionResizes.push({ id, cols, rows })
      realSessionResize(id, cols, rows)
    }
    ctx.pterm.resize = (id, cols, rows) => {
      shellResizes.push({ id, cols, rows })
      realShellResize(id, cols, rows)
    }

    try {
      // --- setup: a project pane with a shell, and a session beside it -------
      //
      // The CLI setting goes back to the real executable first. The validation
      // group leaves `claudePath` on a stub that answers `--version` and exits,
      // and a session launched from that is a process which is gone before
      // anything can look at it - which would make this group's failures a
      // report about the group that ran before it.
      await sendWrite(win, { claudePath: claudeForPark })
      // And the terminal settings start from their documented defaults, for the
      // same reason: the validation group parks each of them on a value of its
      // own choosing on the way past, so without this the deltas below would be
      // measured from wherever that left them.
      await sendWrite(win, {
        terminalFontFamily: null,
        terminalFontSize: DEFAULT_TERMINAL.fontSize,
        terminalCursorStyle: DEFAULT_TERMINAL.cursorStyle,
        terminalCursorBlink: DEFAULT_TERMINAL.cursorBlink,
        terminalScrollback: DEFAULT_TERMINAL.scrollback,
        terminalShell: null
      })
      await sleep(600)

      await js<unknown>(
        win,
        `window.helm.invoke('roots:accept', { path: ${JSON.stringify(fixtures.termRoot)} })`
      )
      await js<unknown>(win, `window.helm.invoke('discovery:scan', { includeGit: false })`)
      const treeHasFixtures = await pollJs(
        win,
        `[...document.querySelectorAll('aside button[title]')]
          .filter((b) => b.title.toLowerCase().startsWith(${JSON.stringify(
            fixtures.termRoot.toLowerCase()
          )})).length === 2`,
        45_000
      )

      const projectOne = fixtures.termProjects[0] ?? ''
      await clickProject(win, projectOne)
      const shellUp = await pollJs(
        win,
        `window.__helmTerminals().shells.length > 0
         && document.querySelector('[data-shell-running]')?.dataset.shellRunning`,
        45_000
      )
      await sleep(1200)
      const shellNameInHeader = await attr(win, '[data-shell-running]', 'data-shell-running')

      // A real session, launched from the pane's own button. The process behind
      // it is irrelevant to every claim below - what is needed is a terminal in
      // the *other* registry, which only a session produces.
      const launched = await js<boolean>(
        win,
        `(() => { const el = [...document.querySelectorAll('button')]
            .find((b) => (b.textContent ?? '').includes('Start session here'));
          if (!el) return false; el.click(); return true })()`
      )
      const sessionUp = await pollJs(win, `window.__helmTerminals().sessions.length > 0`, 60_000)
      await sleep(2500)

      const sessionIds = ctx.sessions.list().map((record) => record.id)
      const sessionId = sessionIds.at(-1) ?? -1

      // ---------------------------------------------------------------------
      // S-10: a size change reaches every terminal, and only the visible pane's
      // pty is told - until the hidden one comes back
      // ---------------------------------------------------------------------

      /**
       * Take the project shell out of the document, leaving the session in it.
       *
       * The claim needs one terminal of each kind on opposite sides of the
       * question at the same moment, and this is now the only thing that
       * arranges that. It used to arrange itself: opening a session dropped the
       * project shell, so by this line the shell was already gone. That was a
       * bug - the session has its own column and takes nothing from the
       * project's - and fixing it means the split shows both. Maximising the
       * session is the honest replacement: the workspace column unmounts, its
       * shell goes with it, and the session pane stays exactly where it was.
       *
       * `session` singular is the button's own `data-maximize` value, and the
       * same button restores the split further down.
       */
      const shellHidden0 = await click(win, '[data-maximize="session"]')
      const shellWentAway = await pollJs(
        win,
        `window.__helmTerminals().shells.every((t) => !t.attached)
         && window.__helmTerminals().sessions.some((t) => t.attached)`,
        15_000
      )
      await sleep(1200)

      const before = await terminalSnapshot(win)
      /**
       * The shell for the project this group actually drove - not
       * `list()[0]`, which is whichever shell was opened first.
       *
       * That was this check measuring something it never touched. A project
       * tab restored at startup opens its shell before the driver clicks
       * anything, so index 0 was the *restored* project's shell: detached from
       * the moment the driver moved to its own fixture, therefore never
       * refitted, therefore frozen. "The grid changed once the pane came back"
       * was then being asked of a pane that never came back, and the answer
       * depended on whether the user's last session happened to leave a project
       * tab active - which is a fact about the machine, not about Helm.
       */
      const shellIdBefore =
        ctx.pterm.list().find((entry) => entry.path.toLowerCase() === projectOne.toLowerCase())
          ?.id ?? -1
      const sessionGridBefore = ctx.sessions.grid(sessionId)
      const shellGridBefore = ctx.pterm.grid(shellIdBefore)
      sessionResizes.length = 0
      shellResizes.length = 0

      const bigger = 20
      await sendWrite(win, { terminalFontSize: bigger })
      const sizeLanded = await pollJs(
        win,
        `window.__helmTerminals().sessions.concat(window.__helmTerminals().shells)
          .every((t) => t.fontSize === ${String(bigger)})`,
        15_000
      )
      await sleep(1200)

      const afterSize = await terminalSnapshot(win)
      const sessionGridAfter = ctx.sessions.grid(sessionId)
      const shellGridAfter = ctx.pterm.grid(shellIdBefore)
      const sessionResizedWhileVisible = sessionResizes.length
      const shellResizedWhileHidden = shellResizes.length

      /**
       * The three settings that change how a terminal looks without changing
       * how big a cell is.
       *
       * They have to reach every open terminal, and they must NOT put a resize
       * through: a cursor shape moves no cells, and a pty told its size has
       * changed when it has not is a full repaint of whatever TUI is running in
       * it. This is the other half of "only when it actually changed", and the
       * half a build that refits unconditionally would fail.
       */
      sessionResizes.length = 0
      shellResizes.length = 0
      const cosmetic = { cursorStyle: 'bar', cursorBlink: false, scrollback: 2500 } as const
      await sendWrite(win, {
        terminalCursorStyle: cosmetic.cursorStyle,
        terminalCursorBlink: cosmetic.cursorBlink,
        terminalScrollback: cosmetic.scrollback
      })
      const cosmeticLanded = await pollJs(
        win,
        `window.__helmTerminals().sessions.concat(window.__helmTerminals().shells)
          .every((t) => t.cursorStyle === '${cosmetic.cursorStyle}'
            && t.cursorBlink === false
            && t.scrollback === ${String(cosmetic.scrollback)})`,
        15_000
      )
      await sleep(1000)
      const afterCosmetic = await terminalSnapshot(win)
      const cosmeticResizes = sessionResizes.length + shellResizes.length
      const cosmeticIsFree = cosmeticLanded && cosmeticResizes === 0

      // The hidden pane comes back - the same button, which now restores the
      // split. Its terminal was reconfigured while it was out of the document,
      // measured 0x0, and refused to act on that; showing it is the moment the
      // pty is allowed to hear about the new cell size.
      shellResizes.length = 0
      await click(win, '[data-maximize="session"]')
      const shellVisible = await pollJs(
        win,
        `window.__helmTerminals().shells.every((t) => t.attached)`,
        15_000
      )
      await sleep(1500)
      const shellGridShown = ctx.pterm.grid(shellIdBefore)
      const shellResizedOnceShown = shellResizes.length

      // The driver's own idea of how wide a cell is at the new size, measured
      // with a canvas of its own making.
      const sessionAfter = afterSize.sessions[0] ?? null
      const measured = await measureCell(win, bigger, sessionAfter?.fontFamily ?? '')
      const paintedCell =
        sessionAfter?.screen != null && sessionAfter.cols > 0
          ? sessionAfter.screen.width / sessionAfter.cols
          : 0
      const paintedRow =
        sessionAfter?.screen != null && sessionAfter.rows > 0
          ? sessionAfter.screen.height / sessionAfter.rows
          : 0
      // xterm quantises a cell to whole device pixels, so the painted cell is
      // this driver's own measurement rounded down - never wider than it, and
      // never more than one device pixel narrower. Anything outside that is a
      // terminal drawing at a size nobody asked for.
      const step = 1 / (measured.dpr || 1)
      const cellAgrees =
        paintedCell > 0 &&
        paintedCell <= measured.spanWidth + 1e-6 &&
        measured.spanWidth - paintedCell < step + 1e-6

      // A second write of the same value must move nothing: a settings change
      // that refits every terminal regardless is a SIGWINCH per unrelated write.
      sessionResizes.length = 0
      shellResizes.length = 0
      await sendWrite(win, { terminalFontSize: bigger })
      await sleep(900)
      const idempotent = sessionResizes.length === 0 && shellResizes.length === 0

      // And the pre-spawn estimate: a brand new shell, opened at the changed
      // size, has to land where the fit puts it. `opened` is the grid
      // `estimateGrid` produced before any pane had measured itself.
      const projectTwo = fixtures.termProjects[1] ?? ''
      await clickProject(win, projectTwo)
      const secondShellUp = await pollJs(
        win,
        `window.__helmTerminals().shells.length === 2`,
        45_000
      )
      await sleep(2000)
      const secondShell = ctx.pterm
        .list()
        .find((entry) => entry.path.toLowerCase() === projectTwo.toLowerCase())
      const estimate = secondShell?.opened ?? null
      const settled = secondShell?.grid ?? null
      const estimateTracks =
        estimate !== null &&
        settled !== null &&
        Math.abs(estimate.cols - settled.cols) <= 1 &&
        Math.abs(estimate.rows - settled.rows) <= 1

      /**
       * The pane that just changed project holds **one** terminal, and it is
       * that project's.
       *
       * Two shells are running by now and only one project is on screen, which
       * is the ordinary state and was also the state in which this went wrong.
       * The pane's box used to be appended to rather than taken over, so the
       * second project's terminal went in underneath the first: the island
       * clips, so what was painted stayed the *previous* project's shell - a
       * live prompt in the wrong directory, under a header naming the right
       * one - with the rest spilling past the bottom edge, one more each time a
       * project was opened.
       *
       * Counted in the DOM rather than in the registry, because the registry
       * was never wrong: `pterms.ts` had two shells and two elements, and the
       * bug was entirely in which box they were parented to. `attached` is
       * xterm's own `isConnected`, so "the other one is detached" is the claim
       * that it kept its process and its scrollback while off screen.
       */
      const paneHolds = await js<{ inBox: number; captioned: string | null }>(
        win,
        `(() => {
          const cap = document.querySelector('[data-shell-running]');
          const island = cap ? cap.closest('div.rounded-island') : null;
          return {
            inBox: island ? island.querySelectorAll('.xterm').length : -1,
            captioned: cap ? cap.dataset.shellRunning : null
          };
        })()`
      )
      const shells = (await terminalSnapshot(win)).shells
      const activeShell = shells.find(
        (shell) => shell.path.toLowerCase() === projectTwo.toLowerCase()
      )
      const otherShell = shells.find(
        (shell) => shell.path.toLowerCase() === projectOne.toLowerCase()
      )
      const onePaneOneTerminal =
        paneHolds.inBox === 1 &&
        paneHolds.captioned !== null &&
        activeShell?.attached === true &&
        otherShell?.attached === false

      const shot10 = await screenshot(win, shotDir, 'settings-10-terminal-size.png')

      const everyTerminalResized =
        afterSize.sessions.length > 0 &&
        afterSize.shells.length > 0 &&
        [...afterSize.sessions, ...afterSize.shells].every((t) => t.fontSize === bigger) &&
        [...before.sessions, ...before.shells].every(
          (t) =>
            t.fontSize === DEFAULT_TERMINAL.fontSize &&
            t.cursorStyle === DEFAULT_TERMINAL.cursorStyle &&
            t.cursorBlink === DEFAULT_TERMINAL.cursorBlink &&
            t.scrollback === DEFAULT_TERMINAL.scrollback
        )

      checks.push({
        id: 'S-10',
        criterion:
          'Font, size, cursor and scrollback apply live to every open terminal; the grid is re-reported to each pty only when it changed',
        title:
          'Size, cursor and scrollback reach both registries; only the size resizes a pty, the hidden pane waits until it is shown, and a repeat moves nothing',
        ok:
          treeHasFixtures &&
          shellUp &&
          launched &&
          sessionUp &&
          shellHidden0 &&
          shellWentAway &&
          everyTerminalResized &&
          sizeLanded &&
          cosmeticIsFree &&
          sessionGridBefore !== null &&
          sessionGridAfter !== null &&
          sessionGridAfter.cols !== sessionGridBefore.cols &&
          sessionResizedWhileVisible > 0 &&
          shellResizedWhileHidden === 0 &&
          shellVisible &&
          shellResizedOnceShown > 0 &&
          shellGridShown !== null &&
          shellGridBefore !== null &&
          shellGridShown.cols !== shellGridBefore.cols &&
          cellAgrees &&
          idempotent &&
          secondShellUp &&
          estimateTracks,
        detail: {
          fixtureProjectsInTree: treeHasFixtures,
          shellStarted: shellUp,
          shellNameInHeader,
          sessionStarted: sessionUp,
          // Every gate in `ok` is now reported, which four of them were not.
          // This check failed once with `secondShellUp` false and *every*
          // scalar in the detail identical to a passing run, because the gate
          // that went false was not among them - the diagnosis had to start
          // from two registry dumps and a guess. A conjunction of twenty-two
          // booleans owes the report all twenty-two.
          sessionLaunchClicked: launched,
          everyTerminalTookTheSize: everyTerminalResized,
          sizeLandedInTheDatabase: sizeLanded,
          hiddenPaneCameBack: shellVisible,
          hidTheShellByMaximizingTheSession: { clicked: shellHidden0, detached: shellWentAway },
          sizeChangedFrom: DEFAULT_TERMINAL.fontSize,
          sizeChangedTo: bigger,
          reportedBefore: [...before.sessions, ...before.shells],
          reportedAfter: [...afterSize.sessions, ...afterSize.shells],
          cursorAndScrollback: {
            wrote: cosmetic,
            reported: [...afterCosmetic.sessions, ...afterCosmetic.shells].map((t) => ({
              key: t.key,
              cursorStyle: t.cursorStyle,
              cursorBlink: t.cursorBlink,
              scrollback: t.scrollback
            })),
            reachedEveryTerminal: cosmeticLanded,
            ptyResizesItCaused: cosmeticResizes,
            costNothing: cosmeticIsFree
          },
          visiblePane: {
            grid: { before: sessionGridBefore, after: sessionGridAfter },
            ptyResizes: sessionResizedWhileVisible
          },
          hiddenPane: {
            grid: { before: shellGridBefore, whileHidden: shellGridAfter, onceShown: shellGridShown },
            ptyResizesWhileHidden: shellResizedWhileHidden,
            ptyResizesOnceShown: shellResizedOnceShown
          },
          cell: {
            paintedByXterm: { width: paintedCell, height: paintedRow },
            measuredByThisDriver: measured,
            stack: sessionAfter?.fontFamily ?? null,
            devicePixel: step,
            agrees: cellAgrees
          },
          rewritingTheSameValueMovedNothing: idempotent,
          preSpawnEstimate: {
            secondShellUp,
            // What the registry actually holds, and where each one came from.
            // `secondShellUp` is a count - `shells.length === 2` - so the way
            // it fails is a *third* shell somebody else opened, and the only
            // useful thing to say about that is whose it is.
            shellsOpen: ctx.pterm.list().map((entry) => entry.path),
            estimate,
            settledAfterFit: settled,
            tracks: estimateTracks
          }
        },
        notes: [
          'Every resize is captured by wrapping `sessions.resize` and',
          '`pterm.resize` on the host objects the IPC handlers call, so what is',
          'counted is what the pty was actually told rather than what the',
          'renderer believes it sent.',
          'A hidden pane measures 0x0 and `applyFit` refuses to act on that, so',
          'its pty must NOT be resized while it is out of the document and must',
          'be as soon as it comes back. Both halves are asserted; only asserting',
          'the second would pass for a build that resized a hidden pane to 1x1.',
          'The shell is hidden by maximising the session, which unmounts the',
          'whole workspace column. Launching a session used to do it on its own',
          'because the project shell was dropped whenever the split opened; that',
          'was the bug, and a check written around it would now be asserting the',
          'shell is gone at the moment it is supposed to be on screen.',
          'That the shell detached and the session did not is asserted before',
          'the write, so "the hidden one was not resized" cannot be satisfied by',
          'a run in which nothing was hidden.',
          'The cell width xterm painted is compared with a measurement this',
          'driver made itself at the same size in the same stack.',
          'Cursor shape, blinking and scrollback are changed in a separate write',
          'and must reach every terminal while resizing none of them: none of',
          'the three moves a cell, and a pty told its size changed when it has',
          'not is a full repaint of whatever is running in it.',
          'The size is then written again unchanged: a settings write that',
          'refits regardless would put a SIGWINCH through every running TUI on',
          'an unrelated setting.',
          'The estimate is the grid `estimateGrid` produced before a pane had',
          'measured anything, recorded by the pty host at open. At 20px it can',
          'only land within a column of the fit if the estimate reads the',
          'setting rather than the built-in 14.'
        ]
      })

      checks.push({
        id: 'S-10b',
        criterion:
          'A project pane shows the shell of the project it is captioned with, and only that one',
        title:
          'After a switch the pane holds exactly one terminal, it is the active project’s, and the other keeps its process off screen',
        ok: onePaneOneTerminal,
        detail: {
          activeProject: projectTwo,
          terminalsInTheBox: paneHolds.inBox,
          captionedShell: paneHolds.captioned,
          activeProjectAttached: activeShell?.attached ?? null,
          previousProjectAttached: otherShell?.attached ?? null,
          shells: shells.map((shell) => ({ path: shell.path, attached: shell.attached }))
        },
        notes: [
          'Counted in the DOM, not in the registry. The registry was never wrong',
          'when this broke - two shells, two elements - and the whole of the bug',
          'was that both elements were parented to the same box, the pane having',
          'been appended to rather than taken over.',
          'It did not look like two terminals. The island clips, so the pane went',
          'on painting the *previous* project’s shell under a header naming the',
          'current one, and each project opened added another below the edge.',
          'So a count of one is the assertion and the caption is not: a build',
          'that painted the wrong shell alone would still satisfy the caption.',
          '`attached` is xterm’s own `isConnected`, so the second half - the',
          'displaced shell is detached rather than disposed - is what says its',
          'process and scrollback are waiting rather than gone.'
        ]
      })

      // ---------------------------------------------------------------------
      // S-11: the user's family is prepended, never substituted
      // ---------------------------------------------------------------------
      await openSettings(win)
      await sleep(400)
      await js<void>(
        win,
        `(() => { const el = document.querySelector('[data-settings-pane]');
          if (el) el.scrollTop = el.scrollHeight })()`
      )
      await sleep(300)

      const present = 'Consolas'
      const absent = 'Helm No Such Font'

      await typeInto(win, '[data-settings-terminal-font]', present)
      const presentLanded = await pollJs(
        win,
        `window.__helmTerminals().shells.every((t) => t.fontFamily.startsWith('"${present}"'))`,
        15_000
      )
      await sleep(800)
      const withPresent = await terminalSnapshot(win)
      const presentStack = withPresent.shells[0]?.fontFamily ?? ''
      const presentInstalled = await driverSeesFont(win, present)
      const hintWithPresent = await exists(win, '[data-settings-terminal-font-missing]')
      const rowWithPresent = rowValue(dbFile, 'terminalFontFamily')

      await typeInto(win, '[data-settings-terminal-font]', absent)
      const absentLanded = await pollJs(
        win,
        `window.__helmTerminals().shells.every((t) => t.fontFamily.startsWith('"${absent}"'))`,
        15_000
      )
      await sleep(800)
      const withAbsent = await terminalSnapshot(win)
      const absentStack = withAbsent.shells[0]?.fontFamily ?? ''
      const absentInstalled = await driverSeesFont(win, absent)
      const hintWithAbsent = await attr(
        win,
        '[data-settings-terminal-font-missing]',
        'data-settings-terminal-font-missing'
      )
      const rowWithAbsent = rowValue(dbFile, 'terminalFontFamily')

      // Three measurements this driver makes for itself. The default stack and
      // the nonsense-prepended stack must measure the same - that is the
      // fallback working. The nonsense family *alone* must measure differently,
      // which is what makes the first comparison mean anything: a build that
      // replaced the stack instead of prepending would land on that value.
      const wDefault = (await measureCell(win, 14, DEFAULT_FONT_STACK)).spanWidth
      const wPrepended = (await measureCell(win, 14, `"${absent}", ${DEFAULT_FONT_STACK}`)).spanWidth
      const wAlone = (await measureCell(win, 14, `"${absent}"`)).spanWidth
      const fallbackHeld = Math.abs(wPrepended - wDefault) <= 0.01
      const fixtureDiscriminates = Math.abs(wAlone - wDefault) > 0.5

      const shot11 = await screenshot(win, shotDir, 'settings-11-terminal-font.png')

      // Back to the built-in stack, through the pane's own button.
      await click(win, '[data-settings-terminal-font-clear]')
      const cleared = await pollJs(
        win,
        `window.__helmTerminals().shells.every((t) => t.fontFamily === ${JSON.stringify(
          DEFAULT_FONT_STACK
        )})`,
        15_000
      )
      const rowAfterClear = rowValue(dbFile, 'terminalFontFamily')

      checks.push({
        id: 'S-11',
        criterion:
          'The user font is prepended to the default stack, never replaces it; a font this machine lacks degrades per glyph',
        title:
          'Both an installed and an absent family land in front of the built-in stack, the absent one raises the hint, and rendering falls back',
        ok:
          presentLanded &&
          presentStack === `"${present}", ${DEFAULT_FONT_STACK}` &&
          presentInstalled &&
          !hintWithPresent &&
          rowWithPresent === present &&
          absentLanded &&
          absentStack === `"${absent}", ${DEFAULT_FONT_STACK}` &&
          !absentInstalled &&
          hintWithAbsent === absent &&
          rowWithAbsent === absent &&
          fallbackHeld &&
          fixtureDiscriminates &&
          cleared &&
          rowAfterClear === null,
        detail: {
          defaultStackThisDriverExpects: DEFAULT_FONT_STACK,
          installedFamily: {
            typed: present,
            resolvedStack: presentStack,
            thisDriverSeesTheFont: presentInstalled,
            hintShown: hintWithPresent,
            databaseRow: rowWithPresent
          },
          absentFamily: {
            typed: absent,
            resolvedStack: absentStack,
            thisDriverSeesTheFont: absentInstalled,
            hintNames: hintWithAbsent,
            databaseRow: rowWithAbsent
          },
          cellWidthAt14: {
            defaultStack: wDefault,
            absentPrependedToIt: wPrepended,
            absentFamilyAlone: wAlone,
            fallbackHeld,
            fixtureDiscriminates
          },
          clearedBackToBuiltIn: cleared,
          databaseRowAfterClear: rowAfterClear,
          screenshots: [shot11.file]
        },
        notes: [
          'Typed into the real field with real keystrokes and committed with',
          'Enter, so what is measured is the control a person uses.',
          'The expected stack is this file’s own constant, not an import from',
          '`terminal.ts`: the claim is about what the terminal ends up with, and',
          'importing the value would make it agree with itself.',
          'The fallback is proved by measurement, not by the string. A nonsense',
          'family in front of the stack must measure exactly what the stack',
          'measures - and the same family ALONE must measure something else, or',
          'the first comparison would pass for a build that had thrown the stack',
          'away.'
        ]
      })

      // ---------------------------------------------------------------------
      // S-12: the shell a project pane opens
      // ---------------------------------------------------------------------
      // `PATH` first, then the places an installer puts a shell without adding
      // it to `PATH` - the same order the resolver uses, arrived at separately.
      // A machine whose only PowerShell 7 is the Store build has none of it on
      // `PATH`: `where.exe pwsh.exe` finds nothing, and a sweep that stopped
      // there would confirm a Helm that had silently dropped to 5.1.
      const swept: Record<string, string | null> = {}
      for (const name of Object.keys(EXPECTED_SHELL_ARGS)) {
        swept[name] = whereIs(name)[0] ?? installedOffPath(name)[0] ?? null
      }
      const sweptNames = Object.entries(swept)
        .filter(([, path]) => path !== null)
        .map(([name]) => name)
        .sort()

      const offered = ctx.pterm.detected()
      const offeredNames = offered.map((shell) => shell.name.toLowerCase()).sort()
      const throughTheChannel = await js<Array<{ name: string; path: string; args: string[] }>>(
        win,
        `window.helm.invoke('pterm:shells')`
      )
      const listMatches = offeredNames.join(',') === sweptNames.join(',')
      const pathsMatch = offered.every(
        (shell) => (swept[shell.name.toLowerCase()] ?? '').toLowerCase() === shell.path.toLowerCase()
      )
      const argsMatch = offered.every(
        (shell) =>
          JSON.stringify(shell.args) ===
          JSON.stringify(EXPECTED_SHELL_ARGS[shell.name.toLowerCase()] ?? null)
      )
      const channelAgrees =
        throughTheChannel.map((s) => s.name.toLowerCase()).sort().join(',') === offeredNames.join(',')

      // Every detected shell, actually launched. `bash -NoLogo` - which the
      // substring test this table replaces would have produced for any bash
      // under a path containing "pwsh" - prints a usage error and exits, so a
      // shell that is still alive a second and a half later is the evidence
      // that its arguments were the right ones.
      const launchedShells: Array<Record<string, unknown>> = []
      let everyShellSurvived = true
      for (const [index, shell] of offered.entries()) {
        const dir = join(fixtures.dir, `shell-${String(index)}`)
        mkdirSync(dir, { recursive: true })
        let opened: { id: number; shell: string } | null = null
        try {
          opened = ctx.pterm.open({ path: dir, cols: 80, rows: 24, shell: shell.path })
        } catch (err) {
          opened = null
          launchedShells.push({ name: shell.name, spawnError: String(err) })
        }
        if (opened === null) {
          if (MUST_SURVIVE.includes(shell.name.toLowerCase())) everyShellSurvived = false
          continue
        }
        await sleep(1600)
        const alive = ctx.pterm.list().some((entry) => entry.id === opened.id)
        if (!alive && MUST_SURVIVE.includes(shell.name.toLowerCase())) everyShellSurvived = false
        launchedShells.push({
          name: shell.name,
          path: shell.path,
          args: shell.args,
          reported: opened.shell,
          stillRunningAfter1600ms: alive,
          required: MUST_SURVIVE.includes(shell.name.toLowerCase())
        })
        ctx.pterm.close(opened.id)
      }

      /**
       * The default shell, flipped twice through the pane's own picker with no
       * restart in between.
       *
       * Neither choice is the one auto-detection would make - `pwsh.exe` is
       * first in the list and is deliberately not used here - so "the shell it
       * opened under" cannot be satisfied by a resolver that ignored the
       * setting entirely. The row is put back to null first, so the first pick
       * is a change rather than a value an earlier group already left behind.
       */
      const auto = offered[0]?.path ?? null
      const cmd = swept['cmd.exe'] ?? null
      const winPs = swept['powershell.exe'] ?? null
      const dirs = ['default-auto', 'default-a', 'default-b'].map((name) => {
        const dir = join(fixtures.dir, name)
        mkdirSync(dir, { recursive: true })
        return dir
      })
      const openDefault = (dir: string): Promise<{ shell: string }> =>
        js<{ shell: string }>(
          win,
          `window.helm.invoke('pterm:open', { path: ${JSON.stringify(dir)}, cols: 80, rows: 24 })`
        )

      await sendWrite(win, { terminalShell: null })
      await sleep(500)
      const rowWhenAuto = rowValue(dbFile, 'terminalShell')
      const underAuto = await openDefault(dirs[0] ?? '')

      await openSettings(win)
      await sleep(500)
      const pickedCmd =
        cmd !== null
          ? await chooseOption(win, '[data-settings-terminal-shell]', cmd)
          : { found: false, offered: false, set: false }
      await sleep(800)
      const rowAfterCmd = rowValue(dbFile, 'terminalShell')
      const underCmd = await openDefault(dirs[1] ?? '')

      const pickedWinPs =
        winPs !== null
          ? await chooseOption(win, '[data-settings-terminal-shell]', winPs)
          : { found: false, offered: false, set: false }
      await sleep(800)
      const rowAfterWinPs = rowValue(dbFile, 'terminalShell')
      const underWinPs = await openDefault(dirs[2] ?? '')

      const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
        (a ?? '').toLowerCase() === (b ?? '').toLowerCase()
      const flippedWithoutRestart =
        rowWhenAuto === null &&
        same(underAuto.shell, auto) &&
        pickedCmd.offered &&
        pickedCmd.set &&
        rowAfterCmd === cmd &&
        same(underCmd.shell, cmd) &&
        pickedWinPs.offered &&
        pickedWinPs.set &&
        rowAfterWinPs === winPs &&
        same(underWinPs.shell, winPs)
      for (const entry of ctx.pterm.list()) {
        if (dirs.includes(entry.path)) ctx.pterm.close(entry.id)
      }

      // The per-pane override, driven through the picker in the project shell's
      // own header while the default sits on something else. What the other
      // pane is running is written down first, so "it was left alone" is a
      // comparison rather than an assumption about which shell it had.
      const otherBefore = ctx.pterm
        .list()
        .find((entry) => entry.path.toLowerCase() === projectTwo.toLowerCase())?.shell
      await clickProject(win, projectOne)
      await sleep(1500)
      const overrodeOne =
        cmd !== null
          ? await chooseOption(win, '[data-shell-picker]', cmd)
          : { found: false, offered: false, set: false }
      const overrideRan = await pollJs(
        win,
        `(document.querySelector('[data-shell-running]')?.dataset.shellRunning ?? '')
          .toLowerCase() === ${JSON.stringify((cmd ?? '').toLowerCase())}`,
        30_000
      )
      await sleep(1500)
      const runningNow = ctx.pterm.list()
      const overriddenPane = runningNow.find(
        (entry) => entry.path.toLowerCase() === projectOne.toLowerCase()
      )
      const untouchedPane = runningNow.find(
        (entry) => entry.path.toLowerCase() === projectTwo.toLowerCase()
      )
      // Discriminating only because the override is a shell the default is not:
      // the default is Windows PowerShell by now and the override is cmd.
      const overrideIsLocal =
        !same(cmd, winPs) &&
        same(overriddenPane?.shell, cmd) &&
        same(untouchedPane?.shell, otherBefore)

      // And the session is untouched by any of it. Asked of Windows rather than
      // of Helm: whatever the shell setting says, the process behind a session
      // pane has to be the CLI.
      const sessionPid = ctx.sessions.pid(sessionId)
      const sessionImage = sessionPid === null ? null : imageNameOf(sessionPid)
      const claudeStatus = await js<{ path: string | null }>(win, `window.helm.invoke('setup:status')`)
      const expectedImage = claudeStatus.path === null ? null : baseName(claudeStatus.path)
      const sessionUnaffected =
        sessionImage !== null &&
        expectedImage !== null &&
        sessionImage.toLowerCase() === expectedImage.toLowerCase()

      const shot12 = await screenshot(win, shotDir, 'settings-12-terminal-shell.png')

      checks.push({
        id: 'S-12',
        criterion:
          'The default shell governs new project shells without a restart, a pane can override it for itself, and Claude sessions are unaffected',
        title:
          'The detected list matches this driver’s own where.exe sweep, every shell launches and survives, a flipped default takes effect on the next open, and one pane overrides alone',
        ok:
          listMatches &&
          pathsMatch &&
          argsMatch &&
          channelAgrees &&
          offered.length > 0 &&
          everyShellSurvived &&
          flippedWithoutRestart &&
          overrodeOne.offered &&
          overrodeOne.set &&
          overrideRan &&
          overrideIsLocal &&
          sessionUnaffected,
        detail: {
          whereExeSweptByThisDriver: swept,
          offeredByHelm: offered,
          offeredThroughTheChannel: throughTheChannel,
          listMatches,
          pathsMatch,
          argsMatchThisDriversTable: argsMatch,
          expectedArgs: EXPECTED_SHELL_ARGS,
          channelAgrees,
          launchedShells,
          everyRequiredShellSurvived: everyShellSurvived,
          defaultShell: {
            autoDetectWouldPick: auto,
            unset: { databaseRow: rowWhenAuto, openedUnder: underAuto.shell },
            firstPick: { picked: pickedCmd, databaseRow: rowAfterCmd, openedUnder: underCmd.shell },
            secondPickNoRestart: {
              picked: pickedWinPs,
              databaseRow: rowAfterWinPs,
              openedUnder: underWinPs.shell
            },
            flippedWithoutRestart
          },
          perPaneOverride: {
            picked: overrodeOne,
            headerFollowed: overrideRan,
            defaultAtTheTime: winPs,
            otherPaneBefore: otherBefore,
            overriddenPane,
            untouchedPane,
            localOnly: overrideIsLocal
          },
          session: {
            pid: sessionPid,
            imageNameFromTasklist: sessionImage,
            expectedFromSetupStatus: expectedImage,
            unaffected: sessionUnaffected
          },
          screenshots: [shot10.file, shot12.file]
        },
        notes: [
          'The offered list is compared against this driver’s own `where.exe`',
          'sweep - paths and arguments both - rather than against anything Helm',
          'computed, and the arguments against a table written here.',
          'Every detected shell is then actually launched and checked to still',
          'be alive: `bash -NoLogo`, which the filename substring test this',
          'replaces would produce for a bash under any path containing "pwsh",',
          'prints a usage error and exits. `wsl.exe` is launched and reported',
          'but not required to survive - a machine can have it with no',
          'distribution installed, which is not a fact about Helm.',
          'The default is set to nothing, then flipped twice with no restart in',
          'between, which is what proves the resolver is no longer answering',
          'from a module-level variable it filled once. Neither chosen shell is',
          'the one auto-detection picks, so a resolver that ignored the setting',
          'could not pass by coincidence.',
          'The per-pane override is driven from the picker in the shell pane’s',
          'own header, and the other pane is checked to have kept the default -',
          'an override that changed both would be a global setting with extra',
          'steps.',
          'That the session is unaffected is asked of Windows: `tasklist` is',
          'given the pty’s pid and its answer compared with the executable',
          '`setup:status` names.'
        ]
      })

      // ---------------------------------------------------------------------
      // S-20: the shell's height is the user's, and its terminal follows it
      // ---------------------------------------------------------------------
      //
      // The claim a resizable pane has to make is not "the box moved" - that is
      // visible - it is that the grid inside it moved with it. A shell whose
      // terminal still describes the old box paints into rows the pty does not
      // know it has, and nothing on screen says so until something wraps in the
      // wrong place. So every reading here carries `.xterm-screen`'s height and
      // the box the fit is measured against, and the verdict is arithmetic on
      // those rather than a screenshot.
      await clickProject(win, projectOne)
      await pollJs(win, `document.querySelector('[data-project-shell]')`, 15_000)
      await sendWrite(win, { projectShellHeightPct: SHELL_HEIGHT_BOUNDS.default })
      await sleep(900)

      const HANDLE = '[role="separator"][aria-orientation="horizontal"]'

      interface DragResult {
        before: ShellPaneReading | null
        after: ShellPaneReading | null
        writes: { n: number; values: number[] }
        resizes: Array<{ id: number; cols: number; rows: number }>
        pointer: PointerTrace
        row: unknown
      }

      /**
       * One pointer drag on the handle, `dy` pixels, with everything it moved.
       *
       * Eight moves rather than one, because the thing being measured is a
       * gesture: a single jump would be satisfied by a build that wrote the
       * setting on `pointerdown`, and the count of writes is only interesting
       * when there were frames it could have written on.
       */
      const dragShell = async (dy: number): Promise<DragResult> => {
        const before = await readShellPane(win, projectOne)
        await armSettingsCounter(win)
        await tracePointer(win, HANDLE)
        shellResizes.length = 0
        if (before !== null) {
          const x = before.pane.left + before.pane.width / 2
          const y = before.handle.top + before.handle.height / 2
          // `leftbuttondown` on the moves, because a move without it is a
          // hover: see `sendMouse`. The press and the release carry it too, so
          // the whole gesture reads as one button being held and let go.
          const held = { modifiers: ['leftbuttondown' as const] }
          await sendMouse(win, 'mouseDown', x, y, held)
          for (let step = 1; step <= 8; step++) {
            await sendMouse(win, 'mouseMove', x, y + (dy * step) / 8, held)
          }
          await sendMouse(win, 'mouseUp', x, y + dy, held)
          await sleep(900)
        }
        return {
          before,
          after: await readShellPane(win, projectOne),
          writes: await readSettingsCounter(win),
          resizes: [...shellResizes],
          pointer: await readPointerTrace(win),
          row: rowValue(dbFile, 'projectShellHeightPct')
        }
      }

      const atRest = await readShellPane(win, projectOne)
      // Far past the ceiling in one gesture, so "it stopped at half" is the
      // pane refusing rather than the pointer running out of travel.
      const up = await dragShell(-600)
      const shotUp = await screenshot(win, shotDir, 'settings-20-shell-ceiling.png')
      const down = await dragShell(600)
      const shotDown = await screenshot(win, shotDir, 'settings-20-shell-floor.png')

      // And the double-click, which is the only way back to the default that
      // does not involve typing a number into another pane.
      await armSettingsCounter(win)
      shellResizes.length = 0
      const beforeReset = await readShellPane(win, projectOne)
      if (beforeReset !== null) {
        const x = beforeReset.pane.left + beforeReset.pane.width / 2
        const y = beforeReset.handle.top + beforeReset.handle.height / 2
        for (const clickCount of [1, 2]) {
          await sendMouse(win, 'mouseDown', x, y, { clickCount })
          await sendMouse(win, 'mouseUp', x, y, { clickCount })
        }
        await sleep(900)
      }
      const reset = await readShellPane(win, projectOne)
      const resetWrites = await readSettingsCounter(win)
      const resetRow = rowValue(dbFile, 'projectShellHeightPct')
      const resetResizes = [...shellResizes]
      await disarmSettingsCounter(win)

      /**
       * One cell, taken from the terminal before anything was dragged.
       *
       * Nothing about the font changes across these drags, so a cell measured
       * once is the constant every later grid is checked against - and it is
       * measured from what xterm painted (`.xterm-screen` over `rows`) rather
       * than from anything Helm computed.
       */
      const shellCell = atRest !== null && atRest.rows > 0 ? atRest.screen / atRest.rows : 0

      /** The grid describes the box it is in, to within the one cell it must. */
      const gridFitsBox = (r: ShellPaneReading | null): boolean =>
        r !== null &&
        r.rows > 0 &&
        shellCell > 0 &&
        Math.abs(r.screen - r.rows * shellCell) < 1 &&
        r.container - r.screen >= 0 &&
        r.container - r.screen < shellCell

      const halfOf = (r: ShellPaneReading): number =>
        (r.column.height * SHELL_HEIGHT_BOUNDS.max) / 100

      const ceilingHeld =
        up.after !== null &&
        up.after.pct === SHELL_HEIGHT_BOUNDS.max &&
        up.row === SHELL_HEIGHT_BOUNDS.max &&
        Math.abs(up.after.pane.height - halfOf(up.after)) <= 1 &&
        up.before !== null &&
        up.after.rows > up.before.rows

      // The floor is a pixel figure, so it is checked in pixels. The row is
      // checked separately and loosely: it is that same height expressed as a
      // whole percentage, so it can only be a rounding away from it.
      const floorHeld =
        down.after !== null &&
        Math.abs(down.after.pane.height - SHELL_MIN_PX) <= 1 &&
        up.after !== null &&
        down.after.rows < up.after.rows &&
        typeof down.row === 'number' &&
        Math.abs((down.row / 100) * down.after.column.height - SHELL_MIN_PX) <=
          down.after.column.height / 100

      const resetHeld =
        reset !== null &&
        reset.pct === SHELL_HEIGHT_BOUNDS.default &&
        resetRow === SHELL_HEIGHT_BOUNDS.default &&
        Math.abs(
          reset.pane.height - (reset.column.height * SHELL_HEIGHT_BOUNDS.default) / 100
        ) <= 1

      // One write for each gesture. Not zero - which is what a handle that
      // moved nothing would report - and not one a frame, which is a database
      // write per `pointermove`.
      const oneWriteEach =
        up.writes.n === 1 && down.writes.n === 1 && resetWrites.n === 1

      // The pty was told, and told the grid the terminal actually settled at.
      const ptyToldLast = (r: DragResult, at: ShellPaneReading | null): boolean =>
        r.resizes.length > 0 && at !== null && (r.resizes.at(-1)?.rows ?? -1) === at.rows

      // The positive control, in AFF-1's spirit: a gesture that never reached
      // the handle produces exactly the readings a handle nobody wired up
      // produces, and "the height did not move" would be a finding about this
      // driver rather than about Helm.
      const gestureArrived = (r: DragResult): boolean =>
        r.pointer.down === 1 && r.pointer.move >= 8 && r.pointer.up === 1

      checks.push({
        id: 'S-20',
        criterion:
          'The project shell can be dragged between its floor and half the page, the height persists as one write per drag, and the terminal’s grid follows its box',
        title:
          'A drag past the ceiling stops at half the column, a drag past the floor stops at 180px, the double-click returns to the default, and every grid still describes the box it is in',
        ok:
          atRest !== null &&
          atRest.pct === SHELL_HEIGHT_BOUNDS.default &&
          gridFitsBox(atRest) &&
          gestureArrived(up) &&
          gestureArrived(down) &&
          ceilingHeld &&
          gridFitsBox(up.after) &&
          ptyToldLast(up, up.after) &&
          floorHeld &&
          gridFitsBox(down.after) &&
          ptyToldLast(down, down.after) &&
          resetHeld &&
          gridFitsBox(reset) &&
          oneWriteEach,
        detail: {
          cellHeightFromXterm: shellCell,
          bounds: { ...SHELL_HEIGHT_BOUNDS, floorPx: SHELL_MIN_PX },
          atRest,
          draggedUp: {
            ...up,
            halfTheColumn: up.after === null ? null : halfOf(up.after),
            held: ceilingHeld,
            gridFitsBox: gridFitsBox(up.after)
          },
          draggedDown: {
            ...down,
            held: floorHeld,
            gridFitsBox: gridFitsBox(down.after)
          },
          doubleClicked: {
            before: beforeReset,
            after: reset,
            row: resetRow,
            writes: resetWrites,
            resizes: resetResizes,
            held: resetHeld,
            gridFitsBox: gridFitsBox(reset)
          },
          screenshots: [shotUp.file, shotDown.file]
        },
        notes: [
          'The grid is read, not looked at. `.xterm-screen` is exactly `rows`',
          'cells tall and the element around it is what FitAddon measures, so',
          'the difference between them can only be under one cell - and a',
          'terminal still describing the box it had before the drag is where',
          'that stops being true. The cell itself comes from what xterm painted',
          'before any of this, not from anything Helm computed.',
          'Every pointer event is counted on `document` as well, because a',
          'drag the app ignored and a drag that was never delivered produce',
          'identical readings otherwise - and the first time this ran, the',
          'gesture was being sent without `leftbuttondown` and Helm never saw',
          'a single move of it.',
          'Each drag is eight moves, so "one write" is a claim about a gesture',
          'that had frames to write on. The count is `settings:changed` events,',
          'which main emits once per accepted write - the app broadcasting,',
          'rather than the window’s account of what it sent.',
          'Zero writes would fail it too: that is what a handle nothing is',
          'listening to reports.',
          'Both bounds are driven past rather than up to. Half is checked',
          'against half of the column measured in the same read, and the floor',
          'in pixels, because a pixel is what the floor is: a percentage cannot',
          'say "still enough rows to be a terminal".',
          'Every pty resize is captured by the same wrapper S-10 uses, and the',
          'last one has to name the grid the terminal ended at - a pane that',
          'refit itself and never told the pty would pass every box measurement',
          'above and still be the bug this feature could ship.'
        ]
      })

      // -----------------------------------------------------------------
      // S-21: the session split is remembered, and remembered as a layout
      // -----------------------------------------------------------------
      //
      // The half of this that S-9 cannot make. S-9 reads the parked number back
      // after a restart, which proves the row survived; it says nothing about
      // whether anything is laid out from it. A percentage that persists
      // perfectly and moves no boundary is the bug this setting exists to fix,
      // wearing the shape of a passing check.
      //
      // So the claim here is about **the measured column**: write a percentage,
      // and the sessions pane is that percentage of the row. Then drag, and the
      // row holds what the pane ended at - one write for the gesture, which is
      // the other thing a percentage per `mousemove` would pass.
      {
        const DIVIDER = '[role="separator"][aria-orientation="vertical"]'
        const splitGeometry = `(() => {
          const sep = document.querySelector(${JSON.stringify(DIVIDER)})
          const row = sep?.parentElement
          const col = sep?.nextElementSibling
          if (!sep || !row || !col) return null
          const r = row.getBoundingClientRect()
          const c = col.getBoundingClientRect()
          const s = sep.getBoundingClientRect()
          return {
            rowWidth: r.width,
            rowLeft: r.left,
            columnWidth: c.width,
            pct: (c.width / r.width) * 100,
            gripX: s.left + s.width / 2,
            gripY: s.top + s.height / 2
          }
        })()`
        type SplitGeometry = {
          rowWidth: number
          rowLeft: number
          columnWidth: number
          pct: number
          gripX: number
          gripY: number
        }

        const laidOut: Array<{ wrote: number; measured: number | null }> = []
        // Two, and neither is the default: one value could be the number the
        // app already had.
        for (const pct of [SPLIT_BOUNDS.min, 70]) {
          await sendWrite(win, { sessionSplitPct: pct })
          await sleep(700)
          const at = await js<SplitGeometry | null>(win, splitGeometry).catch(() => null)
          laidOut.push({ wrote: pct, measured: at === null ? null : at.pct })
        }

        const beforeDrag = await js<SplitGeometry | null>(win, splitGeometry).catch(() => null)
        let afterDrag: SplitGeometry | null = null
        let dragWrites = { n: 0, values: [] as number[] }
        let dragPointer: PointerTrace | null = null
        if (beforeDrag !== null) {
          await armSettingsCounter(win)
          await tracePointer(win, DIVIDER)
          // Toward the left, which widens the sessions column. Six moves, so
          // "one write" is a claim about a gesture that had frames to write on.
          await drag(
            win,
            { x: beforeDrag.gripX, y: beforeDrag.gripY },
            { x: beforeDrag.gripX - Math.round(beforeDrag.rowWidth * 0.1), y: beforeDrag.gripY },
            { steps: 6 }
          )
          await sleep(900)
          afterDrag = await js<SplitGeometry | null>(win, splitGeometry).catch(() => null)
          dragWrites = await readSettingsCounter(win)
          dragPointer = await readPointerTrace(win)
        }

        const rowAfterDrag = rowValue(dbFile, 'sessionSplitPct')
        // The row names the pane's own measured share, to the percentage point
        // the setting is stored in.
        const rowMatchesPane =
          afterDrag !== null &&
          typeof rowAfterDrag === 'number' &&
          Math.abs(rowAfterDrag - afterDrag.pct) <= 1
        const followedTheSetting = laidOut.every(
          (l) => l.measured !== null && Math.abs(l.measured - l.wrote) <= 1
        )
        const gestureArrivedHere =
          dragPointer !== null &&
          dragPointer.down === 1 &&
          dragPointer.move >= 6 &&
          dragPointer.up === 1 &&
          dragPointer.buttons === 1

        checks.push({
          id: 'S-21',
          criterion: 'The session split is remembered, and the pane is laid out from it',
          title:
            'A written percentage becomes the sessions pane’s measured share, and a drag writes the row exactly once',
          ok:
            followedTheSetting &&
            gestureArrivedHere &&
            rowMatchesPane &&
            dragWrites.n === 1 &&
            beforeDrag !== null &&
            afterDrag !== null &&
            afterDrag.columnWidth > beforeDrag.columnWidth,
          detail: {
            bounds: SPLIT_BOUNDS,
            laidOut,
            beforeDrag,
            afterDrag,
            writesDuringDrag: dragWrites,
            pointer: dragPointer,
            rowAfterDrag
          },
          notes: [
            'The pane is measured, never the number. A setting that round-trips',
            'and lays nothing out is what this is here to catch, and S-9 - which',
            'reads the same key back after a restart - cannot see the difference.',
            'Two written values, neither of them the default, because one could',
            'be the number the app already had on screen.',
            'One write per drag, over six moves: zero is a divider nothing is',
            'listening to, and one per move is a database round trip per frame,',
            'each coming back as a `settings:changed` into the middle of the',
            'gesture.',
            '`pointer.buttons` has to read 1. Sent without `leftbuttondown` the',
            'moves arrive as hovers, and this divider answered those for as long',
            'as it existed - see `drag()` in main/bridge.ts.'
          ]
        })
      }

      // Put the pane back the way a person left it, so the run does not end
      // with a maximised workspace and two fixture shells running.
      await click(win, '[data-maximize="workspace"]')
      await sleep(300)
      for (const entry of ctx.pterm.list()) {
        if (entry.path.toLowerCase().startsWith(fixtures.dir.toLowerCase())) {
          ctx.pterm.close(entry.id)
        }
      }
      // Forced, because the confirmation is the renderer's and nobody is here
      // to answer it. The session was started by this driver and has no purpose
      // beyond having been a terminal.
      await js<unknown>(
        win,
        `window.helm.invoke('session:close', { id: ${String(sessionId)}, force: true })`
      )
      await js<unknown>(
        win,
        `window.helm.invoke('roots:remove', { path: ${JSON.stringify(fixtures.termRoot)} })`
      )
      await sleep(600)
    } finally {
      ctx.sessions.resize = realSessionResize
      ctx.pterm.resize = realShellResize
    }
  }

  // -------------------------------------------------------------------------
  // S-12b: the content viewer's wrap settings, and what they reach
  // -------------------------------------------------------------------------
  //
  // Two claims, and the second is the one worth having. The first is the
  // ordinary round trip: the pane's controls write the rows. The second is that
  // the rows reach the **document**, which is where a setting like this
  // actually fails - a value that persists perfectly and paints nothing is the
  // shape a settings row is most likely to be wrong in.
  //
  // The document is asked for geometry rather than for class names: a wrapped
  // block is one whose `scrollWidth` has come back to its `clientWidth`, and a
  // hanging indent is a second visual row starting further right than the
  // first. Both are measured off the real window; neither can be satisfied by
  // an attribute that says the right thing while the block runs off the side.
  //
  // The group owns its scope and the file in it, and it measures that file
  // **twice** - once with wrapping off, once with it on - because geometry is a
  // comparator like any other and a comparator is not believed until it has
  // been made to disagree. See `wrapSource` and `controlDiscriminates`.
  if (run('content')) {
    // A scope of this group's own, so `--only=content` is a run that means
    // something and so the file being measured is one this driver wrote. The
    // argument for planting it rather than finding one is at `wrapSource`.
    await openSettings(win)
    await sleep(300)
    answerPicker('directory', fixtures.wrapRoot)
    await click(win, '[data-settings-add-root]')
    await pollJs(win, byData('settings-root', fixtures.wrapRoot), 20_000)
    const wrapScopeScanned = await pollJs(
      win,
      `[...document.querySelectorAll('aside nav button[title]')]
        .some((b) => b.title.toLowerCase() === ${JSON.stringify(fixtures.wrapScope.toLowerCase())})`,
      45_000
    )
    await sleep(600)

    // Both wrap keys back to their documented defaults first, the way the
    // terminal group starts from its own. The validation group parks each of
    // them on a value of its choosing on the way past, and the database this
    // runs against is a copy of the user's - so "off" and "four" are a state to
    // establish rather than one to assume. Without this, S-12b's "the row
    // changed" is only true on a machine that happened to have wrapping off.
    const primed = await sendWrite(win, {
      contentWrap: DEFAULT_CONTENT_WRAP.wrap,
      contentWrapIndent: DEFAULT_CONTENT_WRAP.indent
    })
    await sleep(500)
    const wrapPrimed = rowValue(dbFile, 'contentWrap')
    const indentPrimed = rowValue(dbFile, 'contentWrapIndent')

    // ---------------------------------------------------------------------
    // The control, before anything is believed: the same file, the same
    // measuring function, wrapping **off**.
    //
    // TPL-1's rule, applied to a comparator made of geometry. A file that fits
    // the pane would satisfy "wrapped" - `scrollWidth === clientWidth` - by
    // being short, and a measurement that never finds a two-row line would
    // report a hang of -1 in both states. So the fixture has to be shown to
    // overflow and to lay out in single rows before "it wrapped" is worth
    // anything, and this is the run where the same function must disagree.
    // ---------------------------------------------------------------------
    const openedUnwrapped = await openPlantedSource(
      win,
      fixtures.wrapScope,
      fixtures.wrapSourceRel
    )
    const unwrapped = await measureSource(win)
    const shotUnwrapped = await screenshot(win, shotDir, 'settings-12c-unwrapped.png')
    // Shut, so the measured pane below is one that *mounted* holding the new
    // settings rather than one that was on screen while they changed.
    const closedBetween = await closeContentTab(win)
    await sleep(500)

    await openSettings(win)
    await sleep(300)

    const wrapBox = '[data-settings-content-wrap] input[type="checkbox"]'
    const indentField = '[data-settings-content-wrap-indent]'

    const wrapBefore = rowValue(dbFile, 'contentWrap')
    const clickedWrap = await click(win, wrapBox)
    await sleep(500)
    const wrapAfter = rowValue(dbFile, 'contentWrap')

    // Committed with Enter, which is what a person does, and **not** with a
    // dispatched `blur`: React maps `onBlur` to `focusout`, so a raw non-bubbling
    // `blur` reaches nothing and the field keeps its draft. That is how this
    // probe first reported a written row of `undefined` while the pane on screen
    // showed 7 - the field had the text and the commit had never run.
    const setIndent = await js<boolean>(
      win,
      `(() => {
         const el = document.querySelector('${indentField}')
         if (!el) return false
         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
         setter.call(el, '${String(WRAP_INDENT_COLUMNS)}')
         el.dispatchEvent(new Event('input', { bubbles: true }))
         el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
         return true
       })()`
    ).catch(() => false)
    await sleep(600)
    const indentAfter = rowValue(dbFile, 'contentWrapIndent')

    checks.push({
      id: 'S-12b',
      criterion: 'The content viewer’s wrap default and indent are settings that round-trip',
      title: `contentWrap ${JSON.stringify(wrapBefore)} -> ${JSON.stringify(wrapAfter)}, contentWrapIndent -> ${JSON.stringify(indentAfter)}`,
      ok:
        primed.accepted &&
        wrapPrimed === DEFAULT_CONTENT_WRAP.wrap &&
        indentPrimed === DEFAULT_CONTENT_WRAP.indent &&
        clickedWrap &&
        wrapAfter === true &&
        setIndent &&
        indentAfter === WRAP_INDENT_COLUMNS,
      detail: {
        primedToTheDefaults: { write: primed, wrap: wrapPrimed, indent: indentPrimed },
        clickedWrap,
        wrapBefore,
        wrapAfter,
        setIndent,
        indentAfter,
        readBy: 'this driver’s own read-only connection to helm.db, not services.store'
      },
      notes: [
        'Both keys are written back to their documented defaults first and read',
        'back, because neither is a state this group may assume: the validation',
        'group parks both on the way past, and the database is a copy of the',
        'user’s. Without it "the row changed" was only true on a machine that',
        'happened to have wrapping switched off.',
        'The values it moves to are then not the defaults - true, and a hang of',
        '7 - so "the row changed" cannot be confused with "the row was always',
        'this".'
      ]
    })

    // Now the half that matters: does a document obey them? A second mount, of
    // a tab that was shut while the settings changed, so what is measured is a
    // pane that read them on the way in. `contentWrap` is the *default* a
    // document takes; a pane already on screen holds a per-file answer instead.
    const openedWrapped = await openPlantedSource(win, fixtures.wrapScope, fixtures.wrapSourceRel)
    const wrapped = await measureSource(win)
    const shotWrapped = await screenshot(win, shotDir, 'settings-12c-wrapped.png')

    const expectedHangPx = wrapped === null ? -1 : Math.round(WRAP_INDENT_COLUMNS * wrapped.charPx)
    /**
     * The fixture is discriminating, proven by the same function disagreeing.
     *
     * Overflowing while unwrapped is what says the file is wider than the pane
     * - without it "no horizontal overflow" is what a short file reports - and
     * no line taller than one row is what says the two-row search below found
     * something rather than always finding something.
     */
    const controlDiscriminates =
      unwrapped !== null &&
      unwrapped.wrapAttr === 'off' &&
      unwrapped.togglePressed === 'false' &&
      unwrapped.linesSeen > 50 &&
      unwrapped.scrollWidth > unwrapped.clientWidth &&
      unwrapped.wrappedLines === 0 &&
      unwrapped.hangPx === -1

    checks.push({
      id: 'S-12c',
      criterion: 'A source file opens wrapped, hanging by the setting, because the settings say so',
      title:
        wrapped === null || unwrapped === null
          ? `the planted source file could not be measured (${fixtures.wrapSourceRel})`
          : `${fixtures.wrapSourceRel}: ${String(unwrapped.clientWidth)}px block holding ${String(unwrapped.scrollWidth)}px unwrapped, ${String(wrapped.scrollWidth)}px wrapped, hang ${String(wrapped.hangPx)}px for ${String(wrapped.indentColumns)} columns`,
      ok:
        wrapScopeScanned &&
        openedUnwrapped.scopeChosen &&
        openedUnwrapped.rendered &&
        closedBetween &&
        openedWrapped.scopeChosen &&
        openedWrapped.rendered &&
        controlDiscriminates &&
        wrapped !== null &&
        // The same document in both states, not two that happened to open.
        wrapped.linesSeen === unwrapped?.linesSeen &&
        wrapped.wrapAttr === 'on' &&
        wrapped.togglePressed === 'true' &&
        // Wrapped means the horizontal overflow is gone, not that a class is set.
        wrapped.scrollWidth === wrapped.clientWidth &&
        // ...and that lines actually became more than one visual row, which is
        // the half a block that had simply been made narrow would fail.
        wrapped.wrappedLines > 0 &&
        // And the hang is the setting, measured: 7 columns of this mono face,
        // from the line's own indentation rather than from the block's edge.
        wrapped.indentColumns > 0 &&
        wrapped.hangPx > 0 &&
        Math.abs(wrapped.hangPx - expectedHangPx) <= 2,
      detail: {
        fixture: {
          scope: fixtures.wrapScope,
          file: fixtures.wrapSource,
          asListed: fixtures.wrapSourceRel,
          scanFound: wrapScopeScanned
        },
        unwrapped: { opened: openedUnwrapped, geometry: unwrapped, screenshot: shotUnwrapped.file },
        closedBetween,
        wrapped: {
          opened: openedWrapped,
          geometry: wrapped,
          expectedHangPx,
          indentColumnsSet: WRAP_INDENT_COLUMNS,
          screenshot: shotWrapped.file
        },
        controlDiscriminates
      },
      notes: [
        'The file is planted by this driver, in a harness of its own added as a',
        'scan root. It used to be chosen by shape out of whatever scope the',
        'machine opened on, and on this machine there was none - the probe',
        'reported "no source file in this scope could be measured", which is',
        'honest and is not the failure it exists to report. CONT-16 met the same',
        'wall and answered it the same way.',
        'The comparator is made to disagree before it is believed - TPL-1’s',
        'rule, applied to geometry. The same measuring function is run over the',
        'same file with the setting off, and it has to find the block',
        'overflowing and every line one row tall. A file that fitted the pane',
        'would satisfy "wrapped" by being short.',
        'Geometry, not class names: "wrapped" is `scrollWidth` back at',
        '`clientWidth` *and* lines taller than one row, and "hung" is the second',
        'visual row of a line starting further right than the line’s own code. A',
        '`data-wrap` attribute would report all of it whether or not it happened.',
        'The expected hang is computed from a ruler measured in the block’s own',
        'font, so it is in the unit the browser resolved `ch` with.',
        'The tab is shut between the two: `contentWrap` is the default a',
        'document *mounts* with, so a pane that was already open is answering a',
        'different question.'
      ]
    })

    // The tree this group leaves is the tree it found: its own root back out,
    // and its tab shut. A content tab left open is a pane the next group has to
    // click past, and the root would otherwise sit in `scanRoots` until the
    // restore.
    await closeContentTab(win)
    await sleep(400)
    await openSettings(win)
    await sleep(300)
    await clickByData(win, 'settings-remove-root', fixtures.wrapRoot)
    await sleep(800)
  }

  // -------------------------------------------------------------------------
  // S-13: the GitHub group
  // -------------------------------------------------------------------------
  if (run('github')) {
    /** A fetch pass, forced through the real channel and waited on. */
    const refreshPulls = (): Promise<{ ghPath: string | null; problem: string | null }> =>
      js<{ ghPath: string | null; problem: string | null }>(
        win,
        `window.helm.invoke('pr:refresh', {}).then((s) => ({
           ghPath: s.gh.path, problem: s.gh.problem ? s.gh.problem.kind : null }))`
      )

    // Start from "no override", whatever an earlier run left: this runs against
    // the real profile, and the group is only meaningful from a known state.
    await sendWrite(win, { ghPath: null })
    await refreshPulls()
    await openSettings(win)
    await sleep(500)

    // What the pane says gh is, and what this driver finds by asking Windows
    // and then asking the program itself.
    const paintedPath = await text(win, '[data-settings-gh-path]')
    const paintedVersion = await text(win, '[data-settings-gh-version]')
    const onPath = whereIs('gh.exe').concat(whereIs('gh'))
    const directVersion =
      paintedPath === NOTHING ? null : (versionOf(paintedPath)?.split(/\r?\n/)[0]?.trim() ?? null)
    const agreesWithPath =
      onPath.length === 0 ||
      onPath.some((entry) => entry.toLowerCase() === paintedPath.toLowerCase())
    const clearDisabledBefore = await disabled(win, '[data-settings-clear-gh]')

    // Point it at a gh that is installed and not signed in. Everything after
    // this is the unauthenticated path, provoked on a machine whose real gh is
    // signed in - which is the only honest way to see that sentence here.
    answerPicker('file', fixtures.ghStub)
    await click(win, '[data-settings-gh-locate]')
    const overrideShown = await pollJs(
      win,
      `(document.querySelector('[data-settings-gh-path]')?.textContent ?? '')
        .includes(${JSON.stringify('gh.cmd')})`,
      30_000
    )
    await sleep(600)

    const overriddenPath = await text(win, '[data-settings-gh-path]')
    const overriddenVersion = await text(win, '[data-settings-gh-version]')
    const stubSays = versionOf(fixtures.ghStub)?.split(/\r?\n/)[0]?.trim() ?? null
    const ghRowAfterPick = rowValue(dbFile, 'ghPath')
    const clearDisabledAfter = await disabled(win, '[data-settings-clear-gh]')
    const afterPick = await refreshPulls()

    // The sentence, where a user would meet it: the Pulls pane and the sidebar
    // row that leads to it.
    await click(win, '[data-open-pulls]')
    const pulled = await pollJs(win, `document.querySelector('[data-pulls-caption]')`, 15_000)
    await sleep(500)
    const unauthSentence = await text(win, '[data-pulls-problem="unauthenticated"]')
    const sidebarLine = await text(win, '[data-open-pulls]')
    const caption = await text(win, '[data-pulls-caption]')
    const shotGh = await screenshot(win, shotDir, 'settings-13-github.png')

    await openSettings(win)
    await sleep(400)
    await click(win, '[data-settings-clear-gh]')
    const cleared = await pollJs(
      win,
      `!(document.querySelector('[data-settings-gh-path]')?.textContent ?? '')
        .includes(${JSON.stringify('gh.cmd')})`,
      30_000
    )
    await sleep(500)
    const ghRowAfterClear = rowValue(dbFile, 'ghPath')
    const afterClear = await refreshPulls()

    // The interval, through the pane's own picker. Off first, because off is
    // the state a select could most easily fail to represent.
    const offered = await js<string[]>(
      win,
      `[...(document.querySelector('[data-settings-pr-poll]')?.options ?? [])].map((o) => o.value)`
    )
    const pickedOff = await chooseOption(win, '[data-settings-pr-poll]', '0')
    await sleep(600)
    const rowWhenOff = rowValue(dbFile, 'prPollMinutes')
    const pickedFifteen = await chooseOption(win, '[data-settings-pr-poll]', '15')
    await sleep(600)
    const rowWhenFifteen = rowValue(dbFile, 'prPollMinutes')

    // The stale cutoff, through its own picker and in the same shape: off
    // first, because off is the state a select is likeliest to fail to
    // represent - and here it is also the state that switches a whole section
    // of the Pulls pane back off.
    const staleOffered = await js<string[]>(
      win,
      `[...(document.querySelector('[data-settings-pr-stale]')?.options ?? [])].map((o) => o.value)`
    )
    const pickedStaleOff = await chooseOption(win, '[data-settings-pr-stale]', '0')
    await sleep(600)
    const rowWhenStaleOff = rowValue(dbFile, 'prStaleDays')
    const pickedStaleWeek = await chooseOption(win, '[data-settings-pr-stale]', '7')
    await sleep(600)
    const rowWhenStaleWeek = rowValue(dbFile, 'prStaleDays')

    // The review launch's two settings, through the pane's own controls.
    // The template is typed rather than written, because a text field that
    // commits on blur has two ways to fail that a row write does not.
    const template = 'Review {slug}#{number} on {branch}'
    const typedTemplate = await typeInto(win, '[data-settings-pr-prompt]', template)
    await sleep(600)
    const rowAfterTyping = rowValue(dbFile, 'prReviewPrompt')
    const resetDisabledWhenCustom = await disabled(win, '[data-settings-pr-prompt-reset]')
    await click(win, '[data-settings-pr-prompt-reset]')
    await sleep(600)
    const rowAfterReset = rowValue(dbFile, 'prReviewPrompt')
    const resetDisabledWhenDefault = await disabled(win, '[data-settings-pr-prompt-reset]')

    const pickedCheckout = await chooseOption(win, '[data-settings-pr-checkout]', 'checkout')
    await sleep(600)
    const rowWhenCheckout = rowValue(dbFile, 'prCheckout')
    const pickedNone = await chooseOption(win, '[data-settings-pr-checkout]', 'none')
    await sleep(600)
    const rowWhenNone = rowValue(dbFile, 'prCheckout')

    // The model and the effort. Both are set, read back, and then put *back* to
    // the default - because null is the interesting value on these two: it is
    // the state in which the launch passes no flag at all, and a select that
    // can reach every named option but not the empty one would be a setting
    // nobody could turn off again.
    const pickedModel = await chooseOption(win, '[data-settings-pr-model]', 'opus')
    await sleep(600)
    const rowWhenOpus = rowValue(dbFile, 'prReviewModel')
    const pickedEffort = await chooseOption(win, '[data-settings-pr-effort]', 'high')
    await sleep(600)
    const rowWhenHigh = rowValue(dbFile, 'prReviewEffort')
    const clearedModel = await chooseOption(win, '[data-settings-pr-model]', '')
    await sleep(600)
    const rowWhenNoModel = rowValue(dbFile, 'prReviewModel')
    const clearedEffort = await chooseOption(win, '[data-settings-pr-effort]', '')
    await sleep(600)
    const rowWhenNoEffort = rowValue(dbFile, 'prReviewEffort')

    checks.push({
      id: 'S-13',
      criterion:
        'Every GitHub setting is settable from the pane’s GitHub group: the gh path, the interval, the review prompt and the checkout mode',
      title:
        'The pane names the gh this machine actually has, takes an override that reaches the fetch, and the interval, prompt and checkout mode all reach the database',
      ok:
        paintedPath !== '' &&
        paintedPath !== NOTHING &&
        directVersion !== null &&
        paintedVersion === directVersion &&
        agreesWithPath &&
        clearDisabledBefore === true &&
        overrideShown &&
        overriddenPath === fixtures.ghStub &&
        stubSays !== null &&
        overriddenVersion === stubSays &&
        ghRowAfterPick === fixtures.ghStub &&
        clearDisabledAfter === false &&
        afterPick.ghPath === fixtures.ghStub &&
        afterPick.problem === 'unauthenticated' &&
        pulled &&
        unauthSentence.includes('gh auth login') &&
        sidebarLine.includes('Run gh auth login') &&
        caption.includes('fetched') &&
        cleared &&
        ghRowAfterClear === null &&
        afterClear.ghPath === paintedPath &&
        afterClear.problem === null &&
        offered.includes('0') &&
        pickedOff.offered &&
        pickedOff.set &&
        rowWhenOff === 0 &&
        pickedFifteen.offered &&
        pickedFifteen.set &&
        rowWhenFifteen === 15 &&
        staleOffered.includes('0') &&
        pickedStaleOff.offered &&
        pickedStaleOff.set &&
        rowWhenStaleOff === 0 &&
        pickedStaleWeek.offered &&
        pickedStaleWeek.set &&
        rowWhenStaleWeek === 7 &&
        typedTemplate &&
        rowAfterTyping === template &&
        resetDisabledWhenCustom === false &&
        rowAfterReset === '/code-review {number}' &&
        // Disabled once it is back at the built-in prompt: a Reset that stays
        // live is a Reset that says the setting is still custom.
        resetDisabledWhenDefault === true &&
        pickedCheckout.offered &&
        pickedCheckout.set &&
        rowWhenCheckout === 'checkout' &&
        pickedNone.offered &&
        pickedNone.set &&
        rowWhenNone === 'none' &&
        pickedModel.offered &&
        pickedModel.set &&
        rowWhenOpus === 'opus' &&
        pickedEffort.offered &&
        pickedEffort.set &&
        rowWhenHigh === 'high' &&
        clearedModel.offered &&
        clearedModel.set &&
        rowWhenNoModel === null &&
        clearedEffort.offered &&
        clearedEffort.set &&
        rowWhenNoEffort === null,
      detail: {
        discovered: { painted: { path: paintedPath, version: paintedVersion }, whereExeSays: onPath },
        askedTheExecutableDirectly: directVersion,
        paintedPathIsTheOneOnPath: agreesWithPath,
        clearDisabledWithNoOverride: clearDisabledBefore,
        afterPicking: {
          painted: { path: overriddenPath, version: overriddenVersion },
          stubSaysDirectly: stubSays,
          databaseRow: ghRowAfterPick,
          snapshot: afterPick,
          clearEnabled: clearDisabledAfter === false
        },
        degradation: {
          paneSentence: unauthSentence,
          sidebarSecondLine: sidebarLine,
          ageCaption: caption
        },
        afterClearing: { databaseRow: ghRowAfterClear, snapshot: afterClear },
        pollInterval: {
          offeredValues: offered,
          off: { picked: pickedOff, databaseRow: rowWhenOff },
          fifteen: { picked: pickedFifteen, databaseRow: rowWhenFifteen }
        },
        staleCutoff: {
          offeredValues: staleOffered,
          off: { picked: pickedStaleOff, databaseRow: rowWhenStaleOff },
          aWeek: { picked: pickedStaleWeek, databaseRow: rowWhenStaleWeek }
        },
        reviewPrompt: {
          typed: typedTemplate,
          templateTyped: template,
          databaseRowAfterTyping: rowAfterTyping,
          resetEnabledWhileCustom: resetDisabledWhenCustom === false,
          databaseRowAfterReset: rowAfterReset,
          resetDisabledAtTheDefault: resetDisabledWhenDefault === true
        },
        checkoutMode: {
          checkout: { picked: pickedCheckout, databaseRow: rowWhenCheckout },
          none: { picked: pickedNone, databaseRow: rowWhenNone }
        },
        reviewModel: {
          opus: { picked: pickedModel, databaseRow: rowWhenOpus },
          cleared: { picked: clearedModel, databaseRow: rowWhenNoModel }
        },
        reviewEffort: {
          high: { picked: pickedEffort, databaseRow: rowWhenHigh },
          cleared: { picked: clearedEffort, databaseRow: rowWhenNoEffort }
        },
        screenshot: shotGh.file
      },
      notes: [
        'The version on screen is compared with what the executable prints when',
        'this driver runs it, and the path against `where.exe gh` - the same',
        'two independent reads the Claude CLI group gets.',
        'The override is a real program on disk that answers `--version` and',
        'fails `auth status`, which is the only honest way to see the',
        '"not signed in" sentence on a machine whose gh is signed in. It is',
        'picked through the pane’s own button and the real `path:chooseFile`',
        'handler, and read back out of the database file rather than the app.',
        'The sentence is then read where a user meets it: in the Pulls pane and',
        'on the sidebar row, in its short form. Detection is from gh’s exit code',
        'alone - nothing here or in the app opens a credential store.',
        'The interval is set through the select, including 0, which is the value',
        'that disarms the timer rather than a small number inside the range.',
        'The stale cutoff is set the same way and for the same reason: 0 there is',
        'the Pulls pane reverting to one flat Open list rather than a one-day',
        'cutoff, so it is the value most worth watching round-trip. What the',
        'setting then *does* to that pane is `pnpm pr-check`’s triage phase.',
        'The review prompt is typed into the field and committed the way a person',
        'commits it, then put back with Reset - and Reset is checked for being',
        'disabled at the built-in prompt, because a Reset that stays live is one',
        'saying the setting is still custom when it is not.',
        'The model and the effort are each set and then cleared again, because',
        'the empty option is the load-bearing one: it is the state where the',
        'launch passes no flag at all, and a picker that could reach every named',
        'model but not "default" would be a setting nobody could turn back off.',
        'What these settings actually *do* is `pnpm pr-check`’s: this proves they',
        'are reachable and persist, and that driver proves the template and the',
        'two flags reach the argv, and that checkout mode refuses a dirty tree.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-23..S-26: the WSL group
  // -------------------------------------------------------------------------
  //
  // The one group in this pane that does not write a settings row. What it
  // changes is `%USERPROFILE%\.wslconfig` - a file Helm does not own, that
  // applies to every distribution and every WSL process on the machine - so
  // there is no database read to put beside the UI here. The independent read
  // is the file itself, and this driver does all of it with `readFileSync`.
  //
  // **It is aimed at a fixture profile, not at the user's.** `wslConfigPath()`
  // resolves `USERPROFILE` at call time, so swapping that variable points the
  // real channel, the real editor and the real backup at a directory this
  // driver made - which means honouring the variable is something the run
  // exercises rather than something a hook simulates, the same posture
  // `transcript-check` takes with `CLAUDE_CONFIG_DIR`. Nothing here can write
  // to the developer's own `.wslconfig`, and a group that dies half way leaves
  // the swap in place only until the process exits.
  //
  // The swap is why this group runs last: on Windows `os.homedir()` *is*
  // `USERPROFILE`, so anything asking for a home while it is swapped - the
  // config console's scopes, the history index - would be handed the fixture.
  // Nothing is driven between the swap and the restore except this group.
  if (run('wsl')) {
    const profileDir = join(fixtures.dir, 'wsl profile')
    const configFile = join(profileDir, '.wslconfig')
    const realProfile = process.env['USERPROFILE']

    /** The fixture's bytes, or null for a file that is not there. */
    const onDisk = (): string | null => {
      try {
        return readFileSync(configFile, 'utf8')
      } catch {
        return null
      }
    }
    /** The copies Helm has taken beside it. */
    const backups = (): string[] =>
      existsSync(profileDir)
        ? readdirSync(profileDir)
            .filter((name) => name.endsWith('.helm.bak'))
            .sort()
        : []

    /**
     * The pane, remounted.
     *
     * `.wslconfig` is read when the group mounts and again after every write,
     * and nothing watches the file - deliberately, see `useWslNetworking`. So
     * a fixture planted underneath an open pane is a fixture the pane has not
     * read, and remounting is what makes the next assertion a claim about the
     * file rather than about a stale render.
     *
     * Done by putting another pane on screen rather than by closing the tab.
     * The pane is a conditional render on the *active* pane, so switching away
     * unmounts it and the hook runs its read again on the way back - whereas
     * the close button leaves a tab strip that may still be showing the pane
     * this is trying to get rid of. Written the other way first, and S-23
     * caught it exactly as it should have: the state and the mode agreed with
     * the fixture by coincidence - both files were absent - while the path on
     * screen was still `C:\Users\<me>\.wslconfig`, which is the one read that
     * could tell a remount from a stale render.
     */
    const remount = async (): Promise<boolean> => {
      await click(win, '[data-open-history]')
      await pollJs(win, `document.querySelector('[data-settings-pane]') === null`, 10_000)
      const opened = await openSettings(win)
      // The state attribute is `reading` until the channel answers, so waiting
      // for the element is not enough - waiting for it to stop reading is.
      await pollJs(
        win,
        `document.querySelector('[data-settings-wsl-state]')?.dataset.settingsWslState !== 'reading'`,
        10_000
      )
      return opened
    }

    const paneState = (): Promise<string | null> =>
      attr(win, '[data-settings-wsl-state]', 'data-settings-wsl-state')

    rmSync(profileDir, { recursive: true, force: true })
    mkdirSync(profileDir, { recursive: true })
    process.env['USERPROFILE'] = profileDir

    try {
      // ---------------------------------------------------------------------
      // S-23: what the file says, including when there is no file
      // ---------------------------------------------------------------------
      //
      // The absent file is the interesting half and it is the state of the
      // machine this was written on. Absent must read as "no mode set" and
      // never as `nat`: which mode WSL defaults to is a fact about the WSL
      // build, and printing the default as though the file said it would be
      // Helm inventing a line nobody wrote.
      await remount()
      const absentState = await paneState()
      const absentMode = await attr(win, '[data-settings-wsl-mode]', 'data-settings-wsl-mode')
      const absentPath = (await text(win, '[data-settings-wsl-file]')).trim()
      const absentOnDisk = onDisk()
      const offerWhenAbsent = await attr(win, '[data-settings-wsl-set]', 'data-settings-wsl-set')
      const offerLive = await disabled(win, '[data-settings-wsl-set]')

      checks.push({
        id: 'S-23',
        criterion: 'The pane states what `.wslconfig` says, and says nothing the file does not',
        title: 'An absent .wslconfig reads as no mode set, names the path, and offers the change',
        ok:
          absentOnDisk === null &&
          absentState === 'not-mirrored' &&
          absentMode === '' &&
          absentPath === configFile &&
          offerWhenAbsent === 'mirrored' &&
          offerLive === false,
        detail: {
          configFile,
          fileOnDisk: absentOnDisk,
          paneState: absentState,
          paneMode: absentMode,
          panePath: absentPath,
          buttonOffers: offerWhenAbsent,
          buttonDisabled: offerLive
        },
        notes: [
          'The path on screen is compared with the path this driver put in',
          '`USERPROFILE`, so it is evidence that the pane is reading the file the',
          'channel would write - not two independently plausible strings.',
          'The mode attribute must be empty rather than `nat`. A pane that filled',
          'in the platform default would be indistinguishable from a file that',
          'set it, which is the one thing a user reads this row to find out.',
          'The button is live for an absent file: there is nothing to lose, and',
          'the way back from creating the file is deleting it.'
        ]
      })

      // ---------------------------------------------------------------------
      // S-24: the write - what it puts in, what it keeps, what it copies first
      // ---------------------------------------------------------------------
      //
      // Two writes, and the second is the one that matters. The first is into
      // nothing, which cannot say anything about preservation; so a file with
      // comments, an inline comment, another section, CRLF line endings and
      // `networkingMode=nat` already in it is planted underneath, and every
      // line of it except the one under test has to come out byte-identical.
      const createClicked = await clickByData(win, 'settings-wsl-set', 'mirrored')
      await pollJs(
        win,
        `document.querySelector('[data-settings-wsl-state]')?.dataset.settingsWslState === 'mirrored'`,
        15_000
      )
      const createdText = onDisk()
      const createdBackups = backups()
      const createdNotice = (await text(win, '[data-settings-wsl-notice]')).trim()

      const PLANTED = [
        '# a comment somebody wrote',
        '[wsl2]',
        'memory=8GB   # and an inline one',
        'processors=4',
        'networkingMode=nat',
        '',
        '[experimental]',
        'autoMemoryReclaim=gradual',
        ''
      ].join('\r\n')
      writeFileSync(configFile, PLANTED, 'utf8')
      for (const name of backups()) rmSync(join(profileDir, name), { force: true })

      await remount()
      const natState = await paneState()
      const natMode = await attr(win, '[data-settings-wsl-mode]', 'data-settings-wsl-mode')

      // The button offers the mode it is *not* on, so this click reaching the
      // element is itself evidence the remount above happened: on a stale
      // "mirrored" render there is no `mirrored` button to find, which is how
      // the first run of this group failed - a write that never fired, whose
      // notice was still the previous one's.
      const rewriteClicked = await clickByData(win, 'settings-wsl-set', 'mirrored')
      await pollJs(
        win,
        `document.querySelector('[data-settings-wsl-state]')?.dataset.settingsWslState === 'mirrored'`,
        15_000
      )
      const rewritten = onDisk() ?? ''
      const madeBackups = backups()
      const backupText =
        madeBackups.length === 1 ? readFileSync(join(profileDir, madeBackups[0] ?? ''), 'utf8') : ''
      const rewrittenNotice = (await text(win, '[data-settings-wsl-notice]')).trim()

      // Every line of the planted file except the one key, still present and
      // unaltered - compared line by line rather than with a regex, because
      // "nothing else changed" is a claim about all of them.
      const keptLines = PLANTED.split('\r\n').filter(
        (line) => line !== 'networkingMode=nat' && line !== ''
      )
      const rewrittenLines = rewritten.split(/\r?\n/)
      const kept = keptLines.filter((line) => rewrittenLines.includes(line))
      const mirroredOnce =
        rewrittenLines.filter((line) => line.trim().toLowerCase().startsWith('networkingmode'))
          .length === 1
      const natGone = !rewritten.toLowerCase().includes('networkingmode=nat')
      const insideSection =
        rewrittenLines.findIndex((line) => line.trim() === '[wsl2]') <
          rewrittenLines.findIndex((line) =>
            line.trim().toLowerCase().startsWith('networkingmode')
          ) &&
        rewrittenLines.findIndex((line) =>
          line.trim().toLowerCase().startsWith('networkingmode')
        ) < rewrittenLines.findIndex((line) => line.trim() === '[experimental]')

      /*
       * Idempotence: the file already says this, so the write must report that
       * and copy nothing.
       *
       * Hand-sent down the real channel rather than pressed, because the
       * control is a **toggle** - now that the file reads mirrored the button
       * offers `nat`, and there is no second press of "set mirrored" to make.
       * That is the right shape for the pane and it leaves the unchanged reply
       * with no button behind it, so the claim is made where it can be: the
       * same handler the button calls, with the same argument. What the pane
       * owes here instead is that the offer flipped, which is asserted beside
       * it.
       */
      const offerAfterWrite = await attr(win, '[data-settings-wsl-set]', 'data-settings-wsl-set')
      const again = await js<{ ok: boolean; unchanged: boolean; backupPath: string | null }>(
        win,
        `window.helm.invoke('wsl:setNetworking', { mode: 'mirrored' })
           .then((r) => ({ ok: r.ok, unchanged: r.unchanged, backupPath: r.backupPath }))`
      )
      const afterAgain = onDisk() ?? ''
      const backupsAfterAgain = backups()

      const shot = await screenshot(win, shotDir, 'settings-9-wsl.png')

      checks.push({
        id: 'S-24',
        criterion:
          'The write sets one key, keeps everything else, and copies the file before touching it',
        title:
          'networkingMode is set inside [wsl2] with comments, sections and CRLF intact, over a timestamped backup',
        ok:
          createClicked &&
          rewriteClicked &&
          createdText !== null &&
          createdText.includes('[wsl2]') &&
          createdText.toLowerCase().includes('networkingmode=mirrored') &&
          createdBackups.length === 0 &&
          natState === 'not-mirrored' &&
          natMode === 'nat' &&
          kept.length === keptLines.length &&
          mirroredOnce &&
          natGone &&
          insideSection &&
          rewritten.includes('\r\n') &&
          madeBackups.length === 1 &&
          backupText === PLANTED &&
          rewrittenNotice.includes(madeBackups[0] ?? 'no backup') &&
          offerAfterWrite === 'nat' &&
          again.ok &&
          again.unchanged &&
          again.backupPath === null &&
          afterAgain === rewritten &&
          backupsAfterAgain.length === 1,
        detail: {
          created: {
            clickReached: createClicked,
            text: createdText,
            backups: createdBackups,
            notice: createdNotice
          },
          plantedFileRead: { paneState: natState, paneMode: natMode },
          rewrite: {
            clickReached: rewriteClicked,
            text: rewritten,
            keptLinesExpected: keptLines,
            keptLinesFound: kept,
            exactlyOneModeLine: mirroredOnce,
            oldValueGone: natGone,
            insideTheWsl2Section: insideSection,
            crlfPreserved: rewritten.includes('\r\n'),
            notice: rewrittenNotice
          },
          backup: {
            files: madeBackups,
            bytesMatchTheFileAsFound: backupText === PLANTED,
            plantedBytes: PLANTED
          },
          secondWrite: {
            buttonNowOffers: offerAfterWrite,
            reply: again,
            fileUnchanged: afterAgain === rewritten,
            backupsStillOne: backupsAfterAgain.length
          },
          screenshot: shot.file
        },
        notes: [
          'The file is read off disk by this driver, not read back through the',
          'channel that wrote it: a writer that reported success and wrote',
          'nothing would agree with its own reply.',
          'The backup is compared byte for byte against the bytes this driver',
          'planted. A copy that exists is not the claim - a copy of *what was*',
          'there is, and it is what makes the change reversible.',
          'The created-from-nothing case must take no backup and say so: there',
          'were no previous bytes, and the way back is deleting the file. A',
          'timestamped copy of an empty file would be a way back to nothing.',
          'The mode line is required to be inside [wsl2] and before the next',
          'section header. An editor appending at EOF produces a file that',
          'parses - the key would sit under [experimental] - and WSL would',
          'ignore it, which is a change that reports success and does nothing.',
          'The second write is the unchanged path: it must report that nothing',
          'was written, leave the bytes alone, and *not* take a second copy,',
          'because a copy per press would eventually bury the original. Sent',
          'down the channel rather than pressed, because the control is a toggle',
          'and after the write it offers `nat` - which is itself asserted, since',
          'a toggle still offering the mode the file already has would be the',
          'pane disagreeing with the file it had just written.'
        ]
      })

      // ---------------------------------------------------------------------
      // S-25: a file too odd to touch is refused, not rewritten
      // ---------------------------------------------------------------------
      //
      // Two `networkingMode` keys under one `[wsl2]`. Which one a person meant
      // is not Helm's to guess, and the failure this refuses to become is the
      // one that matters: an editor that changed the first and left the second
      // would leave the file saying something the user never wrote, having
      // reported success.
      const ODD = ['[wsl2]', 'networkingMode=mirrored', 'networkingMode=nat', ''].join('\n')
      writeFileSync(configFile, ODD, 'utf8')
      for (const name of backups()) rmSync(join(profileDir, name), { force: true })

      await remount()
      const refusedState = await paneState()
      const refusalOnScreen = (await text(win, '[data-settings-wsl-state]')).trim()
      const refusedButton = await disabled(win, '[data-settings-wsl-set]')
      const clicked = await clickByData(win, 'settings-wsl-set', 'mirrored')
      await sleep(900)
      const oddAfter = onDisk() ?? ''
      const oddBackups = backups()

      checks.push({
        id: 'S-25',
        criterion: 'A file Helm cannot read with confidence is reported and left alone',
        title: 'Two networkingMode keys: the pane prints the refusal, the button is dead, the bytes are untouched',
        ok:
          refusedState === 'refused' &&
          refusalOnScreen.toLowerCase().includes('networkingmode') &&
          refusedButton === true &&
          oddAfter === ODD &&
          oddBackups.length === 0,
        detail: {
          planted: ODD,
          paneState: refusedState,
          sentenceOnScreen: refusalOnScreen,
          buttonDisabled: refusedButton,
          clickReached: clicked,
          fileAfter: oddAfter,
          bytesUnchanged: oddAfter === ODD,
          backupsTaken: oddBackups
        },
        notes: [
          'The refusal is required to be *on screen* and to name the key. The',
          'whole point of refusing is to tell the user what is in their file so',
          'they can fix it in their own editor, and a disabled button with no',
          'sentence beside it is a control that has simply stopped working.',
          'The click is attempted anyway. A disabled attribute is the claim; the',
          'file being byte-identical afterwards is the evidence, and only the',
          'second one would survive the attribute being lost in a refactor.',
          'No backup either: a refusal that copied the file first would leave',
          'litter beside a file it then declined to change.'
        ]
      })

      // ---------------------------------------------------------------------
      // S-26: the two facts are never merged, and the restart is never a side effect
      // ---------------------------------------------------------------------
      //
      // The state this exists for is the one every user of the control passes
      // through: the file says `mirrored` and WSL has not restarted, so the
      // file is right and the distro still cannot connect. Both are true and
      // one verdict over the pair would hide it. So the pane must not paint a
      // reachability verdict at all until somebody asks for one - asking boots
      // a stopped distribution, which is why it is a button and not a mount.
      writeFileSync(configFile, '[wsl2]\nnetworkingMode=mirrored\n', 'utf8')
      for (const name of backups()) rmSync(join(profileDir, name), { force: true })
      await remount()
      const mirroredState = await paneState()
      const verdictBeforeAsking = await exists(win, '[data-settings-wsl-reachable]')

      const distrosOffered = await js<string[]>(
        win,
        `[...document.querySelectorAll('[data-settings-wsl-distro] option')]
           .map((o) => o.value).filter((v) => v !== '')`
      )
      let probeAttribute: string | null = null
      let driverSawReachable: boolean | null = null
      const chosen = distrosOffered[0] ?? ''
      // The port the running app is actually listening on, asked of the
      // endpoint itself. Null where the tools are off, and then there is
      // nothing for a distribution to reach and no second read to make.
      const endpointPort = ctx.browserMcp?.address()?.port ?? null
      if (chosen !== '') {
        await click(win, '[data-settings-wsl-check]')
        await pollJs(win, `document.querySelector('[data-settings-wsl-reachable]')`, 60_000)
        probeAttribute = await attr(
          win,
          '[data-settings-wsl-reachable]',
          'data-settings-wsl-reachable'
        )
        // The driver's own connect, from inside the distribution, with no part
        // of Helm in it. `/dev/tcp` is a bash builtin, which is what the app's
        // own probe uses and all a minimal distro is guaranteed to have.
        try {
          if (endpointPort === null) throw new Error('the tools are off; no endpoint to reach')
          const answer = execFileSync(
            'wsl.exe',
            [
              '-d',
              chosen,
              '--',
              'bash',
              '-lc',
              `timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${String(endpointPort ?? 0)}' 2>/dev/null && echo yes || echo no`
            ],
            { encoding: 'utf8', timeout: 60_000, windowsHide: true }
          )
          driverSawReachable = answer.trim().endsWith('yes')
        } catch {
          driverSawReachable = null
        }
      }

      // The restart, opened and cancelled. Its accepting half is deliberately
      // not pressed - see the note.
      const restartOffered = await exists(win, '[data-settings-wsl-restart]')
      await click(win, '[data-settings-wsl-restart]')
      const dialogUp = await pollJs(win, `document.querySelector('[data-wsl-shutdown-dialog]')`, 5000)
      const dialogText = (await text(win, '[data-wsl-shutdown-dialog]')).toLowerCase()
      const namesTheCost =
        dialogText.includes('every') && (dialogText.includes('wsl') || dialogText.includes('distr'))
      const namesClaude = dialogText.includes('claude')
      await click(win, '[data-wsl-shutdown-cancel]')
      const dialogGone = await pollJs(
        win,
        `document.querySelector('[data-wsl-shutdown-dialog]') === null`,
        5000
      )
      const noticeAfterCancel = (await text(win, '[data-settings-wsl-notice]')).trim()

      checks.push({
        id: 'S-26',
        criterion:
          'What the file says and whether a distribution can reach Helm are two facts, never one',
        title:
          'A file reading mirrored paints no reachability verdict until Check is pressed, and Restart WSL only ever asks first',
        ok:
          mirroredState === 'mirrored' &&
          !verdictBeforeAsking &&
          restartOffered &&
          dialogUp &&
          namesTheCost &&
          namesClaude &&
          dialogGone &&
          noticeAfterCancel === '' &&
          (chosen === '' ||
            (probeAttribute !== null &&
              (driverSawReachable === null ||
                probeAttribute === String(driverSawReachable)))),
        detail: {
          fileSays: onDisk(),
          paneState: mirroredState,
          reachabilityVerdictBeforeAsking: verdictBeforeAsking,
          distrosOffered,
          probe: {
            distro: chosen,
            paneAttribute: probeAttribute,
            driversOwnConnect: driverSawReachable,
            port: endpointPort
          },
          restart: {
            offered: restartOffered,
            dialogAppeared: dialogUp,
            dialogText,
            namesEveryWslProcess: namesTheCost,
            namesClaudeSessions: namesClaude,
            dismissedByCancel: dialogGone,
            noticeAfterCancel
          }
        },
        notes: [
          'The divergence is the point. On this machine the fixture file now',
          'reads mirrored while WSL has not restarted, so "the file is right"',
          'and "the distro cannot connect" are both true at once - which is',
          'exactly the state a single merged verdict would hide, and the reason',
          'the pane has two rows instead of one.',
          'No reachability verdict may be on screen before Check is pressed.',
          'Painting one at mount would mean the pane had booted every',
          'distribution on the machine to draw itself.',
          'The probe answer is compared against a connect this driver makes',
          'itself, through `wsl.exe`, to the port the running app is actually',
          'listening on - not against what Helm says it found. A distro that',
          'cannot be reached to ask records null rather than passing.',
          'The dialog is required to name what it ends - every WSL process, and',
          'Claude Code sessions running in one - because that is the cost the',
          'user is being asked to accept and nothing in Helm can see its extent.',
          'Its accepting half is NOT pressed, and this is the same standing',
          'exception PKG-2 is: `wsl --shutdown` would end every WSL process on',
          'this machine, including any Claude Code session in a distribution and',
          'possibly the one reading this. Cancel is driven, the notice is',
          'required to still be empty, and the confirmed path is unrun.'
        ]
      })
    } finally {
      // Back before anything else can ask for a home. A restore in `finally`
      // rather than at the end of the block: a throw half way through would
      // otherwise leave the rest of the process reading a fixture profile.
      if (realProfile === undefined) delete process.env['USERPROFILE']
      else process.env['USERPROFILE'] = realProfile
    }
  }

  // -------------------------------------------------------------------------
  // What the restart phase will look for
  // -------------------------------------------------------------------------
  const parked: Partial<AppSettings> = {
    // None of these is the default, so reading them back after a restart is
    // evidence rather than a coincidence: `system`, `percent` and `null` are
    // what a database with no row at all reports.
    theme: 'light',
    usageDisplay: 'off',
    ...(claudeForPark !== null ? { claudePath: claudeForPark } : {}),
    // Root A added through the pane and root B removed through it: one array
    // carrying both halves of the criterion across the restart. Root A appears
    // exactly once - `original` has had this driver's own paths scrubbed out.
    scanRoots: [...original.scanRoots, fixtures.rootA],
    // A pin on a path that is not a project and never was. Parked for the same
    // reason `prIgnoredRepos` is - it is the other array setting, and an array
    // JSON round-tripping through one `app_settings` row is the half worth
    // restarting for - and under the fixture directory so `original`'s scrub
    // takes it out again if this run never reaches its restore.
    pinnedProjects: [join(fixtures.dir, 'parked-project')],
    // All six terminal settings, every one of them off its default for the same
    // reason. `terminalShell` is parked on a real program rather than a
    // fixture: a restore that somehow does not happen must leave the app able
    // to open a shell.
    terminalFontFamily: 'Consolas',
    terminalFontSize: 15,
    terminalCursorStyle: 'bar',
    terminalCursorBlink: false,
    terminalScrollback: 12345,
    terminalShell: whereIs('cmd.exe')[0] ?? original.terminalShell,
    // Off the default in the one direction that is unambiguous: the ceiling.
    // A shell at half the page is a state no default and no fresh database
    // produces, so finding it after a restart is evidence.
    projectShellHeightPct: SHELL_HEIGHT_BOUNDS.max,
    // The other pane proportion, parked at its ceiling for the same reason and
    // deliberately not at a round number a default could plausibly become.
    sessionSplitPct: SPLIT_BOUNDS.max,
    // The real gh rather than the fixture, for the reason `claudePath` uses the
    // real claude: a restore that somehow does not happen must leave the app
    // pointed at a working program, not at a stub that refuses to sign in.
    ...(whereIs('gh.exe')[0] !== undefined ? { ghPath: whereIs('gh.exe')[0] } : {}),
    prPollMinutes: 30,
    // Off the default in the direction that is unambiguous. A week is a cutoff
    // nobody's default produces, and unlike 0 it leaves the split switched on -
    // so what the restart phase finds is a real value rather than an absence.
    prStaleDays: 7,
    // A repository nobody has, on purpose. The setting is a list rather than a
    // scalar and JSON round-tripping an array through one `app_settings` row is
    // the half of it worth restarting for; naming a repository that exists
    // would also stop this run fetching it.
    prIgnoredRepos: ['helm-parked/never-fetched'],
    // Both off their defaults, like everything else here. The template is one
    // no default could produce and the checkout mode is the non-default half of
    // a two-value enum, which is the strongest either can be parked on.
    prReviewPrompt: '/security-review {number} in {slug}',
    prCheckout: 'checkout',
    // The archive's ceiling, parked well *above* its default rather than below
    // it. Below would evict from this run's database on the way past, which is
    // a copy of the user's and holds their real archive - and a restart check
    // has no business destroying the thing it is checking the setting for.
    transcriptArchiveMaxBytes: 4 * 1024 ** 3
  }

  const applied = await sendWrite(win, parked as Record<string, unknown>)
  await sleep(600)
  if (!applied.accepted) {
    checks.push({
      id: 'S-8',
      criterion: 'The pane writes settings that persist',
      title: 'The run could not park the settings the restart phase reads',
      ok: false,
      detail: { parked, error: applied.error },
      notes: ['Without a parked value there is nothing for the second phase to find.']
    })
  }

  writeFileSync(
    join(dataDir, 'settings-parked.json'),
    JSON.stringify({ parked, dbFile, at: new Date().toISOString() }, null, 2)
  )

  const finalRows = allRows(dbFile)
  checks.push({
    id: 'S-8',
    criterion: 'Every visible setting round-trips to the database',
    title: 'Every setting the restart phase reads is in the file before the app is closed',
    ok:
      applied.accepted &&
      Object.entries(parked).every(
        ([key, value]) => JSON.stringify(finalRows[key]) === JSON.stringify(value)
      ),
    detail: { parked, rowsInFile: finalRows, dbFile, originalSettings: original },
    notes: [
      'Read from the database file through a second connection, not from the',
      'app - a value in the app is not yet a value a restart will find.',
      'Whether it survives the restart is decided by phase two in',
      'scripts/run-settings.mjs, which starts the app again and reports what it',
      'read. This process cannot assert that about itself.',
      'The parked CLI path is the real one on this machine rather than the stub:',
      'the run script restores the originals afterwards, and a restore that',
      'somehow does not happen must not leave the app pointed at a fake.'
    ]
  })

  win.setTitleBarOverlay = realSetOverlay
  return { checks, parked }
}

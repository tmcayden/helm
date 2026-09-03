import { type BrowserWindow } from 'electron'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  claudeHome,
  directoryExists,
  historyFileIn,
  indexHistory,
  projectsDirIn,
  readHistorySession,
  readHistorySessions,
  readHistoryTail,
  resolveRecordedPath,
  scanTranscripts,
  type HistorySession,
  type TranscriptFile,
  type WslHome
} from '@helm/core'
import { screenshot, sendKey, sleep, squash, stripAnsi, typeText, waitFor } from './bridge'
import { resolveClaudeCommand } from './claude-cli'
import type { Check } from './fidelity'
import { answerStartupGates, atPrompt, processAlive, type Collector, type CheckContext } from './sessionscheck'
import { killSession, spawnSession } from './pty'
import { wslHomes } from './wsl'

/**
 * The session-history criteria, driven through the app the way a user reaches
 * them.
 *
 * The discipline that matters here is that nothing is asserted against Helm's
 * own index alone. Every count is checked against a second, independent read of
 * `~/.claude/history.jsonl` and `~/.claude/projects/` done by this file - a
 * parser agreeing with itself proves nothing about whether it read the file
 * correctly.
 *
 * `pnpm history-check` -> helm-data/history-report.json
 */

const SEARCH_BUDGET_MS = 100

// ---------------------------------------------------------------------------
// A second opinion about what is on disk
// ---------------------------------------------------------------------------

interface Truth {
  historyFile: string
  prompts: Array<{ sessionId: string; project: string; display: string; timestamp: number }>
  /** Session id -> the project it recorded, in first-seen order. */
  sessions: Map<string, string>
  /** Distinct working directories, case-folded the way the launcher groups them. */
  projects: Set<string>
  /** Session ids with a transcript still on disk, by a separate directory walk. */
  transcripts: Map<string, number>
}

/**
 * Reads the same sources the index does, with none of its code.
 *
 * Deliberately naive - `readFileSync`, `split`, `JSON.parse` - because the
 * point is to disagree with the incremental reader if the incremental reader is
 * wrong.
 *
 * **Every** home, not just this machine's. A WSL distribution keeps a
 * `~/.claude` of its own and the index reads both; an oracle that read one file
 * would fail HIST-0 on any machine with WSL installed, and would be failing it
 * for being out of date rather than for finding anything. On the machine this
 * was written against the two differ by two orders of magnitude - 24 prompts
 * here, 3,539 in the distro - so this is not a rounding difference.
 *
 * The *list* of homes comes from `wslHomes`, which is the app's own discovery,
 * and that is deliberate rather than a lapse: HIST-0 asks whether the
 * incremental reader agrees with a naive read **of the same files**. Which
 * files those are is a different question, and re-deriving it here would test
 * `wsl.exe --list` parsing twice and the thing under test not at all.
 */
function readTruth(homes: readonly string[]): Truth {
  const historyFile = historyFileIn(homes[0] ?? claudeHome())
  const prompts: Truth['prompts'] = []
  const sessions = new Map<string, string>()
  const projects = new Set<string>()
  const transcripts = new Map<string, number>()

  for (const home of homes) {
    let text: string
    try {
      text = readFileSync(historyFileIn(home), 'utf8')
    } catch {
      // A home with no history file yet contributes nothing, which is a true
      // answer about it rather than a reason to stop.
      text = ''
    }

    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const row = parsed as Record<string, unknown>
      if (typeof row['sessionId'] !== 'string' || typeof row['project'] !== 'string') continue
      const sessionId = row['sessionId']
      const project = row['project']
      prompts.push({
        sessionId,
        project,
        display: typeof row['display'] === 'string' ? row['display'] : '',
        timestamp: typeof row['timestamp'] === 'number' ? row['timestamp'] : 0
      })
      if (!sessions.has(sessionId)) sessions.set(sessionId, project)
      projects.add(project.toLowerCase())
    }

    const projectsDir = projectsDirIn(home)
    let dirs: string[]
    try {
      dirs = readdirSync(projectsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      dirs = []
    }
    for (const dir of dirs) {
      for (const name of readdirSync(join(projectsDir, dir))) {
        if (!/^[0-9a-f-]{36}\.jsonl$/i.test(name)) continue
        const id = name.slice(0, -6).toLowerCase()
        const size = statSync(join(projectsDir, dir, name)).size
        if ((transcripts.get(id) ?? -1) < size) transcripts.set(id, size)
      }
    }
  }

  return { historyFile, prompts, sessions, projects, transcripts }
}

/**
 * Sessions the file knows about that could actually be reopened right now.
 *
 * The `stat` goes through `resolveRecordedPath` for the reason the index's does:
 * a distro's CLI records `/home/me/harness`, and `statSync` on Windows resolves
 * that leading slash against the current drive root and reports it absent. An
 * oracle that skipped the translation would insist every distro conversation is
 * unresumable, and HIST-0 would be enforcing the bug.
 */
function trulyResumable(truth: Truth, distros: readonly WslHome[]): Set<string> {
  const there = (path: string): boolean => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }
  const out = new Set<string>()
  for (const [id, project] of truth.sessions) {
    if (!truth.transcripts.has(id.toLowerCase())) continue
    const resolved = resolveRecordedPath(project, distros, there)
    // The folder being gone means `--resume` has nowhere to resolve the id.
    if (resolved !== null && there(resolved)) out.add(id)
  }
  return out
}

// ---------------------------------------------------------------------------
// Talking to the renderer
// ---------------------------------------------------------------------------

/**
 * Electron reports a renderer-side throw as "Script failed to execute" with no
 * indication of which script, which is unhelpful in a file with a dozen of
 * them. The expression goes into the message.
 */
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

/** What the list is currently showing, read off the rendered rows. */
interface PaintedRow {
  sessionId: string
  resumable: boolean
  /** The row's title, read from its own element rather than sliced out of `text`. */
  title: string
  /** Whether a name was given by hand, as the row itself reports it. */
  named: boolean
  /** Whole row text, whitespace collapsed - project, age, prompt count, badge. */
  text: string
  /**
   * The meta line's fields, one per element.
   *
   * Read separately rather than sliced out of `text`, because `textContent`
   * concatenates adjacent elements with no separator - a row rendering
   * "<project> 25m 11 prompts" with flex gaps reads back as
   * "<project>25m11 prompts". Asserting on the fields is also the stronger
   * claim: that the row *has* a project and an age, not that its text happens
   * to contain something shaped like one.
   */
  fields: string[]
}

async function paintedRows(win: BrowserWindow): Promise<PaintedRow[]> {
  return js<PaintedRow[]>(
    win,
    `[...document.querySelectorAll('button[data-session]')].map((el) => ({
      sessionId: el.dataset.session,
      resumable: el.dataset.resumable === 'true',
      title: (el.querySelector('[data-session-title]')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      named: el.dataset.named === 'true',
      text: (el.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      fields: [...(el.lastElementChild?.children ?? [])]
        .map((child) => (child.textContent ?? '').replace(/\\s+/g, ' ').trim())
        .filter((value) => value !== '')
    }))`
  )
}

async function groupHeaders(win: BrowserWindow): Promise<string[]> {
  return js<string[]>(
    win,
    `[...document.querySelectorAll('[aria-label="Sessions"] > button:not([data-session])')]
      .map((el) => (el.textContent ?? '').trim())`
  )
}

/**
 * Brings the history pane back to the front and waits for it to paint.
 *
 * Needed between groups because the pane is only mounted while its tab is
 * active - resuming a session puts a terminal in front of it, and the next
 * group would otherwise be driving a surface that is not on screen.
 */
async function showHistory(win: BrowserWindow): Promise<boolean> {
  if (!(await click(win, '[data-tab="history"]'))) {
    await click(win, 'aside button[data-open-history]')
  }
  return pollJs(win, `document.querySelector('input[data-history-search]')`, 10_000)
}

/** The close button beside a session's tab, which is how a user ends one. */
async function closeSessionTab(win: BrowserWindow, id: number): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const tab = document.querySelector('[data-tab="session:${String(id)}"]');
      const el = tab?.parentElement?.querySelector('button[aria-label^="Close"]');
      if (!el) return false; el.click(); return true })()`
  )
}

/**
 * Replaces the search box's contents with real keystrokes.
 *
 * The term is reduced to printable ASCII first. `sendInputEvent` takes a
 * keyCode, and a prompt copied out of `history.jsonl` can contain a newline or
 * a character that is not one - the point of typing rather than assigning is
 * that the input's own handler runs, which it does just as well for a subset of
 * the text.
 */
async function typeSearch(win: BrowserWindow, term: string): Promise<string> {
  const typeable = term.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim()
  let clicked = await click(win, 'input[data-history-search]')
  if (!clicked) {
    /*
     * The list is not on screen, which in the **compact** layout is a state and
     * not a fault: `showList` is `!compact || selected === null`, and `compact`
     * is true for as long as a session is running - which this driver
     * guarantees, because it starts two. So from the moment a row is selected,
     * the detail replaces the list and takes the search box with it.
     *
     * The way back is the affordance a user has, so it is the one driven here:
     * `PaneBack`'s button, which clears the selection. Pressed once and the
     * click retried - a second failure is a real absence and still throws.
     */
    await click(win, '[data-pane-back]')
    await pollJs(win, `document.querySelector('input[data-history-search]')`, 5000)
    clicked = await click(win, 'input[data-history-search]')
  }
  if (!clicked) throw new Error('the search box is not on screen')
  await js<boolean>(
    win,
    `(() => { const el = document.querySelector('input[data-history-search]');
      el.focus(); el.select(); return true })()`
  )
  await sendKey(win, 'Backspace')
  if (typeable !== '') await typeText(win, typeable, 8)

  /*
   * Wait for the painted list to be the answer to the text now in the box.
   *
   * Clearing the box and typing are two edits, so two queries are in flight and
   * the pane shows the whole index until the second lands. This was a flat
   * 450 ms sleep, which is a guess, and the guess lost often enough to matter:
   * the reader arrived early and counted all 886 sessions as the answer to a
   * search for `geofenc`, then reported the pane as broken.
   *
   * Waiting for the count to *stop changing* does not fix it either, and that
   * is the part worth remembering - the count is unchanging on both sides of
   * the update, so stability cannot tell "not yet" from "final". The signal has
   * to be positive, so the DOM is compared against what the query for that
   * exact text returns. What the answer should *be* is still settled against
   * `history.jsonl` by the caller; this only decides when to look.
   *
   * The comparison is over the **session ids**, and it used to be over the row
   * count. That was the same mistake one level down: two different searches
   * returning the same number of rows agree on the count while showing entirely
   * different sessions, and this machine has a term matching four sessions and
   * a project matching four others. The check reported the pane as returning
   * the wrong rows for a search it had not run yet. Ids, in order, cannot do
   * that.
   */
  for (let attempt = 0; attempt < 30; attempt++) {
    const agreed = await js<boolean>(
      win,
      `(async () => {
        const box = document.querySelector('input[data-history-search]');
        // The scope the pane is actually on, not an assumption about it: this
        // comparison decides *when* to look, and asking the wrong question
        // would answer "not yet" for ever.
        const on = document.querySelector('[data-history-scope][aria-pressed="true"]');
        const page = await window.helm.invoke('history:sessions', {
          search: box.value,
          scope: on ? on.dataset.historyScope : 'prompts'
        });
        const painted = [...document.querySelectorAll('button[data-session]')]
          .map((el) => el.dataset.session);
        return page.sessions.length === painted.length &&
          page.sessions.every((s, i) => s.sessionId === painted[i]);
      })()`
    ).catch(() => false)
    if (agreed) return typeable
    await sleep(50)
  }
  // Fell through: let the caller's assertion fail on the numbers rather than
  // hang here. Other filters being on is the honest reason this can happen.
  return typeable
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * Groups a run can be narrowed to with `--only=`.
 *
 * `resume` and `outside` each spawn a real `claude` and account for most of
 * the wall clock, so being able to re-run the pane checks without them is the
 * difference between a ten-second loop and a five-minute one.
 */
const GROUPS = ['list', 'search', 'resume', 'reaped', 'titles', 'outside'] as const
type Group = (typeof GROUPS)[number]

export async function runHistoryChecks(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string,
  only?: readonly string[]
): Promise<Check[]> {
  const wanted = new Set<string>(only && only.length > 0 ? only : GROUPS)
  const running = (group: Group): boolean => wanted.has(group)

  const checks: Check[] = []
  const { win, services } = ctx
  // The same homes the app indexes, found the same way it finds them - see
  // `readTruth` for why that sharing is the right boundary here.
  const distros = await wslHomes()
  const truth = readTruth([claudeHome(), ...distros.map((home) => home.claudeHome)])
  const resumableTruth = trulyResumable(truth, distros)

  // -------------------------------------------------------------------------
  // HIST-0: the index agrees with the file
  // -------------------------------------------------------------------------
  const built = await waitFor(() => ctx.history.summary().sessions > 0, 60_000)
  const summary = ctx.history.refresh()

  const indexAgrees =
    built &&
    summary.sessions === truth.sessions.size &&
    summary.prompts === truth.prompts.length &&
    summary.projects === truth.projects.size &&
    summary.resumable === resumableTruth.size

  checks.push({
    id: 'HIST-0',
    criterion: 'setup',
    title: 'The index matches an independent read of history.jsonl and projects/',
    ok: indexAgrees,
    detail: {
      index: {
        sessions: summary.sessions,
        prompts: summary.prompts,
        projects: summary.projects,
        resumable: summary.resumable,
        indexedBytes: summary.indexedBytes
      },
      file: {
        path: truth.historyFile,
        sessions: truth.sessions.size,
        prompts: truth.prompts.length,
        projects: truth.projects.size,
        transcriptsOnDisk: truth.transcripts.size,
        resumable: resumableTruth.size
      }
    },
    notes: [
      'The second read is a plain readFileSync + JSON.parse in historycheck.ts, sharing no',
      'code with the incremental reader it is checking.'
    ]
  })

  if (!indexAgrees) {
    checks.push({
      // audit: optional - only reached when HIST-0 has already failed, so a
      // healthy run never produces it and its absence is not a short report.
      id: 'HIST-SKIP',
      criterion: 'setup',
      title: 'Nothing else can be trusted while the index disagrees with the file',
      ok: false,
      detail: {},
      notes: []
    })
    return checks
  }

  // -------------------------------------------------------------------------
  // HIST-1: every session visible, grouped, with project and age
  // -------------------------------------------------------------------------
  const opened = await click(win, 'aside button[data-open-history]')
  const painted = await pollJs(
    win,
    `document.querySelectorAll('button[data-session]').length > 0`,
    20_000
  )
  await sleep(600)

  const rows = await paintedRows(win)
  // A row has to carry the two things the criterion names, each as its own
  // field: an age the formatter produced, and the project the file recorded
  // for that exact session.
  const AGE = /^(now|\d+[mhdwy])$/
  const projectOf = new Map(
    [...truth.sessions].map(([id, project]) => [id, basename(project).toLowerCase()])
  )
  const rowsWithAge = rows.filter((row) => row.fields.some((f) => AGE.test(f))).length
  const rowsWithProject = rows.filter((row) => {
    const expected = projectOf.get(row.sessionId)
    return expected !== undefined && row.fields.some((f) => f.toLowerCase() === expected)
  }).length

  const shotRecent = await screenshot(win, shotDir, 'history-recent.png')

  if (running('list')) checks.push({
    id: 'HIST-1',
    criterion: 'All sessions from history.jsonl visible, grouped and searchable, with project and age',
    title: 'The pane lists every session in the file, each with its project and its age',
    ok:
      opened &&
      painted &&
      rows.length === truth.sessions.size &&
      rowsWithAge === rows.length &&
      rowsWithProject === rows.length,
    detail: {
      painted: rows.length,
      inFile: truth.sessions.size,
      rowsWithAge,
      rowsWithProject,
      sample: rows.slice(0, 4),
      screenshot: shotRecent.file
    },
    notes: [
      '`/resume` can only ever show the sessions of the directory it was started in;',
      `this is ${String(truth.projects.size)} directories at once.`
    ]
  })

  // -------------------------------------------------------------------------
  // HIST-8: the list off screen costs nothing, and says its true length
  // -------------------------------------------------------------------------
  // Two claims: that a resize is cheap, and that the scrollbar is honest.
  //
  // The cost one is measured **against itself**, with the rule turned off and
  // on again in the same window on the same list in the same second, and the
  // assertion is the ratio. An absolute millisecond bound would be a claim
  // about the machine the check is running on rather than about the app, and a
  // probe that goes red on a slow afternoon is a probe people learn to skip -
  // which costs more than never having written it. A ratio is the same number on
  // a fast machine and a slow one.
  //
  // The first draft of this probe asserted the *mechanism* - that rows below
  // the fold have unrendered subtrees - and it failed, correctly, because that
  // is not what is happening. `content-visibility: auto` also applies
  // `contain: layout style paint` unconditionally, and on Chromium 150 that
  // containment is the whole of the win: 0 of 965 rows were ever observed
  // skipped, scrolled to the bottom and back. The lesson is in the assertion
  // now - measure what the user complained about, which was a stutter, not the
  // implementation detail that was supposed to fix it.
  //
  // The second claim has a bug already behind it. `contain-intrinsic-size`
  // describes a **content box**, and writing the height a ruler reports gives a
  // skipped row its own padding twice: 47px instead of 35px turned a 45,718px
  // list into a 56,824px one. Every row still correct, the search still
  // working, and a scrollbar describing a list that does not exist. Nothing
  // else in this file would ever have caught it.
  const layout = await js<{
    rows: number
    withRule: number
    msWithRule: number
    msWithoutRule: number
    msRestored: number
    speedup: number
    scrollHeight: number
    rowHeight: number
    predicted: number
    errorPct: number
  }>(
    win,
    `(() => {
      const list = document.querySelector('[role=group][aria-label=Sessions]')
      const rows = [...list.querySelectorAll('button[data-session]')]
      // One resize tick's worth of work: change the width the rows lay out
      // against, then force the layout the next frame would have done anyway.
      const once = (w) => {
        const t = performance.now()
        list.style.width = w
        void list.offsetHeight
        return performance.now() - t
      }
      // Median of seven, alternating widths so no run can be answered from the
      // last one's cached layout. Median rather than mean: one GC pause in the
      // middle of a sample should not decide a check.
      const sample = () => {
        const runs = []
        for (let i = 0; i < 7; i++) runs.push(once(i % 2 ? '99.5%' : '99%'))
        list.style.width = ''
        void list.offsetHeight
        runs.sort((a, b) => a - b)
        return runs[3]
      }
      const withRule = sample()
      const off = document.createElement('style')
      off.textContent =
        '.session-row { content-visibility: visible !important; contain: none !important; }'
      document.head.appendChild(off)
      void list.offsetHeight
      const withoutRule = sample()
      off.remove()
      void list.offsetHeight
      const restored = sample()

      const rowHeight = rows.length ? rows[0].getBoundingClientRect().height : 0
      const predicted = rowHeight * rows.length
      return {
        rows: rows.length,
        withRule: rows.filter((r) => getComputedStyle(r).contentVisibility === 'auto').length,
        msWithRule: withRule,
        msWithoutRule: withoutRule,
        msRestored: restored,
        speedup: withRule === 0 ? 0 : withoutRule / withRule,
        scrollHeight: list.scrollHeight,
        rowHeight,
        predicted,
        errorPct: predicted === 0 ? 0 : ((list.scrollHeight - predicted) / predicted) * 100
      }
    })()`
  )

  // 3x against a measured 8.4-9.2x. Far enough below to survive a noisy
  // machine, far enough above 1x that losing the rule is caught.
  const cheapToResize = layout.speedup >= 3
  // Turning it back on has to restore the win, which is what says the
  // measurement was of the rule rather than of warm-up.
  const restoredWin = layout.msRestored <= layout.msWithRule * 2
  // 2% of a list this long is a row and a half - tight enough to catch the
  // padding mistake (24%) and loose enough to survive the half pixel a row
  // differs by depending on where it lands on the device grid.
  const scrollbarHonest = Math.abs(layout.errorPct) < 2

  if (running('list')) checks.push({
    id: 'HIST-8',
    criterion: 'All sessions from history.jsonl visible, grouped and searchable, with project and age',
    title: 'A resize does not pay for every row in the history, and the scrollbar still describes the whole list',
    ok:
      layout.rows > 0 &&
      layout.withRule === layout.rows &&
      cheapToResize &&
      restoredWin &&
      scrollbarHonest,
    detail: {
      rows: layout.rows,
      rowsCarryingTheRule: layout.withRule,
      relayoutMs: {
        withRule: Number(layout.msWithRule.toFixed(2)),
        withoutRule: Number(layout.msWithoutRule.toFixed(2)),
        restored: Number(layout.msRestored.toFixed(2))
      },
      speedup: Number(layout.speedup.toFixed(1)),
      scrollHeight: layout.scrollHeight,
      rowHeight: layout.rowHeight,
      predicted: Math.round(layout.predicted),
      errorPct: Number(layout.errorPct.toFixed(2))
    },
    notes: [
      'The rule is turned off and back on inside one measurement, so the two',
      'numbers come from the same window, the same list and the same second.',
      'That is what makes a ratio meaningful where a millisecond would not be.',
      'Restoring it has to restore the win as well, which is what separates',
      'the rule from a warm cache.',
      'The scrollbar assertion is here because nothing else would catch it -',
      'every row can be correct while the bar describes a different list.'
    ]
  })

  // -------------------------------------------------------------------------
  // HIST-2: grouped by project
  // -------------------------------------------------------------------------
  // Named rather than "the first unpressed button": this pane now holds two
  // segmented groups - grouping, and what the search box searches - and the
  // positional selector started clicking the wrong one the moment the second
  // arrived. It reported zero group headers and then a search over the wrong
  // scope, which looked like two unrelated regressions.
  await click(win, '[data-history-grouping="project"]')
  await sleep(500)
  const headers = await groupHeaders(win)
  const groupedRows = await paintedRows(win)
  const shotGrouped = await screenshot(win, shotDir, 'history-by-project.png')

  if (running('list')) checks.push({
    id: 'HIST-2',
    criterion: 'All sessions from history.jsonl visible, grouped and searchable, with project and age',
    title: 'Grouping by project yields one header per recorded working directory',
    ok:
      headers.length === truth.projects.size &&
      groupedRows.length === truth.sessions.size &&
      headers.every((h) => /\d/.test(h)),
    detail: {
      headers: headers.length,
      distinctProjectsInFile: truth.projects.size,
      rowsStillShown: groupedRows.length,
      sample: headers.slice(0, 5),
      screenshot: shotGrouped.file
    },
    notes: [
      'Case-folded on both sides: the same folder is recorded under more than one casing',
      'and two groups for one directory would be a wrong answer, not a cosmetic one.'
    ]
  })

  // Back to the flat list for everything that follows.
  await click(win, '[data-history-grouping="recent"]')
  await sleep(400)

  // -------------------------------------------------------------------------
  // HIST-3: resumable and reaped are told apart
  // -------------------------------------------------------------------------
  const resumableRows = rows.filter((row) => row.resumable)
  const reapedRows = rows.filter((row) => !row.resumable)
  // Four words now, not two. The transcript archive gave the pane a third and a
  // fourth state - `archived` for a conversation Helm kept before Claude Code
  // deleted it, `dropped` for one the storage ceiling later took - and they are
  // sub-kinds of "cannot be reopened" rather than a second vocabulary beside it.
  // `pnpm transcript-check` is what asserts the *right* one is on each row; this
  // one still asserts that every unreopenable row carries one at all.
  const BADGES = /history only|folder gone|archived|dropped/i
  const badged = reapedRows.filter((row) => BADGES.test(row.text)).length
  const wronglyMarked = rows.filter(
    (row) => row.resumable !== resumableTruth.has(row.sessionId)
  ).length

  if (running('list')) checks.push({
    id: 'HIST-3',
    criterion: 'Sessions with surviving transcripts are visually distinct from reaped ones',
    title: 'Every row is marked, correctly, and the mark is a word as well as a shape',
    ok: wronglyMarked === 0 && resumableRows.length === resumableTruth.size && badged === reapedRows.length,
    detail: {
      resumable: resumableRows.length,
      reaped: reapedRows.length,
      resumableOnDisk: resumableTruth.size,
      wronglyMarked,
      reapedRowsCarryingABadge: badged,
      badgeVocabulary: BADGES.source.split('|'),
      retention: `${String(Math.round((resumableTruth.size / truth.sessions.size) * 1000) / 10)}%`
    },
    notes: [
      'The badge matters as much as the dot: a difference only in colour is not a',
      'difference for everyone reading it.',
      'Resumability is still the thing the *dot* answers. What the badge says has grown with',
      'the archive, so the words are listed here rather than left in a regex nobody reads.'
    ]
  })

  // -------------------------------------------------------------------------
  // HIST-4: search, and what it costs
  // -------------------------------------------------------------------------
  const TERMS = ['the', 'schema', 'resume', 'release', 'spec', 'test', 'fix', 'claude']
  const timings: Array<{ term: string; tookMs: number; total: number }> = []
  for (const term of TERMS) {
    for (let run = 0; run < 5; run++) {
      const page = readHistorySessions(services.store, { search: term })
      timings.push({ term, tookMs: page.tookMs, total: page.total })
    }
  }
  const sorted = timings.map((t) => t.tookMs).sort((a, b) => a - b)
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0

  // And the same question through the surface, which is where the criterion
  // actually binds: keystrokes into the box, rows out of the DOM.
  const TYPED = 'geofenc'
  await typeSearch(win, TYPED)
  const searched = await paintedRows(win)
  // The box searches prompts *and* project paths, so the independent count has
  // to do both. Prompt-only was right until it wasn't, and it kept passing on
  // this machine for the uninteresting reason that no directory here is called
  // anything like `geofenc`.
  const matchesTyped = (needle: string) => (p: Truth['prompts'][number]): boolean =>
    p.display.toLowerCase().includes(needle) || p.project.toLowerCase().includes(needle)
  const expectedIds = new Set(truth.prompts.filter(matchesTyped(TYPED)).map((p) => p.sessionId))
  const shotSearch = await screenshot(win, shotDir, 'history-search.png')

  /**
   * A term that appears in a project path and in no prompt, so that the project
   * half of the search is actually exercised rather than merely allowed for.
   *
   * Derived from what this machine has rather than written down - which
   * directories exist here is not this file's business - and null when nothing
   * discriminating turns up, in which case the criterion says so instead of
   * quietly claiming coverage it did not get.
   */
  const projectTerm = (() => {
    for (const project of truth.projects) {
      const segment = project.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase()
      if (segment === undefined || segment.length < 4) continue
      if (truth.prompts.some((p) => p.display.toLowerCase().includes(segment))) continue
      return segment
    }
    return null
  })()

  let projectSearchOk = true
  let projectSearch: Record<string, unknown> = { term: null, note: 'no discriminating term here' }
  if (projectTerm !== null) {
    await typeSearch(win, projectTerm)
    const rows = await paintedRows(win)
    const expected = new Set(truth.prompts.filter(matchesTyped(projectTerm)).map((p) => p.sessionId))
    projectSearchOk =
      expected.size > 0 &&
      rows.length === expected.size &&
      rows.every((row) => expected.has(row.sessionId))
    projectSearch = {
      term: projectTerm,
      painted: rows.length,
      expected: expected.size,
      paintedNotExpected: rows.filter((row) => !expected.has(row.sessionId)).map((r) => r.sessionId),
      expectedNotPainted: [...expected].filter((id) => !rows.some((row) => row.sessionId === id))
    }
    await typeSearch(win, TYPED)
    await sleep(300)
  }

  if (running('search')) checks.push({
    id: 'HIST-4',
    criterion: 'Search over 3k+ prompts returns in <100ms (SQLite FTS or LIKE with index - measure)',
    title: `Substring search over ${String(truth.prompts.length)} prompts, measured`,
    ok:
      truth.prompts.length >= 3000 &&
      p95 < SEARCH_BUDGET_MS &&
      searched.length === expectedIds.size &&
      searched.every((row) => expectedIds.has(row.sessionId)) &&
      projectSearchOk,
    detail: {
      promptsIndexed: truth.prompts.length,
      projectSearch,
      budgetMs: SEARCH_BUDGET_MS,
      p95Ms: Math.round(p95 * 1000) / 1000,
      slowestMs: Math.round((sorted.at(-1) ?? 0) * 1000) / 1000,
      perTerm: TERMS.map((term) => {
        const runs = timings.filter((t) => t.term === term)
        return {
          term,
          matches: runs[0]?.total ?? 0,
          medianMs: Math.round((runs[Math.floor(runs.length / 2)]?.tookMs ?? 0) * 1000) / 1000
        }
      }),
      throughTheUi: {
        typed: TYPED,
        rows: searched.length,
        expected: expectedIds.size,
        // The ids, not only the counts. Two sets of four that do not overlap
        // report as "4 and 4" and fail on the `every` below, which is a
        // failure with nothing in the report to explain it.
        paintedNotExpected: searched
          .filter((row) => !expectedIds.has(row.sessionId))
          .map((row) => row.sessionId),
        expectedNotPainted: [...expectedIds].filter(
          (id) => !searched.some((row) => row.sessionId === id)
        )
      },
      screenshot: shotSearch.file
    },
    notes: [
      'LIKE, not FTS5. A filter box has to match `geofenc` inside `geofencing` and',
      '`--resume` as itself; a tokenising index matches whole words and would find',
      'neither. The cost is a table scan, which is what the number above is.'
    ]
  })

  // -------------------------------------------------------------------------
  // HIST-5: resuming a session that still has a transcript
  // -------------------------------------------------------------------------
  //
  // The smallest surviving transcript with a short opening prompt: small so the
  // TUI finishes replaying it quickly, short so the prompt is not elided when
  // it is redrawn - and the redrawn prompt is the evidence that the
  // conversation came back rather than a new one starting.
  const candidates = readHistorySessions(services.store, { resumableOnly: true })
    .sessions.filter((s) => s.firstPrompt.trim().length >= 12 && s.firstPrompt.length <= 120)
    .sort((a, b) => (a.transcriptBytes ?? 0) - (b.transcriptBytes ?? 0))

  let resumed: {
    target: HistorySession
    id: number
    argv: string[]
    cwd: string
    pid: number | null
    restored: boolean
    notFound: boolean
    reachedPrompt: boolean
    needle: string
  } | null = null

  for (const target of running('resume') ? candidates.slice(0, 2) : []) {
    await showHistory(win)
    await typeSearch(win, target.firstPrompt.slice(0, 24))
    const clickedRow = await click(win, `button[data-session="${target.sessionId}"]`)
    await sleep(400)

    /*
     * The session this iteration starts, identified by **id** rather than by
     * being last in the list - and the ids are taken before the click that
     * creates one.
     *
     * `before` is captured once, outside the loop, so on the second candidate
     * `list().length > before` is already true from the first one's session and
     * the wait returns instantly - handing back `at(-1)`, which is the *first*
     * attempt's session. The report then describes one session under another
     * one's target: on 2026-09-03 HIST-5 said it had resumed a `C:\.harness\gse`
     * conversation and printed an argv resuming a different id inside Ubuntu,
     * which reads exactly like a resume aimed at the wrong session and was not.
     */
    const idsBefore = new Set(ctx.sessions.list().map((session) => session.id))
    const clickedResume = await click(win, `button[data-resume="${target.sessionId}"]`)
    if (!clickedRow || !clickedResume) continue

    const started = await waitFor(
      () => ctx.sessions.list().some((session) => !idsBefore.has(session.id)),
      20_000
    )
    if (!started) continue
    const record = ctx.sessions.list().find((session) => !idsBefore.has(session.id))
    if (!record) continue

    const stopGates = answerStartupGates(ctx, collector, [record.id])
    // The needle is the opening prompt as the TUI would redraw it, with the
    // whitespace taken out - a replayed prompt is wrapped to the pane width,
    // which puts line breaks inside it.
    const needle = squash(target.firstPrompt).slice(0, 24)
    const restored = await waitFor(() => squash(collector.output(record.id)).includes(needle), 60_000)
    stopGates()
    await sleep(1500)

    const text = stripAnsi(collector.output(record.id))
    resumed = {
      target,
      id: record.id,
      argv: record.argv,
      cwd: record.cwd,
      pid: ctx.sessions.pid(record.id),
      restored,
      notFound: /No conversation found/i.test(text),
      reachedPrompt: atPrompt(text),
      needle
    }
    if (restored) break
  }

  const shotResumed = await screenshot(win, shotDir, 'history-resumed.png')

  if (running('resume')) checks.push({
    id: 'HIST-5',
    criterion: 'Clicking a resumable session opens a tab with that conversation restored in the real TUI',
    title: 'A resumed session runs `claude --resume` in its own project and redraws the conversation',
    ok:
      resumed !== null &&
      resumed.argv.includes('--resume') &&
      resumed.argv.includes(resumed.target.sessionId) &&
      resumed.cwd.toLowerCase() === resumed.target.project.toLowerCase() &&
      resumed.pid !== null &&
      processAlive(resumed.pid) &&
      !resumed.notFound &&
      resumed.restored,
    detail: {
      candidates: candidates.length,
      chosen: resumed && {
        sessionId: resumed.target.sessionId,
        project: resumed.target.project,
        transcriptBytes: resumed.target.transcriptBytes,
        prompts: resumed.target.promptCount,
        openingPrompt: resumed.target.firstPrompt
      },
      session: resumed && {
        id: resumed.id,
        argv: resumed.argv,
        cwd: resumed.cwd,
        pid: resumed.pid,
        alive: resumed.pid !== null && processAlive(resumed.pid)
      },
      evidence: resumed && {
        needle: resumed.needle,
        conversationRedrawn: resumed.restored,
        sawNoConversationFound: resumed.notFound,
        reachedPrompt: resumed.reachedPrompt
      },
      screenshot: shotResumed.file
    },
    notes: [
      'No `-n` on the argv: resuming continues a session that already has a name, and',
      'passing one would rename it as a side effect of Helm opening it.',
      'The cwd assertion is the load-bearing one - `--resume` resolves the id against',
      'the working directory, and from anywhere else it finds nothing.'
    ]
  })

  if (resumed) {
    // Through the tab's own close button, not the session host directly: main
    // ending a process does not remove the renderer's tab, and the pane behind
    // it is what the next group needs on screen.
    await closeSessionTab(win, resumed.id)
    await waitFor(() => !ctx.sessions.list().some((s) => s.id === resumed?.id), 15_000)
    await sleep(800)
  }
  await showHistory(win)

  // -------------------------------------------------------------------------
  // HIST-6: a reaped session explains itself
  // -------------------------------------------------------------------------
  /*
   * A session whose *transcript* is gone and whose folder is still there.
   *
   * `projectExists` is the half this used to leave out, and the row it picked
   * on 2026-09-03 is why it matters: the first no-transcript session in the
   * index was one whose working directory had also gone - a deleted worktree
   * inside a WSL distribution - so the pane quite correctly explained the
   * *folder*, and this probe compared that against wording about a transcript.
   * Two honest states, and only one of them is what HIST-6 is about.
   *
   * It changed because the index widened: with a distribution's history read
   * alongside this machine's, the first such row is no longer the same row. The
   * probe was always this fragile; the new data is what showed it.
   */
  const reapedTarget = readHistorySessions(services.store)
    .sessions.filter((s) => s.transcriptFile === null && s.promptCount >= 2 && s.projectExists)
    .at(0)

  let reapedView: {
    hasResumeButton: boolean
    explanation: string
    promptsShown: number
    spawned: number
  } | null = null
  let refusal: string | null = null

  if (reapedTarget && running('reaped')) {
    await showHistory(win)
    const sessionsBefore = ctx.sessions.list().length
    await typeSearch(win, reapedTarget.firstPrompt.slice(0, 24) || 'e')
    await click(win, `button[data-session="${reapedTarget.sessionId}"]`)
    await pollJs(win, `document.querySelector('[data-unavailable]')`, 8000)
    await sleep(600)

    reapedView = await js<{
      hasResumeButton: boolean
      explanation: string
      promptsShown: number
      spawned: number
    }>(
      win,
      `(() => ({
        hasResumeButton: Boolean(document.querySelector('button[data-resume]')),
        explanation: (document.querySelector('[data-unavailable]')?.textContent ?? '')
          .replace(/\\s+/g, ' ').trim(),
        promptsShown: document.querySelectorAll('ol li').length,
        spawned: 0
      }))()`
    )
    reapedView.spawned = ctx.sessions.list().length - sessionsBefore

    // The pane will not offer it, but the main process is what actually spawns
    // - so it has to refuse on its own rather than trust the window.
    try {
      // Awaited inside the `try`: the refusal is a rejected promise now that a
      // launch reads the branch first, and an unawaited one would sail past
      // this catch and report that nothing refused.
      await ctx.sessions.resume({ sessionId: reapedTarget.sessionId, cols: 100, rows: 30 })
      refusal = null
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err)
    }
  }

  const shotReaped = await screenshot(win, shotDir, 'history-reaped.png')

  if (running('reaped')) checks.push({
    id: 'HIST-6',
    criterion: 'Attempting a reaped session shows a graceful explanation, not a broken terminal',
    title: 'A reaped session offers no resume, explains why, and still shows its prompts',
    ok:
      reapedTarget !== undefined &&
      reapedView !== null &&
      !reapedView.hasResumeButton &&
      reapedView.spawned === 0 &&
      reapedView.promptsShown === reapedTarget.promptCount &&
      /transcript/i.test(reapedView.explanation) &&
      refusal !== null &&
      /transcript/i.test(refusal),
    detail: {
      target: reapedTarget && {
        sessionId: reapedTarget.sessionId,
        project: reapedTarget.project,
        prompts: reapedTarget.promptCount
      },
      pane: reapedView,
      mainProcessRefusal: refusal,
      screenshot: shotReaped.file
    },
    notes: [
      'No process is started at all. `claude --resume <reaped id>` prints "No conversation',
      'found with session ID" and exits 1 (measured on 2.1.225) - a tab that dies in front',
      'of the user is the failure this criterion is about.'
    ]
  })

  // -------------------------------------------------------------------------
  // HIST-9: a row says what its session was about
  // -------------------------------------------------------------------------
  //
  // Judged on **properties**, not against a second copy of the derivation.
  // Re-implementing `titleRank` here would be a check that agrees with itself
  // one indirection away, and it would have to be edited every time the rule
  // is. What is asserted instead is what the complaint actually was: no row is
  // titled with a bare slash command while that session said something else, no
  // row is titled with an attachment placeholder, no row is blank, and a
  // truncation ends where a word does.
  //
  // The predicates below are deliberately crude - "starts with a slash and has
  // no space in it" is a bare command by anybody's reading - because a crude
  // predicate cannot quietly encode the same mistake the rule under test made.
  if (running('titles')) {
    await showHistory(win)
    await typeSearch(win, '')
    const titled = await paintedRows(win)

    const promptsOf = new Map<string, string[]>()
    for (const prompt of truth.prompts) {
      const list = promptsOf.get(prompt.sessionId)
      if (list === undefined) promptsOf.set(prompt.sessionId, [prompt.display])
      else list.push(prompt.display)
    }

    const PLACEHOLDER = /\[(?:Image #\d+|Pasted text[^\]]*)\]/g
    /** A slash command with no arguments at all: `/usage`, `/exit`. */
    const bare = (text: string): boolean => /^\/\S*$/.test(text.trim())
    const strip = (text: string): string =>
      text.replace(PLACEHOLDER, ' ').replace(/\s+/g, ' ').trim()
    /**
     * Prompts that are plainly prose, by the strictest reading available.
     *
     * Anything beginning with a slash is excluded outright, although the rule
     * under test will happily title a session from `/spec:quick when a user
     * clicks...` - the point of a one-sided predicate is that this check can
     * only ever under-report. A session with one of these in it and a bare
     * command on its row is a failure nobody has to arbitrate.
     */
    const usable = (texts: readonly string[]): string[] =>
      texts.filter((text) => {
        const cleaned = strip(text)
        if (cleaned === '' || cleaned.startsWith('/')) return false
        return cleaned.split(' ').filter((word) => /[A-Za-z]{2,}/.test(word)).length >= 2
      })
    /** The cap, written here rather than imported: a change should reach this file. */
    const CAP = 60

    // The stand-ins, which are Helm's words rather than anybody's prompt and so
    // cannot be looked for in the file. Written out here rather than imported:
    // if one of them changes, this check should have to be told.
    const STAND_INS = new Set(['No prompt recorded', 'Image only', 'Pasted text only'])

    const blank = titled.filter((row) => row.title === '')
    const placeholders = titled.filter((row) => PLACEHOLDER.test(row.title))
    const tooLong = titled.filter((row) => row.title.length > CAP + 1)
    // A row still titled with a bare command although that session went on to
    // say something. This is the `/usage` complaint, stated as a predicate.
    const stillBare = titled.filter(
      (row) => bare(row.title) && usable(promptsOf.get(row.sessionId) ?? []).length > 0
    )
    // A stand-in on a session that had something to read is the opposite
    // failure, and worth catching separately: it would mean the derivation gave
    // up where the prompts did not.
    const wrongStandIn = titled.filter(
      (row) => STAND_INS.has(row.title) && usable(promptsOf.get(row.sessionId) ?? []).length > 0
    )

    /*
     * Every title is either a stand-in or a prefix of something that session
     * actually said, and where it was cut, it was cut where a word ends.
     *
     * "Where a word ends" is a space *or* the punctuation that ended the
     * sentence, because a title is not left holding a trailing comma. And a
     * title cut at exactly the cap is exempt: that is the only way the
     * derivation produces one, and it means the cut fell inside a token longer
     * than half the cap - a 100-character URL, of which this machine's history
     * has several. Backing up to the last space there would title the session
     * "Look at this task…" and throw away the subject.
     */
    const unfounded: string[] = []
    const midWord: string[] = []
    for (const row of titled) {
      if (STAND_INS.has(row.title)) continue
      const cut = row.title.endsWith('…')
      const kept = cut ? row.title.slice(0, -1) : row.title
      const source = (promptsOf.get(row.sessionId) ?? [])
        .map(strip)
        .find((text) => text.startsWith(kept))
      if (source === undefined) unfounded.push(row.sessionId)
      else if (cut && kept.length < CAP && !/[\s,.;:!?-]/.test(source[kept.length] ?? '')) {
        midWord.push(row.sessionId)
      }
    }

    /*
     * Does this machine's history discriminate at all.
     *
     * A pane where no session opens with a slash command would pass every
     * assertion above by having nothing to get wrong - the `PROF-4` shape, and
     * the reason this counts the sessions the rule is *for* and requires there
     * to be some. 1,011 sessions on the machine this was written against, 291
     * of them opening on a bare command.
     */
    const retitled = titled.filter((row) => {
      const prompts = promptsOf.get(row.sessionId) ?? []
      const opener = prompts[0] ?? ''
      return (strip(opener) === '' || bare(opener)) && usable(prompts).length > 0
    })
    const retitledCorrectly = retitled.filter((row) => !bare(row.title) && row.title !== '')

    const shotTitles = await screenshot(win, shotDir, 'history-titles.png')

    checks.push({
      id: 'HIST-9',
      criterion: 'A row is titled from what the session was about, not from whatever was typed first',
      title: 'No row is titled with a bare slash command, a placeholder or nothing at all',
      ok:
        titled.length > 0 &&
        retitled.length > 0 &&
        retitled.length === retitledCorrectly.length &&
        blank.length === 0 &&
        placeholders.length === 0 &&
        tooLong.length === 0 &&
        stillBare.length === 0 &&
        wrongStandIn.length === 0 &&
        unfounded.length === 0 &&
        midWord.length === 0,
      detail: {
        rows: titled.length,
        openersWorthReadingPast: retitled.length,
        blank: blank.length,
        placeholderTitles: placeholders.slice(0, 4).map((r) => r.title),
        overTheCap: tooLong.slice(0, 4).map((r) => r.title),
        stillBare: stillBare.slice(0, 4).map((r) => ({ id: r.sessionId, title: r.title })),
        wrongStandIn: wrongStandIn.slice(0, 4).map((r) => ({ id: r.sessionId, title: r.title })),
        titleSaidByNobody: unfounded.slice(0, 4),
        truncatedMidWord: midWord.slice(0, 4),
        sample: retitled.slice(0, 4).map((row) => ({
          opener: (promptsOf.get(row.sessionId) ?? [])[0],
          title: row.title
        })),
        screenshot: shotTitles.file
      },
      notes: [
        'Claude Code writes no summary to borrow: 0 of 275 transcripts on this machine carry',
        'a "type":"summary" record, so the title is derived rather than read.',
        'Asserted as properties rather than against a second copy of the rule - a check that',
        're-implements what it checks agrees with itself and proves nothing. Every predicate',
        'here is one-sided: a session titled `/spec:plan` whose every other prompt is also a',
        'command is not a failure, and this cannot report it as one.'
      ]
    })

    // -----------------------------------------------------------------------
    // HIST-10: a name given by hand outlives the index it was given against
    // -----------------------------------------------------------------------
    //
    // `history_sessions` is emptied and rebuilt in full on a reset, so this is
    // the claim that decides whether the rename was put in the right place. The
    // rebuild is **made to destroy something first**: a canary is written into
    // the derived column beside the name, and the canary being gone afterwards
    // is what says the rebuild really happened. Without it, "the name survived"
    // is also what a reset that silently did nothing would report.
    const target = titled.find((row) => !row.named)
    const NAME = `HELM-NAMED-${String(Date.now())}`
    let renamed: Record<string, unknown> = { skipped: 'no row to rename' }
    let renameOk = false

    if (target !== undefined) {
      await click(win, `button[data-session="${target.sessionId}"]`)
      await pollJs(win, `document.querySelector('[data-history-rename]')`, 8000)
      await click(win, `button[data-history-rename]`)
      const fieldOpen = await pollJs(win, `document.querySelector('input[data-history-name]')`, 5000)
      // The field open over the heading, which is the one state in this pane
      // design-shot's itinerary cannot reach.
      const shotField = await screenshot(win, shotDir, 'history-rename-field.png')

      /*
       * What the field was holding, and how much of it was selected.
       *
       * Recorded rather than assumed, because this is what HIST-10 got wrong
       * for a whole run: the field opens pre-filled with the current title and
       * selects it (`autoFocus` plus `onFocus={select()}`), so a person typing
       * replaces it - but this driver typed into it without establishing that,
       * and got `<title><NAME>` written into `history_names`. The probe then
       * reported the painted title as wrong, which it was, about a name nobody
       * would ever have produced by hand.
       *
       * So the selection is measured and reported, and then the driver selects
       * the field's contents itself before typing. If the app ever stops
       * selecting on focus, `selectedOnOpen` in the detail says so while the
       * rest of the check goes on testing renaming.
       */
      const fieldOnOpen = await js<{ value: string; selected: number; focused: boolean }>(
        win,
        `(() => { const el = document.querySelector('input[data-history-name]');
          if (!el) return { value: '', selected: -1, focused: false };
          return {
            value: el.value,
            selected: (el.selectionEnd ?? 0) - (el.selectionStart ?? 0),
            // Which of the two failures this is: an app that did not select, or
            // a field the focus never reached.
            focused: document.activeElement === el
          } })()`
      )
      await js<boolean>(
        win,
        `(() => { const el = document.querySelector('input[data-history-name]');
          if (!el) return false; el.focus(); el.select(); return true })()`
      )
      await typeText(win, NAME, 8)
      await sendKey(win, 'Enter')
      /*
       * The row repaints under the name, and this is **asserted** rather than
       * merely waited for.
       *
       * Its first version polled and dropped the answer on the floor, which
       * would have let every other assertion here be satisfied by the database
       * while the pane went on painting the derived title - and the window is
       * where the criterion binds. A poll whose result nobody reads is a
       * `waitFor` wearing a claim's clothes.
       */
      /*
       * The row is on the *list*, and in the compact layout the list is not on
       * screen while a session is selected - the detail replaces it. This runs
       * with two sessions alive, so compact is on, and the row this is about is
       * the one just selected: the assertion had no element to read and failed
       * while the rename had worked perfectly. `typeSearch` learned the same
       * lesson earlier in this file; this is the second place that needed it.
       *
       * Pressing back is what a user does, and it is safe when the list is
       * already showing: the button is only rendered in the compact-and-
       * selected state.
       */
      await click(win, '[data-pane-back]')
      await pollJs(win, `document.querySelector('input[data-history-search]')`, 5000)

      const paintedAfterRename = await pollJs(
        win,
        `document.querySelector('button[data-session="${target.sessionId}"] [data-session-title]')
          ?.textContent === ${JSON.stringify(NAME)}`,
        8000
      )

      // Back into the detail, which the rest of this group drives - the clear
      // control lives there.
      await click(win, `button[data-session="${target.sessionId}"]`)
      await sleep(400)

      const afterRename = readHistorySession(services.store, target.sessionId)
      // The DOM above is the evidence; this is only the picture. `capturePage`
      // hands back the last composited frame, and a repaint that has happened
      // in the tree may not have reached the compositor yet - the first version
      // of this photographed the old title a frame after the assertion above
      // had already passed on the new one.
      await sleep(400)
      const shotNamed = await screenshot(win, shotDir, 'history-renamed.png')

      // Plant the canary in a column the rebuild owns, then force the rebuild
      // the way a rewritten history file would: everything derived thrown away
      // and recomputed from the file itself.
      const CANARY = 'HELM-REBUILD-CANARY'
      services.store.raw
        .prepare('UPDATE history_sessions SET first_prompt = ? WHERE session_id = ?')
        .run(CANARY, target.sessionId)
      /*
       * Every home, re-read from zero, which is what the service itself does
       * when it sees a reset.
       *
       * A reset empties both tables - the rows do not record which file they
       * came from - so forcing one over this machine's history alone would
       * rebuild the index out of 24 prompts and throw away the distro's 3,539.
       * The rest of this group then measures the rebuild against a `truth` that
       * covers both, and would fail for a reason that is this driver's rather
       * than the code's.
       */
      const rebuildDistros = await wslHomes()
      const homes = [claudeHome(), ...rebuildDistros.map((entry) => entry.claudeHome)]
      const transcripts = new Map<string, TranscriptFile>()
      for (const home of homes) {
        for (const [id, entry] of scanTranscripts(projectsDirIn(home))) transcripts.set(id, entry)
      }
      indexHistory(services.store, {
        sources: homes.map((home) => {
          const file = historyFileIn(home)
          return { file, tail: { ...readHistoryTail(file, 0), reset: true } }
        }),
        transcripts,
        // The service's own resolver, not the bare one: a distro's recorded
        // `/home/me/...` is absent to `statSync` on Windows, and a rebuild that
        // used the bare check would mark every distro session unresumable.
        directoryExists: (path) => {
          const resolved = resolveRecordedPath(path, rebuildDistros, directoryExists)
          return resolved !== null && directoryExists(resolved)
        }
      })
      const afterReset = readHistorySession(services.store, target.sessionId)

      // Back through the surface: the name is searchable, and the row the
      // rebuild wrote is still painted under it.
      await typeSearch(win, NAME)
      const found = await paintedRows(win)

      // And cleared through the surface too, which is the only way a user has
      // of asking for the derived title back.
      //
      // The box is emptied first, and that is not tidying up: the search that
      // just proved the name is searchable is a filter *on that name*, so a row
      // that gives it up leaves the list - correctly - and there would be
      // nothing left to read the derived title off. The first version of this
      // asserted against the filtered list and failed for that reason, which is
      // the check being wrong about the app rather than the other way round.
      await typeSearch(win, '')
      await click(win, `button[data-session="${target.sessionId}"]`)
      await pollJs(win, `document.querySelector('[data-history-rename-clear]')`, 8000)
      await click(win, 'button[data-history-rename-clear]')
      // Asserted for the reason above: the row going back to its derived title
      // is the visible half of "clearing restores it", and the database half
      // would be satisfied by a pane that never repainted.
      /*
       * The two halves are read one after the other, because in the compact
       * layout they cannot both be on screen.
       *
       * The claim is that the detail's heading and the row's title are the same
       * derived string, and it used to be one expression querying both at once
       * - which is unsatisfiable the moment the pane is narrow enough to show
       * one at a time, and this group runs with two sessions alive, so it
       * always is. The heading is read where it lives, the list is brought
       * back, and the row is compared against the string the heading gave.
       */
      // Waited for, not snapshotted. Read the instant after the click it is
      // still the name that was just cleared, and the row would then be
      // compared against a heading from before the clear - which is how this
      // failed on its first run, in the layout where both halves *are* visible.
      await pollJs(
        win,
        `document.querySelector('[data-history-title]')?.textContent !== ${JSON.stringify(NAME)}`,
        8000
      )
      const detailTitle = await js<string>(
        win,
        `(document.querySelector('[data-history-title]')?.textContent ?? '')`
      )
      await click(win, '[data-pane-back]')
      await pollJs(win, `document.querySelector('input[data-history-search]')`, 5000)
      const paintedAfterClear = await pollJs(
        win,
        `(() => {
          const row = document.querySelector('button[data-session="${target.sessionId}"]');
          const title = row?.querySelector('[data-session-title]')?.textContent;
          return row?.dataset.named === 'false' && title !== '' &&
            title !== ${JSON.stringify(NAME)} &&
            title === ${JSON.stringify(detailTitle)}
        })()`,
        8000
      )
      const afterClear = readHistorySession(services.store, target.sessionId)
      const namesLeft = (
        services.store.raw
          .prepare('SELECT COUNT(*) AS n FROM history_names WHERE session_id = ?')
          .get(target.sessionId.toLowerCase()) as { n: number }
      ).n

      renameOk =
        fieldOpen &&
        paintedAfterRename &&
        afterRename?.label === NAME &&
        // The rebuild happened: the derived column was put back from the file.
        afterReset?.firstPrompt !== CANARY &&
        afterReset?.label === NAME &&
        found.length === 1 &&
        found[0]?.sessionId === target.sessionId &&
        found[0]?.title === NAME &&
        paintedAfterClear &&
        afterClear?.label === null &&
        afterClear.title.trim() !== '' &&
        afterClear.title !== NAME &&
        namesLeft === 0

      renamed = {
        sessionId: target.sessionId,
        typed: NAME,
        // The field as the user meets it: pre-filled with the current title,
        // and how much of it the app had selected. Anything but the whole
        // string means typing would append rather than replace.
        fieldOnOpen: {
          value: fieldOnOpen.value,
          selectedChars: fieldOnOpen.selected,
          focusedOnOpen: fieldOnOpen.focused,
          selectedOnOpen: fieldOnOpen.selected === fieldOnOpen.value.length
        },
        paintedAfterRename,
        labelAfterRename: afterRename?.label ?? null,
        canaryAfterRebuild: afterReset?.firstPrompt === CANARY,
        labelAfterRebuild: afterReset?.label ?? null,
        rowsFoundByName: found.length,
        paintedAfterClear,
        titleAfterClear: afterClear?.title ?? null,
        labelAfterClear: afterClear?.label ?? null,
        nameRowsLeft: namesLeft,
        screenshots: [shotField.file, shotNamed.file]
      }
    }

    checks.push({
      id: 'HIST-10',
      criterion: 'A session can be named by hand, and the name survives a full re-index',
      title: 'A hand-given name is what the list shows, outlives a rebuild, and clears back to the derived title',
      ok: renameOk,
      detail: renamed,
      notes: [
        'The rename lives in `history_names`, keyed on the session id. A column on',
        '`history_sessions` would be deleted by the DELETE + rebuild this probe performs -',
        'which is what the canary is there to prove actually ran.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // HIST-7: a session started outside the app turns up on its own
  // -------------------------------------------------------------------------
  if (!running('outside')) return checks

  await showHistory(win)
  await typeSearch(win, '')
  const knownBefore = new Set(
    readHistorySessions(services.store).sessions.map((s) => s.sessionId)
  )

  const marker = `helm history external ${String(Date.now())}`
  const outsideCwd = process.cwd()
  let outsideOutput = ''
  let outsideExit: number | null = null
  const OUTSIDE_ID = 'history-outside'

  // Resolved the same way the app resolves it, so this is the same binary a
  // person would get by typing `claude` - not an assumption about PATH inside
  // a spawned shell.
  const cli = resolveClaudeCommand()
  const outside = spawnSession({
    id: OUTSIDE_ID,
    file: cli?.file ?? 'claude',
    args: [...(cli?.prefixArgs ?? []), '--model', 'haiku'],
    cols: 100,
    rows: 30,
    cwd: outsideCwd,
    onData: (chunk) => {
      outsideOutput += chunk
    },
    onExit: (code) => {
      outsideExit = code
    }
  })

  const outsideReady = await waitFor(() => {
    const text = squash(outsideOutput)
    if (/doyoutrust|trustthisfolder|quicksafetycheck/.test(text)) outside.write('\r')
    if (/mcpservers/.test(text)) outside.write('\x1b')
    return atPrompt(stripAnsi(outsideOutput))
  }, 90_000)

  let noticedMs = -1
  let noticedInDom = false
  let newIds: string[] = []

  if (outsideReady) {
    await sleep(1500)
    outside.write(marker)
    await sleep(400)
    outside.write('\r')
    const submittedAt = Date.now()

    // No refresh is triggered from here: the watcher has to notice on its own,
    // and the row has to reach the window without anyone asking it to.
    const noticed = await waitFor(() => {
      newIds = readHistorySessions(services.store, { search: marker }).sessions.map(
        (s) => s.sessionId
      )
      return newIds.length > 0
    }, 30_000)
    if (noticed) noticedMs = Date.now() - submittedAt

    noticedInDom = await pollJs(
      win,
      `[...document.querySelectorAll('button[data-session]')]
        .some((el) => el.dataset.session === ${JSON.stringify(newIds[0] ?? '')})`,
      15_000
    )
  }

  const shotOutside = await screenshot(win, shotDir, 'history-outside.png')
  killSession(OUTSIDE_ID)
  await sleep(1500)

  checks.push({
    id: 'HIST-7',
    criterion: 'Index updates within seconds of a new session being started outside the app',
    title: 'A prompt typed into a terminal Helm did not open appears in the launcher',
    ok:
      outsideReady &&
      noticedMs >= 0 &&
      noticedMs < 10_000 &&
      noticedInDom &&
      newIds.length === 1 &&
      !knownBefore.has(newIds[0] ?? ''),
    detail: {
      cwd: outsideCwd,
      cli: cli?.resolved ?? null,
      marker,
      startedInTerminal: outsideReady,
      noticedAfterMs: noticedMs,
      appearedInTheWindow: noticedInDom,
      newSessionIds: newIds,
      alreadyKnown: newIds.filter((id) => knownBefore.has(id)),
      externalExitCode: outsideExit,
      screenshot: shotOutside.file
    },
    notes: [
      'A real `claude`, spawned on its own pty by this driver rather than through Helm\'s',
      'session host - no database row, no tab, no IPC. The only thing connecting it to the',
      'app is the history file they share.',
      'Nothing calls refresh(): the fs.watch and the stat poll are what has to notice.'
    ]
  })

  return checks
}

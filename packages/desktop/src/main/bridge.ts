import { type BrowserWindow, ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProbeOp } from '../shared/protocol'

// ---------------------------------------------------------------------------
// main -> renderer request/response
// ---------------------------------------------------------------------------

let nextProbeId = 1
const pendingProbes = new Map<number, (value: unknown) => void>()

ipcMain.on('probe:res', (_e, { id, value }: { id: number; value: unknown }) => {
  pendingProbes.get(id)?.(value)
  pendingProbes.delete(id)
})

export function probe<T = any>(win: BrowserWindow, req: ProbeOp, timeoutMs = 10000): Promise<T> {
  const id = nextProbeId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingProbes.delete(id)
      reject(new Error(`probe timed out: ${req.op}`))
    }, timeoutMs)
    pendingProbes.set(id, (value) => {
      clearTimeout(timer)
      resolve(value as T)
    })
    win.webContents.send('probe:req', { id, req })
  })
}

// ---------------------------------------------------------------------------
// Synthetic input - real Chromium events, so keystrokes take the same route
// through xterm that a user's typing does.
// ---------------------------------------------------------------------------

export type Modifier = 'shift' | 'control' | 'alt' | 'meta'

const PRINTABLE = /^[\x20-\x7e]$/

export async function sendKey(
  win: BrowserWindow,
  keyCode: string,
  modifiers: Modifier[] = [],
  settleMs = 20
): Promise<void> {
  const wc = win.webContents
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  // Chromium only inserts text when a char event follows, and only for an
  // unmodified printable key.
  if (PRINTABLE.test(keyCode) && !modifiers.some((m) => m === 'control' || m === 'alt')) {
    wc.sendInputEvent({ type: 'char', keyCode, modifiers })
  }
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await sleep(settleMs)
}

export async function typeText(win: BrowserWindow, text: string, perKeyMs = 12): Promise<void> {
  for (const ch of text) {
    // Without the shift modifier Chromium delivers the unshifted character, so
    // typed text silently arrives lower-cased.
    const shifted = ch !== ch.toLowerCase() && ch === ch.toUpperCase()
    await sendKey(win, ch, shifted ? ['shift'] : [], perKeyMs)
  }
}

export async function sendMouse(
  win: BrowserWindow,
  type: 'mouseDown' | 'mouseUp' | 'mouseMove',
  x: number,
  y: number,
  /**
   * Two things a plain click does not need and two other gestures do.
   *
   * `clickCount`: Chromium makes a `dblclick` out of the count, not out of two
   * clicks arriving close together, so a driver that wants one has to say 2 on
   * the second press and release.
   *
   * `modifiers`: without `leftbuttondown` the moves of a drag arrive in the
   * page as `buttons: 0` - a hover, not a drag. A handler that reads `clientX`
   * off whatever move turns up never notices, which is why the workspace
   * divider has been driven this way for as long as it has. One that takes
   * pointer capture on the press does notice: measured on the project shell's
   * handle, the identical gesture moved nothing at all without this and moved
   * the pane with it, `document` reporting eight moves at `buttons: 1` and the
   * handle holding the capture through them.
   */
  opts: { clickCount?: number; modifiers?: Array<'leftbuttondown'> } = {}
): Promise<void> {
  win.webContents.sendInputEvent({
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: 'left',
    clickCount: opts.clickCount ?? 1,
    ...(opts.modifiers ? { modifiers: opts.modifiers } : {})
  })
  await sleep(20)
}

/**
 * A right-click, as the platform delivers one.
 *
 * Both halves are sent because the `contextmenu` event is Blink's own reaction
 * to the platform event rather than something a driver can raise, and on
 * Windows it comes off the **release**. A driver that sends only the press gets
 * no `contextmenu` and therefore measures nothing.
 *
 * This exists for C7, where the right-click is not incidental: xterm's
 * `rightClickHandler` writes the live selection into the helper textarea and
 * selects it there, which is the state that made Chromium's built-in Copy win
 * every later Ctrl+C.
 */
export async function rightClick(win: BrowserWindow, x: number, y: number): Promise<void> {
  const at = { x: Math.round(x), y: Math.round(y), button: 'right' as const, clickCount: 1 }
  win.webContents.sendInputEvent({ type: 'mouseDown', ...at })
  await sleep(20)
  win.webContents.sendInputEvent({ type: 'mouseUp', ...at })
  await sleep(60)
}

/**
 * A drag, with the button actually held for the moves in the middle.
 *
 * This exists because getting it wrong is invisible. `sendMouse` defaults to no
 * modifiers, so a driver that writes the gesture out by hand - press, move,
 * move, release - sends two *hovers* between the press and the release, and a
 * handler that reads `clientX` off whatever move arrives cannot tell the
 * difference. Helm had two such drivers and one such handler, and between them
 * they reported a working drag for as long as the divider has existed. The
 * failure only surfaced on the first handle built with `setPointerCapture`,
 * which correctly ignored all of it and moved nothing.
 *
 * So the button-held case is the one that is easy to write, and the loose
 * `sendMouse` calls are what now look unusual at a call site.
 *
 * `steps` is 2 by default because Chromium coalesces a single jump from the
 * press point: the first move is what gets a drag past its own start
 * threshold, and one move on its own can be swallowed.
 *
 * `onStep` runs after each move, before the release. A drag is a gesture that
 * happens *over time*, and every claim worth making about one - does the pane
 * track the pointer, does it move the edge the pointer is on - is a claim about
 * the middle. A probe that only looks after the release is measuring the commit
 * and calling it the drag; that mistake shipped a fix that measured 470x faster
 * and was unusable in the hand.
 */
export async function drag(
  win: BrowserWindow,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { steps?: number; onStep?: (index: number) => Promise<void> } = {}
): Promise<void> {
  const steps = Math.max(1, opts.steps ?? 2)
  await sendMouse(win, 'mouseDown', from.x, from.y)
  for (let i = 1; i <= steps; i++) {
    const at = {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps
    }
    await sendMouse(win, 'mouseMove', at.x, at.y, { modifiers: ['leftbuttondown'] })
    // Deliberately after the move and inside the gesture: the button is still
    // down here, so a frame can render and a measurement can be taken of a
    // drag in progress rather than of one that has already committed.
    if (opts.onStep) await opts.onStep(i)
  }
  await sendMouse(win, 'mouseUp', to.x, to.y)
}

/**
 * What a gesture actually delivered, counted on `document`.
 *
 * Without this a drag that moves nothing is one failure with two very different
 * causes: **the app ignored the gesture, or the gesture never arrived.** Those
 * want opposite fixes, and told apart only by argument they get told apart
 * wrong - the first time this mattered, the app was blameless and the driver
 * had been sending hovers.
 *
 * It lives here rather than in one driver because the rule is general: anything
 * that drives a gesture counts what was delivered, so a silent non-delivery
 * cannot read as "the app declined". `settings-check` S-20 and the workspace
 * divider's own probe both take their positive control from this.
 *
 * The listeners go on `document` in the bubble phase, which is after React's
 * own handler at the root, so `hasPointerCapture` here is what the app left it
 * as rather than what it found.
 */
export interface PointerTrace {
  down: number
  move: number
  up: number
  /** Whether `selector`'s element held the capture, sampled on the last move. */
  captured: boolean | null
  /** `buttons` on the last move - 0 is a hover, 1 is a drag. */
  buttons: number | null
}

export const tracePointer = (win: BrowserWindow, selector: string): Promise<void> =>
  win.webContents
    .executeJavaScript(
      `(() => {
      if (window.__pointerTrace) window.__pointerTrace.off()
      const el = document.querySelector(${JSON.stringify(selector)})
      const t = { down: 0, move: 0, up: 0, captured: null, buttons: null, off: () => undefined }
      const on = (type, key) => {
        const fn = (e) => {
          t[key]++
          if (type === 'pointermove' && el) {
            t.captured = el.hasPointerCapture(e.pointerId)
            t.buttons = e.buttons
          }
        }
        document.addEventListener(type, fn)
        return () => { document.removeEventListener(type, fn) }
      }
      const offs = [on('pointerdown', 'down'), on('pointermove', 'move'), on('pointerup', 'up')]
      t.off = () => { for (const o of offs) o() }
      window.__pointerTrace = t
      return undefined
    })()`,
      true
    )
    .then(() => undefined)

export const readPointerTrace = (win: BrowserWindow): Promise<PointerTrace> =>
  win.webContents.executeJavaScript(
    `(() => { const t = window.__pointerTrace
      const answer = { down: t.down, move: t.move, up: t.up, captured: t.captured, buttons: t.buttons }
      t.off()
      delete window.__pointerTrace
      return answer })()`,
    true
  ) as Promise<PointerTrace>

/**
 * Scroll the pane by `notches`; positive scrolls back toward older output.
 *
 * Two things this has to get right. Chromium routes a wheel event to whatever
 * is under the cursor, so the hover target must be set with a move first, and
 * it needs wheelTicks as well as deltas. And sendInputEvent's deltaY is the
 * inverse of the DOM's: a +400 here arrives in the page as deltaY -400.
 */
export async function sendWheel(
  win: BrowserWindow,
  x: number,
  y: number,
  notches: number
): Promise<void> {
  const at = { x: Math.round(x), y: Math.round(y) }
  win.webContents.sendInputEvent({ type: 'mouseMove', ...at })
  win.webContents.sendInputEvent({
    type: 'mouseWheel',
    ...at,
    deltaX: 0,
    deltaY: notches * 100,
    wheelTicksX: 0,
    wheelTicksY: notches,
    hasPreciseScrollingDeltas: false,
    canScroll: true
  } as Electron.MouseWheelInputEvent)
  await sleep(60)
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export async function screenshot(
  win: BrowserWindow,
  dir: string,
  name: string
): Promise<{ file: string; bitmap: Buffer; width: number; height: number }> {
  mkdirSync(dir, { recursive: true })
  const image = await win.webContents.capturePage()
  const file = join(dir, name)
  writeFileSync(file, image.toPNG())
  const size = image.getSize()
  return { file, bitmap: image.toBitmap(), width: size.width, height: size.height }
}

/**
 * Count pixels in a captured frame that are *exactly* this colour. The 256
 * colour palette contains none of the values this spike paints, so a non-zero
 * count is proof the whole path - SGR parse, renderer, compositor - carried 24
 * bits rather than quantising to the nearest palette entry.
 */
export function countExactPixels(
  bitmap: Buffer,
  rgb: { r: number; g: number; b: number }
): number {
  let n = 0
  // capturePage yields BGRA on Windows.
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    if (bitmap[i] === rgb.b && bitmap[i + 1] === rgb.g && bitmap[i + 2] === rgb.r) n++
  }
  return n
}

export function nearestPixel(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number
): { r: number; g: number; b: number } {
  const i = (y * width + x) * 4
  return { b: bitmap[i]!, g: bitmap[i + 1]!, r: bitmap[i + 2]! }
}

// ---------------------------------------------------------------------------

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 100
): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now()
    const timer = setInterval(() => {
      let ok: boolean
      try {
        ok = predicate()
      } catch {
        ok = false
      }
      if (ok) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, intervalMs)
  })
}

/**
 * TUI output interleaves cursor-movement and style sequences inside words and
 * positions text without emitting spaces, so any text assertion has to run
 * against a stripped view of the stream.
 */
const ANSI_RE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][A-Z0-9]|\x1b[=><]|\x1b[PX^_][^\x1b]*\x1b\\/g

export const stripAnsi = (text: string): string => text.replace(ANSI_RE, '')

/**
 * Claude's TUI positions text without emitting the spaces between words and
 * interleaves style sequences inside them, so whitespace in the output stream
 * is not a reliable landmark. Squashing it away makes text assertions survive
 * that.
 */
export const squash = (text: string): string =>
  stripAnsi(text).replace(/\s+/g, '').toLowerCase()

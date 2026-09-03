import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { SerializeAddon } from '@xterm/addon-serialize'
import '@xterm/xterm/css/xterm.css'
import type { TermCreateOptions } from '../../shared/protocol'

/**
 * A 24-bit theme. Every entry is an exact hex triple so that a screenshot can
 * be checked pixel-for-pixel: if the compositor or the renderer quantised
 * anything, these values would not survive.
 */
const THEME = {
  background: '#11121a',
  foreground: '#c9d1d9',
  cursor: '#f0c674',
  cursorAccent: '#11121a',
  selectionBackground: '#2b4a6f',
  black: '#1c1e26',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#5c6370',
  brightRed: '#ff7b86',
  brightGreen: '#b5e890',
  brightYellow: '#ffd68a',
  brightBlue: '#7cc4ff',
  brightMagenta: '#dd93f0',
  brightCyan: '#6fd3e0',
  brightWhite: '#ffffff'
}

/**
 * The pane's font metrics, in one place because two things need them: the
 * terminal itself, and the estimate of how many cells fit in a pane that does
 * not have a terminal in it yet (see `estimateGrid`).
 */
export const TERMINAL_FONT = {
  family: '"Cascadia Mono", "Consolas", monospace',
  size: 14,
  lineHeight: 1.0
} as const

/**
 * Everything about a terminal a person is allowed to change.
 *
 * Passed in rather than read from a module-level store, and that is the whole
 * routing rule in one signature: the app hands its effective preferences down
 * from `settings:changed`, and the spike page - which calls `createTerminal`
 * with three arguments - gets `TERMINAL_DEFAULTS` and cannot be reached by a
 * setting even by accident. `pnpm fidelity` and `pnpm claude-check` measure
 * that page, so their numbers stay a statement about the proven configuration.
 */
export interface TerminalPrefs {
  /** A resolved CSS font stack, not a single family. See `terminalFontStack`. */
  fontFamily: string
  fontSize: number
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  scrollback: number
}

/** What a terminal is when nobody has changed anything. Spike C's values. */
export const TERMINAL_DEFAULTS: TerminalPrefs = {
  fontFamily: TERMINAL_FONT.family,
  fontSize: TERMINAL_FONT.size,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000
}

/**
 * The user's family in front of the default stack, never instead of it.
 *
 * A stack is a per-glyph fallback chain, so keeping the default behind whatever
 * was chosen is what makes a bad choice survivable: a font with no box-drawing
 * characters loses its box-drawing characters to Cascadia Mono and keeps its
 * letterforms, instead of turning Claude Code's whole interface into tofu.
 * There is no way to express "replace the stack" from the settings pane, on
 * purpose.
 */
export function terminalFontStack(family: string | null): string {
  const chosen = family?.trim()
  if (chosen === undefined || chosen === '') return TERMINAL_FONT.family
  return `"${chosen}", ${TERMINAL_FONT.family}`
}

/**
 * Push preferences onto a terminal that already exists, and re-measure it.
 *
 * The re-measure is the half that matters. A cell-size change makes the grid
 * wrong for the pane it is in, and `refit` only tells the pty about it when the
 * answer actually changed - which is the right semantics here, because a
 * cursor-style change moves no cells and must not put a SIGWINCH through a
 * running TUI.
 */
export function applyPrefs(host: TerminalHost, prefs: TerminalPrefs): void {
  const options = host.term.options
  options.fontFamily = prefs.fontFamily
  options.fontSize = prefs.fontSize
  options.cursorStyle = prefs.cursorStyle
  // A terminal whose process has ended had its cursor stopped and its input
  // disabled deliberately (TerminalPane, pterms.ts). A settings change must not
  // make a dead pane start blinking again.
  if (options.disableStdin !== true) options.cursorBlink = prefs.cursorBlink
  options.scrollback = prefs.scrollback
  host.refit()
}

/**
 * One live terminal, described for a driver.
 *
 * A read-only tap, in the same spirit as `SessionObserver` in `main/sessions.ts`
 * and the picker stand-ins `--packaging-firstrun` passes: the app never calls it. It
 * exists because the terminals live outside React in module registries, so a
 * check driving the real window has no other route to them - and "the setting
 * reached every open terminal" is the whole claim a terminal setting makes.
 *
 * `screen` is the measured box of xterm's own screen element, so a driver can
 * divide by `cols`/`rows` and compare the cell size against a measurement it
 * made itself rather than against anything Helm computed.
 */
export interface TerminalReport {
  key: string
  fontFamily: string
  fontSize: number
  cursorStyle: string
  cursorBlink: boolean
  scrollback: number
  cols: number
  rows: number
  screen: { width: number; height: number } | null
  /** False for a pane React has taken out of the document; it keeps its state. */
  attached: boolean
}

export function describeTerminal(key: string, host: TerminalHost): TerminalReport {
  const options = host.term.options
  const screen = host.element.querySelector('.xterm-screen')
  const box = screen ? screen.getBoundingClientRect() : null
  return {
    key,
    fontFamily: String(options.fontFamily ?? ''),
    fontSize: Number(options.fontSize ?? 0),
    cursorStyle: String(options.cursorStyle ?? ''),
    cursorBlink: options.cursorBlink === true,
    scrollback: Number(options.scrollback ?? 0),
    cols: host.term.cols,
    rows: host.term.rows,
    screen: box ? { width: box.width, height: box.height } : null,
    attached: host.element.isConnected
  }
}

export interface WheelRecord {
  deltaY: number
  deltaMode: number
  /** The legacy property VS Code's scrollable element actually reads. */
  wheelDeltaY: number | undefined
  target: string
  count: number
}

export interface TerminalHost {
  term: Terminal
  serialize: SerializeAddon
  fit: FitAddon | null
  /** Live, not a snapshot: it flips to 'dom' if the GL context is ever lost. */
  readonly rendererKind: 'webgl' | 'dom'
  element: HTMLElement
  lastWheel: () => WheelRecord | null
  /** Re-measure against the container. Call after the pane becomes visible. */
  refit: () => void
  /** Releases the terminal, its addons, and the resize observer. */
  dispose: () => void
}

export interface TerminalHooks {
  /** Host -> pty. Everything the user types funnels through here. */
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
  readClipboard: () => Promise<string>
  writeClipboard: (text: string) => Promise<void>
  /** Fired on every keydown that xterm will translate, for latency timing. */
  onKeyDown?: (at: number) => void
}

export function createTerminal(
  container: HTMLElement,
  opts: TermCreateOptions,
  hooks: TerminalHooks,
  prefs: TerminalPrefs = TERMINAL_DEFAULTS
): TerminalHost {
  const term = new Terminal({
    cols: opts.cols,
    rows: opts.rows,
    // Unicode 11 widths are proposed API; without this the addon cannot load
    // and emoji fall back to Unicode 6 widths, which mis-measures most of them.
    allowProposedApi: true,
    fontFamily: prefs.fontFamily,
    fontSize: prefs.fontSize,
    lineHeight: TERMINAL_FONT.lineHeight,
    letterSpacing: 0,
    scrollback: prefs.scrollback,
    // Any value above 1 rewrites colours to hit a contrast target. A host that
    // claims to render the TUI faithfully must leave them alone.
    minimumContrastRatio: 1,
    // Likewise: do not promote bold text into the bright palette.
    drawBoldTextInBrightColors: false,
    rescaleOverlappingGlyphs: true,
    cursorBlink: prefs.cursorBlink,
    cursorStyle: prefs.cursorStyle,
    theme: THEME,
    // Spread rather than `windowsPty: cond ? {...} : undefined`. Same value
    // reaches xterm either way - it tests the property for truthiness - but
    // under `exactOptionalPropertyTypes` an explicit `undefined` is not a legal
    // value for an optional property, and omitting the key is what "no ConPTY
    // quirk handling" actually means.
    ...(opts.windowsBuild
      ? { windowsPty: { backend: 'conpty' as const, buildNumber: opts.windowsBuild } }
      : {})
  })

  const unicode11 = new Unicode11Addon()
  term.loadAddon(unicode11)
  term.unicode.activeVersion = '11'

  const serialize = new SerializeAddon()
  term.loadAddon(serialize)

  let fit: FitAddon | null = null
  if (opts.fit) {
    fit = new FitAddon()
    term.loadAddon(fit)
  }

  term.open(container)

  // Held in an object rather than a bare `let` because the context-loss
  // handler fires long after `createTerminal` has returned: copying the
  // variable into the returned host would freeze it at 'webgl' and the fallback
  // would never be visible to anything that asks.
  const renderer: { kind: 'webgl' | 'dom' } = { kind: 'dom' }
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => {
      // A lost GL context leaves a blank pane; drop back to the DOM renderer
      // rather than showing nothing.
      webgl.dispose()
      renderer.kind = 'dom'
    })
    term.loadAddon(webgl)
    renderer.kind = 'webgl'
  } catch {
    renderer.kind = 'dom'
  }

  term.onData(hooks.onInput)
  term.onBinary((data) => {
    let out = ''
    for (let i = 0; i < data.length; i++) out += String.fromCharCode(data.charCodeAt(i) & 255)
    hooks.onInput(out)
  })

  /**
   * Fit, then tell the pty - but only when there is something to fit to and
   * only when the answer changed.
   *
   * A hidden pane measures 0x0 and FitAddon turns that into a 1x1 grid. That is
   * a real resize as far as the child process is concerned: it redraws its
   * whole UI into one column, and the damage is still there when the tab comes
   * back. Reporting an unchanged size is the milder version of the same
   * problem - every pixel of a window drag would be a SIGWINCH, and Claude
   * Code repaints on each one.
   */
  let reported: { cols: number; rows: number } | null = null
  const applyFit = (): void => {
    if (!fit) return
    const { width, height } = container.getBoundingClientRect()
    if (width < 1 || height < 1) return
    fit.fit()
    if (reported?.cols === term.cols && reported.rows === term.rows) return
    reported = { cols: term.cols, rows: term.rows }
    hooks.onResize(term.cols, term.rows)
  }

  let observer: ResizeObserver | null = null
  if (fit) {
    applyFit()
    observer = new ResizeObserver(applyFit)
    observer.observe(container)
  }

  attachKeyBindings(term, hooks)

  // Diagnostic only: records what a wheel event actually looked like by the
  // time it reached the pane, so a "scrolling does not work" result can name
  // whether the event arrived at all.
  let wheel: WheelRecord | null = null
  container.addEventListener(
    'wheel',
    (e) => {
      const ev = e as WheelEvent & { wheelDeltaY?: number }
      wheel = {
        deltaY: ev.deltaY,
        deltaMode: ev.deltaMode,
        wheelDeltaY: ev.wheelDeltaY,
        target: (ev.target as HTMLElement)?.className || '(none)',
        count: (wheel?.count ?? 0) + 1
      }
    },
    { capture: true, passive: true }
  )

  term.focus()
  return {
    term,
    serialize,
    fit,
    get rendererKind() {
      return renderer.kind
    },
    element: container,
    lastWheel: () => wheel,
    refit: applyFit,
    dispose: () => {
      observer?.disconnect()
      observer = null
      // Disposes the loaded addons with it, webgl's GL context included.
      term.dispose()
    }
  }
}

/**
 * Windows Terminal's contract, which is the bar this spike is measured against:
 *
 *  - Ctrl-C copies when there is a selection and interrupts otherwise
 *  - Ctrl-Shift-C / Ctrl-Shift-V always copy and paste
 *  - Ctrl-V pastes
 *
 * The interrupt is the interaction Claude Code depends on most, so any other
 * keystroke drops a stale selection - otherwise a selection made minutes ago
 * would silently swallow the next Ctrl-C.
 */
function attachKeyBindings(term: Terminal, hooks: TerminalHooks): void {
  const copy = async (): Promise<void> => {
    const text = term.getSelection()
    if (text) await hooks.writeClipboard(text)
  }
  const paste = async (): Promise<void> => {
    const text = await hooks.readClipboard()
    if (text) term.paste(text)
  }

  /**
   * "Helm has dealt with this keystroke." Both halves, and the second one is
   * the half that was missing.
   *
   * Returning `false` from a custom key event handler only stops **xterm's**
   * translation. xterm 6.0.0's `_keyDown` returns on the spot for a `false`
   * (`CoreBrowserTerminal.ts`, the `_customKeyEventHandler` test) and so never
   * reaches its own `cancel(event, true)` - so the keydown's default action
   * still stands, and Blink's built-in editing key-binding table performs the
   * native command inside the renderer, on top of whatever the branch here
   * already did. Every branch below is a keystroke Helm answers itself, so
   * every one of them has to cancel that.
   *
   * Both halves of ClickUp 868m0egkt are that second write, measured on
   * Electron 43.3.0 / xterm 6.0.0:
   *
   *  - **Paste doubled.** One Ctrl+V with a 17-character clipboard produced a
   *    native `paste` event at xterm's own helper textarea at +0.7ms - xterm
   *    listens for `paste` on the textarea *and* on the element - and then
   *    Helm's `clipboard:read` at +2.3ms. Two `onData` calls, 34 bytes at the
   *    pty, the text on screen twice; with bracketed paste on, two complete
   *    envelopes, so a composer receives the paste twice. 3/3, deterministic.
   *    Ctrl+Shift+V is the same event: Chromium reads it as
   *    PasteAndMatchStyle, which is still a paste at the textarea.
   *  - **Copy went stale.** `rightClickHandler` (xterm's `Clipboard.ts`) writes
   *    the current selection into that textarea and calls `select()` on it, so
   *    after any right-click over the pane there is a real DOM selection for
   *    Blink's Copy to act on. Blink issues its clipboard write at +0.2ms and
   *    it completes *after* the IPC write here resolves at +0.4ms, so Blink is
   *    deterministically the last writer and the clipboard keeps whatever was
   *    selected at the time of the right-click. 13/13, sticky, and a later
   *    left-click does not clear it.
   *
   *    Two of xterm's own listeners are why that lands where it does. It also
   *    registers a `copy` listener, which would have substituted the live
   *    selection - but it opens `if (!this.hasSelection()) return`, and the
   *    branch below has already called `term.clearSelection()` by the time the
   *    default action runs. So xterm's guard bows out and Blink copies the
   *    textarea unopposed. Clearing the selection is right and stays; what was
   *    missing is the cancel.
   *
   * **None of this is an xterm bug, and that is the sentence worth keeping.**
   * `rightClickHandler` is inert in stock xterm: its `_keyDown` translates
   * Ctrl+C itself and ends at `cancel(event, true)`, so Chromium never runs its
   * editing command and nothing ever reads that textarea. Helm's early
   * `return false` is the only reason the native Copy runs at all. Within one
   * keystroke, whether it fires is decided by nothing but whether this handler
   * returned false - which is why Ctrl+C with **no** selection was always
   * correct, since that case falls through to xterm and is cancelled there.
   * The asymmetry is Helm's own, so the remedy is Helm's own.
   *
   * `pnpm fidelity` C5 and C7 are the regression. Both are counts rather than
   * substring matches, because a doubled stream contains a correct one.
   */
  const handled = (e: KeyboardEvent): false => {
    e.preventDefault()
    return false
  }

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    hooks.onKeyDown?.(performance.now())

    // Shift+Enter has no standard encoding, so xterm sends plain CR for it and
    // the composer submits instead of adding a line. Spike C measured which
    // sequences Claude Code's composer accepts as an inline newline - ESC CR,
    // LF, CSI 13;2u and backslash-CR all work - and ESC CR is the conventional
    // meta-Enter, so that is what the host emits.
    //
    // Its native default action is `insertLineBreak` into xterm's helper
    // textarea, and unlike the clipboard chords that has never produced a
    // second write: xterm's `_inputEvent` fires a data event only for
    // `inputType === 'insertText'`, so the resulting `input` event is dropped.
    // It is cancelled anyway, for the reason the branch exists at all - Helm
    // emitted the sequence, so the keystroke is spent - and because "harmless"
    // there rests on Blink's editing table and on that one filter in xterm,
    // neither of which Helm controls, while the cost of the accumulating
    // newlines is a textarea nothing here ever reads. Latent, not measured.
    if (
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      (e.code === 'Enter' || e.code === 'NumpadEnter')
    ) {
      hooks.onInput('\x1b\r')
      return handled(e)
    }

    const mod = e.ctrlKey && !e.altKey
    // Ctrl+Shift+C and Ctrl+Shift+V: Chromium binds an editing command to the
    // second of these (PasteAndMatchStyle) and, as measured, nothing to the
    // first. They are cancelled alike regardless, because which chords Blink
    // has a command for is not a fact about Helm and is not one to encode here.
    if (mod && e.shiftKey && e.code === 'KeyC') {
      void copy()
      return handled(e)
    }
    if (mod && e.shiftKey && e.code === 'KeyV') {
      void paste()
      return handled(e)
    }
    if (mod && !e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
      void copy()
      term.clearSelection()
      return handled(e)
    }
    if (mod && !e.shiftKey && e.code === 'KeyV') {
      void paste()
      return handled(e)
    }

    const isModifierOnly = ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)
    if (!isModifierOnly && term.hasSelection()) term.clearSelection()
    return true
  })
}

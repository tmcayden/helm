/**
 * Types shared by the main process and the renderer. Type-only - nothing here
 * may import from either side.
 */

export interface TermCreateOptions {
  cols: number
  rows: number
  /** Track the window size instead of holding a fixed grid. */
  fit: boolean
  windowsBuild?: number
}

/** One rendered cell, as xterm parsed it. */
export interface CellProbe {
  chars: string
  width: number
  /** 0 = default, 1 = 256-palette, 2 = true colour (RGB) */
  fgMode: number
  bgMode: number
  /** Packed 0xRRGGBB when the mode is RGB, palette index when it is 256. */
  fg: number
  bg: number
  bold: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
  dim: boolean
}

export interface ViewportProbe {
  cols: number
  rows: number
  /** Row of the top of the viewport within the whole buffer. */
  viewportY: number
  /** Row of the top of the *screen* within the whole buffer; grows as output
   * scrolls into scrollback. */
  baseY: number
  length: number
  cursorX: number
  cursorY: number
  /** 'normal' while the app draws inline, 'alternate' inside a full-screen UI. */
  bufferType: string
}

export interface LatencySample {
  /** keydown -> the frame in which the echoed glyph was painted. */
  roundTripMs: number
  /** keydown -> the IPC send that hands the byte to the pty. */
  hostInputMs: number
}

export type ProbeOp =
  | { op: 'viewport' }
  | { op: 'renderer' }
  | { op: 'serialize'; scrollback?: number }
  | { op: 'plainRows'; from: number; to: number }
  | { op: 'logicalLines'; from: number; to: number }
  | { op: 'cells'; row: number; from: number; to: number }
  | { op: 'write'; data: string }
  | { op: 'paste'; text: string }
  | { op: 'select'; col: number; row: number; length: number }
  | { op: 'selectionText' }
  | { op: 'clearSelection' }
  | { op: 'dragSelect'; fromCol: number; fromRow: number; toCol: number; toRow: number }
  | { op: 'scrollLines'; amount: number }
  | { op: 'scrollToBottom' }
  | { op: 'geometry' }
  | { op: 'latencyStart'; count: number; char: string }
  | { op: 'latencyResults' }
  | { op: 'unicodeVersion' }
  | { op: 'lastWheel' }
  | { op: 'helperTextarea' }

/**
 * The state of xterm's own helper textarea, which is where the native editing
 * commands land.
 *
 * Read-only, and it exists for one probe: `rightClickHandler` puts the live
 * selection into that element and calls `select()` on it, which is what gives
 * Chromium's built-in Copy a DOM selection to act on. C7 has to establish that
 * the poisoning actually happened before it can claim anything from the
 * clipboard afterwards - an empty textarea would make the whole probe pass for
 * the wrong reason.
 */
export interface HelperTextareaProbe {
  /** Null when the element is not in the document at all. */
  value: string | null
  selectionStart: number | null
  selectionEnd: number | null
  /** Whether it is `document.activeElement`; a blurred one is not copied from. */
  focused: boolean
}

export interface GeometryProbe {
  /** CSS pixels, relative to the page. */
  x: number
  y: number
  cellWidth: number
  cellHeight: number
  devicePixelRatio: number
}

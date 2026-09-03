import type { IBufferCell } from '@xterm/xterm'
import type { TerminalHost } from './terminal'
import type { LatencyRecorder } from './latency'
import type {
  CellProbe,
  GeometryProbe,
  HelperTextareaProbe,
  ProbeOp,
  ViewportProbe
} from '../../shared/protocol'

/**
 * Read-only (plus a few driving) hooks into a live terminal, so the fidelity
 * driver can assert on what xterm actually parsed instead of on a screenshot
 * that a human has to squint at.
 */
export function makeProbeHandler(
  getHost: () => TerminalHost | null,
  latency: LatencyRecorder
): (req: ProbeOp) => unknown {
  function cellProbe(cell: IBufferCell): CellProbe {
    return {
      chars: cell.getChars(),
      width: cell.getWidth(),
      fgMode: cell.isFgRGB() ? 2 : cell.isFgPalette() ? 1 : 0,
      bgMode: cell.isBgRGB() ? 2 : cell.isBgPalette() ? 1 : 0,
      fg: cell.getFgColor(),
      bg: cell.getBgColor(),
      bold: Boolean(cell.isBold()),
      italic: Boolean(cell.isItalic()),
      underline: Boolean(cell.isUnderline()),
      inverse: Boolean(cell.isInverse()),
      dim: Boolean(cell.isDim())
    }
  }

  return (req: ProbeOp): unknown => {
    const host = getHost()
    if (!host) return { error: 'no terminal' }
    const { term } = host
    const buf = term.buffer.active

    switch (req.op) {
      case 'viewport': {
        const v: ViewportProbe = {
          cols: term.cols,
          rows: term.rows,
          viewportY: buf.viewportY,
          baseY: buf.baseY,
          length: buf.length,
          cursorX: buf.cursorX,
          cursorY: buf.cursorY,
          bufferType: buf.type
        }
        return v
      }

      case 'renderer':
        return { kind: host.rendererKind }

      case 'unicodeVersion':
        return { active: term.unicode.activeVersion, available: term.unicode.versions }

      case 'serialize':
        return { text: host.serialize.serialize({ scrollback: req.scrollback ?? 0 }) }

      case 'plainRows': {
        const rows: string[] = []
        for (let i = req.from; i <= req.to && i < buf.length; i++) {
          rows.push(buf.getLine(i)?.translateToString(false) ?? '')
        }
        return { rows }
      }

      // Follow xterm's wrap flags to rebuild the logical lines the application
      // emitted. This is what "reflow worked" has to be checked against - the
      // visual rows are expected to change on resize; the logical text is not.
      case 'logicalLines': {
        const lines: string[] = []
        let curr: string | null = null
        for (let i = req.from; i <= req.to && i < buf.length; i++) {
          const line = buf.getLine(i)
          if (!line) continue
          const text = line.translateToString(false)
          if (line.isWrapped && curr !== null) {
            curr += text
          } else {
            if (curr !== null) lines.push(curr)
            curr = text
          }
        }
        if (curr !== null) lines.push(curr)
        return { lines: lines.map((l) => l.replace(/\s+$/, '')) }
      }

      case 'cells': {
        const line = buf.getLine(req.row)
        if (!line) return { cells: [] }
        const cells: CellProbe[] = []
        for (let i = req.from; i <= req.to && i < term.cols; i++) {
          const cell = line.getCell(i)
          if (cell) cells.push(cellProbe(cell))
        }
        return { cells }
      }

      case 'write':
        term.write(req.data)
        return { ok: true }

      case 'paste':
        term.paste(req.text)
        return { ok: true }

      case 'select':
        term.select(req.col, req.row, req.length)
        return { ok: true, text: term.getSelection() }

      case 'selectionText':
        return { text: term.getSelection(), has: term.hasSelection() }

      case 'clearSelection':
        term.clearSelection()
        return { ok: true }

      case 'scrollLines':
        term.scrollLines(req.amount)
        return { ok: true, viewportY: term.buffer.active.viewportY }

      case 'scrollToBottom':
        term.scrollToBottom()
        return { ok: true }

      // Cell geometry in page coordinates, so the driver can aim real mouse
      // events at a specific character.
      case 'geometry': {
        const screen = host.element.querySelector('.xterm-screen') as HTMLElement | null
        const target = screen ?? host.element
        const r = target.getBoundingClientRect()
        const g: GeometryProbe = {
          x: r.left,
          y: r.top,
          cellWidth: r.width / term.cols,
          cellHeight: r.height / term.rows,
          devicePixelRatio: window.devicePixelRatio
        }
        return g
      }

      case 'lastWheel':
        return { wheel: host.lastWheel() }

      // xterm's helper textarea, read and never written. See HelperTextareaProbe.
      case 'helperTextarea': {
        const el = host.element.querySelector('.xterm-helper-textarea')
        const ta = el instanceof HTMLTextAreaElement ? el : null
        const answer: HelperTextareaProbe = {
          value: ta ? ta.value : null,
          selectionStart: ta ? ta.selectionStart : null,
          selectionEnd: ta ? ta.selectionEnd : null,
          focused: ta !== null && document.activeElement === ta
        }
        return answer
      }

      case 'latencyStart':
        latency.arm(req.char)
        return { ok: true }

      case 'latencyResults':
        return { samples: latency.results() }

      default:
        return { error: 'unknown op' }
    }
  }
}

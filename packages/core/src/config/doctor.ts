import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DoctorReport } from '../types'
import type { ClaudeCommand } from './mcp'

const run = promisify(execFile)

/**
 * `claude doctor`, surfaced as a health panel (SPEC 4.2).
 *
 * Shown rather than interpreted. The CLI is the authority on whether its own
 * installation is healthy, and the one thing a shell around it must not do is
 * paraphrase that answer into something that disagrees. So the raw text is
 * kept, and the parse below is only enough to lay `Label: value` lines out in a
 * table - anything it fails to recognise still appears in the output block.
 */

const TIMEOUT_MS = 120_000

/** `Auto-update channel: latest` - a label, a colon, a value, no indentation. */
const ROW = /^([A-Za-z][A-Za-z0-9 /-]{1,40}):\s*(.+)$/

function parseRows(output: string): DoctorReport['rows'] {
  const rows: DoctorReport['rows'] = []
  for (const line of output.split(/\r?\n/)) {
    // An indented line belongs to whatever was above it, and a URL in a
    // sentence would otherwise be read as a label.
    if (line !== line.trimStart()) continue
    const match = ROW.exec(line.trim())
    if (!match) continue
    const label = (match[1] ?? '').trim()
    const value = (match[2] ?? '').trim()
    if (label === '' || value === '') continue
    rows.push({ label, value })
  }
  return rows
}

export async function runDoctor(command: ClaudeCommand): Promise<DoctorReport> {
  const started = Date.now()
  const ranAt = new Date().toISOString()

  try {
    const result = await run(command.file, [...(command.prefixArgs ?? []), 'doctor'], {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      // Where *this* process may start the program, which for a WSL command is
      // not the directory the CLI works in: that one is a `\\wsl$\` path and
      // rides on `--cd` in `prefixArgs`. `execFile` given a UNC cwd does not
      // fail - it silently falls back to `C:\Windows` - so the honest thing is
      // to say where to start rather than to let it choose.
      ...(command.hostCwd !== undefined ? { cwd: command.hostCwd } : {})
    })
    const output = `${result.stdout}${result.stderr}`.trim()
    return {
      output,
      rows: parseRows(output),
      exitCode: 0,
      ranAt,
      durationMs: Date.now() - started,
      error: null
    }
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; code?: number; message?: string }
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim()
    return {
      output,
      rows: parseRows(output),
      exitCode: typeof failure.code === 'number' ? failure.code : null,
      ranAt,
      durationMs: Date.now() - started,
      // A non-zero exit from `doctor` is a *finding*, not a failure to run - so
      // the message is only set when there was no output to show at all.
      error: output === '' ? (failure.message ?? 'claude doctor could not be run.') : null
    }
  }
}

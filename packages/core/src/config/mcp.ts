import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { McpAddRequest, McpPreview, McpScope } from '../types'
import { claudeJsonPath } from './effective'
import { readConfigFileContent } from './write'

const run = promisify(execFile)

/**
 * MCP servers, managed by driving the CLI rather than by editing JSON.
 *
 * `claude mcp add` / `add-json` own three different files depending on scope -
 * `.mcp.json` in the project for `project`, `~/.claude.json` under
 * `projects[<cwd>]` for `local`, and that file's top level for `user` - and the
 * shape written differs per transport. Reimplementing that here would be a
 * second implementation of somebody else's format, wrong the first time the CLI
 * changes it. So Helm shells out (SPEC 4.2) and only *predicts* the result well
 * enough to show a diff before the user commits to it.
 *
 * The prediction is never mistaken for the outcome: the file is re-read after
 * the subprocess returns, and it is the re-read that the console displays.
 */

/** How the CLI is invoked. Supplied by the host, because core resolves nothing. */
export interface ClaudeCommand {
  file: string
  /** Arguments that must precede the subcommand, e.g. a script path. */
  prefixArgs?: readonly string[] | undefined
  /**
   * Where the *host* process is started, when that is not the directory the
   * command is about.
   *
   * The two are the same for a CLI on this machine and they are not for one
   * inside a WSL distribution. There the program is `wsl.exe`, the directory
   * the CLI works in is carried on its own argv as `--cd`, and the working
   * directory this process may spawn with is neither: **`CreateProcess`
   * refuses a UNC path** (ENOENT, measured 2026-09-02), so a `\\wsl$\...`
   * project cannot be the spawn's cwd at all.
   *
   * Left unset by every Windows caller, which keeps the ordinary case exactly
   * as it was.
   */
  hostCwd?: string | undefined
}

const TIMEOUT_MS = 60_000

/** The file a given scope writes to, which is what gets snapshotted and diffed. */
export function mcpTargetFile(scope: McpScope, cwd: string): string {
  return scope === 'project' ? join(resolve(cwd), '.mcp.json') : claudeJsonPath()
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** A plain object, or null if the text is not one. */
function parseObject(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * A line diff, computed by the longest common subsequence.
 *
 * A `.mcp.json` is tens of lines, so the quadratic table is a few thousand
 * cells - and the alternative, a diff library, is a dependency for a view that
 * exists to reassure someone before they let a subprocess write a file.
 */
export function diffLines(before: string, after: string): McpPreview['diff'] {
  // The trailing newline is dropped from both sides. A file that ends in one is
  // the normal case, and `split` turns it into a final empty element - which
  // the diff would otherwise render as an added blank line at the bottom of
  // every preview, looking like a change nobody made.
  const split = (text: string): string[] =>
    text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const a = split(before)
  const b = split(after)

  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i]
      const next = lcs[i + 1]
      if (!row || !next) continue
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }

  const out: McpPreview['diff'] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ sign: ' ', text: a[i] ?? '' })
      i++
      j++
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push({ sign: '-', text: a[i] ?? '' })
      i++
    } else {
      out.push({ sign: '+', text: b[j] ?? '' })
      j++
    }
  }
  while (i < a.length) out.push({ sign: '-', text: a[i++] ?? '' })
  while (j < b.length) out.push({ sign: '+', text: b[j++] ?? '' })
  return out
}

/**
 * What the target file would look like with this server in it.
 *
 * Merged the same way the CLI merges it - into `mcpServers` by name, replacing
 * an existing entry rather than deepening it - so a name that is already there
 * shows as a replacement and the user can see what they are about to lose.
 */
export function previewMcpAdd(req: McpAddRequest): McpPreview {
  const file = mcpTargetFile(req.scope, req.cwd)
  const current = readConfigFileContent(file)
  const before = current.exists ? current.content : ''

  const server = parseObject(req.json)
  if (server === null) {
    return {
      file,
      before,
      after: before,
      diff: [],
      replaces: null,
      error: 'The server configuration must be a JSON object, e.g. {"command":"node","args":["server.js"]}.'
    }
  }
  if (req.name.trim() === '') {
    return { file, before, after: before, diff: [], replaces: null, error: 'A server needs a name.' }
  }

  const document = parseObject(before)
  if (document === null) {
    return {
      file,
      before,
      after: before,
      diff: [],
      replaces: null,
      error: `${file} is not a JSON object, so Helm cannot predict what the CLI would write into it.`
    }
  }

  // `local` and `user` differ only in where inside `~/.claude.json` the server
  // lands: the top level for `user`, and under this directory's entry for
  // `local`. `project` is a file whose only content is `mcpServers`.
  const next: Record<string, unknown> = structuredClone(document)
  let container: Record<string, unknown>
  if (req.scope === 'local') {
    const projects = (next['projects'] ??= {}) as Record<string, unknown>
    const key = resolve(req.cwd)
    container = (projects[key] ??= {}) as Record<string, unknown>
  } else {
    container = next
  }
  const servers = (container['mcpServers'] ??= {}) as Record<string, unknown>
  const replaces = Object.prototype.hasOwnProperty.call(servers, req.name)
    ? JSON.stringify(servers[req.name], null, 2)
    : null
  servers[req.name] = server

  const after = `${JSON.stringify(next, null, 2)}\n`
  return { file, before, after, diff: diffLines(before, after), replaces, error: null }
}

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

export interface McpRunResult {
  ok: boolean
  output: string
  exitCode: number | null
}

async function mcp(
  command: ClaudeCommand,
  args: readonly string[],
  cwd: string
): Promise<McpRunResult> {
  try {
    const result = await run(command.file, [...(command.prefixArgs ?? []), 'mcp', ...args], {
      cwd: command.hostCwd ?? cwd,
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    return { ok: true, output: `${result.stdout}${result.stderr}`.trim(), exitCode: 0 }
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; code?: number; message?: string }
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim()
    return {
      ok: false,
      output: output === '' ? (failure.message ?? 'The CLI failed.') : output,
      exitCode: typeof failure.code === 'number' ? failure.code : null
    }
  }
}

export function addMcpServer(command: ClaudeCommand, req: McpAddRequest): Promise<McpRunResult> {
  return mcp(command, ['add-json', req.name, req.json, '-s', req.scope], req.cwd)
}

export function removeMcpServer(
  command: ClaudeCommand,
  req: { name: string; scope: McpScope; cwd: string }
): Promise<McpRunResult> {
  return mcp(command, ['remove', req.name, '-s', req.scope], req.cwd)
}

/**
 * `claude mcp list`, verbatim.
 *
 * Not parsed into rows: the listing health-checks every server, which means it
 * reports OAuth state and connection failures the configuration files cannot,
 * and the wording of those is the CLI's to change. The console shows the
 * configured servers from the files (which it does understand) and this text
 * beside them.
 */
export function listMcpServers(command: ClaudeCommand, cwd: string): Promise<McpRunResult> {
  return mcp(command, ['list'], cwd)
}

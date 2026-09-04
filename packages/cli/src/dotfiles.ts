import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SNIPPET_HEADER } from './snippets.ts'

/** `<file>.<YYYYMMDD-HHMMSS>.bak`, beside the file. */
export function backupName(file: string, at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${String(at.getFullYear())}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  return `${file}.${stamp}.bak`
}

export function hasLine(text: string, line: string): boolean {
  return text.split('\n').some((l) => l.trim() === line.trim())
}

/** The text with `line` appended once, or unchanged when it is already there. */
export function withLine(text: string, line: string): { text: string; changed: boolean } {
  if (hasLine(text, line)) return { text, changed: false }
  const sep = text === '' || text.endsWith('\n') ? '' : '\n'
  return { text: `${text}${sep}${line}\n`, changed: true }
}

export type AppendOutcome = { changed: false } | { changed: true; backup: string | null }

/** Appends one line to a dotfile the user owns, backing it up first when it exists. */
export function appendLine(file: string, line: string, at: Date = new Date()): AppendOutcome {
  const existed = existsSync(file)
  const before = existed ? readFileSync(file, 'utf8') : ''
  const next = withLine(before, line)
  if (!next.changed) return { changed: false }
  let backup: string | null = null
  if (existed) {
    backup = backupName(file, at)
    copyFileSync(file, backup)
  }
  writeFileSync(file, next.text)
  return { changed: true, backup }
}

export function isHelmSnippet(text: string): boolean {
  return text.split('\n')[0]?.trim() === SNIPPET_HEADER
}

export type SnippetOutcome = 'written' | 'unchanged' | 'refused'

/**
 * Helm's own files are rewritten freely; a file at that path without the header
 * is somebody else's and is left alone (TERMINAL.md 10).
 */
export function writeSnippet(file: string, content: string): SnippetOutcome {
  if (existsSync(file)) {
    const current = readFileSync(file, 'utf8')
    if (!isHelmSnippet(current)) return 'refused'
    if (current === content) return 'unchanged'
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return 'written'
}

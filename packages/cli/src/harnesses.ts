import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * The harness index is a JSON file, `<data>/harnesses.json`, rather than a
 * table. It is a list of directories somebody registered - nothing joins to it,
 * nothing else writes it, and a file a person can read and fix beats a schema
 * migration for a dozen strings. Roots are stored absolute and unique; the
 * harness enclosing the cwd is merged in at read time and never written.
 */
export function readHarnessIndex(file: string): string[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${file} is not readable JSON.`)
  }
  const roots = Array.isArray(parsed) ? parsed : (parsed as { harnesses?: unknown })?.harnesses
  if (!Array.isArray(roots)) throw new Error(`${file} does not hold a list of harness roots.`)
  return mergeHarnessRoots(roots.filter((r): r is string => typeof r === 'string'))
}

export function writeHarnessIndex(file: string, roots: readonly string[]): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ harnesses: mergeHarnessRoots(roots) }, null, 2)}\n`)
}

/** Absolute, deduplicated, in first-seen order; null entries are dropped. */
export function mergeHarnessRoots(...lists: readonly (readonly (string | null)[])[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const root of list) {
      if (root === null) continue
      const abs = resolve(root)
      if (seen.has(abs)) continue
      seen.add(abs)
      out.push(abs)
    }
  }
  return out
}

export function isHarnessDir(dir: string): boolean {
  return existsSync(resolve(dir, 'harness.yaml'))
}

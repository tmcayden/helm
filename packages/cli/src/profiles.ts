import { readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import { profileFromYaml, validateProfile } from '@helm/core'
import type { ProfileDraft } from '@helm/core/types'

/** One `<harness>/.helm/profiles/<name>.yaml`, parsed or not. */
export interface ProfileEntry {
  /** From the document, or the file's stem when the document has none. */
  name: string
  harness: string
  file: string
  /** Null when the file could not be read as a profile at all. */
  draft: ProfileDraft | null
  problems: string[]
}

export const PROFILES_DIR = join('.helm', 'profiles')

/**
 * Two keys are optional here that `profileFromYaml` requires: a profile's root
 * is its harness (TERMINAL.md 3), and its name is its file name unless the
 * document says otherwise. Both are filled in before core reads the text, so
 * core's spelling of every other field stays the only one.
 */
export function parseProfileFile(text: string, file: string, harness: string): ProfileEntry {
  const stem = basename(file, extname(file))
  let doc: unknown
  try {
    doc = parse(text)
  } catch (err) {
    return { name: stem, harness, file, draft: null, problems: [describe(err)] }
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { name: stem, harness, file, draft: null, problems: ['A profile file must be a YAML mapping.'] }
  }
  const filled = { name: stem, root: harness, ...(doc as Record<string, unknown>) }
  try {
    const draft = profileFromYaml(stringify(filled))
    return { name: draft.name, harness, file, draft, problems: validateProfile(draft) }
  } catch (err) {
    return { name: stem, harness, file, draft: null, problems: [describe(err)] }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function readHarnessProfiles(harness: string): ProfileEntry[] {
  const dir = join(resolve(harness), PROFILES_DIR)
  let files: string[]
  try {
    files = readdirSync(dir).filter((name) => /\.ya?ml$/i.test(name))
  } catch {
    return []
  }
  return files
    .sort()
    .map((name) => {
      const file = join(dir, name)
      return parseProfileFile(readFileSync(file, 'utf8'), file, resolve(harness))
    })
}

export function readAllProfiles(harnesses: readonly string[]): ProfileEntry[] {
  return harnesses.flatMap((harness) => readHarnessProfiles(harness))
}

export type ProfileResolution =
  | { kind: 'found'; entry: ProfileEntry }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; candidates: ProfileEntry[] }

/** By name, across harnesses; `harness` narrows to one when two share a name. */
export function resolveProfile(
  entries: readonly ProfileEntry[],
  name: string,
  harness: string | null = null
): ProfileResolution {
  const wanted = harness === null ? null : resolve(harness)
  const matches = entries.filter(
    (entry) => entry.name === name && (wanted === null || entry.harness === wanted)
  )
  if (matches.length === 0) return { kind: 'missing' }
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches }
  return { kind: 'found', entry: matches[0] as ProfileEntry }
}

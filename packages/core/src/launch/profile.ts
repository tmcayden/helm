import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parse, stringify } from 'yaml'
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  formatLaunchTarget,
  parseLaunchTarget,
  type EffortLevel,
  type PermissionMode,
  type LaunchTarget,
  type Profile,
  type ProfileDraft
} from '../types'


/**
 * A profile as a file, so it can travel with a harness (SPEC 3).
 *
 * The wire format is the one the spec prints: snake_case keys, and paths
 * written relative to the profile's own root wherever they are under it. That
 * second part is what makes an export portable rather than merely serialised -
 * the same harness cloned to `D:\work\dev` on another machine still resolves
 * `repos/acme`, where an absolute path would resolve to nothing.
 *
 * Import reverses it against the root, so a profile that has been through the
 * file is the profile that went in.
 *
 * `pinnedOrder` is deliberately not part of the document. It is where this
 * launcher puts the profile in its own list, not anything about the launch -
 * and importing a folder of five exported profiles that each claim to be first
 * is not an order, it is a collision. Imports arrive unpinned.
 */

/** The document written to disk. Every field optional on the way in. */
interface ProfileDocument {
  name?: unknown
  root?: unknown
  overlays?: unknown
  access?: unknown
  model?: unknown
  effort?: unknown
  permission_mode?: unknown
  agent?: unknown
  mcp?: unknown
  opening_prompt?: unknown
  target?: unknown
}

/**
 * `target:` on the wire, through the same codec the `target` column uses.
 *
 * A value this cannot read is dropped rather than fatal, which is this file's
 * rule for every other field: a distro named in a file from another machine is
 * a setting to fix in the editor, not a refusal to import.
 */
function asTarget(value: unknown): LaunchTarget | null {
  return parseLaunchTarget(typeof value === 'string' ? value : null)
}

/** `~` for the home directory, as the spec's example writes it. */
function contractHome(path: string): string {
  const home = resolve(homedir())
  const abs = resolve(path)
  if (abs.toLowerCase() === home.toLowerCase()) return '~'
  const rel = relative(home, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) return abs
  return `~/${rel.split(sep).join('/')}`
}

function expandHome(path: string): string {
  if (path === '~') return resolve(homedir())
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2))
  return path
}

/** Under the root, written relative to it; anywhere else, left absolute. */
function contractPath(path: string, root: string): string {
  const abs = resolve(path)
  const rel = relative(resolve(root), abs)
  if (rel === '') return '.'
  if (rel.startsWith('..') || isAbsolute(rel)) return contractHome(abs)
  return rel.split(sep).join('/')
}

function expandPath(path: string, root: string): string {
  const expanded = expandHome(path)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded)
}

export function profileToYaml(profile: ProfileDraft): string {
  const root = resolve(profile.root)
  const document = {
    name: profile.name,
    root: contractHome(root),
    overlays: profile.overlays.map((path) => contractPath(path, root)),
    access: profile.access.map((path) => contractPath(path, root)),
    model: profile.model,
    effort: profile.effort,
    permission_mode: profile.permissionMode,
    agent: profile.agent,
    mcp: profile.mcp,
    opening_prompt: profile.openingPrompt,
    target: formatLaunchTarget(profile.target)
  }
  // `null` rather than an omitted key for the unset ones: the export doubles as
  // the format a person edits by hand, and a listed key with a null value shows
  // what can be set where an absent one shows nothing.
  return stringify(document, { nullStr: 'null', lineWidth: 0 })
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asEffort(value: unknown): EffortLevel | null {
  const found = EFFORT_LEVELS.find((level) => level === value)
  return found ?? null
}

function asPermissionMode(value: unknown): PermissionMode | null {
  const found = PERMISSION_MODES.find((mode) => mode === value)
  return found ?? null
}

/**
 * Parses an exported profile.
 *
 * Throws only for a document that is not a profile at all. A field whose value
 * is not one the CLI accepts - an `effort` of `medium-high`, say - is dropped
 * rather than fatal: the alternative is refusing to import a file over a
 * setting the user can see and fix in the editor afterwards.
 */
export function profileFromYaml(text: string): ProfileDraft {
  let parsed: unknown
  try {
    parsed = parse(text)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Not a readable YAML document: ${detail}`, { cause: err })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('A profile file must be a YAML mapping.')
  }

  const doc = parsed as ProfileDocument
  const name = asNullableString(doc.name)
  const rawRoot = asNullableString(doc.root)
  if (name === null) throw new Error('A profile needs a `name`.')
  if (rawRoot === null) throw new Error('A profile needs a `root`.')

  const root = resolve(expandHome(rawRoot))
  return {
    name,
    root,
    overlays: asStringArray(doc.overlays).map((path) => expandPath(path, root)),
    access: asStringArray(doc.access).map((path) => expandPath(path, root)),
    model: asNullableString(doc.model),
    effort: asEffort(doc.effort),
    permissionMode: asPermissionMode(doc.permission_mode),
    agent: asNullableString(doc.agent),
    mcp: asStringArray(doc.mcp),
    openingPrompt: asNullableString(doc.opening_prompt),
    pinnedOrder: null,
    target: asTarget(doc.target)
  }
}

/** A stored profile, minus its identity - what export and equality care about. */
export function profileDraft(profile: Profile): ProfileDraft {
  return {
    name: profile.name,
    root: profile.root,
    overlays: profile.overlays,
    access: profile.access,
    model: profile.model,
    effort: profile.effort,
    permissionMode: profile.permissionMode,
    agent: profile.agent,
    mcp: profile.mcp,
    openingPrompt: profile.openingPrompt,
    pinnedOrder: profile.pinnedOrder,
    target: profile.target
  }
}

/**
 * Rejects a draft the store should not accept.
 *
 * Returns every problem rather than the first, because these are shown against
 * the fields of a form and fixing them one round trip at a time is the worse
 * version of the same dialog.
 */
export function validateProfile(draft: ProfileDraft): string[] {
  const problems: string[] = []
  if (draft.name.trim().length === 0) problems.push('A profile needs a name.')
  if (draft.root.trim().length === 0) problems.push('A profile needs a root directory.')
  else if (!isAbsolute(resolve(draft.root))) problems.push('The root must be an absolute path.')
  if (draft.effort !== null && !EFFORT_LEVELS.includes(draft.effort)) {
    problems.push(`Effort must be one of ${EFFORT_LEVELS.join(', ')}.`)
  }
  if (draft.permissionMode !== null && !PERMISSION_MODES.includes(draft.permissionMode)) {
    problems.push(`Permission mode must be one of ${PERMISSION_MODES.join(', ')}.`)
  }
  // A target names a distro that has to exist *at launch*, not now: one can be
  // installed, renamed or removed between saving a profile and running it, so
  // this checks the shape and leaves existence to the launch, which is where a
  // useful sentence about it can be written.
  if (draft.target !== null && draft.target.kind === 'wsl' && draft.target.distro.trim() === '') {
    problems.push('A WSL target needs a distribution name.')
  }
  return problems
}

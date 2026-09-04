import type {
  ConfigFile,
  ConfigLive,
  ConfigLiveState,
  ConfigSettingLive,
  EffectiveView,
  HookBinding,
  SettingsLayerKind
} from '../types'
import { pathKey } from '../paths/key'

/**
 * What the effective view has to say about one file in a `.claude` tree.
 *
 * `computeEffectiveView` already knows which skills resolve, under which
 * overlay namespace, and which layer won each setting leaf. The Files view was
 * showing none of it, which left the list reading as a directory listing - and
 * a directory listing is the one thing a file explorer already does better.
 * This is the join between the two: given a file and a resolution, what would
 * a session do with it.
 *
 * Pure, and derived entirely from an `EffectiveView` that has already been
 * computed. Two consequences are deliberate:
 *
 *   - **It never reads a file.** Everything here comes out of the view, so the
 *     answer for a row can never disagree with the answer the Effective tab
 *     gives for the same file - they are the same computation, read twice.
 *   - **It states nothing when there is no view.** Every caller passes a view
 *     that may be null (loading, or a scope nothing has resolved yet), and the
 *     answer is then `null` rather than a guess. The usage figures' rule: paint
 *     nothing rather than a wrong number.
 *
 * A resolution is a *working directory*, not a scope. The same
 * `~/.claude/settings.json` is wholly live under one directory and half
 * shadowed under another, so every answer here is relative to `view.cwd` and
 * the surface that paints it has to say so.
 */

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Two absolute paths naming the same file.
 *
 * Separator-blind, and on Windows case-insensitive, because this compares paths
 * that arrived by different routes: the tree walk joins with the platform
 * separator, a settings file quotes whatever somebody typed, and on Windows
 * those differ in both respects for the same file. On Linux case is a different
 * file, so only the separators fold there.
 */
export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return normalise(a, platform) === normalise(b, platform)
}

function normalise(path: string, platform: NodeJS.Platform): string {
  return pathKey(path.replace(/\\/g, '/').replace(/\/+$/, ''), platform)
}

/** A relative path folded for textual matching against a known file name. */
function fold(path: string): string {
  return normalise(path, 'win32')
}

/**
 * A file mentioned inside a settings value.
 *
 * Textual, because that is what the value is: a hook's command is a shell line
 * and a status line's is a program with arguments, and neither is a path field
 * this can parse. So the test is deliberately conservative - the whole relative
 * path, or the file name at a path boundary - rather than a bare `includes`,
 * which would report every `index.js` in the tree as the one a command runs.
 */
function mentions(value: string, file: ConfigFile): boolean {
  const haystack = value.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase()
  const rel = fold(file.relPath)
  if (rel !== '' && haystack.includes(rel)) return true
  const name = rel.split('/').at(-1) ?? ''
  if (name === '') return false
  const at = haystack.indexOf(name)
  if (at < 0) return false
  const before = at === 0 ? '' : haystack[at - 1]
  // A name at a path boundary. `statusline-command.js` inside
  // `my-statusline-command.js` is a different file with a longer name.
  return before === undefined || before === '' || /[/\s"'=]/.test(before)
}

// ---------------------------------------------------------------------------
// Files the CLI owns
// ---------------------------------------------------------------------------

/**
 * What the CLI's own working files in a `.claude` directory are.
 *
 * They land in `other` because they are not configuration, and the group reads
 * as a dumping ground without this. Each line says what writes the file and
 * whether a session reads it - which is the question the rest of this module
 * answers for everything else, and the honest answer here is "no".
 *
 * Keyed on the relative path, so `hooks/history.jsonl` - a file somebody's own
 * hook wrote - is not described as Claude Code's prompt history.
 */
const CLI_FILES: ReadonlyArray<{ rel: string; summary: string; redacted?: boolean }> = [
  {
    rel: '.credentials.json',
    summary: 'OAuth tokens, written by `claude` at sign-in. Helm never opens this file.',
    redacted: true
  },
  {
    rel: 'history.jsonl',
    summary: 'Every prompt typed on this machine, appended by the CLI. Helm reads it for the session index; a session never reads it back.'
  },
  { rel: '.claude-spec-version', summary: 'A version stamp the CLI writes when it upgrades itself.' },
  { rel: 'stats-cache.json', summary: 'The CLI’s cached usage figures. Safe to delete; it is rebuilt.' },
  { rel: 'usage-cache.json', summary: 'The CLI’s cached usage figures. Safe to delete; it is rebuilt.' },
  { rel: 'mcp_config.json', summary: 'An MCP server list the CLI no longer reads from here. `.mcp.json` and `~/.claude.json` are the two it does.' },
  { rel: 'settings.local.json', summary: 'A local settings file. The CLI reads one of these beside a project’s `settings.json`, not in the user directory.' }
]

function cliFile(file: ConfigFile): (typeof CLI_FILES)[number] | null {
  const rel = fold(file.relPath)
  return CLI_FILES.find((known) => known.rel.toLowerCase() === rel) ?? null
}

/**
 * A file Helm will not open, whatever else it would do with it.
 *
 * The credentials rule (CLAUDE.md) is that a sign-in is detected from the
 * *existence* of an artefact and nothing opens one. The console reads a file's
 * bytes to show them, so the console is exactly the surface that would break
 * that rule by accident - it is a `.json` in a directory full of `.json` that
 * Helm is otherwise right to open.
 */
export function isRedactedConfigFile(relPath: string): boolean {
  const rel = fold(relPath)
  return CLI_FILES.some((known) => known.redacted === true && known.rel.toLowerCase() === rel)
}

/** What a file the resolution has nothing to say about is, when Helm knows. */
export function configFileNote(file: ConfigFile): string | null {
  return cliFile(file)?.summary ?? null
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Every leaf this settings file declares, and whether it survived the merge.
 *
 * Read out of the resolved settings rather than by parsing the file again: each
 * `EffectiveSetting` carries every layer that named the key, so "what does this
 * file say" and "what won" are two reads of one answer. Parsing the file here
 * would be a second implementation of the merge, free to disagree with the one
 * the Effective tab shows.
 */
export function settingsDeclaredBy(path: string, view: EffectiveView): ConfigSettingLive[] {
  const rows: ConfigSettingLive[] = []
  for (const setting of view.settings) {
    // An empty document flattens to one nameless leaf - `{}` at the root hits
    // the same "an empty object is a leaf" branch that `env: {}` does. A file
    // that says nothing has no keys, so the nameless one is not counted here.
    if (setting.key === '') continue
    const mine = setting.candidates.find((candidate) => samePath(candidate.file, path))
    if (!mine) continue
    const winner = setting.candidates[0]
    // Not "is this the winning layer" but "is this the winning *value*": two
    // layers that agree have not overridden each other, and calling the lower
    // one shadowed would invent a disagreement nobody made.
    const wins = winner === undefined || winner.value === mine.value
    rows.push({
      key: setting.key,
      value: mine.value,
      layer: mine.layer,
      wins,
      outrankedBy:
        wins || winner === undefined
          ? null
          : { layer: winner.layer, file: winner.file, value: winner.value }
    })
  }
  return rows
}

/** The layer a settings file is in the chain, or null when it is not in it. */
function layerOf(path: string, view: EffectiveView): SettingsLayerKind | null {
  return view.settingsLayers.find((layer) => samePath(layer.file, path))?.kind ?? null
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

interface HookEntry {
  matcher?: unknown
  hooks?: unknown
}

/**
 * Which events fire this file, and from which settings block.
 *
 * `hooks.<Event>` arrives here as one leaf carrying the whole array, because
 * the effective view flattens objects and stops at arrays - an array in a
 * settings file is a list the CLI consumes whole. So the array is parsed back
 * out and matched against the file, which is the only place in this module that
 * looks inside a value.
 *
 * The layer is carried through because it is half the answer: a hook that fires
 * is one thing, a hook that fires *because the local settings say so* is
 * another, and the second is what a person needs when they are wondering why a
 * project behaves differently on their machine than on anybody else's.
 */
export function hookBindings(file: ConfigFile, view: EffectiveView): HookBinding[] {
  const bindings: HookBinding[] = []
  for (const setting of view.settings) {
    if (!setting.key.startsWith('hooks.')) continue
    const event = setting.key.slice('hooks.'.length)
    // A nested leaf (`hooks.PreToolUse.something`) is not the array this
    // understands, and an event name never contains a dot.
    if (event === '' || event.includes('.')) continue

    for (const candidate of setting.candidates) {
      let parsed: unknown
      try {
        parsed = JSON.parse(candidate.value)
      } catch {
        continue
      }
      if (!Array.isArray(parsed)) continue
      for (const raw of parsed) {
        if (raw === null || typeof raw !== 'object') continue
        const entry = raw as HookEntry
        const inner = Array.isArray(entry.hooks) ? entry.hooks : []
        for (const step of inner) {
          if (step === null || typeof step !== 'object') continue
          const command = (step as { command?: unknown }).command
          if (typeof command !== 'string' || !mentions(command, file)) continue
          bindings.push({
            event,
            matcher: typeof entry.matcher === 'string' && entry.matcher !== '' ? entry.matcher : null,
            command,
            layer: candidate.layer,
            file: candidate.file
          })
        }
      }
    }
  }
  return bindings
}

/** Settings leaves that name this file - a status line's command, and so on. */
export function settingReferences(
  file: ConfigFile,
  view: EffectiveView
): Array<{ key: string; layer: SettingsLayerKind; file: string; value: string }> {
  const out: Array<{ key: string; layer: SettingsLayerKind; file: string; value: string }> = []
  for (const setting of view.settings) {
    if (setting.key.startsWith('hooks.')) continue
    const winner = setting.candidates[0]
    if (!winner || !mentions(winner.value, file)) continue
    out.push({ key: setting.key, layer: winner.layer, file: winner.file, value: winner.value })
  }
  return out
}

/** True when a settings layer has turned every hook off. */
function hooksDisabled(view: EffectiveView): boolean {
  return view.settings.find((setting) => setting.key === 'disableAllHooks')?.value === 'true'
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

const empty = (state: ConfigLiveState, note: string | null, reason: string): ConfigLive => ({
  state,
  note,
  reason,
  invocation: null,
  alsoDefinedBy: [],
  contested: false,
  settings: [],
  hooks: [],
  references: []
})

/**
 * What a session in `view.cwd` would do with this file.
 *
 * The six states are a deliberate spread rather than live/dead, because "not
 * live" hides three different situations that need three different reactions:
 * a file that is outranked (change the other one), a file that is empty
 * (nothing to change), and a file this resolution never looks at at all
 * (you are pointed at the wrong directory).
 */
export function computeConfigLive(file: ConfigFile, view: EffectiveView | null): ConfigLive | null {
  if (view === null) return null

  switch (file.kind) {
    case 'settings':
    case 'settings-local':
      return settingsLive(file, view)
    case 'skill':
    case 'command':
    case 'agent':
      return entryLive(file, view)
    case 'claude-md':
      return instructionLive(file, view)
    case 'hook':
      return hookLive(file, view)
    case 'mcp':
      return mcpLive(file, view)
    default:
      return otherLive(file, view)
  }
}

function settingsLive(file: ConfigFile, view: EffectiveView): ConfigLive {
  const layer = layerOf(file.path, view)
  const rows = settingsDeclaredBy(file.path, view)
  const base = { ...empty('live', null, ''), settings: rows }

  if (layer === null) {
    // A settings file that is not one of the three the CLI reads for this
    // directory. `~/.claude/settings.local.json` is the one people are
    // surprised by: the CLI reads a local file beside a *project's* settings.
    return {
      ...base,
      state: 'absent',
      note: 'not read from here',
      reason: `The CLI reads three settings files for ${view.cwd}, and this is not one of them.`
    }
  }

  const broken = view.settingsLayers.find((candidate) => samePath(candidate.file, file.path))?.error
  if (broken != null) {
    return {
      ...base,
      state: 'inert',
      note: 'not valid JSON',
      reason: `The CLI cannot parse this file, so it ignores all of it: ${broken}`
    }
  }

  if (rows.length === 0) {
    return {
      ...base,
      state: 'inert',
      note: 'contributes nothing',
      reason: `This file is the ${layer} layer for ${view.cwd} and declares no settings.`
    }
  }

  const shadowed = rows.filter((row) => !row.wins)
  if (shadowed.length === 0) {
    return {
      ...base,
      state: 'live',
      note: rows.length === 1 ? 'its one key wins' : `all ${rows.length} keys win`,
      reason: `Every key this file sets is the value a session in ${view.cwd} would see.`
    }
  }
  const outranking = [...new Set(shadowed.map((row) => row.outrankedBy?.layer ?? ''))].filter(
    (name) => name !== ''
  )
  if (shadowed.length === rows.length) {
    return {
      ...base,
      state: 'shadowed',
      note: `every key outranked by ${outranking.join(' and ')}`,
      reason: `A higher layer sets a different value for all ${rows.length} of this file's keys, so none of them reaches a session in ${view.cwd}.`
    }
  }
  return {
    ...base,
    state: 'partial',
    note: `${shadowed.length} of ${rows.length} keys outranked by ${outranking.join(' and ')}`,
    reason: `${shadowed.length} of this file's ${rows.length} keys are set to a different value by a higher layer.`
  }
}

function entryLive(file: ConfigFile, view: EffectiveView): ConfigLive {
  const pool =
    file.kind === 'skill' ? view.skills : file.kind === 'command' ? view.commands : view.agents
  const mine = pool.find((entry) => samePath(entry.path, file.path))
  const what = file.kind === 'skill' ? 'skill' : file.kind === 'command' ? 'command' : 'agent'

  if (!mine) {
    return {
      ...empty(
        'absent',
        'not resolved here',
        `Nothing in ${view.cwd} composes this ${what}, so no session started there could invoke it.`
      )
    }
  }

  // Every other copy of the same *name*. Not a collision report: the platform
  // prefixes everything an overlay contributes, so two overlays defining
  // `think` both resolve. The exception is two unprefixed sources - the user
  // directory and the working directory - which really do land on one name.
  const others = pool.filter(
    (entry) => entry.name === mine.name && !samePath(entry.path, file.path)
  )
  const contested = others.some((entry) => entry.invocation === mine.invocation)
  const invocation = file.kind === 'command' ? `/${mine.invocation}` : mine.invocation

  const answer: ConfigLive = {
    ...empty('live', null, ''),
    invocation,
    alsoDefinedBy: others.map((entry) => ({
      invocation: file.kind === 'command' ? `/${entry.invocation}` : entry.invocation,
      source: entry.source,
      origin: entry.origin,
      path: entry.path
    })),
    contested
  }

  if (contested) {
    return {
      ...answer,
      state: 'partial',
      note: `${invocation} is defined twice`,
      reason: `Two unprefixed sources define ${mine.name}. Helm does not predict which one the CLI resolves - only an overlay's copy is guaranteed its own name.`
    }
  }
  return {
    ...answer,
    state: 'live',
    note:
      file.kind === 'command'
        ? `available as ${invocation}`
        : mine.namespace === null
          ? `resolves as ${invocation}`
          : `resolves as ${invocation}, under the ${mine.namespace} overlay`,
    reason: `A session in ${view.cwd} resolves this ${what} as ${invocation}.`
  }
}

function instructionLive(file: ConfigFile, view: EffectiveView): ConfigLive {
  const mine = view.instructions.find((entry) => samePath(entry.path, file.path))
  if (!mine) {
    return empty(
      'absent',
      'not read here',
      `A session in ${view.cwd} is given the user's CLAUDE.md, the working directory's, and each overlay's. This is none of them.`
    )
  }
  return empty(
    'live',
    'read at session start',
    `Handed to every session in ${view.cwd}, in the order user, working directory, overlays.`
  )
}

function hookLive(file: ConfigFile, view: EffectiveView): ConfigLive {
  const bindings = hookBindings(file, view)
  const references = settingReferences(file, view)
  const base = { ...empty('inert', null, ''), hooks: bindings, references }
  if (bindings.length === 0) {
    // A program under `hooks/` that no `hooks` block runs may still be run by
    // something else - a status line's command is the one this was found by.
    // Its directory is a convention, and a convention is not a claim about
    // what reads it.
    if (references.length > 0) {
      const first = references[0]
      return {
        ...base,
        state: 'live',
        note: `run by ${first?.key ?? 'a setting'}`,
        reason: `No hooks block runs this, but ${first?.key ?? 'a setting'} in the ${first?.layer ?? ''} layer names it, so a session in ${view.cwd} runs it.`
      }
    }
    return {
      ...base,
      state: 'inert',
      note: 'no settings block runs it',
      reason: `A file under hooks/ runs because a settings file names it. Nothing in the three layers for ${view.cwd} does.`
    }
  }
  if (hooksDisabled(view)) {
    return {
      ...base,
      state: 'shadowed',
      note: 'every hook is disabled',
      reason: '`disableAllHooks` is set, which turns off every hook without deleting any of them.'
    }
  }
  const events = [...new Set(bindings.map((binding) => binding.event))]
  return {
    ...base,
    state: 'live',
    note: events.length === 1 ? `runs on ${events[0] ?? ''}` : `runs on ${events.length} events`,
    reason: `Fired by ${events.join(', ')} for a session in ${view.cwd}.`
  }
}

function mcpLive(file: ConfigFile, view: EffectiveView): ConfigLive {
  const mine = view.mcpServers.filter((server) => samePath(server.file, file.path))
  if (mine.length === 0) {
    return empty(
      'inert',
      'declares no servers',
      `Nothing in this file reaches a session in ${view.cwd}.`
    )
  }
  const approved = mine.filter((server) => server.approved !== false)
  if (approved.length === 0) {
    return empty(
      'shadowed',
      `${mine.length} declared, none approved`,
      'A `.mcp.json` server gates on first launch until a settings layer approves it.'
    )
  }
  if (approved.length < mine.length) {
    return empty(
      'partial',
      `${approved.length} of ${mine.length} servers approved`,
      'The rest gate on first launch until a settings layer approves them.'
    )
  }
  return empty(
    'live',
    mine.length === 1 ? 'its server is approved' : `all ${mine.length} servers approved`,
    `Loaded by a session in ${view.cwd}.`
  )
}

/**
 * Everything else: `rules/`, a script beside the settings that names it, and
 * the CLI's own working files.
 *
 * The default is **no claim at all**, which is the important half. A file Helm
 * has nothing to say about gets no dot and no pill, rather than a confident
 * "not loaded" - `rules/` is a convention some instruction files reference and
 * nothing here can see that reference.
 */
function otherLive(file: ConfigFile, view: EffectiveView): ConfigLive {
  const references = settingReferences(file, view)
  if (references.length > 0) {
    const first = references[0]
    return {
      ...empty(
        'live',
        `run by ${first?.key ?? 'a setting'}`,
        `Named by ${first?.key ?? 'a setting'} in the ${first?.layer ?? ''} settings layer, so a session in ${view.cwd} runs it.`
      ),
      references
    }
  }
  const known = cliFile(file)
  if (known) {
    return empty('inert', 'not part of a session', known.summary)
  }
  return empty('none', null, '')
}

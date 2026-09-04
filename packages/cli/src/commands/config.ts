import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import {
  buildLaunchArgs,
  claudeHome,
  claudeJsonPath,
  composeOverlayMemory,
  computeConfigLive,
  computeEffectiveView,
  findEnclosingHarness,
  hashContent,
  insertConfigSnapshot,
  planOverlays,
  projectConfigScope,
  readConfigFileContent,
  readConfigSnapshots,
  readConfigTree,
  restoreConfigSnapshot,
  snapshotKey,
  userConfigScope
} from '@helm/core'
import type { ConfigScope, EffectiveView, ProfileDraft } from '@helm/core/types'
import { flagInt, flagString } from '../args.ts'
import type { CommandContext } from '../command.ts'
import { snapshotTargetFor } from '../config-files.ts'
import { isHarnessDir } from '../harnesses.ts'
import type { ConfigDoctorJson, ConfigSnapshotJson, ConfigSnapshotListJson, ConfigTreeJson } from '../json.ts'
import { CliError, print, printJson, table, warn } from '../output.ts'
import { shimRoot } from '../paths.ts'
import { requireDraft, resolveContextProfile } from '../profile-context.ts'
import { readHarnessProfiles, type ProfileEntry } from '../profiles.ts'
import { withStore } from '../store.ts'

/** What `claude` would load at the profile's root: the same call the desktop's config console makes. */
export function effectiveViewFor(draft: ProfileDraft): EffectiveView {
  return computeEffectiveView({ cwd: draft.root, overlays: draft.overlays, profileName: draft.name })
}

/**
 * The argv a launch would run, planned rather than prepared: `planOverlays`
 * only reads the overlay directories and `buildLaunchArgs` is pure, so nothing
 * lands under the shim root. `prepareLaunch` is what writes the shims and the
 * composed CLAUDE.md, and its memory file's name is its own, so the answer says
 * whether one would be passed rather than guessing its path.
 */
export function planArgv(draft: ProfileDraft, shims: string): { argv: string[]; composesMemory: boolean } {
  const plans = planOverlays(draft.overlays.filter((dir) => existsSync(dir)), shims)
  return {
    argv: buildLaunchArgs({
      root: draft.root,
      name: draft.name,
      overlays: draft.overlays,
      access: draft.access,
      model: draft.model,
      effort: draft.effort,
      permissionMode: draft.permissionMode,
      agent: draft.agent,
      openingPrompt: draft.openingPrompt,
      pluginDirs: plans.map((plan) => plan.dir),
      target: null
    }),
    composesMemory: composeOverlayMemory(plans) !== null
  }
}

/** The scope, and the effective view of the one profile whose harness encloses it - or null, and `live` says nothing. */
async function scopeFor(dir: string): Promise<{ scope: ConfigScope; profile: ProfileEntry | null }> {
  const abs = resolve(dir)
  const scope =
    abs === resolve(homedir()) ? userConfigScope() : projectConfigScope(abs, isHarnessDir(abs) ? 'harness' : 'project')
  const harness = scope.kind === 'user' ? null : await findEnclosingHarness(abs)
  const entries = harness === null ? [] : readHarnessProfiles(harness)
  const only = entries.length === 1 ? (entries[0] as ProfileEntry) : null
  return { scope, profile: only !== null && only.draft !== null && only.problems.length === 0 ? only : null }
}

export async function configTree(ctx: CommandContext): Promise<number> {
  const dir = ctx.args.flags['user'] === true ? homedir() : ctx.args.positionals[0]
  if (dir === undefined) throw new CliError('helm config tree needs a scope directory or --user.', 2)
  const { scope, profile } = await scopeFor(dir)
  const tree = readConfigTree(scope)
  const view = profile === null ? null : effectiveViewFor(requireDraft(profile))
  const json: ConfigTreeJson = {
    scope,
    profile: profile?.name ?? null,
    files: tree.files.map((file) => ({ ...file, live: computeConfigLive(file, view) })),
    errors: tree.errors,
    scannedAt: tree.scannedAt
  }
  if (ctx.json) {
    printJson(json)
    return 0
  }
  if (!scope.exists) {
    print(`${scope.claudeDir} does not exist.`)
    return 0
  }
  print(`${scope.label} (${scope.kind})  ${scope.claudeDir}${profile === null ? '' : `  live against profile ${profile.name}`}`)
  if (json.files.length === 0) print('Nothing in the tree.')
  else {
    print(
      table([
        ['KIND', 'NAME', 'STATE', 'NOTE', 'PATH'],
        ...json.files.map((f) => [f.kind, f.name, f.live?.state ?? '-', f.live?.note ?? '', f.relPath])
      ])
    )
  }
  for (const error of tree.errors) warn(`warning: ${error}`)
  return 0
}

export async function configDoctor(ctx: CommandContext): Promise<number> {
  const { entry, resolvedBy } = await resolveContextProfile(flagString(ctx.args.flags, 'profile'))
  const draft = requireDraft(entry)
  const view = effectiveViewFor(draft)
  const { argv, composesMemory } = planArgv(draft, shimRoot())
  const json: ConfigDoctorJson = {
    profile: { name: entry.name, harness: entry.harness, file: entry.file, root: draft.root, resolvedBy },
    view,
    argv,
    composesMemory
  }
  if (ctx.json) {
    printJson(json)
    return 0
  }
  print(describeDoctor(json))
  return 0
}

export function describeDoctor(d: ConfigDoctorJson): string {
  const { view } = d
  const out: string[] = [`profile ${d.profile.name} (${d.profile.resolvedBy})  ${d.profile.file}`, `root ${view.cwd}`, '']
  const section = (title: string, rows: string[][], empty: string) => {
    out.push(title)
    out.push(rows.length === 0 ? `  ${empty}` : indent(table(rows)))
    out.push('')
  }
  section(
    'overlays',
    view.overlays.map((o) => [o.name, o.exists ? `${String(o.skills)} skills, ${String(o.commands)} commands, ${String(o.agents)} agents` : 'missing', o.projectPath]),
    'none'
  )
  for (const [title, entries] of [['skills', view.skills], ['commands', view.commands], ['agents', view.agents]] as const) {
    section(title, entries.map((e) => [e.invocation, e.source, e.path]), 'none')
  }
  const hooks = view.settings.filter((s) => s.key.startsWith('hooks.'))
  section(
    'settings',
    view.settings.filter((s) => !s.key.startsWith('hooks.')).map((s) => [s.key, s.value, `${s.winner}${s.overridden ? ' (overrides)' : ''}`, s.winnerFile]),
    'no settings leaves'
  )
  section('hooks', hooks.map((s) => [s.key, s.value, s.winner, s.winnerFile]), 'none')
  section('instructions', view.instructions.map((i) => [i.source, `${String(i.bytes)} B`, i.path]), 'none')
  section(
    'mcp servers',
    view.mcpServers.map((m) => [m.name, m.scope, m.transport, m.approved === null ? '' : m.approved ? 'approved' : 'unapproved', m.file]),
    'none'
  )
  out.push('argv', `  claude ${d.argv.join(' ')}`)
  if (d.composesMemory) out.push('  plus --append-system-prompt-file <the overlays\' CLAUDE.md, composed by the launch>')
  for (const w of view.warnings) out.push(`warning: ${w}`)
  return out.join('\n')
}

function indent(text: string): string {
  return text.split('\n').map((line) => `  ${line}`).join('\n')
}

/**
 * The snapshot half of `writeSnapshottedFile`, for a write Helm does not make:
 * the editor's `BufWritePre` calls this and writes only if it exits 0. The row
 * carries the bytes as they are now; `create` marks a file that is not there
 * yet, so restoring it removes the file rather than emptying it.
 */
export async function configSnapshot(ctx: CommandContext): Promise<number> {
  const file = ctx.args.positionals[0]
  if (file === undefined) throw new CliError('helm config snapshot needs a file.', 2)
  const target = snapshotTargetFor(resolve(file), claudeHome(), claudeJsonPath())
  target.guard(target.scopePath, target.path)
  const key = snapshotKey(target.scopePath, target.path)

  if (ctx.args.flags['list'] === true) {
    const snapshots = withStore((store) => readConfigSnapshots(store, target.scopePath, key))
    const json: ConfigSnapshotListJson = { path: target.path, scopePath: target.scopePath, filePath: key, snapshots }
    if (ctx.json) printJson(json)
    else if (snapshots.length === 0) print(`No snapshots of ${target.path}.`)
    else print(table([['ID', 'TAKEN', 'REASON', 'BYTES'], ...snapshots.map((s) => [String(s.id), s.createdAt, s.reason, String(s.bytes)])]))
    return 0
  }

  const current = readConfigFileContent(target.path)
  if (current.binary) throw new CliError(`${target.path} is not text, so it is not snapshotted and must not be rewritten.`)
  const content = current.exists ? current.content : ''
  const reason = current.exists ? 'edit' : 'create'
  const id = withStore((store) =>
    insertConfigSnapshot(store, {
      scopePath: target.scopePath,
      filePath: key,
      content,
      contentHash: current.exists ? current.hash : hashContent(''),
      reason
    })
  )
  const json: ConfigSnapshotJson = { ok: true, id, path: target.path, scopePath: target.scopePath, filePath: key, reason, bytes: Buffer.byteLength(content) }
  if (ctx.json) printJson(json)
  else print(`Snapshot ${String(id)} of ${target.path} taken.`)
  return 0
}

export async function configRestore(ctx: CommandContext): Promise<number> {
  const file = ctx.args.positionals[0]
  if (file === undefined) throw new CliError('helm config restore needs a file and --id <n>.', 2)
  const id = flagInt(ctx.args.flags, 'id', 0)
  if (id === 0) throw new CliError('helm config restore needs --id <n> - see helm config snapshot --list <file>.', 2)
  const result = withStore((store) => restoreConfigSnapshot(store, id, resolve(file)))
  if (!result.ok) {
    throw new CliError(result.error ?? (result.conflict ? 'The file changed while restoring; nothing was written.' : 'The restore was refused.'))
  }
  if (ctx.json) printJson(result)
  else print(result.unchanged ? `${result.file.path} already matches snapshot ${String(id)}.` : `Restored ${result.file.path} from snapshot ${String(id)}${result.snapshotId === null ? '' : ` (previous bytes are snapshot ${String(result.snapshotId)})`}.`)
  return 0
}

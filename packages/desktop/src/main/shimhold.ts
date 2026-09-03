import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProfile, deleteProfile, overlayPluginName } from '@helm/core'
import { sleep, waitFor } from './bridge'
import type { Check } from './fidelity'
import { buildComposeFixtures, type ProfilesContext } from './profilescheck'
import { shimRoot } from './paths'

/**
 * PROF-10: a second Helm starting must not delete the first one's live shim.
 *
 * The bug this exists for had no symptom. `createServices` swept every overlay
 * shim at start, reasoning that nothing could be reading a plugin directory
 * this early - true of one Helm, false of two. Starting the dev build, or a
 * portable copy, or a second install, unlinked the running app's session
 * `--plugin-dir` out from under it. The session carried on, the repositories
 * were safe, and the skills were simply gone. Nothing printed.
 *
 * One process cannot observe this, and neither can two run in sequence: the
 * whole claim is about *overlap*. So this is its own phase and the shape is a
 * handshake through files, orchestrated by `run-profiles.mjs`:
 *
 *   A (`--shim-hold`)   builds a fixture harness, makes a profile over it,
 *                       launches a real session - which is what builds the shim
 *                       and stamps A as its owner - and writes READY.
 *   run-profiles        sees READY, starts B (`--shim-sweep`), a real second
 *                       app start against the same data directory, and writes
 *                       RELEASE when it has exited.
 *   A                   sees RELEASE and reads its own shim back.
 *
 * **A makes the verdict, not the orchestrator**, and that is the point: A is
 * the process whose session would have lost its skills, so A is the honest
 * witness to whether it still has them. It re-reads the skill body *through*
 * the junction, because a shim directory that survived with a dangling reparse
 * point inside it is the same outcome as one that did not.
 */

/** A dies rather than hangs if the orchestrator never gets to its half. */
const RELEASE_TIMEOUT_MS = 180_000

export const READY_FILE = 'shim-hold-ready.json'
export const RELEASE_FILE = 'shim-hold-release'
export const HOLD_REPORT = 'shim-hold-report.json'

const HOLD_PROFILE = 'Shim hold'
const MODEL = 'haiku'

export async function runShimHold(ctx: ProfilesContext, dataDir: string): Promise<Check> {
  const ready = join(dataDir, READY_FILE)
  const release = join(dataDir, RELEASE_FILE)
  for (const file of [ready, release]) rmSync(file, { force: true })

  const fixtures = buildComposeFixtures(join(dataDir, 'shim-hold'))
  const alphaName = overlayPluginName(fixtures.alpha)
  const shimDir = join(shimRoot, `overlay-${alphaName}`)
  /** The file the junction has to still reach, not merely point at. */
  const throughJunction = join(shimDir, 'skills', 'think', 'SKILL.md')

  // Straight into the store rather than through the form. PROF-1 is the check
  // that the form works; this one is about two processes, and driving a dialog
  // to get there would put a second thing in front of the thing being proved.
  const profile = createProfile(ctx.services.store, {
    name: HOLD_PROFILE,
    root: fixtures.root,
    overlays: [fixtures.alpha],
    access: [fixtures.alpha],
    model: MODEL,
    effort: null,
    permissionMode: null,
    agent: null,
    mcp: [],
    openingPrompt: null,
    pinnedOrder: null,
    target: null
  })

  const detail: Record<string, unknown> = {
    pid: process.pid,
    shimDir,
    throughJunction,
    fixtureAlpha: fixtures.alpha
  }

  try {
    const before = ctx.sessions.list().length
    await ctx.sessions.launchProfile({ profileId: profile.id, cols: 100, rows: 30 })
    await waitFor(() => ctx.sessions.list().length > before, 60_000)
    const session = ctx.sessions.list().at(-1)
    detail['sessionId'] = session?.id ?? null
    detail['pluginDirs'] = (session?.argv ?? []).filter((_, i, all) =>
      (all[i - 1] ?? '') === '--plugin-dir'
    )

    // Believed only if it is discriminating. A shim that was never built, or
    // one whose junction never resolved, would let "it survived" pass for the
    // wrong reason - both halves would be absent before and after.
    const builtBefore = existsSync(shimDir)
    const tokenBefore = tokenOf(throughJunction)
    detail['builtBefore'] = builtBefore
    detail['tokenBefore'] = tokenBefore

    writeFileSync(
      ready,
      `${JSON.stringify({ pid: process.pid, shimDir, throughJunction, builtBefore }, null, 2)}\n`
    )

    const released = await waitForFile(release, RELEASE_TIMEOUT_MS)
    detail['released'] = released

    const survived = existsSync(shimDir)
    const tokenAfter = tokenOf(throughJunction)
    detail['survivedSweep'] = survived
    detail['tokenAfter'] = tokenAfter
    detail['sweptBy'] = readJson(join(dataDir, 'shim-sweep-hold.json'))

    return {
      id: 'PROF-10',
      criterion: 'A live session’s overlay shim survives a second Helm starting',
      title: 'A second app start left the running app’s shim, junctions and all',
      ok:
        builtBefore &&
        tokenBefore !== '' &&
        released &&
        survived &&
        tokenAfter === tokenBefore,
      detail,
      notes: [
        'Two processes: this one holds a live session while a second real app start sweeps.',
        'The skill body is read back through the junction, because a directory that outlived',
        'the sweep with a dangling reparse point in it is the same outcome as one that did not.',
        'The before-values are asserted too - "absent then, absent now" would otherwise pass.'
      ]
    }
  } finally {
    for (const session of ctx.sessions.list()) {
      if (session.profileId === profile.id) {
        await ctx.sessions.close({ id: session.id, force: true })
      }
    }
    await sleep(1000)
    deleteProfile(ctx.services.store, profile.id)
  }
}

/** The heading token the fixture skill was written with, read off disk. */
function tokenOf(file: string): string {
  try {
    return /Its token is ([A-Z0-9]+)\./.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
  } catch {
    return ''
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (existsSync(file)) return true
    await sleep(500)
  }
  return false
}

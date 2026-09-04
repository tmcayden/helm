import { eq, sql } from 'drizzle-orm'
import { pathKey } from '../paths/key'
import type { ClaudeInventory, GitState, Harness, Project, ProjectKind } from '../types'
import { EMPTY_INVENTORY } from '../types'
import type { Store } from './db'
import { projects } from './schema'

/**
 * The discovery cache. The launcher reads this first so it can paint before a
 * scan finishes; a scan then overwrites the rows it saw and leaves the rest
 * alone, which is what lets a project that has gone missing be shown as stale
 * rather than disappearing.
 */

/**
 * Writes the rows a scan found.
 *
 * `harnesses` is not optional, and that is the compiler being asked to prevent
 * one bug: the only thing a `Project` row carries that is not on the `Project`
 * object is the harness's `template:`, so a caller that passed the projects
 * alone would silently write null over it on the next `refreshGit`. Making it a
 * parameter means every call site has to have the answer in hand.
 */
export function cacheProjects(store: Store, found: Project[], harnesses: readonly Harness[]): void {
  const seenAt = new Date().toISOString()
  const templates = new Map(
    harnesses.map((harness) => [pathKey(harness.path), harness.template])
  )
  const templateOf = (project: Project): string | null =>
    project.kind === 'harness' ? (templates.get(pathKey(project.path)) ?? null) : null

  const write = store.raw.transaction(() => {
    for (const project of found) {
      store.db
        .insert(projects)
        .values({
          path: project.path,
          name: project.name,
          kind: project.kind,
          harnessPath: project.harnessPath,
          template: templateOf(project),
          hasClaudeDir: project.hasClaudeDir,
          inventory: project.inventory,
          git: project.git,
          lastSeenAt: seenAt
        })
        .onConflictDoUpdate({
          target: projects.path,
          set: {
            name: project.name,
            kind: project.kind,
            harnessPath: project.harnessPath,
            template: templateOf(project),
            hasClaudeDir: project.hasClaudeDir,
            inventory: project.inventory,
            git: project.git,
            lastSeenAt: seenAt
          }
        })
        .run()
    }
  })
  write()
}

/**
 * Drops rows by path, and the only way a project leaves this table.
 *
 * Which paths is not this function's decision - `disprovedProjectPaths` and
 * `orphanedProjectPaths` in `discovery/scan.ts` are where that argument lives,
 * because it is a claim about what a scan proved rather than about storage.
 * Compared case-insensitively for the same reason every other path comparison
 * here is: the row was written from a picker, and the caller may be holding a
 * different spelling of the same Windows directory.
 */
export function forgetProjects(store: Store, paths: readonly string[]): number {
  if (paths.length === 0) return 0
  const wanted = new Set(paths.map((path) => pathKey(path)))
  const doomed = store.db
    .select({ path: projects.path })
    .from(projects)
    .all()
    .map((row) => row.path)
    .filter((path) => wanted.has(pathKey(path)))
  if (doomed.length === 0) return 0

  const remove = store.raw.transaction(() => {
    for (const path of doomed) store.db.delete(projects).where(eq(projects.path, path)).run()
  })
  remove()
  return doomed.length
}

export interface CachedProject extends Project {
  lastSeenAt: string
  /** The harness manifest's `template:`, for a harness row. Null otherwise. */
  template: string | null
}

export function readCachedProjects(store: Store): CachedProject[] {
  return store.db
    .select()
    .from(projects)
    .orderBy(sql`${projects.path} COLLATE NOCASE`)
    .all()
    .map((row) => ({
      path: row.path,
      name: row.name,
      kind: row.kind as ProjectKind,
      harnessPath: row.harnessPath,
      template: row.template,
      hasClaudeDir: row.hasClaudeDir,
      inventory: (row.inventory as ClaudeInventory | null) ?? EMPTY_INVENTORY,
      git: (row.git as GitState | null) ?? null,
      lastSeenAt: row.lastSeenAt
    }))
}

import { asc, eq, sql } from 'drizzle-orm'
import type { EffortLevel, PermissionMode, Profile, ProfileDraft } from '../types'
import { formatLaunchTarget, parseLaunchTarget } from '../types'
import type { Store } from './db'
import { profiles } from './schema'

/**
 * Profile persistence.
 *
 * A profile is edited and launched whole and never queried by its parts, so the
 * list columns are JSON rather than join tables (see `schema.ts`). That makes
 * this file a straight mapping in both directions, which is the point: YAML
 * export is then the same shape again rather than a third representation.
 */

type Row = typeof profiles.$inferSelect

function toProfile(row: Row): Profile {
  return {
    id: row.id,
    name: row.name,
    root: row.root,
    overlays: row.overlays,
    access: row.access,
    model: row.model,
    effort: row.effort as EffortLevel | null,
    permissionMode: row.permissionMode as PermissionMode | null,
    agent: row.agent,
    mcp: row.mcp,
    openingPrompt: row.openingPrompt,
    pinnedOrder: row.pinnedOrder,
    target: parseLaunchTarget(row.target),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function toValues(draft: ProfileDraft): Omit<Row, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: draft.name.trim(),
    root: draft.root,
    overlays: draft.overlays,
    access: draft.access,
    model: draft.model,
    effort: draft.effort,
    permissionMode: draft.permissionMode,
    agent: draft.agent,
    mcp: draft.mcp,
    openingPrompt: draft.openingPrompt,
    pinnedOrder: draft.pinnedOrder,
    // Written out even for Windows rather than left null. A null means "a row
    // from before targets existed", and that is a different fact from "this
    // profile chose Windows" - they launch the same, but only one of them is
    // something the user decided.
    target: formatLaunchTarget(draft.target)
  }
}

/**
 * Pinned first in their order, then the rest alphabetically.
 *
 * `pinned_order` is null for an unpinned profile, and SQLite sorts nulls first
 * ascending - so the ordering is expressed as a computed key rather than a
 * plain column, which would put every unpinned profile above the pinned ones.
 */
export function listProfiles(store: Store): Profile[] {
  return store.db
    .select()
    .from(profiles)
    .orderBy(
      asc(sql`CASE WHEN ${profiles.pinnedOrder} IS NULL THEN 1 ELSE 0 END`),
      asc(profiles.pinnedOrder),
      asc(sql`${profiles.name} COLLATE NOCASE`)
    )
    .all()
    .map(toProfile)
}

export function readProfile(store: Store, id: number): Profile | null {
  const row = store.db.select().from(profiles).where(eq(profiles.id, id)).get()
  return row ? toProfile(row) : null
}

export function findProfileByName(store: Store, name: string): Profile | null {
  const row = store.db
    .select()
    .from(profiles)
    .where(sql`${profiles.name} = ${name.trim()} COLLATE NOCASE`)
    .get()
  return row ? toProfile(row) : null
}

/**
 * Names are unique, so an import of a profile that is already here needs one.
 *
 * `name`, then `name (2)`, `name (3)`. The suffix is parenthesised rather than
 * appended bare because these are read in a launcher list beside each other,
 * and "Acme cloud sync 2" reads as a second version of a workflow where
 * "Acme cloud sync (2)" reads as a copy.
 */
export function uniqueProfileName(store: Store, base: string): string {
  const root = base.trim() || 'Profile'
  if (findProfileByName(store, root) === null) return root
  for (let n = 2; ; n++) {
    const candidate = `${root} (${String(n)})`
    if (findProfileByName(store, candidate) === null) return candidate
  }
}

export function createProfile(store: Store, draft: ProfileDraft): Profile {
  const row = store.db.insert(profiles).values(toValues(draft)).returning().get()
  return toProfile(row)
}

/** Returns null if the profile has been deleted in the meantime. */
export function updateProfile(store: Store, id: number, draft: ProfileDraft): Profile | null {
  const row = store.db
    .update(profiles)
    .set({
      ...toValues(draft),
      updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    })
    .where(eq(profiles.id, id))
    .returning()
    .get()
  return row ? toProfile(row) : null
}

export function deleteProfile(store: Store, id: number): boolean {
  const row = store.db
    .delete(profiles)
    .where(eq(profiles.id, id))
    .returning({ id: profiles.id })
    .get()
  return row !== undefined
}

/**
 * Rewrites the pinned order from a list of ids.
 *
 * Ids not in the list become unpinned, so "pinned, in this order" is expressed
 * by one call with one array rather than by a pin toggle and a move that can
 * disagree with each other. In a transaction because a half-applied reorder is
 * an order nobody asked for.
 */
export function setPinnedProfiles(store: Store, ids: readonly number[]): void {
  store.raw.transaction(() => {
    store.db.update(profiles).set({ pinnedOrder: null }).run()
    ids.forEach((id, index) => {
      store.db.update(profiles).set({ pinnedOrder: index }).where(eq(profiles.id, id)).run()
    })
  })()
}

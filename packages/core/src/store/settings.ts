import { isAbsolute } from 'node:path'
import { pathKey } from '../paths/key'
import { sql } from 'drizzle-orm'
import {
  BROWSER_PROJECT_URLS_MAX,
  BROWSER_REACH_MODES,
  BROWSER_RECENT_URLS_MAX,
  browserReachAllows,
  CONTENT_WRAP_INDENT,
  DEFAULT_SETTINGS,
  EFFORT_LEVELS,
  isRepoSlug,
  PINNED_PROJECTS_MAX,
  PR_CHECKOUT_MODES,
  PR_IGNORED_REPOS_MAX,
  PR_POLL_MINUTES,
  PR_REVIEW_PROMPT_MAX_LENGTH,
  PR_STALE_DAYS,
  PROJECT_SHELL_HEIGHT_PCT,
  SESSION_SPLIT_PCT,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_SIZE,
  TERMINAL_SCROLLBACK,
  THEME_PREFERENCES,
  TRANSCRIPT_ARCHIVE_BYTES,
  USAGE_DISPLAY_MODES,
  WORKSPACE_TABS_MAX,
  type AppSettings
} from '../types'
import type { Store } from './db'
import { appSettings } from './schema'

/**
 * `app_settings` as a typed object rather than a key-value bag at the call
 * site. Unknown keys in the table are ignored and missing keys fall back to
 * `DEFAULT_SETTINGS`, so a database written by an older or newer build still
 * loads.
 *
 * Reads are tolerant and writes are strict, and the asymmetry is deliberate.
 * A row this build does not understand is a fact about the past - another
 * version wrote it - and refusing to start over one would make every settings
 * change a migration. A *write* that does not match a key's shape is a bug
 * happening now: `{ theme: 'purple' }` reaches `nativeTheme.themeSource`, and
 * a value that only fails at the surface it drives fails a long way from
 * whatever sent it. So `writeSetting` and `writeSettings` validate first and
 * write nothing at all when a value does not fit.
 */

/**
 * The shape of every key, restated as a predicate.
 *
 * One entry per key of `AppSettings`, enforced by the compiler: adding a key to
 * the interface without a validator here does not compile. Each returns a
 * sentence naming what was wrong, or null when the value is fine.
 */
type SettingValidators = { [K in keyof AppSettings]: (value: unknown) => string | null }

const oneOf = (allowed: readonly string[]) => {
  return (value: unknown): string | null =>
    typeof value === 'string' && allowed.includes(value)
      ? null
      : `expected one of ${allowed.join(', ')}, got ${describe(value)}`
}

/** What a rejected value was, for the message. Short - this goes in an Error. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `an array of ${String(value.length)}`
  if (typeof value === 'object') return 'an object'
  return `${typeof value} ${String(value)}`
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** A whole number inside `[min, max]`, named for the message. */
const boundedInteger = (bounds: { min: number; max: number }) => {
  return (value: unknown): string | null => {
    if (!isFiniteNumber(value) || !Number.isInteger(value)) {
      return `expected a whole number, got ${describe(value)}`
    }
    if (value < bounds.min || value > bounds.max) {
      return `expected ${String(bounds.min)} to ${String(bounds.max)}, got ${String(value)}`
    }
    return null
  }
}

/**
 * Characters that must not reach a `font-family` declaration.
 *
 * The value is assigned to `Terminal.options.fontFamily`, which xterm puts
 * straight into an element's inline style. A semicolon or a brace there is not
 * a font name, it is the end of the declaration - so the shape of the value is
 * checked at the point it is saved rather than at the point it is painted.
 *
 * A comma is refused too, and that one is about meaning rather than safety:
 * this setting names *one* family, which Helm puts in front of the default
 * stack. A stack typed in here would look like it replaced the default and
 * would not.
 */
const FONT_FAMILY_PUNCTUATION = ";{}<>,\\/*\"'`"

function unsafeFontFamily(value: string): boolean {
  for (const ch of value) {
    // Written as a scan rather than a regular expression so the control-character
    // half of the rule is legible: an escape sequence in a character class is
    // exactly the kind of thing that gets "tidied" into a range that means
    // something else.
    if (ch.charCodeAt(0) < 0x20) return true
    if (FONT_FAMILY_PUNCTUATION.includes(ch)) return true
  }
  return false
}

export const SETTING_VALIDATORS: SettingValidators = {
  theme: oneOf(THEME_PREFERENCES),

  usageDisplay: oneOf(USAGE_DISPLAY_MODES),

  /**
   * Absolute paths only. A relative root would be resolved against whatever
   * the process's working directory happened to be - which for a packaged app
   * is wherever the shortcut pointed - so the same setting would scan two
   * different directories on two different launches.
   */
  scanRoots: (value) => {
    if (!Array.isArray(value)) return `expected an array of paths, got ${describe(value)}`
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        return `expected every root to be a path, got ${describe(entry)}`
      }
      if (!isAbsolute(entry)) return `expected an absolute path, got ${JSON.stringify(entry)}`
    }
    return null
  },

  /**
   * Projects in the sidebar's Pinned section, as a *set* of absolute paths.
   *
   * **Keyed by path, and a moved or re-cloned checkout therefore loses its
   * pin.** That is the decision, not an oversight found later: `prIgnoredRepos`
   * next door learned to key by slug precisely so an entry would survive a
   * re-clone into a different directory, and a project has no slug to key by.
   * It is not a repository - a plain folder and a harness root are both
   * pinnable and neither has a remote - and it is not a database row, because
   * this list has to be readable and writable before the first scan finishes.
   * Its path is the only identity it has; `Project.path` says so, and the
   * `projects` table uses it as the primary key for the same reason.
   *
   * What that costs is one re-pin after a move, in the surface the pin was made
   * in. What keying by anything else would cost is an identity that has to be
   * resolved before the tree can paint. The trade is worth it in that
   * direction, and it is written here so the next person to meet a pin that
   * disappeared after a re-clone knows it was chosen rather than broken.
   *
   * Absolute, for the reason `scanRoots` is: a relative entry would name a
   * different directory depending on what the shortcut's working directory was.
   * The duplicate check is case-insensitive and matches `isProjectPinned`, so
   * two spellings of one path cannot become two rows in a section where only
   * one of them could ever be un-pinned.
   */
  pinnedProjects: (value) => {
    if (!Array.isArray(value)) return `expected an array of paths, got ${describe(value)}`
    if (value.length > PINNED_PROJECTS_MAX) {
      return `expected at most ${String(PINNED_PROJECTS_MAX)} projects, got ${String(value.length)}`
    }
    const seen = new Set<string>()
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        return `expected every pin to be a path, got ${describe(entry)}`
      }
      if (!isAbsolute(entry)) return `expected an absolute path, got ${JSON.stringify(entry)}`
      const key = pathKey(entry)
      if (seen.has(key)) return `expected each project once, got ${JSON.stringify(entry)} twice`
      seen.add(key)
    }
    return null
  },

  /** Null means "find it"; anything else has to be an absolute path. */
  claudePath: (value) => {
    if (value === null) return null
    if (typeof value !== 'string' || value.trim() === '') {
      return `expected an absolute path or null, got ${describe(value)}`
    }
    if (!isAbsolute(value)) return `expected an absolute path, got ${JSON.stringify(value)}`
    return null
  },

  /**
   * Geometry, not a preference - but it is written on every resize, so a
   * nonsense value here is a window that opens off screen or 0px wide.
   * Position is optional and only meaningful as a pair.
   */
  windowBounds: (value) => {
    if (value === null) return null
    if (typeof value !== 'object' || Array.isArray(value)) {
      return `expected window bounds or null, got ${describe(value)}`
    }
    const bounds = value as Record<string, unknown>
    if (!isFiniteNumber(bounds['width']) || bounds['width'] <= 0) {
      return `expected a positive width, got ${describe(bounds['width'])}`
    }
    if (!isFiniteNumber(bounds['height']) || bounds['height'] <= 0) {
      return `expected a positive height, got ${describe(bounds['height'])}`
    }
    for (const axis of ['x', 'y'] as const) {
      const at = bounds[axis]
      if (at !== undefined && !isFiniteNumber(at)) {
        return `expected a number for ${axis}, got ${describe(at)}`
      }
    }
    return null
  },

  /**
   * The workspace strip. State like `windowBounds`, and validated like it:
   * written by the window on every tab change, so a malformed value here is a
   * strip that cannot be restored on the next launch.
   *
   * Every `kind` is checked against the union and every kind's own fields with
   * it, because this is read back and rendered as panes - a `project` with no
   * path is a tab pointing nowhere, and it would fail at the pane rather than
   * at the write. The whole value is rejected rather than the offending entry
   * filtered out: a partly-written strip restored as if it were whole is a
   * worse answer than the previous strip.
   */
  workspaceTabs: (value) => {
    if (value === null) return null
    if (typeof value !== 'object' || Array.isArray(value)) {
      return `expected a workspace strip or null, got ${describe(value)}`
    }
    const strip = value as Record<string, unknown>
    const { panes, activeId } = strip
    if (!Array.isArray(panes)) return `expected an array of panes, got ${describe(panes)}`
    if (panes.length > WORKSPACE_TABS_MAX) {
      return `expected at most ${String(WORKSPACE_TABS_MAX)} panes, got ${String(panes.length)}`
    }
    if (activeId !== null && typeof activeId !== 'string') {
      return `expected a tab id or null, got ${describe(activeId)}`
    }
    for (const pane of panes) {
      if (typeof pane !== 'object' || pane === null || Array.isArray(pane)) {
        return `expected a pane, got ${describe(pane)}`
      }
      const { kind, path, repoPath, number } = pane as Record<string, unknown>
      if (kind === 'history' || kind === 'pulls' || kind === 'config') continue
      if (kind === 'content' || kind === 'settings' || kind === 'sessions') continue
      if (kind === 'project') {
        if (typeof path !== 'string' || path.trim() === '') {
          return `expected a project path, got ${describe(path)}`
        }
        continue
      }
      if (kind === 'pr') {
        if (typeof repoPath !== 'string' || repoPath.trim() === '') {
          return `expected a repository path, got ${describe(repoPath)}`
        }
        if (!isFiniteNumber(number) || !Number.isInteger(number) || number <= 0) {
          return `expected a pull request number, got ${describe(number)}`
        }
        continue
      }
      return `expected a pane kind, got ${describe(kind)}`
    }
    return null
  },

  /** A timestamp, or null for "has not happened". Parsed, not pattern-matched. */
  firstRunCompletedAt: (value) => {
    if (value === null) return null
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      return `expected an ISO timestamp or null, got ${describe(value)}`
    }
    return null
  },

  /**
   * One family name, or null for the built-in stack.
   *
   * Length-capped as well as character-checked: this ends up in an inline style
   * on every terminal, and there is no font name that needs a hundred
   * characters.
   */
  terminalFontFamily: (value) => {
    if (value === null) return null
    if (typeof value !== 'string' || value.trim() === '') {
      return `expected a font family or null, got ${describe(value)}`
    }
    if (value.length > 100) return `expected a font family, got ${String(value.length)} characters`
    if (unsafeFontFamily(value)) {
      return `expected one plain family name, got ${JSON.stringify(value)}`
    }
    return null
  },

  terminalFontSize: boundedInteger(TERMINAL_FONT_SIZE),

  terminalCursorStyle: oneOf(TERMINAL_CURSOR_STYLES),

  terminalCursorBlink: (value) =>
    typeof value === 'boolean' ? null : `expected true or false, got ${describe(value)}`,

  terminalScrollback: boundedInteger(TERMINAL_SCROLLBACK),

  /**
   * Null means "find one"; anything else is an absolute path, for the same
   * reason `claudePath` is. A bare `pwsh.exe` would be resolved against the
   * PATH of whatever launched Helm, so the setting would name different
   * programs on different launches.
   */
  terminalShell: (value) => {
    if (value === null) return null
    if (typeof value !== 'string' || value.trim() === '') {
      return `expected an absolute path or null, got ${describe(value)}`
    }
    if (!isAbsolute(value)) return `expected an absolute path, got ${JSON.stringify(value)}`
    return null
  },

  /**
   * A percentage of the project page's column, bounded at both ends.
   *
   * The non-finite case is the one worth naming. This number is divided into a
   * layout - it becomes a `height` - and `NaN%` is a declaration the style
   * parser drops silently, so the pane would keep whatever height it happened
   * to have and nothing on screen would say the setting was broken. The bound
   * that refuses it is the same one that refuses 900.
   *
   * Whole numbers only, because that is what the drag writes: a percentage is
   * rounded before it is stored, so the settings row shows the number a person
   * can retype rather than 31.4159.
   */
  projectShellHeightPct: boundedInteger(PROJECT_SHELL_HEIGHT_PCT),

  /**
   * The sessions column's width, bounded the way the divider already bounded
   * it. One value for everybody rather than one per project - the argument is
   * in the field's comment in `types.ts`, and it is the same one
   * `projectShellHeightPct` makes with one addition: this divider stays put
   * when you change tabs, so a per-project value would move the boundary every
   * time somebody did.
   *
   * An integer for the same reason its neighbour is one: it is written on
   * pointerup from a fraction, and a settings row wants 45 rather than
   * 0.4499999.
   */
  sessionSplitPct: boundedInteger(SESSION_SPLIT_PCT),

  /**
   * Whether a source file wraps, and how far its continuation rows hang.
   *
   * Two keys rather than one nullable number, because they answer different
   * questions and one of them survives the other being switched off: the indent
   * a person settled on should still be there when they turn wrapping back on.
   * Folding "off" into `indent: null` would lose it every time.
   */
  contentWrap: (value) =>
    typeof value === 'boolean' ? null : `expected true or false, got ${describe(value)}`,

  contentWrapIndent: boundedInteger(CONTENT_WRAP_INDENT),

  /**
   * The transcript archive's ceiling, in bytes.
   *
   * A plain bounded integer, with no "off" value beside it - unlike
   * `prPollMinutes`, where zero is a real state. Turning the archive off is not
   * something this key expresses, because the archive is not optional: see the
   * field's comment in `types.ts`. The floor is low enough for a check to drive
   * eviction, which is the whole reason it is not something respectable.
   */
  transcriptArchiveMaxBytes: boundedInteger(TRANSCRIPT_ARCHIVE_BYTES),

  /** Null means "find it"; anything else is absolute, exactly as `claudePath`. */
  ghPath: (value) => {
    if (value === null) return null
    if (typeof value !== 'string' || value.trim() === '') {
      return `expected an absolute path or null, got ${describe(value)}`
    }
    if (!isAbsolute(value)) return `expected an absolute path, got ${JSON.stringify(value)}`
    return null
  },

  /**
   * Minutes, or zero for off.
   *
   * Zero is deliberately outside the range rather than the bottom of it: the
   * interval and "no interval at all" are different states, and a validator
   * that accepted 1 through 1440 plus 0 as a special case would let a
   * one-minute sweep over a dozen repositories through as well. Off is off, and
   * anything on is at least `PR_POLL_MINUTES.min` apart.
   */
  prPollMinutes: (value) => {
    if (value === PR_POLL_MINUTES.off) return null
    const problem = boundedInteger(PR_POLL_MINUTES)(value)
    return problem === null
      ? null
      : `${problem} (or ${String(PR_POLL_MINUTES.off)} to poll not at all)`
  },

  /**
   * Days, or zero for no split at all.
   *
   * The same two-step as `prPollMinutes` above, for the same reason: zero is
   * not the bottom of the range, it is the absence of one. A cutoff of a day
   * and no cutoff at all are different states - the second is the Open section
   * reverting to the single flat list it was before ACTIVE/STALE existed - and
   * a validator that accepted `0` as an ordinary member of the range would also
   * have to accept the half-day cutoffs the unit cannot express.
   */
  prStaleDays: (value) => {
    if (value === PR_STALE_DAYS.off) return null
    const problem = boundedInteger(PR_STALE_DAYS)(value)
    return problem === null ? null : `${problem} (or ${String(PR_STALE_DAYS.off)} for no split)`
  },

  /**
   * A template with something in it.
   *
   * Empty is refused rather than treated as "no prompt": this value becomes the
   * trailing positional argument of a launch, and `buildLaunchArgs` drops an
   * empty one - so a blank template would silently start an ordinary session
   * from a button labelled "Review with Claude". The remedy for not wanting a
   * prompt is not to press it.
   *
   * The placeholders are deliberately *not* checked. An unknown one survives
   * into the prompt as written (see `renderPullPrompt`), which is what makes a
   * typo visible in the pane's disclosure sentence instead of invisible in the
   * argv, and refusing the write would make a template naming a placeholder a
   * later version adds unwritable.
   */
  prReviewPrompt: (value) => {
    if (typeof value !== 'string' || value.trim() === '') {
      return `expected a prompt template, got ${describe(value)}`
    }
    if (value.length > PR_REVIEW_PROMPT_MAX_LENGTH) {
      return `expected at most ${String(PR_REVIEW_PROMPT_MAX_LENGTH)} characters, got ${String(value.length)}`
    }
    return null
  },

  /**
   * A set of `owner/name` slugs, and validated as a *set*.
   *
   * The duplicate check is case-insensitive and it is the interesting half. The
   * matcher this list is read through is case-insensitive too, so
   * `["Owner/Repo", "owner/repo"]` would behave as one entry while presenting
   * as two - a settings row that could not be un-ticked because removing one
   * spelling leaves the other. Refusing the write is what keeps the list and
   * its meaning the same length.
   */
  prIgnoredRepos: (value) => {
    if (!Array.isArray(value)) {
      return `expected an array of owner/name slugs, got ${describe(value)}`
    }
    if (value.length > PR_IGNORED_REPOS_MAX) {
      return `expected at most ${String(PR_IGNORED_REPOS_MAX)} repositories, got ${String(value.length)}`
    }
    const seen = new Set<string>()
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        return `expected an owner/name slug, got ${describe(entry)}`
      }
      if (!isRepoSlug(entry)) {
        return `expected an owner/name slug, got ${JSON.stringify(entry)}`
      }
      const key = entry.toLowerCase()
      if (seen.has(key)) return `expected each repository once, got ${JSON.stringify(entry)} twice`
      seen.add(key)
    }
    return null
  },

  prCheckout: oneOf(PR_CHECKOUT_MODES),

  /**
   * One argv word, or null for the CLI's own default.
   *
   * Deliberately **not** checked against a list of model names - see the field's
   * comment in `types.ts`. What is checked is that the value can be an argument:
   * a leading dash would arrive at the CLI as another flag, whitespace would
   * split into two words at the point where nothing is looking, and a hundred
   * characters is not a model name whatever else it is.
   */
  prReviewModel: (value) => {
    if (value === null) return null
    if (typeof value !== 'string' || value.trim() === '') {
      return `expected a model name or null, got ${describe(value)}`
    }
    if (value !== value.trim()) return `expected no surrounding whitespace, got ${JSON.stringify(value)}`
    if (/\s/.test(value)) return `expected one word, got ${JSON.stringify(value)}`
    if (value.startsWith('-')) return `expected a model name, got the flag ${JSON.stringify(value)}`
    if (value.length > 100) return `expected a model name, got ${String(value.length)} characters`
    return null
  },

  prReviewEffort: (value) => (value === null ? null : oneOf(EFFORT_LEVELS)(value)),

  updateCheck: (value) => (typeof value === 'boolean' ? null : 'must be a boolean'),

  /**
   * An instant Helm wrote, checked anyway. This is the only defence against a
   * throttle that never opens: a value `Date.parse` cannot read would make
   * every comparison against it NaN, and NaN fails every `>` - so a single bad
   * row would silently mean "never check again" rather than "check now".
   */
  lastUpdateCheckAt: (value) => {
    if (value === null) return null
    if (typeof value !== 'string') return 'must be an ISO 8601 string or null'
    return Number.isFinite(Date.parse(value)) ? null : 'must be an ISO 8601 instant'
  },

  browserReach: oneOf(BROWSER_REACH_MODES),

  /**
   * The two agent controls, and a boolean is checked as a boolean for the
   * reason `updateCheck` is: `'false'` is truthy, and a row hand-edited into a
   * string would switch the endpoint **on** while reading as off in the pane.
   */
  browserMcp: (value) => (typeof value === 'boolean' ? null : 'must be a boolean'),
  browserMcpLocalOnly: (value) => (typeof value === 'boolean' ? null : 'must be a boolean'),

  /**
   * The session-awareness tools, checked exactly as strictly for exactly the
   * same reason: this one also decides whether a port is bound.
   */
  sessionMcp: (value) => (typeof value === 'boolean' ? null : 'must be a boolean'),

  /**
   * Addresses the browser pane has been to, newest first.
   *
   * Every entry has to be something `browserReachAllows` would allow with the
   * widest posture - which is to say an absolute http or https URL. A dropdown
   * whose rows are not addresses is a dropdown whose rows do nothing when
   * clicked, and the value is written by Helm rather than typed, so a row that
   * is not one is a bug in this build and not a fact about the past.
   */
  browserRecentUrls: (value) => {
    if (!Array.isArray(value)) return `expected an array of URLs, got ${describe(value)}`
    if (value.length > BROWSER_RECENT_URLS_MAX) {
      return `expected at most ${String(BROWSER_RECENT_URLS_MAX)}, got ${String(value.length)}`
    }
    for (const entry of value) {
      if (typeof entry !== 'string') return `expected URLs, got ${describe(entry)}`
      if (!browserReachAllows(entry, 'web').allowed) {
        return `expected an http or https URL, got ${JSON.stringify(entry)}`
      }
    }
    return null
  },

  /** The same, keyed by the project directory the browser was opened beside. */
  browserProjectUrls: (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `expected an object of path to URL, got ${describe(value)}`
    }
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > BROWSER_PROJECT_URLS_MAX) {
      return `expected at most ${String(BROWSER_PROJECT_URLS_MAX)}, got ${String(entries.length)}`
    }
    for (const [path, url] of entries) {
      // Absolute for the reason `scanRoots` is: a relative key resolves against
      // whatever the working directory happened to be when it was written.
      if (!isAbsolute(path)) return `expected absolute project paths, got ${JSON.stringify(path)}`
      if (path !== path.toLowerCase()) {
        return `expected lower-cased project paths, got ${JSON.stringify(path)}`
      }
      if (typeof url !== 'string' || !browserReachAllows(url, 'web').allowed) {
        return `expected an http or https URL for ${JSON.stringify(path)}, got ${describe(url)}`
      }
    }
    return null
  }
}

/** A write that was refused, with the key and the reason in the message. */
export class SettingsValidationError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`settings rejected: ${problems.join('; ')}`)
    this.name = 'SettingsValidationError'
    this.problems = problems
  }
}

/** The problem with this value for this key, or null when there is none. */
export function validateSetting(key: keyof AppSettings, value: unknown): string | null {
  const problem = SETTING_VALIDATORS[key](value)
  return problem === null ? null : `${key}: ${problem}`
}

export function readSettings(store: Store): AppSettings {
  const rows = store.db.select().from(appSettings).all()
  const result: AppSettings = { ...DEFAULT_SETTINGS }

  for (const row of rows) {
    if (!(row.key in DEFAULT_SETTINGS)) continue
    try {
      // A hand-edited or truncated value must not take the whole app down with
      // it; one unreadable key falls back to its default.
      Object.assign(result, { [row.key]: JSON.parse(row.value) as unknown })
    } catch {
      continue
    }
  }
  return result
}

export function writeSetting<K extends keyof AppSettings>(
  store: Store,
  key: K,
  value: AppSettings[K]
): void {
  const problem = validateSetting(key, value)
  if (problem !== null) throw new SettingsValidationError([problem])

  store.db
    .insert(appSettings)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        value: JSON.stringify(value),
        updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      }
    })
    .run()
}

/**
 * A patch, applied as one edit.
 *
 * Every key is validated *before* anything is written, so a patch carrying one
 * bad value leaves the table exactly as it was rather than half applied - the
 * caller's next read then still describes a state the app was ever actually in.
 * Keys this build does not know are skipped rather than rejected: that is the
 * read side's tolerance, kept on the write side for the same reason.
 */
export function writeSettings(store: Store, patch: Partial<AppSettings>): AppSettings {
  const entries = Object.entries(patch).filter(([key]) => key in DEFAULT_SETTINGS) as Array<
    [keyof AppSettings, AppSettings[keyof AppSettings]]
  >

  const problems = entries
    .map(([key, value]) => validateSetting(key, value))
    .filter((problem): problem is string => problem !== null)
  if (problems.length > 0) throw new SettingsValidationError(problems)

  const apply = store.raw.transaction(() => {
    for (const [key, value] of entries) writeSetting(store, key, value)
  })
  apply()
  return readSettings(store)
}

import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  claudeConfigFileIn,
  claudeHome,
  projectsDirIn,
  readUsageAcross,
  usageFileState,
  type Store,
  type UsageFileState,
  type UsageSnapshot,
  type UsageSpend,
  type WslHome
} from '@helm/core'
import { createUsageIndex, USAGE_INDEX_POLL_MS, type UsageIndex } from './usageindex'

/**
 * Keeping the status bar's usage figures level with a file Helm does not own.
 *
 * The same two mechanisms `history.ts` uses on `history.jsonl`, for the same
 * reason: `~/.claude.json` is written by every `claude` on the machine, and the
 * refresh that matters most is the one Helm did not cause. An `fs.watch` on the
 * containing directory fires within milliseconds and is documented as not
 * available everywhere; a stat poll every few seconds costs one syscall and
 * covers the case where the watch is silent. Both funnel into one debounced
 * pass.
 *
 * Two differences from the history indexer, both because of what the file is.
 * It is not append-only - one changed digit rewrites the whole thing - so there
 * is no byte cursor and no tail; the pass reads and parses the file whole,
 * which measures about a millisecond at 134 KB. And nothing is written to the
 * database: a cached percentage is worth nothing once it is old, so persisting
 * it would only make it possible to paint a stale number after a restart.
 *
 * There is more than one such file once the WSL homes land, and the two
 * mechanisms are no longer symmetric across them. `fs.watch` on a `\\wsl$\`
 * directory **throws `EISDIR`** - measured 2026-09-03, and worth stating
 * precisely because the ordinary way a watch fails is by being silent: it does
 * not return a watcher that never fires, it refuses. So a distro's file cannot
 * be watched at all and rests entirely on the stat poll below, which is the
 * backstop being the mechanism for exactly one of the candidates. Every watch
 * is therefore attempted and allowed to fail independently: one home that
 * refuses may not cost another home its watch, and it may not throw out of
 * `start()` either.
 *
 * Staleness itself is deliberately not decided here. The main process ships the
 * reading and the window decides what may be painted from it, on a timer, using
 * the same pure function - because a reading goes stale and a window rolls over
 * with no file having changed, and a push-only design would leave a dead number
 * on screen until something happened to touch the disk.
 */

/** Long enough for the CLI's rewrite to land, short enough to feel immediate. */
const DEBOUNCE_MS = 150

/** The backstop, not the mechanism - one `stat` per tick. */
const POLL_MS = 4000

export interface UsageService {
  /** Reads now and returns the reading, whether or not it changed. */
  refresh: () => UsageSnapshot
  /** The last reading, without touching the disk. */
  snapshot: () => UsageSnapshot
  /** The file the last reading came from - the freshest of the candidates. */
  file: () => string
  /**
   * Reads one file and *only* that file - `null` restores the real homes.
   *
   * The one way the usage reader can be pointed at a fixture, used by
   * `--usage-check` to prove that a missing, stale or reshaped
   * `cachedUsageUtilization` paints nothing. It is a method on the service
   * rather than a channel on the IPC contract on purpose: the renderer has no
   * business choosing which file the figures come from.
   *
   * The isolation is now load-bearing rather than incidental. Every one of
   * those proofs is a fixture that must paint nothing, and the freshest-wins
   * rule would otherwise rescue it with a real reading out of another home -
   * a check that passes because it silently measured `~/.claude.json` is the
   * "a check that can pass with no evidence behind it" failure, arriving
   * through a feature rather than a bug. So a pointed service has exactly one
   * candidate.
   */
  pointAt: (file: string | null) => UsageSnapshot
  /**
   * Adds the WSL distributions' `~/.claude` directories to what is read.
   *
   * Their transcripts are spend against the same account and the same limits,
   * so leaving them out would put a dollar figure under a percentage that does
   * not describe it - and their `~/.claude.json` is another cache of that same
   * account's limits, which is why this widens both halves. Separate from
   * construction for the reason the history service's is: finding them is a
   * `wsl.exe` per distribution and the window must not wait on it.
   */
  useHomes: (homes: readonly WslHome[]) => void
  /** The transcript index behind the dollar estimate; `usage-check` drives it. */
  index: UsageIndex
  start: () => void
  stop: () => void
}

export interface UsageServiceDeps {
  /** Called after any pass whose reading differs from the one before it. */
  onChange: (snapshot: UsageSnapshot) => void
  /** Holds the token index. */
  store: Store
  /** Overridden by the checks to read a fixture instead of the real tree. */
  home?: string | undefined
}

/**
 * What makes one reading different from another.
 *
 * Compared as a string rather than field by field so that a limit appearing,
 * disappearing or changing its scope counts as a change without this function
 * having to know which fields exist. The window it does *not* include is time:
 * an unchanged file produces an unchanged signature however old it gets, which
 * is correct, because the ageing is the window's to notice.
 */
function signature(snapshot: UsageSnapshot): string {
  return JSON.stringify([
    snapshot.file,
    // The install as well as the path it came from. `file` moving already
    // implies a different reading, but this is the field the tooltip *shows*,
    // and it is filled in from the home list rather than from the file - so a
    // reading that gains its distro's name when `useHomes` lands is a change
    // the window has to be told about even though nothing on disk moved.
    snapshot.origin,
    snapshot.fetchedAtMs,
    snapshot.problem?.kind ?? null,
    snapshot.limits.map((l) => [l.kind, l.group, l.percent, l.severity, l.resetsAtMs, l.scope]),
    snapshot.spend
  ])
}

function sameState(a: UsageFileState | null, b: UsageFileState | null): boolean {
  if (a === null || b === null) return a === b
  return a.size === b.size && a.mtimeMs === b.mtimeMs
}

export function createUsageService({ onChange, store, home }: UsageServiceDeps): UsageService {
  const primary = home ?? claudeHome()

  /**
   * The homes this account is installed in, this machine's first.
   *
   * More than one once the WSL probe lands: a session hosted in a distro writes
   * its transcript into that distro's `~/.claude/projects`, and those tokens
   * were spent on the same account against the same limits. Omitting them would
   * put a figure under a percentage that does not describe it, which is the one
   * thing the usage surface may not do.
   *
   * The **limits** are gathered over the same list, which is a change: they
   * used to come from this machine's `~/.claude.json` alone, on the grounds
   * that every CLI caches the same account-level reading and choosing between
   * two copies was a rule with nothing behind it. The rule turned out to be in
   * the file - `fetchedAtMs` says when each copy was fetched, and the freshest
   * fetch is the best available description of the one account they all
   * describe (`freshestUsage`). What the old answer cost is exactly what this
   * surface exists to prevent: a user whose work is all inside a distro read
   * this machine's stale or absent percentage underneath a dollar figure summed
   * over *both* homes, so the two numbers beside each other described different
   * things.
   *
   * Order matters twice and is maintained here rather than sorted anywhere
   * else: this machine is first, so a tie resolves to the reading that needs no
   * sentence beside it, and a one-home machine takes the pre-existing path.
   */
  let homes: readonly string[] = [primary]
  const index = createUsageIndex({ store, projectsDirs: () => homes.map(projectsDirIn) })

  /**
   * What to call the install a reading came from, keyed by its home, lowercased.
   *
   * Only the distros are in here: this machine's reading is the unremarkable
   * one and carries no name (`UsageSnapshot.origin`). Held beside `homes`
   * rather than in it because `homes` is what the token index consumes and a
   * list of pairs there would be a shape change for the sake of a tooltip.
   */
  const distroOf = new Map<string, string>()

  /**
   * The one file being read, when the service has been pointed at a fixture.
   *
   * Null is the real configuration - every home's file. This is the whole of
   * `pointAt`'s isolation: there is nowhere else the candidate list can come
   * from, so no fixture proof can be rescued by a real reading.
   */
  let pointed: string | null = null

  let file = claudeConfigFileIn(primary)
  let last: UsageSnapshot = {
    file,
    fetchedAtMs: null,
    limits: [],
    problem: null,
    spend: null,
    origin: null
  }
  let lastSignature = ''
  /** One entry per candidate, so a distro's write is noticed by the poll. */
  let lastStates = new Map<string, UsageFileState | null>()

  /**
   * One per candidate directory, and fewer than there are candidates.
   *
   * A `\\wsl$\` watch throws `EISDIR` (measured 2026-09-03, see the head of
   * this file), so in practice this holds this machine's watch and nothing
   * else. It is still a list rather than a single watcher, because the thing
   * that decides which homes can be watched is the platform and not a rule
   * this file gets to state.
   */
  let watchers: FSWatcher[] = []
  /**
   * Whether the service is running.
   *
   * A separate flag now rather than "is there a watcher": with several
   * candidates, none of which is guaranteed watchable, an empty `watchers` is a
   * normal running state - a machine whose only home refused a watch would
   * otherwise re-enter `start()` and stack a second poll.
   */
  let started = false
  let poll: NodeJS.Timeout | null = null
  let indexPoll: NodeJS.Timeout | null = null
  let debounce: NodeJS.Timeout | null = null
  let catchUp: NodeJS.Immediate | null = null
  let indexMs = 0

  /**
   * The estimate, aligned with the percentage beside it.
   *
   * The session window is taken from the plan's own `resets_at` rather than
   * "the last five hours", so the dollar figure and the percentage describe the
   * same window - which is the only way a user can read one against the other.
   * Null until the first catch-up finishes: an estimate over a third of the
   * transcripts is a wrong number, not a partial one.
   */
  function spendFor(snapshot: UsageSnapshot): UsageSpend | null {
    if (!index.ready()) return null
    const session = snapshot.limits.find((limit) => limit.group === 'session')
    try {
      return index.spend(session?.resetsAtMs ?? null, indexMs)
    } catch (err) {
      console.warn(`usage spend could not be summed: ${String(err)}`)
      return null
    }
  }

  /** One candidate reading: the file to read and what to call where it lives. */
  interface Candidate {
    file: string
    /** Null for this machine's; a distro's name otherwise. */
    origin: string | null
  }

  /**
   * Every file a reading may come from, this machine's first.
   *
   * Derived from `homes` on each pass rather than computed once, for two
   * reasons that are both about the list not being fixed. `useHomes` extends it
   * while the app runs; and `claudeConfigFileIn` *chooses* between
   * `<home>/.claude.json` and its parent's by what exists, so a home whose file
   * appears later resolves differently later - re-deriving costs one
   * `existsSync` per home and is the only way the answer stays true.
   *
   * Deduplicated case-insensitively because two homes resolving to one file is
   * a reading that would then be ranked against itself, and on Windows the two
   * spellings of one path are the same file.
   */
  function candidates(): readonly Candidate[] {
    // Pointed at a fixture: that file and nothing else. See `pointAt`.
    if (pointed !== null) return [{ file: pointed, origin: null }]
    const found: Candidate[] = []
    const seen = new Set<string>()
    for (const where of homes) {
      const config = claudeConfigFileIn(where)
      const key = config.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ file: config, origin: distroOf.get(where.toLowerCase()) ?? null })
    }
    return found
  }

  function refresh(): UsageSnapshot {
    const from = candidates()
    const read = readUsageAcross(from.map((candidate) => candidate.file))
    // The winner names its own file, so the install it came from is a lookup
    // rather than a second decision - which keeps the ranking rule in core,
    // where it can be tested without a `.claude` tree to point at.
    const won = from.find((candidate) => candidate.file === read.file)
    const next: UsageSnapshot = {
      ...read,
      spend: spendFor(read),
      origin: won?.origin ?? null
    }
    file = read.file
    lastStates = new Map(from.map((candidate) => [candidate.file, usageFileState(candidate.file)]))
    last = next
    const nextSignature = signature(next)
    if (nextSignature !== lastSignature) {
      lastSignature = nextSignature
      onChange(next)
    }
    return next
  }

  /**
   * Works the index forward one chunk per tick until it has caught up.
   *
   * `setImmediate` rather than a loop: the first pass over 214 MB takes about a
   * second in total, and the window has to keep painting while it happens.
   */
  function scheduleCatchUp(): void {
    if (catchUp !== null) return
    catchUp = setImmediate(() => {
      catchUp = null
      let result
      try {
        result = index.pass()
      } catch (err) {
        console.warn(`usage index pass failed: ${String(err)}`)
        return
      }
      indexMs = result.ms
      if (!result.caughtUp) {
        scheduleCatchUp()
        return
      }
      // Only once the whole index is current: a partial estimate is wrong.
      if (result.rows > 0 || result.forgotten > 0 || last.spend === null) refresh()
    })
  }

  function scheduleRefresh(): void {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      try {
        refresh()
      } catch (err) {
        // A pass that throws must not take the interval with it: the next write
        // to the file is the next chance to get back in step.
        console.warn(`usage refresh failed: ${String(err)}`)
      }
    }, DEBOUNCE_MS)
  }

  function closeWatchers(): void {
    for (const watcher of watchers) watcher.close()
    watchers = []
  }

  /**
   * A watch per candidate, and each one allowed to fail on its own.
   *
   * `fs.watch` over a `\\wsl$\` directory **throws `EISDIR`** - measured
   * 2026-09-03, and it throws rather than staying quiet, which is why the
   * `try` is inside the loop. One home that cannot be watched must not cost
   * another home its watch, and must not throw out of `start()` and take the
   * poll and the token index down with it. A distro's file is therefore
   * covered by the stat poll alone, at up to `POLL_MS` of latency instead of
   * milliseconds - the acceptable half of a trade whose other half is no
   * distro readings at all.
   */
  function watchFiles(): void {
    closeWatchers()
    for (const candidate of candidates()) {
      const watched = candidate.file
      try {
        // The directory rather than the file, so a rewrite that replaces the
        // inode rather than appending to it still reports - the same reason the
        // history watch is on `dirname`. Non-recursive: this is the home
        // directory, and a recursive watch over it would fire on everything.
        const watcher = watch(dirname(watched), { persistent: false }, (_event, name) => {
          if (name === null || basename(String(name)) === basename(watched)) scheduleRefresh()
        })
        watcher.on('error', () => {
          watcher.close()
          watchers = watchers.filter((held) => held !== watcher)
        })
        watchers.push(watcher)
      } catch {
        // Left to the poll - which for a distro is the only mechanism there is.
      }
    }
  }

  return {
    refresh,
    snapshot: () => last,
    file: () => file,
    index,

    useHomes(next) {
      const added = next.filter(
        (home) => !homes.some((held) => held.toLowerCase() === home.claudeHome.toLowerCase())
      )
      if (added.length === 0) return
      for (const home of added) distroOf.set(home.claudeHome.toLowerCase(), home.distro)
      homes = [...homes, ...added.map((home) => home.claudeHome)]
      // The index asks for the list on every pass, so nothing else has to be
      // told. This only brings the next pass forward from the ten-second tick,
      // so a distro's transcripts land in the estimate now rather than shortly.
      scheduleCatchUp()
      // The limits do have to be told: `candidates()` re-derives, but nothing
      // would call it until the file this machine's watch is on changed, and on
      // a machine whose work is all inside a distro that could be never. A
      // debounced pass rather than a direct one, so several distros arriving
      // together read every file once.
      scheduleRefresh()
      // The new homes get a watch attempted for the sake of the one platform
      // where it might work; a `\\wsl$\` one throws and is left to the poll.
      if (started) watchFiles()
    },

    pointAt(next) {
      pointed = next
      // Not merely cleared per file: the candidate list itself has changed, so
      // every held state is about a file that may no longer be read.
      lastStates = new Map()
      if (started) watchFiles()
      return refresh()
    },

    start() {
      if (started) return
      started = true
      watchFiles()

      poll = setInterval(() => {
        // Every candidate, not just the one the last reading won with: a distro
        // has no watch behind it at all (`EISDIR`, above), so this tick is the
        // only thing that will ever notice its CLI refreshing the account's
        // figures - and a fresher reading appearing in a file Helm is *not*
        // currently reading is exactly the case the freshest-wins rule is for.
        //
        // Size *and* mtime: the CLI rewrites this file in place, and a
        // refreshed percentage can land on exactly the same byte count.
        let moved = false
        for (const candidate of candidates()) {
          const state = usageFileState(candidate.file)
          if (sameState(state, lastStates.get(candidate.file) ?? null)) continue
          lastStates.set(candidate.file, state)
          moved = true
        }
        if (moved) scheduleRefresh()
      }, POLL_MS)
      poll.unref()

      // The token index has no watch behind it. `fs.watch` over `projects/`
      // would have to be recursive to see a transcript grow, and a recursive
      // watch there fires on every token a live session writes - which is the
      // one thing the debounce cannot absorb. A ten-second stat sweep over 178
      // files costs less than that watch does when nothing is happening.
      scheduleCatchUp()
      indexPoll = setInterval(scheduleCatchUp, USAGE_INDEX_POLL_MS)
      indexPoll.unref()
    },

    stop() {
      if (debounce) clearTimeout(debounce)
      debounce = null
      if (poll) clearInterval(poll)
      poll = null
      if (indexPoll) clearInterval(indexPoll)
      indexPoll = null
      if (catchUp) clearImmediate(catchUp)
      catchUp = null
      closeWatchers()
      started = false
    }
  }
}

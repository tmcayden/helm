import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../store/db'
import {
  countUsageMessages,
  forgetUsageFiles,
  indexUsageFile,
  indexedUsageFiles,
  readUsageSpend,
  usageCursor
} from '../store/usage'
import { costOfTokens, priceFor, PRICES } from './prices'
import {
  parseUsageLine,
  readUsageTail,
  scanUsageTranscripts,
  usageScanUnits,
  walkUsageTranscriptsUntil
} from './transcripts'

/**
 * The dollar half, unit-tested where a driver would be slow: the shapes a
 * transcript row can take, the arithmetic, and the index's idempotence. The
 * `usage-check` driver reconciles the totals against the user's real
 * transcripts; these cover the cases those transcripts do not happen to have.
 */

const AT = '2026-08-10T09:00:00.000Z'

function assistantRow(
  overrides: {
    uuid?: string
    model?: string
    timestamp?: string
    usage?: unknown
  } = {}
): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid: overrides.uuid ?? 'a1',
    timestamp: overrides.timestamp ?? AT,
    isSidechain: false,
    requestId: 'req_1',
    message: {
      model: overrides.model ?? 'claude-opus-5',
      role: 'assistant',
      content: [],
      usage:
        'usage' in overrides
          ? overrides.usage
          : {
              input_tokens: 100,
              output_tokens: 200,
              cache_creation_input_tokens: 1000,
              cache_read_input_tokens: 50_000,
              cache_creation: {
                ephemeral_1h_input_tokens: 400,
                ephemeral_5m_input_tokens: 600
              }
            }
    }
  })}\n`
}

describe('parseUsageLine', () => {
  it('reads the four token classes and splits cache writes by TTL', () => {
    const row = parseUsageLine(assistantRow())

    expect(row).toEqual({
      uuid: 'a1',
      at: Date.parse(AT),
      model: 'claude-opus-5',
      input: 100,
      output: 200,
      cacheWrite5m: 600,
      cacheWrite1h: 400,
      cacheRead: 50_000
    })
  })

  it('treats an unsplit cache write as the five-minute default', () => {
    const row = parseUsageLine(
      assistantRow({
        usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 900 }
      })
    )

    expect(row?.cacheWrite5m).toBe(900)
    expect(row?.cacheWrite1h).toBe(0)
  })

  it('trusts the total over the parts when they disagree', () => {
    const row = parseUsageLine(
      assistantRow({
        usage: {
          cache_creation_input_tokens: 1000,
          cache_creation: { ephemeral_1h_input_tokens: 400, ephemeral_5m_input_tokens: 0 }
        }
      })
    )

    expect(row?.cacheWrite1h).toBe(400)
    expect(row?.cacheWrite5m).toBe(600)
  })

  it('skips rows that are not assistant messages', () => {
    expect(parseUsageLine(JSON.stringify({ type: 'user', uuid: 'u1' }))).toBeNull()
    expect(parseUsageLine(JSON.stringify({ type: 'attachment' }))).toBeNull()
  })

  it('skips an assistant row with no usage, no uuid, or no timestamp', () => {
    expect(parseUsageLine(assistantRow({ usage: undefined }))).toBeNull()
    expect(parseUsageLine(assistantRow({ uuid: '' }))).toBeNull()
    expect(parseUsageLine(assistantRow({ timestamp: 'not a date' }))).toBeNull()
  })

  it('keeps a synthetic model rather than dropping the row', () => {
    expect(parseUsageLine(assistantRow({ model: '<synthetic>' }))?.model).toBe('<synthetic>')
  })
})

describe('priceFor', () => {
  it('prices the four classes off the base input rate', () => {
    const rate = priceFor('claude-opus-5', Date.parse(AT))

    expect(rate).toEqual({
      input: 5,
      output: 25,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
      cacheRead: 0.5
    })
  })

  it('falls back to the family for a dated snapshot id', () => {
    expect(priceFor('claude-haiku-4-5-20251001', Date.parse(AT))?.input).toBe(1)
  })

  it('applies an introductory rate inside its window and not after', () => {
    const inside = priceFor('claude-sonnet-5', Date.parse('2026-08-31T23:00:00Z'))
    const after = priceFor('claude-sonnet-5', Date.parse('2026-09-01T00:00:01Z'))

    expect(inside?.input).toBe(2)
    expect(after?.input).toBe(PRICES['claude-sonnet-5']?.input)
    expect(after?.input).toBe(3)
  })

  it('has no price for a model it does not know', () => {
    expect(priceFor('<synthetic>', Date.parse(AT))).toBeNull()
    expect(priceFor('claude-something-9', Date.parse(AT))).toBeNull()
  })

  it('prices cache reads an order of magnitude below input', () => {
    // The whole reason the classes are priced apart: cache reads dominate the
    // volume, so folding them into the input rate would be tenfold wrong.
    const rate = priceFor('claude-opus-5', Date.parse(AT))
    expect(rate!.cacheRead * 10).toBeCloseTo(rate!.input, 10)

    const asInput = costOfTokens(
      { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
      rate!
    )
    const asRead = costOfTokens(
      { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1_000_000 },
      rate!
    )
    expect(asInput).toBe(5)
    expect(asRead).toBe(0.5)
  })
})

describe('the usage index', () => {
  let dir: string
  let store: Store
  let projects: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'helm-cost-'))
    store = openStore({ file: join(dir, 'helm.db') })
    projects = join(dir, 'projects')
    mkdirSync(join(projects, 'alpha'), { recursive: true })
  })

  afterEach(async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  const write = (name: string, body: string): string => {
    const file = join(projects, 'alpha', name)
    writeFileSync(file, body)
    return file
  }

  it('finds transcripts nested under a session, where subagents write', () => {
    write('s1.jsonl', assistantRow())
    mkdirSync(join(projects, 'alpha', 's1', 'subagents'), { recursive: true })
    writeFileSync(join(projects, 'alpha', 's1', 'subagents', 'agent-x.jsonl'), assistantRow())

    expect(scanUsageTranscripts(projects).map((t) => t.file.endsWith('agent-x.jsonl'))).toContain(
      true
    )
    expect(scanUsageTranscripts(projects)).toHaveLength(2)
  })

  /*
   * The units a bounded scan is split into have to reach as deep as the
   * one-shot walk, and the test above cannot say whether they do: it exercises
   * `scanUsageTranscripts`, whose depth arithmetic was never wrong. What was
   * wrong was the *unit* - `usageScanUnits` gives a project directory `depth: 3`
   * meaning "three more levels", and the walker read it as "already three deep"
   * and refused to descend. Every subagent transcript was dropped, the index
   * came out at 51,270 messages against 135,850, and it called itself caught up.
   * The whole suite stayed green throughout.
   */
  it('reaches subagent transcripts through the units a bounded scan uses', () => {
    write('s1.jsonl', assistantRow())
    mkdirSync(join(projects, 'alpha', 's1', 'subagents'), { recursive: true })
    writeFileSync(join(projects, 'alpha', 's1', 'subagents', 'agent-x.jsonl'), assistantRow())

    const found = usageScanUnits(projects).flatMap(
      (unit) => walkUsageTranscriptsUntil(unit, Infinity).found
    )
    expect(found.map((t) => t.file).sort()).toEqual(
      scanUsageTranscripts(projects)
        .map((t) => t.file)
        .sort()
    )
  })

  it('resumes a directory where the deadline stopped it, losing nothing', () => {
    for (let i = 0; i < 6; i++) write(`s${String(i)}.jsonl`, assistantRow({ uuid: `u${String(i)}` }))

    // A deadline already in the past stops after the first entry of the first
    // directory, which is the strongest form of interruption there is.
    const units = usageScanUnits(projects)
    const seen = new Set<string>()
    let queue = [...units]
    let rounds = 0
    while (queue.length > 0 && rounds < 200) {
      rounds++
      const unit = queue.shift()
      if (unit === undefined) break
      const step = walkUsageTranscriptsUntil(unit, performance.now())
      for (const found of step.found) seen.add(found.file)
      queue = [...step.unfinished, ...queue]
    }

    expect([...seen].sort()).toEqual(scanUsageTranscripts(projects).map((t) => t.file).sort())
  })

  it('reads only what was appended since the cursor', () => {
    const file = write('s1.jsonl', assistantRow({ uuid: 'a1' }))
    const first = readUsageTail(file, 0)
    expect(first.rows).toHaveLength(1)

    writeFileSync(file, assistantRow({ uuid: 'a1' }) + assistantRow({ uuid: 'a2' }))
    const second = readUsageTail(file, first.bytes)

    expect(second.rows.map((r) => r.uuid)).toEqual(['a2'])
    expect(second.reset).toBe(false)
  })

  it('counts a message once even when two transcripts contain it', () => {
    // What a fork does: the new file carries a copy of the parent's history.
    const parent = write('s1.jsonl', assistantRow({ uuid: 'shared' }))
    const fork = write('s2.jsonl', assistantRow({ uuid: 'shared' }) + assistantRow({ uuid: 'own' }))

    indexUsageFile(store, { file: parent, tail: readUsageTail(parent, 0) })
    const added = indexUsageFile(store, { file: fork, tail: readUsageTail(fork, 0) })

    expect(added).toBe(1)
    expect(countUsageMessages(store)).toBe(2)
  })

  it('re-reading a whole file from zero does not double the totals', () => {
    const file = write('s1.jsonl', assistantRow({ uuid: 'a1' }) + assistantRow({ uuid: 'a2' }))
    indexUsageFile(store, { file, tail: readUsageTail(file, 0) })
    indexUsageFile(store, { file, tail: readUsageTail(file, 0) })

    expect(countUsageMessages(store)).toBe(2)
  })

  it('keeps a cursor per file, and forgets one whose transcript was reaped', () => {
    const file = write('s1.jsonl', assistantRow())
    indexUsageFile(store, { file, tail: readUsageTail(file, 0) })

    expect(usageCursor(store, file)).toBeGreaterThan(0)
    expect(indexedUsageFiles(store).size).toBe(1)

    expect(forgetUsageFiles(store, [file])).toBe(1)
    expect(indexedUsageFiles(store).size).toBe(0)
    // The rows stay: the tokens were spent whether or not the record survives.
    expect(countUsageMessages(store)).toBe(1)
  })

  it('sums each window and prices it per model', () => {
    const now = Date.parse('2026-08-10T12:00:00Z')
    const hoursAgo = (n: number): string => new Date(now - n * 3_600_000).toISOString()

    const file = write(
      's1.jsonl',
      assistantRow({ uuid: 'in-session', timestamp: hoursAgo(1) }) +
        assistantRow({ uuid: 'earlier-today', timestamp: hoursAgo(9) }) +
        assistantRow({ uuid: 'last-week', timestamp: hoursAgo(24 * 3) }) +
        assistantRow({ uuid: 'too-old', timestamp: hoursAgo(24 * 20) })
    )
    indexUsageFile(store, { file, tail: readUsageTail(file, 0) })

    const spend = readUsageSpend(store, {
      nowMs: now,
      // The window the plan's own session percentage describes.
      sessionResetsAtMs: now + 2 * 3_600_000,
      todayStartMs: Date.parse('2026-08-10T00:00:00Z'),
      indexMs: 0
    })

    expect(spend.session.messages).toBe(1)
    expect(spend.today.messages).toBe(2)
    expect(spend.week.messages).toBe(3)

    // One message: 100 in, 200 out, 1000 written, 50,000 read, at Opus 5.
    const one = (100 * 5 + 200 * 25 + 600 * 6.25 + 400 * 10 + 50_000 * 0.5) / 1_000_000
    expect(spend.session.dollars).toBeCloseTo(one, 10)
    expect(spend.week.dollars).toBeCloseTo(one * 3, 10)
    expect(spend.week.tokens).toEqual({
      input: 300,
      output: 600,
      cacheWrite: 3000,
      cacheRead: 150_000
    })
    expect(spend.pricedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(spend.unpricedModels).toEqual([])
  })

  it('reports a model it has no rate for rather than pricing it as something else', () => {
    const now = Date.parse('2026-08-10T12:00:00Z')
    const file = write(
      's1.jsonl',
      assistantRow({ uuid: 'x', model: 'claude-unreleased-9', timestamp: new Date(now).toISOString() })
    )
    indexUsageFile(store, { file, tail: readUsageTail(file, 0) })

    const spend = readUsageSpend(store, {
      nowMs: now,
      sessionResetsAtMs: null,
      todayStartMs: now - 3_600_000,
      indexMs: 0
    })

    expect(spend.unpricedModels).toEqual(['claude-unreleased-9'])
    expect(spend.week.dollars).toBe(0)
    // Counted, though - the tokens were real even if the price is not known.
    expect(spend.week.tokens.input).toBe(100)
  })
})

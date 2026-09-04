import { describe, expect, it } from 'vitest'
import { createExistenceCache } from './existence'

/** A fake filesystem whose answers can be changed between passes, with probes counted. */
const fake = (present: Set<string>) => {
  let sync = 0
  let async = 0
  const cache = createExistenceCache({
    probe: (path) => {
      sync++
      return present.has(path)
    },
    probeAsync: async (path) => {
      async++
      return present.has(path)
    },
    concurrency: 2
  })
  return { cache, sync: () => sync, async: () => async }
}

describe('createExistenceCache', () => {
  it('stats synchronously on first sight and from memory after that', () => {
    const { cache, sync } = fake(new Set(['a']))
    expect(cache.exists('a')).toBe(true)
    expect(cache.exists('b')).toBe(false)
    expect(sync()).toBe(2)
    expect(cache.exists('a')).toBe(true)
    expect(cache.exists('b')).toBe(false)
    expect(sync()).toBe(2)
  })

  it('revalidate re-asks asynchronously and reports whether anything moved', async () => {
    const present = new Set(['a', 'b'])
    const { cache, sync, async } = fake(present)
    cache.exists('a')
    cache.exists('b')
    cache.exists('c')
    expect(await cache.revalidate()).toBe(false)
    expect(async()).toBe(3)

    present.delete('a')
    present.add('c')
    cache.exists('a')
    cache.exists('b')
    cache.exists('c')
    expect(await cache.revalidate()).toBe(true)
    // The new answers are now what `exists` says, with no synchronous stat.
    expect(cache.exists('a')).toBe(false)
    expect(cache.exists('c')).toBe(true)
    expect(sync()).toBe(3)
  })

  it('forgets paths nobody asked about since the last revalidate', async () => {
    const { cache, sync } = fake(new Set(['a']))
    cache.exists('a')
    cache.exists('gone')
    await cache.revalidate()
    cache.exists('a')
    await cache.revalidate()
    expect(sync()).toBe(2)
    // `gone` was not asked about in the pass before that revalidate, so it is
    // probed afresh rather than answered from a memory nobody was keeping level.
    cache.exists('gone')
    expect(sync()).toBe(3)
  })

  it('a revalidate while one is running joins it', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cache = createExistenceCache({
      probe: () => true,
      probeAsync: async () => {
        await gate
        return true
      }
    })
    cache.exists('a')
    const first = cache.revalidate()
    const second = cache.revalidate()
    expect(second).toBe(first)
    release()
    expect(await first).toBe(false)
  })

  it('a probe that throws does not leave the cache stuck in flight', async () => {
    const cache = createExistenceCache({
      probe: () => true,
      probeAsync: () => Promise.reject(new Error('EACCES'))
    })
    cache.exists('a')
    await expect(cache.revalidate()).rejects.toThrow('EACCES')
    cache.exists('a')
    // A second call starts a fresh pass rather than returning the failed one.
    await expect(cache.revalidate()).rejects.toThrow('EACCES')
  })

  it('with nothing asked, revalidate resolves false without probing', async () => {
    const { cache, async } = fake(new Set())
    expect(await cache.revalidate()).toBe(false)
    expect(async()).toBe(0)
  })
})

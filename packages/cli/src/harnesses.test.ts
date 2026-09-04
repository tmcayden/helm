import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeHarnessRoots, readHarnessIndex, writeHarnessIndex } from './harnesses.ts'

describe('harness index', () => {
  it('is empty when the file is absent', () => {
    expect(readHarnessIndex(join(tmpdir(), 'nope', 'harnesses.json'))).toEqual([])
  })

  it('round-trips and deduplicates', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'helm-cli-')), 'harnesses.json')
    writeHarnessIndex(file, ['/a/b', '/a/b/', '/c'])
    expect(readHarnessIndex(file)).toEqual(['/a/b', '/c'])
  })

  it('refuses a file that is not a list', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'helm-cli-')), 'harnesses.json')
    writeFileSync(file, '{"x":1}')
    expect(() => readHarnessIndex(file)).toThrow('does not hold a list')
  })

  it('merges the enclosing harness without duplicating an indexed one', () => {
    expect(mergeHarnessRoots(['/h1', '/h2'], ['/h2', null, '/h3'])).toEqual(['/h1', '/h2', '/h3'])
  })
})

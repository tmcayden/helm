import { describe, expect, it } from 'vitest'
import { HELM_BINDINGS } from '../snippets.ts'
import { NVIM_KEYS, renderKeys } from './keys.ts'

describe('helm keys', () => {
  const lines = renderKeys().split('\n')

  it('opens with the leader and lists every binding once, described', () => {
    expect(lines[0]).toBe('prefix Space, then:')
    for (const b of HELM_BINDINGS) {
      const rows = lines.filter((l) => new RegExp(`^  ${b.key.replace('?', '\\?')}\\s+${b.description}$`).test(l))
      expect(rows, b.key).toHaveLength(1)
    }
  })

  it('starts every description of a section in the same column', () => {
    const starts = (rows: readonly { description: string }[], from: number) =>
      new Set(rows.map((r, i) => lines[from + i]?.indexOf(r.description)))
    expect(starts(HELM_BINDINGS, 1).size).toBe(1)
    expect(starts(NVIM_KEYS, lines.length - NVIM_KEYS.length).size).toBe(1)
  })
})

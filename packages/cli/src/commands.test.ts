import { describe, expect, it } from 'vitest'
import { COMMANDS, findCommand } from './commands.ts'

describe('command table', () => {
  it('has unique names', () => {
    const names = COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })
  it('matches two-word names before one-word ones', () => {
    expect(findCommand(['profile', 'list', 'x'])).toMatchObject({ command: { name: 'profile list' }, rest: ['x'] })
    expect(findCommand(['history', '--json'])).toMatchObject({ command: { name: 'history' }, rest: ['--json'] })
    expect(findCommand(['nope'])).toBeNull()
  })
})

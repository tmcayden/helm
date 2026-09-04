import { describe, expect, it } from 'vitest'
import { flagInt, parseArgs } from './args.ts'

describe('parseArgs', () => {
  it('splits positionals, flags and passthrough', () => {
    const parsed = parseArgs(['harness', '--name', 'wa', '--json', '--', '--version', '-p'], ['name'])
    expect(parsed).toEqual({
      positionals: ['harness'],
      flags: { name: 'wa', json: true },
      passthrough: ['--version', '-p']
    })
  })

  it('reads --key=value without a declaration', () => {
    expect(parseArgs(['--limit=5']).flags).toEqual({ limit: '5' })
  })

  it('does not swallow a positional into an undeclared flag', () => {
    expect(parseArgs(['--json', 'harness']).positionals).toEqual(['harness'])
  })

  it('refuses a valued flag with nothing after it', () => {
    expect(() => parseArgs(['--name'], ['name'])).toThrow('--name needs a value.')
  })

  it('keeps a lone dash-dash boundary with nothing behind it', () => {
    expect(parseArgs(['a', '--']).passthrough).toEqual([])
  })

  it('validates integers', () => {
    expect(flagInt({ limit: '7' }, 'limit', 20)).toBe(7)
    expect(flagInt({}, 'limit', 20)).toBe(20)
    expect(() => flagInt({ limit: 'x' }, 'limit', 20)).toThrow()
  })
})

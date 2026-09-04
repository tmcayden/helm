import { describe, expect, it } from 'vitest'
import { CliError } from '../output.ts'
import { stripAnsi } from '../theme.ts'
import { expandHome, formatHarnessResult, harnessNewTarget, templateRows } from './harness-new.ts'

describe('harness new arguments', () => {
  it('refuses a missing directory with the usage line, exit 2', () => {
    for (const dir of [undefined, '', '  ']) {
      let caught: unknown
      try {
        harnessNewTarget(dir, null, '/cwd')
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(CliError)
      expect((caught as CliError).exitCode).toBe(2)
      expect((caught as CliError).message).toMatch(/^usage: helm harness new <dir>/)
    }
  })

  it('splits <dir> into the parent core creates in and the folder name', () => {
    expect(harnessNewTarget('/a/b/wa', null, '/cwd')).toEqual({ dir: '/a/b', name: 'wa' })
    expect(harnessNewTarget('wa', null, '/cwd')).toEqual({ dir: '/cwd', name: 'wa' })
    expect(harnessNewTarget('~/h/wa', null, '/cwd').dir).toBe(expandHome('~/h'))
  })

  it('creates inside <dir> when --name is given', () => {
    expect(harnessNewTarget('/a/b', 'wa', '/cwd')).toEqual({ dir: '/a/b', name: 'wa' })
  })

  it('expands only a leading tilde', () => {
    expect(expandHome('~', '/home/u')).toBe('/home/u')
    expect(expandHome('~/x', '/home/u')).toBe('/home/u/x')
    expect(expandHome('/tmp/~x', '/home/u')).toBe('/tmp/~x')
    expect(expandHome('~other/x', '/home/u')).toBe('~other/x')
  })
})

describe('harness new report', () => {
  it('names the path, what was created and the registration', () => {
    const { lines, problems } = formatHarnessResult({ path: '/h/wa', created: ['repos', 'harness.yaml'], problems: [], existing: null })
    expect(lines).toEqual(['/h/wa', '  created repos', '  created harness.yaml', 'Registered /h/wa.'])
    expect(problems).toEqual([])
  })

  it('prints nothing for a refusal but the problems', () => {
    const { lines, problems } = formatHarnessResult({ path: null, created: [], problems: ['/h/wa already exists.'], existing: null })
    expect(lines).toEqual([])
    expect(problems).toEqual(['problem: /h/wa already exists.'])
  })

  it('keeps a partial template apply visible beside the path', () => {
    const { lines, problems } = formatHarnessResult({ path: '/h/wa', created: ['harness.yaml'], problems: ['x could not be written.'], existing: null })
    expect(lines[0]).toBe('/h/wa')
    expect(problems).toEqual(['problem: x could not be written.'])
  })
})

describe('template picker rows', () => {
  it('shows label then description and carries the id as the value', () => {
    const rows = templateRows(
      [
        { id: 'minimal', label: 'Minimal', description: 'Nothing else.', order: null, builtIn: true },
        { id: 'example', label: 'Example', description: null, order: 10, builtIn: false }
      ],
      { text: (t) => t, muted: (t) => t, dim: (t) => `<${t}>`, accent: (t) => t, ok: (t) => t, warn: (t) => t, bad: (t) => t }
    )
    expect(rows.map((r) => r.value)).toEqual(['minimal', 'example'])
    expect(stripAnsi(rows[0]?.label ?? '')).toBe('Minimal  <Nothing else.>')
    expect(rows[1]?.label.startsWith('Example  ')).toBe(true)
  })
})

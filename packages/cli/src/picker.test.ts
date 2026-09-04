import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { pickerFzfArgs } from './picker.ts'
import { colours } from './theme.ts'

const present = spawnSync('fzf', ['--version'], { stdio: 'ignore' }).status === 0

/** The rows as `pickWithFzf` feeds them: index, hidden keys, then a painted label. */
const paint = colours(true)
const rows = [`0\tqwx\t${paint.text('launch')}  ${paint.dim('pick a profile and start a session')}`, `1\tqwx\tkeys  ${paint.dim("Helm's keybinds")}`].join('\n')

const filter = (query: string) => {
  const run = spawnSync('fzf', [...pickerFzfArgs({ name: 'x', hint: 'Enter' }, 2), `--filter=${query}`], { input: rows, encoding: 'utf8' })
  expect(run.stderr).toBe('')
  return run.stdout.split('\n').filter((l) => l !== '').map((l) => l.split('\t')[0])
}

describe.skipIf(!present)('picker fzf rows', () => {
  it('matches the visible label and nothing hidden', () => {
    expect(filter('pro')).toEqual(['0'])
    expect(filter('keys')).toEqual(['1'])
    expect(filter('qwx')).toEqual([])
    expect(filter('zzz')).toEqual([])
  })
})

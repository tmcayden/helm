import { spawnSync } from 'node:child_process'
import { pick, readTtyLine, type PickRow } from './picker.ts'

/** A line from the controlling tty; the default when the answer is empty. */
export function ask(question: string, fallback: string | null = null): string | null {
  process.stderr.write(`${question}${fallback === null ? '' : ` [${fallback}]`}: `)
  const answer = readTtyLine()
  if (answer === null) return fallback
  const trimmed = answer.trim()
  return trimmed === '' ? fallback : trimmed
}

function hasFzf(): boolean {
  return spawnSync('fzf', ['--version'], { stdio: 'ignore' }).status === 0
}

/** Zero or more from a list: fzf --multi when present, comma-separated numbers otherwise. */
export function pickMany<T>(rows: readonly PickRow<T>[], prompt: string): T[] {
  if (rows.length === 0) return []
  if (hasFzf()) {
    const result = spawnSync(
      'fzf',
      ['--prompt', `${prompt} (tab to mark)> `, '--with-nth', '2..', '--delimiter', '\t', '--multi', '--layout=reverse'],
      { input: rows.map((row, i) => `${String(i)}\t${row.label}`).join('\n'), stdio: ['pipe', 'pipe', 'inherit'], encoding: 'utf8' }
    )
    if (result.status !== 0) return []
    return result.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => rows[Number.parseInt(line.split('\t')[0] ?? '', 10)]?.value)
      .filter((v): v is T => v !== undefined)
  }
  process.stderr.write(`${rows.map((row, i) => `${String(i + 1).padStart(3)}  ${row.label}`).join('\n')}\n`)
  const answer = ask(`${prompt} (numbers, comma-separated, empty for none)`) ?? ''
  return answer
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= rows.length)
    .map((n) => rows[n - 1]?.value)
    .filter((v): v is T => v !== undefined)
}

export function pickOne<T>(rows: readonly PickRow<T>[], prompt: string): T | null {
  return pick(rows, { name: prompt, hint: 'Enter · Esc' })
}

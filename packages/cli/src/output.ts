/** One sentence on stderr and a non-zero exit; every command's failure shape. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1
  ) {
    super(message)
  }
}

export function print(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function warn(text: string): void {
  process.stderr.write(`${text}\n`)
}

/** Fixed-width columns, two spaces apart, for the human listings. */
export function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length)
    })
  }
  return rows
    .map((row) =>
      row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  ')
    )
    .join('\n')
}

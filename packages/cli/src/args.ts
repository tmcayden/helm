export interface ParsedArgs {
  /** Bare words before the first flag-less `--`. */
  positionals: string[]
  /** `--json`, `--limit 5`, `--limit=5`. A repeated flag keeps the last value. */
  flags: Record<string, string | boolean>
  /** Everything after `--`, untouched. */
  passthrough: string[]
}

/**
 * The one argv grammar every command shares. `valued` names the flags that take
 * the next word as their value; every other `--flag` is a boolean, so a command
 * cannot accidentally swallow a positional into a flag it did not declare.
 */
export function parseArgs(argv: readonly string[], valued: readonly string[] = []): ParsedArgs {
  const takesValue = new Set(valued)
  const out: ParsedArgs = { positionals: [], flags: {}, passthrough: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--') {
      out.passthrough = argv.slice(i + 1)
      break
    }
    if (!arg.startsWith('--') || arg.length === 2) {
      out.positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      out.flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const name = arg.slice(2)
    if (takesValue.has(name)) {
      const next = argv[i + 1]
      if (next === undefined || next === '--') throw new Error(`--${name} needs a value.`)
      out.flags[name] = next
      i++
    } else {
      out.flags[name] = true
    }
  }
  return out
}

export function flagString(flags: ParsedArgs['flags'], name: string): string | null {
  const value = flags[name]
  return typeof value === 'string' ? value : null
}

export function flagInt(flags: ParsedArgs['flags'], name: string, fallback: number): number {
  const value = flagString(flags, name)
  if (value === null) return fallback
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive integer.`)
  return n
}

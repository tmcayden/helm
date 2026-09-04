import type { ParsedArgs } from './args.ts'

export interface CommandContext {
  args: ParsedArgs
  json: boolean
}

export interface Command {
  /** `launch`, or `profile list` - one or two words, matched longest first. */
  name: string
  usage: string
  summary: string
  /** Flags that take a value; every other `--flag` is boolean. */
  valued?: readonly string[]
  /** Resolves to the exit code. Loaded lazily so `--version` loads nothing. */
  run: (ctx: CommandContext) => Promise<number>
}

/** A registered name whose implementation has not landed yet. Exit 3. */
export function notImplemented(name: string, usage: string, summary: string): Command {
  return {
    name,
    usage,
    summary,
    run: async () => {
      process.stderr.write(`helm ${name} is not implemented yet.\n`)
      return 3
    }
  }
}

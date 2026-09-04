import { parseArgs } from './args.ts'
import { COMMANDS, findCommand } from './commands.ts'
import { CliError } from './output.ts'

declare const __HELM_VERSION__: string

function usage(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length))
  return [
    'usage: helm <command> [options] [-- <claude args>]',
    '',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    'Every read command takes --json. `helm --version` prints the version.'
  ].join('\n')
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(`${usage()}\n`)
    return argv.length === 0 ? 2 : 0
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${__HELM_VERSION__}\n`)
    return 0
  }

  const found = findCommand(argv)
  if (found === null) {
    process.stderr.write(`helm: unknown command "${argv.slice(0, 2).join(' ')}"\n\n${usage()}\n`)
    return 2
  }

  const { command, rest } = found
  try {
    const args = parseArgs(rest, command.valued ?? [])
    return await command.run({ args, json: args.flags['json'] === true })
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`${err.message}\n`)
      return err.exitCode
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

process.exitCode = await main(process.argv.slice(2))

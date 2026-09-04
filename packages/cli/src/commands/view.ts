import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flagString } from '../args.ts'
import type { CommandContext } from '../command.ts'
import { CliError } from '../output.ts'

/** `packages/nvim`, found from the bundle: `dist/helm.mjs` and `nvim/` are siblings' children. */
export function pluginDir(bundleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('../../nvim/', bundleUrl))
}

/**
 * The `helm://` URI a `helm view` argument names. A config scope is carried as
 * its directory, so `helm://config//home/me` has the absolute path after the
 * prefix; an empty directory is the scope picker's cancel and means "nothing".
 */
export function viewUri(words: readonly string[], user: boolean): string | null {
  const [what, dir] = words
  switch (what) {
    case 'effective':
    case 'profiles':
    case 'history':
      return `helm://${what}`
    case 'config': {
      const scope = user ? homedir() : dir
      if (scope === undefined) throw new CliError('helm view config needs a scope directory or --user.', 2)
      return scope === '' ? null : `helm://config/${resolve(scope)}`
    }
    default:
      throw new CliError(`helm view knows effective, config, profiles and history - not "${what ?? ''}".`, 2)
  }
}

/**
 * A view is a tmux pane running its own nvim (TERMINAL.md 5). The plugin
 * directory is put on the runtime path from the command line, so the view works
 * before the user has added helm.nvim to their config - and twice is harmless
 * when they have. The bundle that is running becomes the `helm` the plugin
 * calls, so a checkout that is not on PATH still paints.
 */
export async function view(ctx: CommandContext): Promise<number> {
  const uri = viewUri(ctx.args.positionals, ctx.args.flags['user'] === true)
  if (uri === null) return 0
  const profile = flagString(ctx.args.flags, 'profile')
  const args = ['--cmd', `set rtp^=${pluginDir()}`]
  if (profile !== null) args.push('--cmd', `let g:helm_profile=${JSON.stringify(profile)}`)
  args.push(uri)
  const env = { ...process.env, HELM_CLI: process.env['HELM_CLI'] ?? `${process.execPath} ${process.argv[1] ?? ''}` }
  return new Promise<number>((done) => {
    const child = spawn(process.env['HELM_NVIM'] ?? 'nvim', args, { stdio: 'inherit', env })
    child.on('error', (err) => {
      process.stderr.write(
        `${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'nvim is not on PATH; HELM_NVIM names another binary.' : err.message}\n`
      )
      done(127)
    })
    child.on('exit', (code) => done(code ?? 1))
  })
}

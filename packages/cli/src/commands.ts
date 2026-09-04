import { notImplemented, type Command } from './command.ts'

/**
 * The whole command surface, as a table (TERMINAL.md 4). Adding a command is
 * adding a row; `main.ts` only matches names and dispatches. Each implemented
 * row imports its module on demand, which is what keeps `helm --version` and
 * the pickers from paying for the store or core's content graph.
 */
export const COMMANDS: readonly Command[] = [
  {
    name: 'launch',
    usage: 'helm launch <profile> [--name <session>] [--harness <dir>] [--dry-run] [--json] [-- <claude args>]',
    summary: 'plan, record, run claude at the profile\'s root',
    valued: ['name', 'harness'],
    run: async (ctx) => (await import('./commands/launch.ts')).launch(ctx)
  },
  {
    name: 'resume',
    usage: 'helm resume <session id | claude session id> [--dry-run] [--json]',
    summary: 'resume a recorded conversation with its own argv',
    run: async (ctx) => (await import('./commands/resume.ts')).resume(ctx)
  },
  {
    name: 'profile list',
    usage: 'helm profile list [--json]',
    summary: 'every profile across known harnesses, with problems and usage',
    run: async (ctx) => (await import('./commands/profile.ts')).profileList(ctx)
  },
  notImplemented('profile new', 'helm profile new', 'create a profile interactively'),
  notImplemented('profile check', 'helm profile check <file>', 'validate a profile file'),
  {
    name: 'harness add',
    usage: 'helm harness add <dir>',
    summary: 'register a harness directory',
    run: async (ctx) => (await import('./commands/harness.ts')).harnessAdd(ctx)
  },
  {
    name: 'harness list',
    usage: 'helm harness list [--json]',
    summary: 'the registered harnesses, plus the one enclosing the cwd',
    run: async (ctx) => (await import('./commands/harness.ts')).harnessList(ctx)
  },
  notImplemented('harness new', 'helm harness new <dir> [--template <name>]', 'create a harness from a template'),
  notImplemented('harness convert', 'helm harness convert <dir>', 'make a harness of a directory holding repositories'),
  {
    name: 'history',
    usage: 'helm history [--limit N] [--json]',
    summary: 'the session index, newest first, resumable rows marked',
    valued: ['limit'],
    run: async (ctx) => (await import('./commands/history.ts')).history(ctx)
  },
  {
    name: 'sessions',
    usage: 'helm sessions [--json]',
    summary: 'every live Claude Code session on this machine',
    run: async (ctx) => (await import('./commands/sessions.ts')).sessions(ctx)
  },
  {
    name: 'pick profile',
    usage: 'helm pick profile',
    summary: 'choose a profile and launch it in a new tmux window',
    run: async (ctx) => (await import('./commands/pick.ts')).pickProfile(ctx)
  },
  {
    name: 'pick scope',
    usage: 'helm pick scope',
    summary: 'choose a config scope; prints its directory',
    run: async (ctx) => (await import('./commands/pick.ts')).pickScope(ctx)
  },
  {
    name: 'menu',
    usage: 'helm menu',
    summary: 'the Helm menu, for a tmux popup',
    run: async (ctx) => (await import('./commands/menu.ts')).menu(ctx)
  },
  notImplemented('config tree', 'helm config tree <scope> [--json]', 'a .claude tree with live states'),
  notImplemented('config doctor', 'helm config doctor <profile> [--json]', 'the effective chain for a profile'),
  notImplemented('config snapshot', 'helm config snapshot <file>', 'snapshot a config file before an editor writes it'),
  notImplemented('view', 'helm view <effective|config|profiles> [scope]', 'run nvim on the named buffer'),
  notImplemented('doctor', 'helm doctor [--json]', 'claude doctor plus Helm\'s own checks'),
  notImplemented('install', 'helm install [--yes]', 'write the tmux and zsh snippets, seed templates'),
  notImplemented('mcp', 'helm mcp <add|list|remove>', 'preview, then shell to claude mcp'),
  notImplemented('archive', 'helm archive', 'the transcript pass')
]

/** Longest name first, so `profile list` wins over a hypothetical `profile`. */
export function findCommand(words: readonly string[]): { command: Command; rest: string[] } | null {
  for (const take of [2, 1]) {
    const name = words.slice(0, take).join(' ')
    const command = COMMANDS.find((c) => c.name === name)
    if (command) return { command, rest: words.slice(take) }
  }
  return null
}

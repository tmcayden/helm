import type { Command } from './command.ts'

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
  {
    name: 'profile new',
    usage: 'helm profile new [--harness <dir>] [--name n] [--overlays a,b] [--model m] [--effort e] [--permission-mode p] [--opening-prompt t] [--yes] [--force] [--json]',
    summary: 'create a profile, prompting for what the flags leave out',
    valued: ['harness', 'name', 'overlays', 'model', 'effort', 'permission-mode', 'opening-prompt'],
    run: async (ctx) => (await import('./commands/profile-new.ts')).profileNew(ctx)
  },
  {
    name: 'profile check',
    usage: 'helm profile check <file|name> [--json]',
    summary: 'validate a profile file; what helm.nvim runs on save',
    run: async (ctx) => (await import('./commands/profile-check.ts')).profileCheck(ctx)
  },
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
  {
    name: 'harness new',
    usage: 'helm harness new <dir> [--template <name>] [--name <n>] [--json]',
    summary: 'create a harness from a template and register it',
    valued: ['template', 'name'],
    run: async (ctx) => (await import('./commands/harness-new.ts')).harnessNew(ctx)
  },
  {
    name: 'harness convert',
    usage: 'helm harness convert <dir> [--name <n>] [--json]',
    summary: 'make a harness of a directory holding repositories',
    valued: ['name'],
    run: async (ctx) => (await import('./commands/harness-new.ts')).harnessConvert(ctx)
  },
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
  {
    name: 'config tree',
    usage: 'helm config tree <scope dir | --user> [--json]',
    summary: 'a .claude tree with live states',
    run: async (ctx) => (await import('./commands/config.ts')).configTree(ctx)
  },
  {
    name: 'config doctor',
    usage: 'helm config doctor [--profile <name>] [--json]',
    summary: 'the effective chain for a profile',
    valued: ['profile'],
    run: async (ctx) => (await import('./commands/config.ts')).configDoctor(ctx)
  },
  {
    name: 'config snapshot',
    usage: 'helm config snapshot <file> [--list] [--json]',
    summary: 'snapshot a config file before an editor writes it',
    run: async (ctx) => (await import('./commands/config.ts')).configSnapshot(ctx)
  },
  {
    name: 'config restore',
    usage: 'helm config restore <file> --id <n> [--json]',
    summary: 'put a snapshot back, snapshotting what is there first',
    valued: ['id'],
    run: async (ctx) => (await import('./commands/config.ts')).configRestore(ctx)
  },
  {
    name: 'view',
    usage: 'helm view <effective | config <dir> | config --user | profiles | history> [--profile <name>]',
    summary: 'run nvim on the named helm:// buffer',
    valued: ['profile'],
    run: async (ctx) => (await import('./commands/view.ts')).view(ctx)
  },
  {
    name: 'doctor',
    usage: 'helm doctor [--claude] [--json]',
    summary: 'Helm\'s own checks; --claude runs claude doctor too',
    run: async (ctx) => (await import('./commands/doctor.ts')).doctor(ctx)
  },
  {
    name: 'install',
    usage: 'helm install [--yes] [--no-dotfiles] [--symlink <path>] [--no-symlink] [--json]',
    summary: 'write the tmux and zsh snippets, seed templates, offer the dotfile lines',
    valued: ['symlink'],
    run: async (ctx) => (await import('./commands/install.ts')).install(ctx)
  },
  {
    name: 'mcp',
    usage: 'helm mcp list [--json] | add <name> <json> [--scope s] | remove <name> [--scope s]',
    summary: 'preview the change, then shell to claude mcp',
    valued: ['scope'],
    run: async (ctx) => (await import('./commands/mcp.ts')).mcp(ctx)
  },
  {
    name: 'archive',
    usage: 'helm archive [--json]',
    summary: 'one transcript archive pass; run it from a timer you own',
    run: async (ctx) => (await import('./commands/archive.ts')).archive(ctx)
  }
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

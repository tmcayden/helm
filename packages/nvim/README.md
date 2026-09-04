# helm.nvim

The Neovim half of Helm's terminal edition (docs/TERMINAL.md 6). Everything it
draws comes out of `helm ... --json`; it reads no file and no database of its
own.

## Install

The plugin is a package in this repository so it versions with the CLI it
reads. Reference it with a `dir =` spec from lazy.nvim:

```lua
{ dir = '<checkout>/packages/nvim', name = 'helm.nvim' }
```

`helm view` also puts this directory on the runtime path itself and sources
`plugin/helm.lua`, so a view pane works before the spec is added; loading twice
is guarded.

The `helm` it runs is, in order: `vim.g.helm_cli` (a list, e.g.
`{ 'node', '/path/to/helm.mjs' }`), `$HELM_CLI` (space-separated; `helm view`
sets it to the bundle that is running), then `helm` on PATH.

## Buffers

`helm://profiles`, `helm://config/<dir>`, `helm://effective`, `helm://history` -
opened with `:edit`, `:Helm <name>`, or `helm view <name>` from a shell. Read
only; `:q` needs no `!`.

| key | does |
|---|---|
| `<CR>` | opens the file the line is about - a profile's yaml, a tree entry, a skill's `SKILL.md`, a setting's winning file |
| `q` | closes the buffer, or quits when it is the only one |
| `<leader>hr` | repaints |

`helm://effective` computes for `g:helm_profile` when set (`helm view effective
--profile <name>` sets it), else for `@helm_profile` on the tmux window or
session, else for the one profile of the harness enclosing the cwd. When the
CLI fails, its sentence is painted into the buffer: "could not look" is never
shown as an empty buffer.

## On save

- `*/.helm/profiles/*.yaml`: `helm profile check <file>` runs after the write
  and its problems become `vim.diagnostic` entries in the `helm` namespace.
- `*/.claude/*` and `~/.claude.json`: `helm config snapshot <file>` runs before
  the write and the write is aborted when it exits non-zero - the config
  console's snapshot-before-write with the editor changed. `helm config snapshot
  --list <file>` shows the history and `helm config restore <file> --id <n>`
  puts one back.

## Liveness

`helm://history` and `helm://effective` repaint when `~/.claude/sessions` or the
store's directory changes, 300 ms after the last event.

## Test

`pnpm -F @helm/nvim test` runs `tests/smoke.sh`: headless paints of every
buffer, a diagnostics run, and a snapshot refusal against a scratch `.claude`
tree. It skips cleanly when `nvim` is absent.

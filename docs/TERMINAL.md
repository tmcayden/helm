---
type: reference
date: 2026-09-04
tags: [helm, terminal, tmux, neovim, cli, spec, draft]
---

# Helm Terminal - spec draft

Helm's job, done as a CLI over `@helm/core`, five tmux bindings and a small
neovim plugin. No window. The Electron app is not replaced by this and shares
`packages/core` with it; this document describes what is different, and leans on
[SPEC.md](SPEC.md) for everything that is not.

> [!note] Measured 2026-09-04
> The first spike has been run. Section 9 holds the numbers.

---

## 1. The problem, restated

SPEC 1 still holds: launching from a harness root loses every project's skills
and agents, and launching from a project loses the harness. Helm composes them
with `--plugin-dir` shims and an appended memory file, and a **profile** is the
saved shape of one such launch.

What the Electron app adds around that is a window: tabs for the sessions, a
browser pane, a pull-request pane, a config console with its own editor. For an
owner whose day is tmux and neovim, the window is the cost. The editor is not
theirs, the tab strip fills, and the app lives on the Windows side of a WSL
boundary while the repositories live inside the distribution.

This edition keeps the composition and drops the window. Everything Helm knows
is reachable from a terminal, the editor is the user's own neovim, and the
place a session appears is wherever the user pressed the key.

## 2. What is and is not Helm's

Three axes, one of them Helm's.

| Axis | Owner | Mechanism |
|---|---|---|
| where you are | tmux | a session is a directory; the user's own sessionizer makes them |
| what is running | tmux | windows and panes, arranged by the user |
| how Claude is configured | **Helm** | a profile, composed by core into argv |

Helm decides what a session is loaded with and where it runs. It does not
decide how sessions are grouped, does not own a "workspace", and does not know
what a feature or a slice is. A user's pipeline that wants a row in a Helm popup
contributes one (section 7); Helm does not learn its vocabulary.

## 3. Objects

**Harness.** A directory with `harness.yaml`, `repos/`, its own `.claude/`, and
`.helm/profiles/`. Made from a template (`discovery/templates.ts`, unchanged) or
by converting a directory that already holds repositories. A harness *owns*
repositories: they are cloned into `repos/`, and every profile in the harness
composes from that set.

**Profile.** How Claude is configured, and only that:

```yaml
name: wa
root: ~/harness/wa            # the harness root, always
overlays: [repos/lams, repos/gse-vue, repos/CommonEnv]
access:   [repos/lams, repos/gse-vue, repos/CommonEnv]
model: opus
effort: high
permission_mode: auto
opening_prompt: "/recap"
```

Two changes from the Electron app, both about where the truth lives:

- **YAML is the source; SQLite is an index.** A profile is a file at
  `<harness>/.helm/profiles/<name>.yaml`, versioned with the harness, edited in
  the user's editor. The store caches it for listing and records which sessions
  used it. `profileFromYaml` already reads tolerantly; the index is rebuilt from
  the files, never the other way round.
- **A harness has many profiles, and a profile's root is its harness.** Claude
  always runs at the root. Editing happens wherever the user is - a slice
  worktree, a repo checkout - and the session still starts at the root with
  that tree reachable through `--add-dir`. This is SPEC 2's mechanism kept
  exactly, and it is the rule the terminal edition is built around.

**Config tree.** The `.claude/` of one scope - user, harness, or a repository the
harness owns - with each entry's live state from `config/live.ts`, and the
**effective view** (`config/effective.ts`) of what a profile composes from all
of them: every skill under its overlay namespace, each setting leaf with the
layer that won, the hooks that fire, the argv.

**Session record.** Unchanged: written on spawn, closed on exit, joined to the
CLI's own registry for live state, archived by the transcript pass.

## 4. The CLI

`helm`, a Node program over `@helm/core`, installed inside the distribution the
repositories live in. Core has no `process.platform` branch; `symlinkSync` with
the junction type is a plain symlink on Linux, so overlay shims work unchanged.
The `wsl/` module is unused when everything is on one side of the boundary.

The CLI is the **pty host**. `helm launch <profile>` plans the argv with
`prepareLaunch`, writes the session row, `exec`s `claude` in the current
terminal, and records the exit. "The main process owns process lifetime"
becomes "the wrapper that spawned it does": a row is written before the CLI
starts, so a session that dies at once still happened.

| Command | Does |
|---|---|
| `helm launch <profile> [-- prompt]` | plan, record, exec `claude` at the profile's root |
| `helm resume <id>` | `prepareResume`: its own argv, borrowing nothing from a profile |
| `helm profile new / check / list` | interactive create; validate a YAML; list with usage |
| `helm harness new / convert` | `createHarness` with a template; clone the owned repos into `repos/` |
| `helm harness add / list` | register a harness root in the index; list the roots known |
| `helm pick profile / scope` | the popup pickers behind the bindings (section 5); `scope --view` opens the split itself |
| `helm menu` | the one-key menu over every picker |
| `helm config tree <scope> / doctor` | the tree with live states; the effective chain for a profile |
| `helm config snapshot <file>` | the snapshot-before-write, called by the editor's save hook; `--list` shows the rows |
| `helm config restore <file> --id <n>` | put a snapshot back, refused if the file moved underneath |
| `helm view <effective\|config\|profiles\|history>` | runs `nvim` on the named `helm://` buffer (section 6) |
| `helm sessions` | machine-wide, from the registry, `.json` files only |
| `helm history` | the session index, newest first, resumable rows marked |
| `helm mcp add / list / remove` | preview the diff, then shell to `claude mcp`; `list --json` redacts secrets |
| `helm doctor` | `claude doctor` plus Helm's own checks |
| `helm install` | write the snippets and templates, seed the store, symlink the bundle into `~/.local/bin` |
| `helm archive` | the transcript pass, run from a timer the user owns |

Every read command takes `--json`; the plugin consumes that and nothing else.

**Process enumeration** (`main/resources.ts` today, PowerShell) needs a Linux
implementation over `/proc` and `ss` into core's `ProcessSnapshot`. It stays
watch-gated and off the registry's timer, for the reasons SPEC 4.8 gives.

## 5. The five bindings

The whole of Helm's presence in tmux, and it lives in **its own key table**
rather than in the user's prefix table. `prefix Space` runs `switch-client -T
helm`; the next key is Helm's and then the client is back in the root table.
So Helm takes one key from the prefix table, never five, the user's `prefix h`
stays pane-left, `tmux list-keys -T helm` lists Helm's whole surface, and the
status line paints `HELM` from `#{client_key_table}` while the table is active -
a mistyped chord is visible rather than mysterious. The same leader idea is
used in the other two places Helm has keys: the user's zsh chord table outside
tmux (`ctrl+a Space`, forwarded by the terminal emulator) and `<leader>h` inside
helm.nvim buffers, so the letters are the same everywhere.

| Binding | Runs | Result |
|---|---|---|
| `prefix Space` | `switch-client -T helm` | enter the helm table for one key |
| `helm: p` | `helm pick profile` in a popup | a new window **in the current session**, cwd the harness root, running `helm launch` |
| `helm: h` | the Helm menu in a popup | launch, new harness, new profile, edit profiles, history, sessions, config, doctor |
| `helm: e` | `split-window -h -- helm view effective` | a pane with nvim on what `claude` loads for this window's profile |
| `helm: c` | a scope picker, then `helm view config <scope>` | a pane with nvim on that `.claude` tree |
| `helm: u` | `helm view config --user` | the same for `~/.claude` |
| `helm: ?` | `helm keys` in a popup | this table, plus the zsh chord and the helm.nvim keys |

`helm keys` and `helm.tmux` are both rendered from `HELM_BINDINGS` in
`snippets.ts`, so the help cannot drift from the bindings.

The cost is one keystroke per Helm action. A gesture that turns out to be
constant may also get a direct prefix binding later without leaving the table.

Two rules follow.

- **Short-lived things are popups; long-lived things are panes.** Pickers,
  wizards, doctor, the launch confirmation all run in `display-popup` and vanish.
  A pane is earned by a Claude session, an editor, or a server the user watches.
- **A view is a tmux pane running nvim, not a split inside an existing nvim.**
  So it works from a Claude pane or a shell, not only from an editor. `:q` exits
  that nvim and tmux reclaims the pane. The cost is stated rather than hidden:
  a view pane is its own nvim process and shares no buffers with the user's.

**Profiles reach sessions through tmux options.** `helm ws` (or the user's
`.ready-tmux`) sets `@helm_profile` on a session; a window may set its own. The
user's `claude` is a shell function that asks the window, then the session, and
execs `helm launch` with the answer, offering `n` for a plain session. Nothing
inside a Helm session starts unconfigured by accident, and a bare `claude` in a
directory with no profile is still a bare `claude`.

## 6. helm.nvim

Small, and everything it draws comes out of `helm ... --json`.

- **Buffers**: `helm://profiles`, `helm://config/<scope>`, `helm://effective`,
  `helm://history`. Read-only, painted from the CLI, with `Enter` opening the
  real file under the cursor. These are what `helm view` opens a pane on.
- **Diagnostics**: saving a file under `.helm/profiles/` runs `helm profile
  check` and surfaces problems through `vim.diagnostic`.
- **Snapshot on write**: a `BufWritePre` autocommand for files inside a `.claude`
  tree calls `helm config snapshot` first. This is the config console's
  snapshot-before-write with the editor changed, and it is what gives
  `~/.claude`, which has no git, its undo history.
- **Liveness**: `vim.uv.fs_event` on `~/.claude/sessions` and the store, so a
  buffer left open repaints when a session starts or ends.

The plugin is a package in this repository beside the CLI, so it versions with
the data it reads. The user's dotfiles reference it with a `dir =` spec.

## 7. What is deliberately not here

- **No workspace concept.** Sessions are directories. A feature or slice
  worktree is a directory the user's pipeline created and their worktreeizer
  opened; Helm neither knows nor cares.
- **No pull-request surface, for now.** Held rather than rejected. When it
  returns it comes as a `helm pulls` command over `core/github/` and a popup row,
  and the forge question (SPEC 4.6) is reopened then.
- **No browser pane, and therefore no browser tools.** Links are handed to the
  system browser. The `helm-sessions` MCP family can stay, since core can back
  it from a small Node process; `helm-browser` cannot exist without a web view.
- **No dashboard.** A user's pipeline dashboard is a pane they open. If it wants
  rows in the Helm menu, the menu reads `helm providers` - executables on PATH that
  print rows as JSON - and shows them under the provider's name. Helm does not
  interpret them.

## 8. Rules carried over unchanged

- **Never handle a credential.** `~/.claude` is read the way the registry is
  read; `.credentials.json` is a sign-in signal by existence; `.key` files are
  never opened; `gh` and `glab` own their tokens.
- **The only writes to a `.claude` tree go through the snapshot.**
- **Rows are written on spawn.**
- **Overlay shims are swept only at start, and only what is provably dead.**
- **Helm renders nothing for a live session.** A view pane is a record on disk.
- **"Could not look" and "nothing there" are never merged.**
- **Measure until the answer changes what you do, then stop.**

## 9. The first spike

Four questions, each cheap, each decisive. Measured 2026-09-04, machine:
Ubuntu WSL2, node 26.1.0, pnpm 10.28, claude 2.1.260, tmux 3.4.

### Does core build and run inside the distribution?

**Verdict: YES.**

`pnpm install` completed in 21s. `better-sqlite3` 13.0.3 ships N-API
prebuilds (`prebuilds/linux-x64.node`, not ABI-keyed): `select 1` works on
both Node 26.1.0 and 24.15.0; no Node 22 was present on this machine and none
was needed. `pnpm -F @helm/core typecheck` passes in 2.8s. Vitest: 902 pass,
22 fail, 9 skip - every failure is a Windows-path assumption in a test
fixture or normaliser (wsl/home `path.join` separator; `C:\` fixture keys in
config/content/store tests; case-insensitive path dedupe in scan/history,
which is a real bug on a case-sensitive filesystem; `\\wsl$` roots in
launch/plan). `prepareLaunch` for root `~/harness` with two overlays: 7.86 ms,
0.66 ms, 0.71 ms across three trials (the first includes shim creation);
core module import takes 764 ms (the shiki/remark graph); the composed argv
reads `-n <name> --plugin-dir <shims>/overlay-lams --plugin-dir
<shims>/overlay-gse-vue --session-id <uuid>`.

What it changes: the test suite gains a platform-aware path-key helper, and
the Windows-only tests are exercised through the win32 branch or skipped with
a stated reason rather than silently passing on posix; the CLI lazy-loads the
heavy content modules so `helm --version` does not pay the 764 ms import cost.

### Do overlay shims compose from Linux symlinks?

**Verdict: YES.**

`fs.symlinkSync(target, path, 'junction')` yields a plain symlink on Linux -
the type argument is ignored - so `launch/overlay.ts` needs no platform
branch. Three trials of `claude -p --plugin-dir` over two symlinked shims
from `~/harness`: 11.87 s, 13.80 s, 13.63 s (that is claude's own turn time,
not shim resolution). Skills, commands and agents all resolved through the
symlinks, namespaced `<overlay>:<name>` (e.g. `staqs:openspec-propose`,
`staqs:opsx:apply`; a fixture repo resolved a skill, a command and an agent).
Only `lams`, `staqs` and `claude-harness` in `~/harness/repos` carry a
`.claude`; `lams`'s `skills/harness` is itself a symlink to a plugin root
without a `SKILL.md`, so it surfaces nothing, which is the same behaviour on
Windows. This matches the SPEC junction finding exactly, and the dead-UNC-
junction hazard SPEC describes does not exist on Linux.

What it changes: nothing.

### Does the `claude` shell function hold?

**Verdict: YES.**

`tmux show-option -wqv @helm_profile` does not inherit a session-level user
option, so window-then-session is two plain lookups; `-q` is required or an
unset option is a tmux error. All four cases pass, three trials each, 33-36
ms round trip: a window-set value wins over a session-set one; an unset
window falls through to the session; both unset runs the real `claude`
binary unmodified; `HELM_PROFILE=n` and `claude -n` both bypass Helm. Tmux on
this machine runs `base-index 1`.

What it changes: nothing - the function is `helm.zsh` as already written.

### Does a view pane behave?

**Verdict: YES, 2026-09-04, NVIM v0.12.2, tmux 3.4.** `split-window -h -- helm
view effective` from a zsh pane: split to nvim painted / `:q` to pane
reclaimed 27/20, 28/21, 27/21 ms. From a pane running a live `claude` 2.1.260
at its prompt: 46/22, 32/23, 31/22 ms, and the claude pane survived every
time with its prompt repainted at the restored width. The buffer options
that make `:q` clean with no "no write since last change" prompt:
buftype=nofile, bufhidden=wipe, noswapfile, lines set while modifiable and
then modified=false, modifiable=false, readonly. The `BufReadCmd helm://*`
autocommand must exist before the argument buffer is read, so it lives in
`plugin/helm.lua` (sourced at startup by lazy.nvim), not in a lazily
required module: measured, `nvim -c` painted an empty buffer and
`nvim --cmd` painted correctly. Two facts for the checks that drive this:
`tmux send-keys` feeds the pane's pty and never fires a key-table binding,
so a scripted verification attaches its own client on a pty it owns, runs
`switch-client -c <client> -T helm`, and writes the key byte (binding fired
in 9 ms, nvim painted in 15 ms); and `#{client_key_table}` is read with
`tmux list-clients -F`, because `display -p` resolved against a different
client and answered `root` while the table was active. `split-window -e
PATH=...` did not take effect, so `helm` must be on the tmux server's PATH,
which `~/.local/bin` is.

What it changes: helm.nvim registers its BufReadCmd in plugin/, the
status-line indicator uses `client_key_table`, and the verification pass
drives bindings through an attached client rather than send-keys.

## 10. Installation

Two audiences, one mechanism. The user's own dotfiles repository is the model:
`runs/fzf` clones a tool and runs its installer, `runs/nvm` puts Node under
`~/.config/nvm`, and a tracked `.zshrc` and `.tmux.conf` carry the reference
lines. Helm fits that shape rather than inventing one.

**What lands on a machine.**

| Piece | Where | How |
|---|---|---|
| the `helm` CLI | `~/.local/bin/helm` | symlink to the built bundle in the checkout |
| Node | wherever the user keeps it | the bundle pins the major it needs and `helm doctor` checks |
| the `helm` key table | `~/.config/helm/helm.tmux` | written by `helm install`; `.tmux.conf` gains one `source-file` line |
| the `claude` wrapper and chord | `~/.config/helm/helm.zsh` | written by `helm install`; `.zshrc` gains one `source` line |
| helm.nvim | the user's plugin spec | a `dir =` spec pointing at `packages/nvim`; printed, never written |
| templates | `~/.config/helm/templates` | seeded only when absent, never overwritten (SPEC 4.5) |
| data | `~/.local/share/helm` | `helm.db`, `overlays/`; created on first run |

**Building.** `packages/cli` is bundled with esbuild into one file with core
compiled in, the way the desktop bundle already compiles core, so there is
still one build step. `better-sqlite3` cannot be bundled and does not need to
be: its N-API prebuilds are what made the portable exe work (SPEC 8.2), and
`pnpm install` inside the distribution fetches the Linux one. The bundle sits
beside that `node_modules`, and the symlink points at the bundle.

**`helm install`.** Writes the two snippet files, seeds templates, creates the
data directory, and offers to append the source lines to `.tmux.conf` and
`.zshrc` - each with a timestamped backup beside it, and refused without
`--yes` when there is no TTY to ask. It prints the Neovim spec rather than
editing a config people shape by hand. `helm doctor` verifies every row of the
table, so an incomplete install is a list rather than a mystery.

**Two rules.** Nothing is written into `~/.claude`. And the installer never
overwrites a file it did not write: the snippet files are Helm's, a dotfile
gets one appended line, the templates are seeded once.

**Reloading while developing.** The symlink is the mechanism: it points at the
built bundle, so `pnpm -F cli build --watch` in a pane makes every save the
`helm` that the next keypress runs. Every Helm action is a fresh process, so
nothing is restarted. Two things cache and each has its own reload: the tmux
table (`prefix r`, the user's existing binding) and helm.nvim
(`:Lazy reload helm.nvim`). A dotfiles repository that installs Helm through a
`runs/helm` script can bind the whole loop into the helm table -
`bind -T helm R run-shell "<dotfiles>/run helm && tmux source-file ~/.tmux.conf"`
- and because the install is idempotent, pressing it when nothing changed is
harmless.

Publishing the bundle to npm, so the first step becomes `npm i -g`, is a
distribution convenience for later and changes nothing above.

## 11. Decisions made while building

- 2026-09-04: Node 26 is the runtime on this machine, not the 22 the kickoff
  assumed; the bundle targets node22 syntax and `helm doctor` checks for
  >=22, because better-sqlite3's prebuild is N-API and works across majors.
- 2026-09-04: helm.nvim's `helm://` BufReadCmd is registered eagerly in
  `plugin/helm.lua` rather than on a lazy trigger, because the buffer named
  on nvim's command line is read before any lazy handler would have run.
- 2026-09-04: Windows-only test fixtures run through an explicit win32 branch
  or are skipped on posix with a stated reason, never weakened, because the
  Electron app's behaviour must stay byte-identical and the suite must be
  green on both hosts.
- 2026-09-04: Path-case normalisation for deduplication happens only on
  win32; on Linux two directories differing in case are two directories.
- 2026-09-04: CLI directories follow XDG: data `~/.local/share/helm`
  (`helm.db`, `overlays/`), config `~/.config/helm` (`helm.tmux`, `helm.zsh`,
  `templates/`), overridable by `HELM_DATA_DIR` and `HELM_CONFIG_DIR` for
  checks, because the spec's section 10 table names those and checks need
  isolation the same way the desktop's `PORTABLE_EXECUTABLE_DIR` gives it.
- 2026-09-04: Harness roots are indexed in a small file under the data
  directory plus whatever `harness.yaml` is found walking up from cwd,
  because the YAML profiles are the truth and an index of where to look is
  all the store needs to hold.
- 2026-09-04: `helm launch` spawns `claude` with inherited stdio and forwards
  signals rather than exec(2), because Node has no exec; the row is written
  before the spawn and finished on exit, so lifetime ownership is unchanged.
- 2026-09-04: `helm pick profile` runs inside `tmux display-popup -E`, uses
  fzf when present and a numbered prompt otherwise, and opens the chosen
  profile with `tmux new-window -c <root> -n <name> helm launch <name>`,
  because the popup inherits TMUX and the window lands in the session the
  key was pressed in.
- 2026-09-04: Path-case folding for identity comparisons goes through core's
  `pathKey`, which lowercases only on win32, because two Linux directories
  differing in case are two directories.
- 2026-09-04: No third launch target kind: on a Linux host the `windows`
  target's path translation is the identity and `wsl.exe` is only reached from
  a `\\wsl$\` root, so argv is byte-identical and nothing else changes.
- 2026-09-04: `helm launch` sweeps stale shims on every launch, because a
  launch is the CLI's whole process life and "swept at app start" has no other
  moment; the sweep also removes the memory file of a provably dead session
  only, since claude reads that file once at startup.
- 2026-09-04: The `c` binding is a popup running `helm pick scope --view`,
  which opens the split itself, because tmux keeps backslashes literal inside
  single quotes and the nested `sh -c` test for the cancel case could never
  see an empty string.
- 2026-09-04: helm.zsh binds its chord itself through a variable-keyed
  `tmux_chords` entry plus `bindkey`, because a quoted subscript in zsh keeps
  its quotes and the user's `.zshrc` binds the table in a loop that has
  already run when the snippet is sourced.
- 2026-09-04: `helm mcp list --json` reads the three config scopes read-only
  and redacts `env`, `headers` and bearer strings before printing, because a
  server entry on this machine carried a token in its args and printing config
  must not become printing a credential.
- 2026-09-04: `helm view` passes `--cmd "runtime plugin/helm.lua"` as well as
  the rtp prepend, because lazy.nvim turns `loadplugins` off and the rtp entry
  alone never sourced the plugin.
- 2026-09-04: The `helm://` buffers use filetype `helmview`, because `helm` is
  the Helm-charts filetype and nvim-treesitter tried to install that grammar.
- 2026-09-04: helm.nvim's snapshot autocommand is a Vimscript `throw`, not a
  Lua `error()`, because on NVIM v0.12.2 only the former aborts the write from
  `BufWritePre`.
- 2026-09-04: `helm config snapshot` composes core's exported
  `insertConfigSnapshot`/`assertWritable`/`snapshotKey` rather than adding a
  core function, following the precedent of the desktop's `mcpAdd`, which
  takes the row alone.
- 2026-09-04: The bundle is made executable by the build, because
  `helm install` symlinks it as-is.
- 2026-09-04: `profileToYaml` writes `target: windows` for a profile created
  on Linux; left as is and noted, because the target is the identity on this
  host and the field is core's to redesign.

## Related

- [SPEC.md](SPEC.md) - the Electron app, and every mechanism this edition reuses
- [DESIGN.md](DESIGN.md) - not applicable here; the terminal has no design system
- `packages/core/` - the shared implementation

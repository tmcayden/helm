---
name: checks
description: How Helm's real-window checks work - sessions-check through packaging-check, usage-check, settings-check, fidelity, claude-check, design-shot. Use when running one, narrowing a re-run with --only, reading a report, diagnosing a failure, or writing a new check.
---

## Helm's checks

Helm has two tiers of test and they do not overlap.

`pnpm check` (typecheck + lint + `vitest`) is fast, hermetic, and covers
`packages/core` only. All 270 unit tests live there. It runs in about a second
and it is what CI runs.

The checks in this skill drive the **real Electron window** - clicking real
rows, launching real `claude` sessions, installing real packages - and they are
the only coverage `packages/ui` and `packages/desktop` have. They take minutes,
they cost tokens, and they are deliberately not in `pnpm check`.

Each is named for the surface it covers, and its report ids carry a matching
prefix - `sessions-check` writes `SESS-1`, `config-check` writes `CFG-1`.

## Which one to run

A change to a surface named here is not done until its check is green.

| check | covers | run after touching |
|---|---|---|
| `pnpm sessions-check` | sessions, tabs, teardown, session state, what a session is holding, the session-awareness tools | session lifecycle, the tab strip, shutdown, `core/registry/`, `core/resources/`, `main/activity.ts`, `main/processes.ts`, `main/resources.ts`, `main/session-tools.ts`, `SessionsPane`, the project pane's launch warning |
| `pnpm profiles-check` | profiles, overlay shims, argv | `core/launch/`, the profile UI, the argv builder |
| `pnpm history-check` | session index, resume | history parsing, the history pane, resume |
| `pnpm config-check` | config console, effective view, MCP | `core/config/`, anything that writes into a `.claude` tree |
| `pnpm content-check` | markdown, artifacts, wikilinks, editor | `core/content/`, the content viewer |
| `pnpm highlight-check` | the editors: the overlay, the highlighting, the editing behaviour | `CodeEditor`, `core/content/editing.ts`, `highlightLines`, `editor:highlight`, `editor.css`, the two panes' editing halves |
| `pnpm packaging-check` | first run, packaging, personal-path audit | setup, portable mode, the installer |
| `pnpm usage-check` | the status bar's usage figures | `core/usage/`, the status bar |
| `pnpm settings-check` | the settings pane, every app setting, terminal/shell preferences | `core/store/settings.ts`, `SettingsPane`, `terminal.ts`, `estimateGrid`, `main/pterm.ts` |
| `pnpm transcript-check` | the transcript archive: capture, search, the ceiling, read-only | `core/archive/`, `core/store/archive.ts`, `main/archive.ts`, the session-history pane's archive states, anything that reads `projects/*.jsonl` |
| `pnpm template-check` | harness templates: the engine, the picker, seeding, authoring | `core/discovery/templates.ts`, `core/discovery/template-authoring.ts`, `createHarness`, `NewHarnessDialog`, `TemplateManager`, `SaveAsTemplateDialog`, `templatesDir` in `paths.ts`, the seeding in `createServices` |
| `pnpm pr-check` | the pull-request surface end to end | `core/github/`, `main/pulls.ts`, `main/gh-cli.ts`, `PullsPane`, `PullRow`, `PullRequestPane`, the project pane's pull-request panel and its Config/Content links, `SessionHost.review` |
| `pnpm browser-check` | the browser pane and the tools a session drives it with: the view's lifetime, its bounds, hiding, the console panel, every posture, the MCP endpoint, the reach intersection and tab ownership | `main/browser.ts`, `main/browser-mcp.ts`, `core/browser/reach.ts`, `core/launch/mcp.ts`, `BrowserPane`, `ConsolePanel`, the `browser:*` channels, the navigation guard in `main/index.ts`, `browserReach`, `browserMcp`, `browserMcpLocalOnly` |
| `pnpm affordance-check` | every clickable control looks clickable | `theme.css`, `lib/segmented.ts`, `Checkbox`, any shared control recipe, any new pane |
| `pnpm fidelity`, `pnpm claude-check` | TUI fidelity inside xterm | `terminal.ts`, `ptyEnv` |

`main/browser-mcp.ts` sits under two of them, because the listener in it serves
both families of tools: a change there owes `browser-check` **and**
`sessions-check --only=tools`, and the two ask different questions of it - the
first that the browser server still works, the second that the session server is
still a separate name behind the same token with its own tick.

`affordance-check` is the one that is about *all* of the UI rather than one
surface, so it is owed by a change to a shared recipe and by a new pane - a new
pane needs a row in its `VIEWS`, or its controls go unmeasured and the check
says so in AFF-2 rather than passing quietly.

`terminal.ts` sits under two of them and they answer different questions:
fidelity says the baked configuration still renders a TUI correctly,
`settings-check --only=terminal` says a preference reaches every live terminal
without disturbing that. A change there is not done until both are green **and
fidelity's numbers have not moved**.

## The discipline every check follows

A check asserts against an **independent second reader**, never against the
code under test. The tree is checked against its own `readdirSync` walk, the
history counts against their own parse of `history.jsonl`, restores against
their own `sha256`. A parser agreeing with itself proves nothing.

Where agreement is not enough, a check asks the world instead: a live `claude`
session is asked what it can actually see, an installer is actually installed,
a usage window is actually allowed to roll over underneath the segment.

**A check that can pass with no evidence behind it is worse than no check.**
PROF-4 asked a session to quote two skills' headings and compared against files
on disk; when those files went missing `firstHeading` returned `''`, the
expected token became `SKILL1=`, and everything matched. It was green for weeks.
Any probe that reads its expected value out of a fixture must first assert the
fixture is there and is discriminating.

## Narrowing a re-run

Most checks take `--only=a,b,c`. **Do not trust a group list written in prose,
including this file.** They have drifted before. Read the authority:

```bash
# in-app groups, per driver
node -e "console.log(require('fs').readFileSync('packages/desktop/src/main/configcheck.ts','utf8').match(/const GROUPS = \[([^\]]*)\]/)[1].replace(/\s|'/g,''))"

# groups the run script owns rather than the app (the packaging phase)
grep -n "wants('" packages/desktop/scripts/run-packaging.mjs
```

`profiles-check`'s groups are filtered inside `profilescheck.ts`; `packaging-check`'s `package`
group lives in `run-packaging.mjs`, not in the driver's `GROUPS`, because the
packaging phase runs outside the app.

## What each one is, and the shape worth knowing first

**`sessions-check`** - sessions, tabs, teardown. Drives the window: sidebar rows, the
launch button, tabs and their close buttons, asserting on processes, xterm grids
and database rows. **Three phases** now, orchestrated by `run-sessions.mjs`: the
driver, a second real app start (`--sessions-restart`), then
`scripts/verify-orphans.mjs`, which confirms nothing survived and which reads the
report so it has to be told where that is.

Its groups are `lifecycle`, `state`, `tools` and `resources`, and only the first
writes what phase two reads - so `run-sessions.mjs` **skips** phase two for any
other `--only=`, rather than running it against nothing and reporting a red line
that means "no rename happened" while reading as "the rename did not survive".

`tools` runs **before** `resources` and that order is load-bearing:
`runResourcesChecks` ends with `ctx.resources.stop()`, which is a permanent
teardown of the service the whole app shares, and the session-detail tool takes
a watch on that same service. SESS-29 asserts the pass moved *because of the
call*, so a reordering fails loudly with `passRan: false` rather than measuring
a stopped service.

The `resources` group is the one that goes outside Helm. It spawns two hosted
sessions in two different working trees and a third `claude` on a pty **this
driver owns** - Helm has no row, no tab and no session id for that one - because
"the listing is machine-wide" cannot be argued into existence, only shown. Then
it drives its own `createResourcesService` with the enumeration injected, so the
two states the pane must never confuse are told apart by what the machine
answered: SESS-23's session with genuinely no children says so in words, and
SESS-24 turns the same session's pass blind and requires that sentence to be
replaced by "Unknown". Neither could be arranged on a real machine on demand.
Whether the real enumeration works at all is asked first and separately -
SESS-21 against a process table the driver reads with a different query, SESS-22
against a listener it starts on a port it chose and then kills, so a matcher
that said yes to everything cannot pass.

The `tools` group is the session-awareness tools over the MCP endpoint, and it
speaks MCP **as the sessions themselves**: it reads each one's bearer token out
of the `--mcp-config` file that session was handed, because attribution is which
token arrived and a driver registering an agent of its own would have no session
to be attributed to. Both sessions are launched through `SessionHost.review` -
not because this is about pull requests but because it is Helm's one launch path
that puts a prompt into argv, which is the exact thing a tool must never hand
over. Two things in it are worth copying. SESS-30 plants a marker as one
session's first message, **proves it is in that session's argv and on its
screen**, and only then requires it to be in no answer - the fixture before the
absence. And SESS-33 asks a real `claude` to report on the other session and
rests its verdict on the **Helm tab number**, which appears in no file on the
machine: the session's name is in the registry and a model with a shell could
have read it there, so a probe resting on the name would not have been a probe
about the tools.

Two things in the rest are worth copying. SESS-11 counts **pty writes** while the
rename field has the caret, by wrapping `sessions.input` on the host - "the
terminal did not get that keystroke" has no other witness, and the mutation that
proves the counter is live puts nine of them in the pty. And SESS-14 is the
second phase, because "the name someone gave a tab survived a restart" is not a
claim the process that set it can make: the session itself does not survive
either - `before-quit` ends it - so what phase two goes looking for is the
`sessions.label` row, read by a process that never saw the rename happen.

SESS-15 is the workspace divider, and the first thing in Helm's history to
drag it. Copy its shape for any gesture. It uses `drag()` so the button is held
- written out as bare `sendMouse` calls the moves arrive as `buttons: 0`, which
is a hover, and this divider answered those for as long as it existed - and it
makes three claims rather than one: the gesture *arrived* (`tracePointer`, so
"ignored" and "never delivered" are different red lines), the pane ended where
the pointer left it, and the pane **tracked the pointer mid-gesture**, sampled
between moves with the frame loop allowed to run. That third one is the one to
copy. A fix for this divider was written and reverted whose end state was
perfectly correct and whose middle lagged, moved the wrong edge and snapped on
release; every assertion about the finished state passed it.

It also opens the session history behind the split and asserts that dragging
mutates **nothing** in that pane. The boundary is a `--split` custom property
nothing in the render tree reads, so moving it reconciles no rows; the row
count is asserted too, because on a machine with six sessions "no mutations" is
also what reconciling six of them reports.

**`profiles-check`** - profiles and overlay composition. Builds a profile through the
real form, launches it, and asks the live session whether the overlays' skills
and instructions actually arrived. **Four phases**, orchestrated by
`run-profiles.mjs` rather than `&&`: the driver, a second real app start
(`--shim-sweep`), `scripts/verify-shims.mjs`, then the hold phase. Spawns real
sessions on haiku.

The last two phases are about **two Helms** and they are opposites, which is
what makes them worth reading together:

- `PROF-9` - a shim from a run that *ended* must be collected. The driver plants
  one stamped with the pid of a process it spawned and waited on, so the sweep
  removes it by establishing the owner is gone rather than by default. Asserted
  across two starts because one process cannot observe its own startup.
- `PROF-10` - a shim a *running* Helm is serving must survive. This is an
  overlap rather than a sequence, so `--shim-hold` is **spawned**, not waited
  on: it launches a real session, writes `shim-hold-ready.json`, and blocks
  while `run-profiles.mjs` starts a second real app that sweeps. The holder then
  reads its own shim back and **makes the verdict itself** - it is the process
  whose session would have lost its skills. It reads the skill body *through*
  the junction, and asserts the before-values too, since "absent then, absent
  now" would otherwise pass.

**`history-check`** - the session index. Drives the history pane and checks every
count against its own read of `~/.claude/history.jsonl`. Spawns two real
sessions: one resumed through the app, one on its own pty to prove the watcher
notices a session Helm did not start.

Its `titles` group spawns nothing and is worth copying twice over. HIST-9 judges
derived titles on **properties** rather than against a second copy of the
derivation - no row titled with a bare slash command while that session said
something in prose, none titled with an attachment placeholder, none blank -
because a check that re-implements the rule it checks agrees with itself and
proves nothing; every predicate in it is one-sided, so it can only under-report.
And HIST-10 **makes the rebuild destroy something first**: it plants a canary in
a derived column beside the hand-given name and forces the DELETE-and-rebuild a
rewritten history file would cause, so "the name survived" is a claim about a
rebuild that provably happened rather than about a reset that quietly did
nothing.

**`config-check`** - the config console. Tree against its own `readdirSync`,
restores against their own `sha256`, predicted overlay namespaces against a
hand-built `basename(overlay):skill` list. The effective view is then checked
against a **live session** - three predicted skills invoked and the settings
winner read back out of `env` - because a prediction about a session is only
worth what a session says about it. One haiku session.

**`content-check`** - the content viewer. Opens every markdown file in the user's
harness vault and checks the DOM against a regex read of the same source,
navigates a wikilink, interrogates the artifact frame's sandbox from inside it,
measures search latency and scroll frame intervals, and edits a real note with
a hash-verified restore. Spawns no sessions, so it takes about a minute.

**`highlight-check`** - the editors. Drives the config console and the content
viewer against a fixture harness the driver owns, reached the way a folder
outside every scanned root is: a profile points at it. It **never clicks Save**,
and `HL-16` hashes the fixture tree either side of the whole run to say so -
this is the surface that writes into a `.claude` tree, and proving an editor
works by writing through it would be asserting the wrong thing.

Four shapes in it are worth copying. The **scroll claim is made in two
currencies**: the transform the component wrote onto the layer stack, and the
underlay's own bounding rectangle, because a string that reads correctly over an
element that did not move passes one and fails the other. The **parity
comparator is made to fail first** (HL-2) - a font size is forced onto one layer
and the same function has to reject the pair it had just accepted - and the
trailing-newline half gets its own mutation, injecting a stylesheet that switches
off the pseudo-element materialising the last line and requiring the two heights
to *stop* matching. That is TPL-1's rule applied per comparison. **Latency is
counted in frames, not milliseconds**, because "inside one frame" is a discrete
claim: an `input` listener the driver installs counts `requestAnimationFrame`
callbacks to the first one where the painted layer holds what the box holds, and
`keystrokesMeasured` must equal `keysSent` - a sample that never resolves is
left *out* of the set, and a maximum over a set missing its worst member is the
PROF-4 shape. And **undo is asserted against the previous user state**: a word
typed key by key, then Tab, then Ctrl+Z, which has to give the word back. The
naive implementation - assigning `.value` - passes every assertion about the
result of the edit and empties Chromium's undo stack, so
`data-editor-direct-writes` counts the times the component had to do that and
zero is part of the claim.

No sessions, no network, about two minutes.

**`packaging-check`** - first run and the built artefacts, in three phases. Two shapes
matter before touching it. **First run is a second process**: "a fresh
`~/.claude` and no harness at all" is not a state this machine can enter, so
`run-packaging.mjs` starts the app again with `PORTABLE_EXECUTABLE_DIR` pointed at a
temp directory - the app's own portable mechanism, not a test hook - and
`--claude-home=` pointed away from the real one. Nothing of the user's is backed
up because nothing of the user's is opened. And **the audit is made to fail
first**: a file carrying a Windows profile path, a harness path and a private
project name is planted, caught, and deleted before its clean result is
believed, because a grep that finds nothing is indistinguishable from a grep
looking for nothing. `--sandbox=` puts the throwaway profile somewhere with no
account name in the path, which is how the README's screenshots were taken.

**Verifying the installer is destructive to the app you are using, it cannot be
isolated, and it is therefore not a check at all.** It installs the NSIS package
to the real `%LOCALAPPDATA%\Programs\Helm`, runs it, and **uninstalls it,
putting nothing back** - because it is *about* where an installer puts things,
so an isolated data directory would erase what it measures.

It lives in `scripts/verify-installer.mjs` and is run by name:

```bash
pnpm verify:installer --yes                     # install, run, uninstall
pnpm verify:installer --yes --replace-running   # ... even with Helm open
```

It refuses without `--yes`, refuses again while Helm is running unless
`--replace-running`, and leaves no installed Helm behind. **No group of any
suite reaches it and no `--only=` spells it** - that is structural, not a list
somebody maintains. Run it deliberately, on a machine where nobody is working,
when a release changes packaging rather than as a matter of course.

`pnpm packaging-check` covers the rest of phase 3 - the artefact build, the
unpacked native modules and the portable exe - and prints a `PKG-2` line
recording that the installer was **not verified there**, so a green run cannot
be mistaken for one that covered it.

It has now cost a session. Run inside a blanket sweep, it uninstalled a Helm
somebody was working in - and Helm **hosts Claude Code**, so that ended the work
in it, and the app had to be reinstalled by hand. Two things came out of that:

- The phase now **refuses** when Helm is running from the install directory,
  rather than terminating it. `--replace-running` is how a release build says it
  meant to.
- The termination it did instead of refusing had never worked. `endInstalledApp`
  built its PowerShell with `JSON.stringify(path)`, which doubles every
  backslash - and PowerShell's escape character is the backtick, not the
  backslash, so `StartsWith("C:\\Users\\user\\…")` was false for every process on the
  machine. It matched nothing, killed nothing, and its "wait until it is gone"
  loop passed instantly *because* it was looking at nothing. Measured on one
  machine with the app plainly open: the JSON form counts 0, a PowerShell
  single-quoted literal counts 4. `psLiteral` is now the only way a path reaches
  a PowerShell command in that file. A destructive step that silently no-ops and
  reports success is the `PROF-4` shape with worse consequences.
- And then the refusal itself threw instead of refusing. `psLiteral` was written
  as a `const` arrow near the foot of the file, but `run-packaging.mjs` *runs*
  its phases on the way down, so the guard called it from the temporal dead zone
  and phase 3 died with `Cannot access 'psLiteral' before initialization`. It
  failed safe - the throw came before the install - but the message was a stack
  trace rather than the sentence that says what to close. It is a `function`
  now, hoisted like the two helpers around it.

  Both faults were in a branch that only runs when Helm is open, and both
  survived the commit that introduced them because on the machine that wrote
  them Helm was open, so the phase was never run at all. **Exercise this guard
  deliberately after touching it**: once with the app open to see it refuse by
  name, once with `--replace-running` to see it still proceed. Nothing else
  takes that branch.

**`usage-check`** - the status bar's figures. A plain `JSON.parse` beside
`parseUsage`, a hand-written "which of these may be shown" beside `usageView`, a
hand-computed weekday beside `formatResetsIn`, a hand-written parse of every
transcript beside the incremental index, a regex over the rendered text beside
the component. Three criteria could not be settled by agreement and are not: a
live `claude` is asked for `/usage` and its panel compared to the bar, a
fixture's window is set to expire ten seconds out so a rollover happens
*underneath* the segment, and the full parse the index avoids is measured rather
than quoted. Two phases, because "the mode survives a restart" cannot be
asserted by the process that set it.

Its `homes` group covers the multi-home rule - a machine with WSL has a
`.claude.json` per distribution as well as its own, and the **freshest reading
wins with nothing averaged or merged**. It runs through `useHomes` with fixture
homes rather than through `pointAt`, which is single-candidate by construction,
and it runs **last** for the same reason `settings-check`'s `wsl` group does:
`useHomes` appends and there is no removal, so a fixture home reached by an
earlier group would win a ranking it has no business in. Both directions are
driven over the same two files - a merged reader and a reader that simply
preferred the last candidate both pass one direction - and the two percentages
are chosen so that an average and a sum are distinguishable from either. One
half is **not** covered and says so in the report: `origin === null`, the value
when this machine's own file wins, needs a reading in the real `~/.claude.json`,
which a check may not write.

**`settings-check`** - the settings pane, every app setting, and the terminal
preferences. The second
reader is this driver's **own read-only connection to `helm.db`**, opened beside
each UI assertion: reading through `services.store` would be reading the handle
the app just wrote through, which passes whether or not anything was committed.
Three things it does not settle by agreement - the removal of a scan root is
checked against the *next scan's* project set rather than against the list of
roots, the theme against the colour Electron was handed for the window controls
(captured by wrapping `setTitleBarOverlay` on the window itself) compared with
the `--helm-bg` token as CSS resolved it, and the CLI override against a stub
program on disk that answers `--version` with 9.9.9. Every rejection case is
preceded by a **valid** write of the same key through the same channel, because
"the row did not change" is also what a channel that writes nothing would
report. Two phases: it parks every setting on a non-default value, and
`run-settings.mjs` starts the app again to read them back - and to restore the
originals, since this one borrows a database (a *copy* of the real one; see
"Where the output lands").

Its `terminal` group is the one part that spawns a `claude`, because the
claim is about terminals in **both** registries and only a session puts one in
the session registry. Three things there are worth knowing before touching it.
Live terminals are reached through `window.__helmTerminals()` - a read-only tap
in `app/inspect.ts`, since they live outside React and `executeJavaScript` has
no other route to them - but it is never the only witness: cell geometry is
checked against a measurement the driver makes itself, and every pty resize is
counted by wrapping `sessions.resize` and `pterm.resize` on the host objects.
The group **writes its own baseline first**, because the validation group parks
each terminal setting on a value of its own on the way past. And a `<select>`
is checked for having taken the value **before** the change event is dispatched:
React flushes a discrete event synchronously and re-renders from props the write
has not come back and changed yet, which puts the old value back.

Its `wsl` group is the other one worth knowing about, because it is the only
group in the pane that writes **no settings row at all**: what the WSL group
changes is `%USERPROFILE%\.wslconfig`, a machine-wide file Helm does not own, so
the second reader is the file itself rather than `helm.db`. It is aimed at a
fixture profile by swapping **`USERPROFILE`** for the length of the group -
`wslConfigPath()` resolves that variable at call time, so the real channel, the
real editor and the real backup all follow it, which is the same posture
`transcript-check` takes with `CLAUDE_CONFIG_DIR`. That swap is why the group
runs **last**: on Windows `os.homedir()` *is* `USERPROFILE`, so anything asking
for a home while it is swapped would be handed the fixture. Four things it
settles rather than assumes - an absent file must read as *no mode set* and
never as `nat`; the backup is compared byte for byte against the bytes the
driver planted, since a copy that exists is not the claim and a copy of *what
was there* is; the mode line must land inside `[wsl2]` and before the next
section header, because an editor appending at EOF produces a file that parses
and that WSL ignores; and a file with two `networkingMode` keys must be refused
with the reason **on screen**, the click attempted anyway and the bytes shown
identical afterwards. `wsl --shutdown` is a standing exception of the kind
`PKG-2` is: the dialog is opened, required to name what it ends, and cancelled,
and the confirmed path is **not** driven - it would end every WSL process on the
machine, possibly including the session running the check.

**`transcript-check`** - the transcript archive. The one check that runs against a
`.claude` tree of its own, pointed at with the real **`CLAUDE_CONFIG_DIR`** rather
than a flag, so "that variable is honoured" is exercised rather than simulated.
Plants transcripts, lets the watch notice them, and compares the archived text
against its own naive parse of the fixture bytes. Four things it does that are
worth copying: it hashes the whole fixture tree either side of a full pass and
requires the digest to be identical (T-5), having first planted a canary file to
prove the hash can move; it computes the storage ceiling from what is actually
stored, so the set of evicted sessions is *exact* rather than "at least one"
(T-4); it asserts a token planted mid-conversation is findable by content **and**
absent from `history_prompts`, which is what says the search is over messages
(T-3); and it is two-phase, because "the archive outlives the transcript" is not
a claim the process that wrote the rows can make - `run-transcript.mjs` deletes
the transcript between the phases and a second real app start has to find the
conversation still there (T-7). No sessions, no network, about ninety seconds.

**`template-check`** - harness templates, in **five app starts**. Three of them
are windowless `--template-seed` runs, and they are the shape worth copying: "a
first start seeds the directory", "a second overwrites nothing" and "deleting it
re-seeds" are three claims about *startup*, and no process that has already
started can make one about itself. `run-template.mjs` arranges the directory
between them and each start writes down what it found; the driver reads those
three files and turns them into TPL-7/8/9, so every verdict still lives in one
report. **The runner edits a seeded file between two of the starts**, and that
edit is the probe rather than preparation: Helm keeps no hashes of what it
seeded and so cannot tell an edited file from an untouched one, which is exactly
why it must never overwrite - "the file is still what the user made it" is the
assertion, where "the file is still there" would pass over a rewrite.

The fourth start drives the real New Harness dialog against a fixture template
planted in the check's own templates directory (free, through `isolate.mjs` -
`templatesDir` reads the same `PORTABLE_EXECUTABLE_DIR`). It picks the fixture
out of the real picker, creates, and walks the result with a recursion that
knows nothing about templates. The load-bearing one is TPL-4: a **non-`.tpl`
file full of literal `{{...}}`** - two GitHub Actions expressions, a Jinja
block, and a `{{NAME}}` - has to arrive identical to the byte, which is what
says substitution stayed inside `.tpl`. TPL-1 comes first and is the reason any
of that is believed: the byte comparator is run clean, then **a byte of the
fixture is flipped and the same function is required to reject the file it had
just accepted**, then the byte is put back. That is the PROF-4 rule applied
before the fact rather than after it.

`hostile` refuses four template names that are paths (`../escape`,
`C:\Windows\System32` and friends) through the real `harness:create` channel -
the picker cannot produce one, so the channel is where the refusal has to hold -
and walks the parent either side, because "it refused" and "it refused after
making the folder" look identical from a return value. Then it creates from a
template carrying a real Windows **junction**: the honest half is written, the
junction is a sentence in `problems`, and what it pointed at is hashed either
side so containment is a claim about bytes rather than about a filename absent
from a listing.

`authoring` (TPL-12 to TPL-18) drives the **template manager**, and every claim
is read back off the disk by the driver rather than out of the channel that
wrote it. It creates, describes, renames and deletes a template through the real
form; imports a skill out of a real `config:scopes` entry and compares sha256 on
both sides *and* again after making a harness from the result; freezes a fixture
harness through the project pane's "Save as template" and checks the tick state
of every previewed row, that the stated total **moves when a row is unticked**,
and that what landed is what was ticked; and imports a `dot-claude/` folder,
which stays `dot-claude/` in the template and arrives as `.claude/` in the
harness.

Three things in it are worth copying. **TPL-13 earns its comparator the way
TPL-1 does** - a second fixture and a second comparison get their own flipped
byte, because PROF-4's failure is per-comparison rather than per-driver.
**Junction safety is proven in both directions** (TPL-15, TPL-16): a save that
walks into one copies a repository, and a delete that walks into one *removes*
it, which is the unrecoverable half. And the fixture the import reads from lives
in the harness's `repos/`, not beside the harness - a root holding any harness
is a directory *of* harnesses and its non-harness siblings are deliberately not
projects (`scan.ts`), so a fixture planted as a sibling is never discovered,
never a scope, and reads as an import bug.

The driver's own teardown does **not** use `rmSync(dir, { recursive: true })`:
that call was measured returning successfully while leaving a Windows junction
in place, which is why `nuke()` in the driver and `removeTree` in the engine are
both written out by hand.

No sessions, no network, about two minutes.

**`browser-check`** - the integrated browser pane and the tools a session drives
it with, in two app starts. It starts its own HTTP and HTTPS fixture servers on
`127.0.0.1` and `127.0.0.2`, so it reaches no network; **one** `claude` session
on haiku, in the `live` group and nowhere else, so `--only=` anything but `live`
still costs no tokens. About three minutes.

Seven shapes in it are worth copying. The first four are M16's, about the pane.

**The witness for "the view is hidden" is a photograph of the window, taken from
outside it.** That is not the obvious choice and the obvious one does not work:
`win.webContents.capturePage()` - which `screenshot()` and every other driver
here uses - **cannot see a `WebContentsView` at all**. Measured while writing
this, with the view plainly on screen, it returned zero fixture pixels in all
three states. A hiding probe built on it would have passed for the wrong
reason forever. So the window is captured through `desktopCapturer`, and
`document.visibilityState` asked *of the page* is read beside it: one is the
compositor's opinion, the other is a picture, and Helm writes neither. Helm's
own `visible` flag is reported in the detail and is never part of a verdict.

**BR-5 makes that counter fail first.** It runs the pixel count over a shown
frame and a hidden one and requires it to find the page and then not find it,
before any hiding assertion is believed - a counter stuck at zero would pass
every one of them. TPL-1's rule, applied to a comparator that is a pixel count.

**BR-3 is the milestone's spike, pinned.** "A tab the user is not on stays
capturable, scriptable and clickable" is what M17 is built on and would regress
with nothing on screen looking different. The capture half is made discriminating
by repainting the page a colour it has **never been** *after* the hide, so a
`capturePage` handing back the last frame drawn while visible fails.

**The self-signed certificate is minted at run time**, by writing the X.509 DER
out by hand in the driver. Committing a PEM would put a private key in the
repository and shelling out to `openssl` would make the check depend on whether
a machine has one. The same certificate is served on `127.0.0.1` and on
`127.0.0.2` - both this machine, both reachable - so the only difference between
the accept and the refuse is the host, which is the rule under test.

The last three are M17's, about an agent driving it.

**The tool groups speak MCP over the wire.** The driver registers with
`browserMcp` as though it were a session, gets a bearer token, and makes real
HTTP requests to `127.0.0.1:<port>/mcp` - it never calls a tool handler as a
function. So one probe exercises the listener, the token gate, the JSON-RPC
framing and the handler at once, and a tool that only worked in-process fails
all of them. The expected tool list is **typed out in the driver**, because a
list read from the server and compared to itself agrees with itself.

**BR-32 is C1's exact-pixel discipline applied to a screenshot the model would
see.** The tool hands back base64 PNG; the driver decodes it with `nativeImage`
- Chromium's decoder rather than the encoder that made the bytes - and counts
the fixture's colour. Then the page is repainted a colour it has never been and
the *same* comparator has to stop finding the first and start finding the
second. A path returning a stale frame, an empty image, or a picture of the
window rather than the page fails that pair - and the window is the plausible
mistake here, since `win.webContents.capturePage()` cannot see a
`WebContentsView` at all.

**BR-33 is the milestone's premise and it needs a decoy.** Every tool has to
work against a tab that is not on screen, judged by photographing the window.
The workspace makes its only pane the active one, so without a second tab
holding the front the agent's own tab *is* the tab in front and the group
measures nothing. The decoy is a fixture route in a colour the counter can never
mistake for the page under test.

Two phases, because a cookie surviving a restart is not a claim the process that
stored it can make. `run-browser.mjs` starts the app again and the fixture
rebinds the port phase one wrote down: an origin includes the port, so a new one
would read as an empty jar however well persistence worked.

**`fidelity` and `claude-check`** - TUI fidelity inside xterm. These render
`spike.html`, a separate page from the app, so app layout changes cannot move
the terminal under them. Read SPEC 8.3 - the terminal-fidelity spike - before
touching `terminal.ts` or `ptyEnv`.

**`design-shot`** - not a check, nothing is asserted. Opens the real window,
walks every main view in both themes, and writes PNGs. It is how a UI change
gets looked at rather than reasoned about. Measure a suspect edge in the PNG
rather than eyeballing it - `System.Drawing` from PowerShell is enough to scan a
column for an island's top and bottom edge.

Five groups, `--only=` like the checks (`GROUPS` in `designshot.ts` is the
authority): **views** is the walk itself, **states** the collapsed section and
the five hover probes,
**responsive** a width sweep over the two scoped pane headers, **split** a
pane docked beside a real session at four widths, and **tabs** the session strip
holding six sessions on one project at the window's `minWidth`. Three of them are
worth knowing about. `responsive` **prints numbers** - each header's `overflow`
and `spill`, the second being how far a child reaches past the padding box, which
is the failure a thumbnail does not show and the one the header bug was found by.
`split` reaches pane widths below the ~596px the window's own `minWidth` leaves:
the divider is bounded at a *fraction* of the row, so it docks far narrower than
any window can be made.

And `tabs` is the crowded strip, which is a *state* rather than a view and is not
reachable by clicking through the walk: it launches six real sessions on one
project, renames two of them through the real double-click, and shoots the strip
split and maximised in both themes. It prints numbers for the same reason
`responsive` does - a tab whose branch has been ellipsised looks slightly
shorter, not wrong, so each line reports the tab's width and whether either of
its two lines is being cut. It and `split` are the two groups that spawn
sessions; `tabs` closes its own before it returns, so the two do not photograph
each other's tabs.

Because it is the only group with more than one live session in it, `tabs` also
shoots the **sessions pane** populated, in both themes, with the detail half
open on a row - a list of one row says nothing about how rows read against each
other. And last, because it stops the activity poller, it shoots the **state
dots**: the four live states cannot be arranged on real sessions at once and
held still long enough to photograph, so they are pushed onto the strip
directly. That is allowed there and nowhere else - `design-shot` asserts nothing
and what has to be looked at is whether seven tones are distinguishable side by
side. Whether the wiring behind them is real is `sessions-check --only=state`'s
question, against a session driven into each state for real.

`states` **prints numbers too**. Five named probes: each moves the pointer away,
moves it onto the element that carries the class, and reports background, border
and a child's colour before and after. Three of them ask "did anything happen";
the other two - `segment-on` and `select` - exist because their hover is a
*judgement about a colour* rather than a yes/no, and the numbers are what say
whether a change an assertion scores as real is one an eye can find. Each probe
carries its own positive control, `el.matches(':hover')`, because a synthesised
move that never reaches the hit test reports every tint on screen as dead, which
looks identical to every tint being dead.

Whether a control has *any* hover state is `affordance-check`'s question, over
every control rather than five. These five stay because they print colours and
cost seconds.

**`affordance-check`** - does everything clickable look clickable. Walks ten
views in the real window, enumerates every button, link, select, tab and
checkbox on each, and puts a real pointer on each one in turn: AFF-3 says it
computes `cursor: pointer`, AFF-4 says some computed property actually changes
underneath it, AFF-5 says the converse - that a text field still reads `text`
and a disabled control does not read `pointer`, since `* { cursor: pointer }`
would pass AFF-3 and is the same lie pointing the other way. No sessions, no
network, about a minute and a half.

AFF-4 also asserts *where* the change lands. A control answering only on a
sibling or its parent is allowed, but only if it is a tab: the active tab is
drawn continuous with the pane below it, so its own fill is pinned and what
moves is its close button. Anything else answering that way fails, and that
tightening is not decoration - the same shape had been sitting in five list-row
components, where an `active ? … : 'hover:…'` ternary drops the hover recipe in
the selected branch and nothing redraws to cover it. AFF-7 is the narrow probe
for it: it opens a project, finds the sidebar row that is now `aria-current`,
and requires the row's **own** fill to change. `near` would pass that row for
the wrong reason, because its pin star fades in beside it.

AFF-6 is the one claim here about something that is *not* clickable. A drag
handle takes a resize cursor, so making it pass AFF-3 would mean putting a
wrong cursor on it to satisfy this file - but leaving it out and stopping there
would drop it into the coverage gap AFF-2 is named for. So a
`[role="separator"]` is measured against the cursor its own `aria-orientation`
calls for, from a table written in the driver rather than read from the app.
The floor is that it found one: an empty set reporting green is the shape
CLAUDE.md rules out.

Three things about it are worth knowing before touching it. It **plants two
controls first** (AFF-1) - one with no hover rule and an inline `cursor: default`
that no stylesheet can outrank, one with both - and refuses to run the walk
unless it fails the first and passes the second; an auditor is not believed
until it has been made to fail. It reads what a person would see rather than
scraping rules, because `document.styleSheets` throws `SecurityError` on
`file://` and returns an empty list that reads exactly like "no rules matched",
which is how the original bug survived one investigation. And a view is
confirmed by an **anchor element**, not by how many controls it produced: a
count high enough to catch a pane that never opened also fails
`config:health`, which legitimately holds one control until the doctor has run.

What it does not reach: the modal dialogs, the pull-request detail tabs and the
profile editor, all of which are behind a state the walk would have to create
and then unwind - and a walk that leaves a dialog open poisons every view after
it. Their controls are covered only where they share a recipe with something the
walk does reach.

Both this and the `states` probes exist because of the same failure. Tailwind v4
gates `hover:` behind `@media (hover: hover)`, and on a machine where Chromium
answers false to that (design-shot prints the four pointer queries beside the
probes) **every hover state in the app dies at once** with nothing else looking
wrong: the tokens resolve, the classes are present, the rules are in the
stylesheet. `theme.css` overrides the variant. Sampling three elements cannot
tell that from three unlucky ones, which is the whole argument for enumerating.

`views` walks the project pane **twice**: once for whatever the tree lists
first, and once for a project the pull-request snapshot knows about
(`project-repo-*.png`), found by path rather than by position. On a machine
organised into harnesses the first row is the harness, which is not a git
repository - so without the second shot a branch, a git stat group and the
whole pull-request panel are never photographed. It is skipped, out loud, where
there are no github.com remotes.

## Where the output lands

Every check runs against a **data directory of its own**:
`%LOCALAPPDATA%\Helm\checks\<name>\helm-data`, one per check so a failed run's
database and screenshots survive for inspection. `scripts/isolate.mjs` makes it,
and the app is told about it with `PORTABLE_EXECUTABLE_DIR` - the app's own
portable-mode mechanism, the same one `run-packaging.mjs` already used as isolation,
rather than a hook that exists only for checks. `paths.ts` puts `helm-data`
under it and calls `app.setPath('userData')`, so the database, the overlay
shims, the reports and Chromium's own profile all move together.

Not under `%TEMP%`, and that is not arbitrary: the directory holds `overlays/`,
whose subdirectories are junctions into real repositories, and CLAUDE.md's rule
about temp cleaners following reparse points is not relaxed by the directory
being a check's.

The database is **seeded with a copy of the real one** each run, taken with
`VACUUM INTO` through a read-only connection - the only safe way to read a
SQLite file another process holds open in WAL mode. So the checks still assert
against the machine's actual projects, roots and history, which is what makes
them worth running, while never writing to the file the user's Helm is using.
This is why `run-settings.mjs` can go on parking settings and restoring them:
what it parks is the copy.

**What the copy does not carry is where the developer left the app.**
`workspaceTabs` and `windowBounds` are stripped from it - the list is
`UI_STATE_KEYS` in `scripts/isolate.mjs` - so every check starts with an empty
tab strip and a 1280x820 window on every machine. Everything else comes across,
`firstRunCompletedAt` very much included: clearing that would start each run in
the first-run pane.

Draw that line before writing a driver, because the failure it prevents is the
expensive kind. `workspaceTabs` persistence landed and three probes began
failing on one developer's machine and passing everywhere else - S-1's Ctrl+Tab
ring was ten tabs long instead of two, S-10 was counting terminals it never
started - while both were entirely right about the app. A check that goes red
for a reason unrelated to what it measures gets waved past, and so does the day
it goes red for a real one. It also hid a second, real failure in S-1 for as
long as it lasted: the settings pane had grown a group and the probe's list had
gone stale, and nobody could see it behind the first red line.

`windowBounds` went with it and had never been noticed at all - `designshot.ts`
says "1280 is the default" and sizes a pane from that, while photographing a
window 1757 wide because that is where somebody had dragged it. `S-0` asserts
both, ungated by `--only=`, so a regression names itself instead of surfacing
as a bug in Ctrl+Tab.

A driver that genuinely wants the developer's tabs passes `keepUiState: true`;
`pnpm dev` does, because it is an app somebody sits in front of rather than a
driver that decides what is open.

Helm is a desktop app somebody is using while its checks run, and the drivers
used to point at `%APPDATA%\Helm` directly. Observed once: a run flipped the
live app's theme, font and default shell underneath it, and the only reason they
came back is that the run reached its restore. A run that dies leaves them
parked. Do not point a new driver at the real directory.

`run-packaging.mjs` is the exception and stays one. Its phases are *about* where data
lands - "beside the exe" for portable, `%APPDATA%\Helm` for installed - so an
isolated data directory would erase the thing it measures.

What is still shared, because it cannot be otherwise: `~/.claude`. Checks that
spawn a real `claude` add to its history like any session, and `config-check` edits
the real user settings layer and puts it back. `CLAUDE_CONFIG_DIR` moves
credentials too, so a session pointed at a fixture home cannot log in.

Screenshots are under `screenshots/`, reports are `<name>-report.json` at the
root. The multi-phase checks make the **report the verdict**, not the exit code,
because node-pty's teardown loses it.

## Writing a new check

- Drive the real window through `executeJavaScript`; never a test renderer.
- Assert against a reader you wrote separately, or against the world.
- Assert your fixtures exist and discriminate before believing a pass.
- If a claim cannot be made by the running process - "cleaned at startup",
  "survives a restart" - it needs a second phase and a `run-*.mjs`, and the
  verdict moves into the report.
- Put the group list in a `GROUPS` const so `--only` has one authority.
- Say what a run costs in the driver's header comment: sessions spawned, model,
  rough wall time.

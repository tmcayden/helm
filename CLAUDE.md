# Helm - Agent Instructions

Desktop shell on top of Claude Code. Read [docs/SPEC.md](docs/SPEC.md) before
doing anything - it holds the measured evidence behind every design decision.
Do not re-litigate what is recorded there without new evidence.

**All UI work follows [docs/DESIGN.md](docs/DESIGN.md)** - the "Nocturne
Islands" design system. Semantic tokens only (no raw hex in components), islands
with hairline edges on a sunken canvas, the accent never solid-fills anything,
no shadows outside modals, no text weight past 500, mono for machine data. A
change that cannot be expressed in the system's tokens is a deliberate
DESIGN.md amendment or a change to reconsider.

Look at the app, not at the class names. `pnpm design-shot` walks every main
view in both themes and writes PNGs to
`%LOCALAPPDATA%\Helm\checks\design-shot\helm-data\screenshots\design` - its own
data directory, like every check, and never the `%APPDATA%\Helm` somebody is
using while it runs. A UI change is not done until you have looked at one, and
measuring a suspect edge in the PNG beats eyeballing it. `--only=` narrows the
walk; the **`checks`** skill has the groups.

For the question design-shot's fixed itinerary does not reach - what happens
two clicks in - `pnpm dev --drive` and `scripts/drive-dev.mjs` click through
the window you have open, and take the same capture. The **`dev`** skill has it.

## Where the rest of this lives

This file is the part that has to be in mind while doing *anything*. Everything
else is a skill, loaded when the work calls for it, and the argument behind any
rule is in a comment at the code site it governs - that is the copy that stays
true when the code moves.

| skill | read it before |
|---|---|
| **`dev`** | launching the app to look at a change, or driving the window you have open |
| **`checks`** | running or writing a real-window check, or deciding which one a change owes |
| **`surfaces`** | editing the terminal, the usage figures, the pull-request pane, or anything touching a `.claude` tree |
| **`procedures`** | adding an app setting, changing the schema, or building a release |

## Work tracking

ClickUp list **"Helm - Claude Code Shell"** (`901114291892`). Nothing in this
repository refers to a task by id. Each task has checkbox acceptance criteria
and is done when every box is checked, not before. When a task's claim and a
check disagree, the check is right.

## Layout

```
packages/
├── core/     # headless: discovery/, launch/, config/, content/, github/, usage/, archive/, store/
├── ui/       # React components
└── desktop/  # Electron main + preload + renderer + the spike harness
```

pnpm workspaces, `node-linker=hoisted` (see `.npmrc` for why). `core` and `ui`
export TypeScript source rather than a build output, so the bundler compiles
them in and there is one build step, not three. `pnpm check` is what CI runs.

## Boundaries

- **`packages/core/` never imports Electron.** Enforced by `no-electron-in-core`
  in `eslint.config.js` - static imports, `require()` and dynamic `import()`
  alike. If core needs something from the host, the host passes it in.
- **A value import into the browser bundle comes from `@helm/core/types`**,
  never the package root, which reaches the filesystem through `launch/` and
  `store/`. That fails at rollup, not at typecheck, so `pnpm typecheck` will not
  catch it. Types are erased and may come from anywhere. `EFFORT_LEVELS` and
  `PERMISSION_MODES` are the ones this comes up for.
- **Every renderer↔main channel is declared in `shared/ipc.ts` and nowhere
  else.** The preload exposes three generic functions; a feature adds a channel
  to the contract, not a method to the bridge. Two terminal families exist and
  never mix: `term:*` is the spike page's single pty, `session:*` is the app's
  many. Changing `term:*` changes what `pnpm fidelity` measures.
- **The main process owns process lifetime.** Rows are written on spawn, so a
  session that dies immediately still happened; `before-quit` ends sessions and
  `will-quit` releases the database. Nothing else may close the store - the
  window's own `close` handler still writes after `before-quit` has run.

## Credentials

- **Never handle or store one, Claude's or GitHub's.** A sign-in is detected
  only from the *existence* of an artefact - `.credentials.json`,
  `ANTHROPIC_API_KEY`, an onboarding record in `.claude.json` - or from what
  `gh` prints on its own streams. Nothing opens any of them, nor `hosts.yml`,
  the keyring or `GH_TOKEN`. The whole remedy for "not signed in" is a sentence
  naming `claude` or `gh auth login`.
- **`~/.claude/sessions` holds a credential beside every record**, and the
  session-state reader's file filter is what keeps Helm out of it. Alongside
  each `<pid>.json` the CLI writes `<pid>.<sha256>.key` carrying a `peerToken`
  for its own session-to-session messaging. `readSessionRegistry` takes `.json`
  and nothing else; a change that widened that to the whole listing would open
  them, which is why the filter has the reason written on it rather than looking
  like tidiness.
- This is why the pull-request surface shells out to `gh` rather than calling
  the API. A remote URL carrying an embedded token is a credential too, so
  `parseGitHubRemote` strips the userinfo before anything reaches the database.
- The network posture is stated identically in four places - README,
  [docs/PACKAGING.md](docs/PACKAGING.md), the `update:check` comment in
  `shared/ipc.ts`, and SPEC 5. If it moves again, all four move together. It
  currently reads: *"Helm contacts nothing on its own initiative except the
  update check. Everything else on the network happens because you asked for
  it: the pull-request surface goes through your own `gh`, and the browser pane
  fetches the page you navigate to."*

  That sentence is about what Helm **contacts**, and the endpoint it serves to
  its own sessions did not change it. What did change is that Helm now
  **listens**, on loopback, for the sessions it hosts - see "The agent tools"
  below. That is stated separately, in the same four places, rather than folded
  into a sentence about outbound traffic.

  The listening paragraph has since moved once and the contacting sentence still
  did not: the listener serves **two** named servers rather than one, each with
  its own tick. Two families of tools is not two sockets and is not an outbound
  connection, so the four listening paragraphs moved together and nothing else
  did.
- **The browser partition is not an exception to the credential rule, and it is
  the one place that has to say so out loud.** `persist:helm-browser` holds
  cookies and logins for whatever the user visits, under the app's data
  directory. Nothing in Helm reads it - no cookie, no storage, no header - and
  the only call the app ever makes against it is `clearStorageData`, from a
  button in the pane. A feature that wanted to read that partition would be a
  feature that made Helm handle credentials.

## The browser pane

Seven rules, and each one is a thing that only shows up when it is broken.

- **The renderer's navigation lock is never loosened.** `will-navigate` and
  `setWindowOpenHandler` are denied on **every** web-contents in
  `main/index.ts`; browser views are exempted by a registry of `webContents.id`
  read *inside* those guards. A change that widens the guard instead of the
  registry is the change this rule exists to stop, and `BR-23` and `BR-40` are
  what say the window itself still gets `null` from `window.open`.
- **A browser view may open a real window, and only for `window.open` with
  features.** This is an amendment to "no Chromium window is ever created", and
  it was measured into existence rather than argued: denied, `window.open`
  returns `null`, every OAuth library reports a blocked popup, and the tab Helm
  opened instead has no `window.opener` for the sign-in to hand its code back
  through - so no popup sign-in could ever complete. The split is by
  disposition: `foreground-tab` and `background-tab` - `target="_blank"`, a
  middle click - are still Helm tabs, capped at `BROWSER_TABS_MAX`; only
  `new-window` is a window, capped at `BROWSER_POPUPS_MAX` per tab. A popup is
  on the same partition with the same denied permissions and refused downloads,
  is in the same exemption registry, goes through the same `browserReachAllows`
  as everything else, carries its host in its title bar because it has no
  address bar to put it in, and **is never an agent's**: an agent tab's
  `window.open` still becomes another agent tab, because "may not exceed the
  pane's reach" and "may not put a window in front of somebody" are two rules
  and only the first was already written down. `BR-39` and `BR-40`.
- **A view Helm is holding may have no web contents at all.** A page can close
  itself - `window.close()` is the last thing every OAuth popup does - and
  Electron then leaves `WebContentsView.webContents` **undefined**, not a
  destroyed object still answering `isDestroyed()`. `contentsOf` in
  `browser.ts` is the only way that file reaches web contents, and a
  `destroyed` listener retires the view exactly as `render-process-gone` does.
  This was a reported freeze and it is worth knowing which half was which: out
  of an *invoke* the `TypeError` was a rejection the renderer swallowed, so the
  pane went blank and refused every address in silence; out of the
  `browser:bounds` **send** there was no reply to reject into, so it was an
  uncaught main-process exception - Electron's own error dialog, once per
  `ResizeObserver` tick. `registerIpc` now wraps every send handler for that
  second reason, and `BR-38` is what says the whole chain stays fixed.
- **Every navigation goes through `browserReachAllows`, in `@helm/core`.** One
  function, taking as many restrictions as the caller has, allowing a URL only
  where all of them do - and the agent's restrictions are composed by
  `agentReach`, in the same file, so the pane's rule and the tools' rule cannot
  drift. It is also where the scheme rule lives: `file:` and custom schemes are
  refused by the same call.
- **A native view paints above all renderer DOM, so it hides for anything drawn
  over it.** The one subscribable answer is `overlayOpen()` in
  `packages/ui/src/lib/overlay.ts`, subscribed **once**, in `useBrowsers`. Two
  transient things get the same treatment for the same reason - a tab drag and
  the address bar's dropdown - and a **toast does not**, because it is not modal
  and is not transient; it is required to be drawn clear of the view instead
  (BR-10). The view must also never enter the top 36px, where Windows draws the
  window controls; main clamps that rather than trusting the layout.
- **Hiding is `setVisible(false)` because that leaves the page live.** M17 will
  drive tabs nobody is looking at, so hidden has to stay capturable, scriptable
  and clickable. Measured on Electron 43.3.0 and pinned by `BR-3`, which
  repaints the page a new colour *after* hiding it so a stale frame cannot pass.
  If that ever stops holding, the mechanism changes - parking the view outside
  the window is the fallback - and `BR-3` is what says so first.
- **Self-signed certificates are accepted for loopback and nowhere else**, and
  there is no click-through: Helm registers no `certificate-error` handler at
  all. Downloads are refused and handed to the system browser, every permission
  on the partition is denied, and the address bar never hands anything to a
  search engine. None of those is a setting; `browserReach` is the only one.

## The agent tools - the app's one inbound listener

A Claude session Helm hosts can drive that pane: open, read, screenshot, click,
type, press keys and evaluate. `main/browser-mcp.ts` serves MCP over HTTP and is
**the only thing in Helm that has ever listened for a connection**. Six rules,
and they are here rather than only at the code site because they are the ones a
future change would weaken without meaning to.

**One listener, two named servers.** `helm-browser` at `/mcp` is the pane;
`helm-sessions` at `/mcp/sessions` is the session-awareness tools below. One
port, one token per session, one process - and a tick each, which is what makes
each family's off assertable three ways rather than promised (see "The session
tools"). Every rule below is about the listener and holds for both.

- **Loopback and a token, always.** `listen(0, '127.0.0.1')` - never
  `0.0.0.0`, never a chosen port. Every request carries `Authorization: Bearer`
  or it is 401 before anything is parsed, and there is **no unauthenticated
  route at all**, not even a health check: a route that answered without a token
  would tell a local process which port to start guessing at.
- **A token per session, minted at launch and revoked when the session ends.**
  It is also the *identity*: attribution is which token arrived, never something
  the caller says. That is what makes "only a tab this session opened" a
  comparison. `before-quit` stops the endpoint **before** sessions shut down, so
  nothing can still be driving a browser on behalf of a process that is gone.
- **A family's tick off is off.** With every tool setting unticked there is no
  bind, no token and no `--mcp-config` at all - the app is then the process it
  was before any of this, and `BR-29` asserts all three. With one of them off
  and the other on, that family has no route (404 to a valid token), no name in
  the `--mcp-config` document, and no tool in any list, while the other family
  goes on answering; `SESS-32` asserts all four.
- **Registration is `--mcp-config`, written per session under the data
  directory.** Never `claude mcp add-json`, which writes into the user's
  `~/.claude.json` on every launch and leaves the entry there. The file is
  removed with its session, and what a crash leaves is swept by the rule the
  overlay shims are swept by: the owning pid is asked about, and anything not
  provably dead is left alone.
- **The reach rule is an intersection with no special cases.** An agent
  navigation is allowed only where `browserReach` **and** `browserMcpLocalOnly`
  both allow it; the narrower always wins, and an agent can never exceed the
  reach of the pane it is driving. Both restrictions are composed by
  `agentReach` and handed to `browserReachAllows` - the same function the pane's
  `will-navigate` calls. `browser_evaluate` is an escape hatch by design and a
  page it navigates is still held to `browserReach`.
- **A tool drives only the tabs its own session opened.** Not just closing:
  a tab the user opened is a page they chose to be on, in a partition that holds
  their cookies, and a tool that could screenshot or script it would be the
  credential rule defeated through a picture. `browser_tabs` lists everything,
  because listing is not driving.

One more thing is worth knowing before touching `browser.ts`: **a view whose
document has never painted while shown is not scriptable in the ways M17
needs** - zero viewport, empty `capturePage`, clicks that land on nothing - and
an agent's tab is never mounted by the window. `AGENT_PEEK` is the answer and
the comment there has the three approaches that were measured and rejected.

## The session tools - awareness, never coordination

The second family on that listener: `sessions_list` and `session_detail`, in
`main/session-tools.ts`, shaped by `core/registry/describe.ts`. A session Helm
hosts can ask what the other Claude Code sessions on this machine are doing, so
it can stay out of a working tree somebody else is in. Four rules, and the first
is the one the whole surface is bounded by.

- **No tool returns any part of another session's conversation.** Not its
  transcript, not its prompts, not its output. This is the analogue of "a tool
  drives only the tabs its own session opened", and a tool that could would be
  "Helm renders nothing for a live session" defeated sideways. It is structural
  rather than promised: the shaping type in core has no field for it, and
  **argv is absent for two independent reasons** - a review session's argv
  carries its opening prompt verbatim, and every argv names the session's own
  `--mcp-config` file, which holds that session's **bearer token for this
  endpoint**. The conversation id is withheld too, because it is the
  transcript's filename under `~/.claude/projects/`. `SESS-30` plants a marker
  in one session's first message and its argv, proves it is there, and requires
  it to be in no answer.

  **The same rule one level down: no child process command lines either.** A
  subagent is `claude -p "<prompt>"`, so a command line can be another
  conversation; it can carry a key as an argument or a nested session's
  `--mcp-config` path; and it is more than the question - `docker.exe` and the
  port already say somebody is holding this tree. `HeldProcess` has no field for
  one and `heldBy` is the only route in. The **pane prints them and is right
  to**: same data, different audience, different answer - a user looking at
  their own machine is not an agent being told about somebody else's work.
  `SESS-30` measures that half over the check driver's own process tree, because
  a `claude` at its prompt has no children and an answer about one could not
  contain a command line however the code was written.
- **Listing is machine-wide; detail is Helm's own.** The same split the sessions
  pane has, for the same reason - a `claude` in a terminal holds a working tree
  exactly as hard as a tab does - and withholding it would buy nothing anyway,
  since any session with a shell can read `~/.claude/sessions` itself. What is
  withheld is what Helm has no business inventing: for a session Helm did not
  spawn there is no branch, no profile and no process tree, and the answer says
  so in a sentence. **A status Helm could not read is "unknown"**, never omitted
  and never guessed - an agent told nothing concludes there is nothing there -
  and `waitingFor` is the CLI's own sentence carried verbatim, which `SESS-35`
  provokes with `/help` and asserts against its own read of the record.
- **Attribution is which token arrived.** No tool takes a session id of any
  kind, so there is nothing to spoof; a pid selects `session_detail`'s *subject*,
  which is a fact about the machine rather than an identity claim. `SESS-31`
  makes the same call twice with two tokens and requires two different answers
  about who is asking.
- **A tool call is somebody looking, for exactly one pass.** The process
  enumeration is watch-gated (`main/resources.ts`), and `session_detail` takes a
  watch, waits for one pass and drops it - the reference count doing its job
  rather than a way around the budget. `SESS-29` asserts the pass moved because
  of the call, so a tool that quietly answered "unknown" would fail.

**It is awareness and it must not grow into coordination.** Nothing here sends a
session anything, waits on one, or hands one work. Claude Code has its own
channel for that (`messagingSocketPath`, `peerFeatures: ["notify_idle"]`), which
Helm does not touch.

## Overlays

- **Shims live under the app data directory, never `%TEMP%`.** Their
  subdirectories are junctions into real repositories, and a temp cleaner that
  follows a reparse point instead of unlinking it deletes the repo's
  `.claude/skills`. Anything that removes a shim must unlink junctions
  (`fs.rm`) and must never walk into one.
- **Shims are swept only at app start** (`createServices`). Sweeping per launch
  would pull a plugin directory out from under a live session that a different
  profile started.
- **The sweep removes only what it can prove is dead.** A shim's stamp names the
  processes holding it; `cleanStaleShims` asks the kernel about each, counts
  `EPERM` as *alive*, treats a claim from before this boot as dead however the
  pid probes, and **leaves the shim wherever the answer is unknown**. The
  asymmetry is the design: a stale directory is collected at the next start,
  where a live shim deleted is a session that has silently lost its skills.
  "Nothing else is running" is never a thing one process may assume - `PROF-10`
  is two of them, overlapping, and it is what says this still holds.

## Where the data lives

Four modes, and `appMode` in `paths.ts` is the authority. Only one of them
shares a directory with another Helm, and it is opt-in:

| run | data directory |
|---|---|
| installed | `%APPDATA%\Helm` |
| portable | `helm-data` beside the exe |
| `pnpm dev` | `%LOCALAPPDATA%\Helm\dev\helm-data` - its own database, Chromium profile and `overlays/`, seeded each launch from a `VACUUM INTO` copy of the real one. A synthetic `gh` (`--gh=`), so the pull-request pane is offline and every state reachable. `~/.claude` and `claude` are the real ones, because `CLAUDE_CONFIG_DIR` moves credentials and a dev app that cannot sign in cannot host a session. `--fresh` for the first-run state; a second `pnpm dev` gets `dev-2`. |
| `pnpm dev:live` | `%APPDATA%\Helm` - the installed app's. Kept deliberately, says so loudly on the console, and the status bar's mode chip reads `dev · live`. |

A check gets its own directory too, under `%LOCALAPPDATA%\Helm\checks\<name>`;
see the **`checks`** skill.

**Harness templates are the one thing not under the data directory**, and they
take the same branch rather than a mechanism of their own. `templatesDir` in
`paths.ts` reads `PORTABLE_EXECUTABLE_DIR`: set, it is `helm-data/templates`
beside the exe, so a portable install stays on the stick and leaves nothing on a
machine it is plugged into, and `pnpm dev` and every check get their own for
free through `isolate.mjs`. Unset - installed and `dev:live` - it is
**`~/.config/helm/templates`**, not `%APPDATA%`, because these are files a
person writes by hand and probably keeps in git, and that is where somebody
looks for those. The shipped README and example are written **only when the
directory is absent** and nothing there is ever overwritten: Helm keeps no
hashes, so it cannot tell an edited file from an untouched one. The accepted
consequence is that an improved example never reaches an existing install, and
deleting the directory is the whole of "reset".

**`pnpm dev` copies that directory once and then leaves it alone**, which is the
opposite of what it does to the database and is the same rule one level down.
The database is a mirror nobody authors into, so a fresh `VACUUM INTO` every
launch is right; a template is a thing a person *writes*, and the dev app can
write one - so wiping and re-copying at every launch would lose it. Nothing here
keeps hashes either, so nothing can tell a template authored in dev from a stale
copy of a real one, and when the two are indistinguishable the outcome that must
never happen decides. Dev's copy therefore diverges; the launch banner says so
every time, and `pnpm dev --fresh` re-copies.

**Helm has no in-app editor for a template file, on purpose.** A template is a
folder, `shell:showItem` opens it, and the user's own editor is a better one
than a pane in a modal. What the app does is what a file manager cannot:
`.tpl` awareness, importing a skill out of a `.claude` tree Helm can already
see, and freezing a harness into a layout. Anything that walks a template or a
folder being frozen **unlinks a reparse point rather than following it** - the
Overlays rule above, in the second place it is load-bearing, and `fs.rm` with
`recursive: true` is not the mechanism: it was measured returning successfully
with a junction still in place.

## Surfaces that degrade

Each of these has one rule that must survive contact with a refactor. The detail
is in the **`surfaces`** skill.

- **`terminal.ts` and `ptyEnv` are load-bearing for TUI fidelity.** Every line
  is there because a spike measured the failure it prevents. Do not "simplify"
  either without reading SPEC 8.3, and never route a setting through the
  `term:*` channels - that is the change that would alter what `pnpm fidelity`
  measures.
- **Usage figures paint nothing rather than a wrong number.** Age alone is the
  exception, painting lower bounds. Dollar figures are estimates and say so.
- **Pull requests degrade the opposite way**: cached rows stay with their age on
  them. One condition stops a fetch pass - there is no `gh` binary. Every other
  reason is a claim about a server, and a claim about a server may never gate
  the request that would correct it (`PR-20`).
- **`~/.claude` is Claude Code's and Helm only reads it**, with exactly one
  exception: the config console writes, through a snapshot taken *before* the
  file is touched that aborts the write if the row cannot be taken. The
  transcript archive is **not** a second exception - it reads those files and
  copies what it reads into `helm.db`, and `pnpm transcript-check`'s T-5 hashes
  the whole tree either side of a full pass to say so.
- **A session tab's state comes from Claude Code's own live registry**, and
  `~/.claude/sessions` is read exactly the way the rest of that tree is. The CLI
  writes one `<pid>.json` per running session carrying `busy` / `shell` /
  `idle` / `waiting`; Helm joins it to its own sessions and puts the answer on
  the dot. It **never writes there and never deletes there** - a stale record is
  filtered at read time by liveness (`probeProcess`, plus `procStart` against pid
  reuse) and left for the CLI's own sweep. Everything it cannot interpret - no
  status published yet, a status this build does not know, a process that cannot
  be proved alive - degrades to what the tab painted before any of this existed.
  The record's age says nothing: it is written on transition, never on a timer.
  `SESS-16` to `SESS-19`, and `core/registry/`.
- **Listing sessions is machine-wide; saying what one is holding is not.** The
  sessions pane lists every live session on the machine, a `claude` somebody
  started in a terminal included, because such a session collides with a working
  tree exactly as hard as a tab does - it is the same rule `browser_tabs`
  established, that listing is not driving. The **detail** half is Helm's own
  and needs no special case for the rest: branch, profile, argv, process tree
  and ports exist because Helm spawned the pty, and for a session it did not
  spawn there is simply nothing to know. The tree is rooted at the **pty's** pid
  and never the registry record's - through a `.cmd` shim those differ, and the
  pty's is the one that roots what the session started. The half that cannot be
  argued into existence, only demonstrated, is the listing: `SESS-25` runs a
  `claude` on a pty Helm does not own and requires the pane to show it, and
  `SESS-26` requires the launch row of *that* folder to name it before the
  button is pressed.
- **The process pass is budgeted, and the budget is why it is not on the
  registry's timer.** Re-measured 2026-08-20: the registry poll is `readdir`
  plus a 451-byte read, **0.15ms**, and runs always; a process-and-ports
  enumeration is **400-480ms of wall time** across two runs, and 478-547ms with
  three sessions running under a check - most of it `powershell.exe` starting,
  which is why load moves it by tens of milliseconds and not by multiples. So it
  runs **only while the sessions pane is on
  screen** (`sessions:watch`), at 4s rather than 750ms, through `execFile` and
  never `execFileSync` - which leaves **0.11-0.21ms** of main-thread work per
  pass, the JSON parse of 58-66KB. That last number is the one that matters, because what
  queues behind main-thread work is pty resizes and IPC replies; the archive's
  16MB synchronous chunks are the standing precedent, and that one was not on a
  timer. Passes never overlap. `SESS-21` to `SESS-24`, and `main/resources.ts`.
- **"Could not look" and "nothing there" are never merged.** A tree that could
  not be enumerated is `null` and paints "Unknown"; a session with no children
  is `[]` and says so in words. Same for the ports, which fail independently,
  and for a command line the host would not give up - 159 of 277 processes
  withheld one to an unelevated query on this machine, and **no elevation is
  ever assumed**. This is the usage figures' rule with a sharper edge: here the
  wrong answer is not a wrong figure but a reassuring one, since "holding
  nothing" is what somebody checks before starting a second agent.
- **`CLAUDE_CONFIG_DIR` moves credentials too**, so a session pointed at a
  fixture home cannot log in. Measuring the user settings layer means using the
  real `~/.claude/settings.json`, snapshotted and put back.

## How a change gets done

The default is the ordinary one, and it is the whole of it:

- **A bug**: reproduce it first, build a test if nothing covers it, fix it, and
  make the covering tests pass.
- **A feature**: implement it, cover it, make the tests pass.

`pnpm check` - typecheck, lint, tests - is the gate. It is fast and hermetic and
it runs every time. Nothing else runs unless one of two things is true: the
change is in the narrow set where **only a real window can answer** - the
terminal and the pty, the browser pane's native views, overlay composition on
disk - in which case it owes **the one check that covers it**, narrowed with
`--only=` wherever that fits; or somebody asked for it.

**A release is not a testing event.** "Cut a release" means bump the version,
write the changelog section, merge, push. CI runs the fast tier, and
`verify-artifact.mjs` over both exes on publish. `packaging-check` is for a
release that **changes packaging** - electron-builder, the native modules,
`dist-win.mjs`, where files land - and is not owed by one that does not. If a
particular release looks like it needs more, say so in a sentence and proceed
anyway; the decision to spend the time is the owner's, and silence costs less
than ceremony.

**Measure until the answer changes what you do, then stop.** "Measure rather
than assume" is why the diagnoses in this repository hold up, and on its own it
has no stopping rule - so a measurement campaign runs well past its own verdict.
Three trials establish a deterministic result; more is earned only once variance
has actually been seen. Reproduce the bug, not the mechanism around it.

## Checks

They drive the **real window** and most spawn real `claude` sessions, so they
take minutes and cost tokens. That price buys the one thing nothing else does:
they are where a bug in the **real stack** is found - Chromium's own editing
commands, ConPTY, what a native view actually paints - which no unit test can
reach. So they are a tool for **discovery**, and a gate only for the surfaces
where only a real window can answer. Regression is the fast tier's job.

They are also, for now, the only coverage `packages/ui` and `packages/desktop`
have - every unit test lives in `packages/core` - and closing that gap is what
makes the rest of this honest, because "run the fast suite" currently means
running nothing for most of the app.

The **`checks`** skill has the table of which one a change owes, what each does,
and how to narrow a re-run. Two rules belong here rather than there:

- **A check that can pass with no evidence behind it is worse than no check.**
  `PROF-4` compared a session's answer against headings read from fixture files;
  when the files went missing the expected value became `''`, every answer
  matched, and it reported green for weeks. Any probe that reads an expected
  value out of a fixture must assert the fixture is there and is discriminating.
- **A check gets its own data directory**, reached through
  `PORTABLE_EXECUTABLE_DIR` - never `%APPDATA%\Helm`, which is the app somebody
  is using while the check runs. A new driver calls `isolate(name)` and threads
  its `env` into every spawn.
- **Nothing that touches the installed app may be part of a suite.** Every check
  gets its own data directory so it cannot reach the app somebody is using;
  verifying the NSIS installer is the one thing that cannot, because it is
  *about* where an installer puts things - it uninstalls the Helm on this
  machine and puts nothing back. So it is not a group of any suite at all: it is
  `pnpm verify:installer --yes`, which refuses without that flag and again while
  Helm is running. `packaging-check` **records that the installer was not
  verified there** rather than letting "packaging-check green" quietly stop
  including it.
  That is the shape the rule takes everywhere: a step that stops, removes or
  replaces the installed app is a **tool somebody asks for**, never a group a
  suite reaches on its own. The same goes for `dev:live`, which runs against the
  real `%APPDATA%\Helm`. Everything else in `packaging-check`, `--only=audit`
  included, is safe and expected.
  When a change owes coverage only that tool would give, **report
  the omission** rather than quietly closing it. Say it out loud to a subagent
  too, which otherwise reads "the checks this change owes" as the whole suite.

## Scope

- **Do not use `@anthropic-ai/claude-agent-sdk`.** Helm shells out to the
  `claude` CLI - see SPEC "Supersedes the SDK draft". The app hosts the TUI, it
  does not reimplement the client.
- **Helm renders nothing for a live session.** It parses no session output,
  handles no permission prompts, and puts nothing of its own between the user
  and the TUI it hosts. A feature that seems to need that is out of scope.

  **Amended when the transcript archive landed**, and the line is worth stating
  rather than deleting. Claude Code writes a transcript per session and reaps it
  on its own schedule - 744 sessions recorded on this machine, 68 transcripts
  surviving, 91% of the conversations already gone. Helm now reads those files
  before they are deleted and can render an **archived** one. That is not
  hosting a client: it is read-only, retrospective, over a record on disk, and
  never in the path of a running session. The boundary is *live*, not *messages*
  - while a session is running Helm still shows a terminal and gets out of the
  way. See `core/archive/`, `main/archive.ts` and `pnpm transcript-check`.
- Windows-first: junctions (`mklink /J`) not symlinks, no elevation
  assumptions, test paths with spaces.

## Environment notes

Whatever is true of **one machine** - where its `claude` binary sits, what
directory this checkout lives in, which repositories happen to be beside it -
belongs in `CLAUDE.local.md`, which is gitignored. This file describes the
project, and a contributor should be able to follow every rule in it without
owning the machine it was written on.

Nothing in `packages/` may assume any of that either, and two checks say so:
`pnpm packaging-check --only=audit` fails if a personal path or name reaches
what ships, and its publication audit fails if one reaches **anywhere in the
repository** - docs, this file, the scripts and the drivers included. That one
reads the names it looks for from `.audit-private.local`, an uncommitted file,
so the audit never publishes the list it polices; `.audit-private.local.example`
says how to write one.

Both derive what to look for at runtime. Do not answer a failure by adding an
exemption: the hit is the finding.

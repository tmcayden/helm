---
type: reference
date: 2026-08-08
tags: [claude-gui, electron, spec, launch-scope, plugin-dir, v1]
---

# Helm - v1 Spec

A portable, configurable desktop shell **on top of** Claude Code. Not a client,
not a reimplementation. It hosts the real `claude` TUI and owns everything that
happens before and after a session.

> [!warning] Supersedes the SDK draft
> The first draft of this spec was built on `@anthropic-ai/claude-agent-sdk`,
> rendering its own transcript and permission UI. That is rebuilding Claude Code.
> **Rejected.** This version shells out to the `claude` CLI and hosts its TUI
> unmodified. The SDK is not a dependency.

---

## 1. The Problem

Claude Code resolves `.claude/` configuration relative to the working directory.
That forces a choice at launch time, and both options lose something:

| Launch from | You get | You lose |
|---|---|---|
| **Harness root** | cross-repo access, harness tools, 8 harness skills | ~43 project skills, project agents, project CLAUDE.md |
| **A single repo** | that repo's skills, agents, CLAUDE.md | cross-repo access, harness tooling |

Measured on one working machine. The counts are the real census. The
repositories are labelled by the role they play rather than named, because the
argument depends on the shape - several repositories of one product, plus
unrelated ones, all with project-local skills - and not on what any of them is
called:

```
~/.claude/skills      0      ← nothing user-level
~/.claude/commands    0
~/.claude/agents      0

repos/product-core          skills:7  agents:16  commands:1  CLAUDE.md
repos/product-reporting     skills:6  agents:12  commands:1  CLAUDE.md
repos/product-builder       skills:5  agents:16  commands:1  CLAUDE.md
repos/product-ui            skills:5  agents:12  commands:1  CLAUDE.md
repos/product-mobile        skills:1
repos/unrelated-1           skills:6  agents:14  commands:1
repos/unrelated-2           skills:5  agents:12  commands:1  CLAUDE.md
repos/unrelated-3           skills:4  agents:14  commands:1  CLAUDE.md
repos/unrelated-4           skills:4                          CLAUDE.md
harness root                skills:8  commands:1
```

The five `product-*` repositories are one product, which is what makes them
worth composing together into a single session.

**Every skill on this machine is project-local. None are user-level.** So working
from the harness root - which is the right call at work, where the product is many
microservices and reaching all of `repos/` matters - silently drops ~43 skills and
~96 agents on the floor.

That is the problem Helm exists to solve. Everything else is secondary.

---

## 2. The Mechanism

`claude --help`:

```
--plugin-dir <path>   Load a plugin from a directory or .zip for this session
                      only (repeatable: --plugin-dir A --plugin-dir B.zip)
--add-dir <dirs...>   Additional directories to allow tool access to
```

A plugin is just a directory. Verified against the installed `superpowers` and
`vercel` plugins, the manifest is minimal:

```jsonc
// .claude-plugin/plugin.json
{ "name": "vercel", "version": "0.45.1", "description": "..." }
```

with convention directories beside it: `skills/`, `commands/`, `agents/`, `hooks/`.

A repo's `.claude/` directory is *already almost that shape* - it just lacks the
manifest. So Helm synthesises a shim per project:

```
%TEMP%/helm/overlay-product-core/
├── .claude-plugin/plugin.json      generated
├── skills/     ──junction──▶  repos/product-core/.claude/skills
├── commands/   ──junction──▶  repos/product-core/.claude/commands
└── agents/     ──junction──▶  repos/product-core/.claude/agents
```

and launches:

```bash
claude \
  --add-dir     repos/product-core repos/product-reporting \
  -n "refactor" \
  --plugin-dir  <data>/overlays/overlay-product-core \
  --plugin-dir  <data>/overlays/overlay-product-reporting \
  --append-system-prompt-file <data>/overlays/memory-refactor.md \
  --model opus --effort high --permission-mode auto \
  "/recap"
# cwd = harness root
```

Result: harness root as the working directory, with project skills and agents
composed in. The tradeoff disappears.

Three details that are load-bearing rather than stylistic:

- **`--append-system-prompt-file`** carries the overlays' CLAUDE.md. Plugins do
  not, and neither does `--add-dir` - both measured. See the risk table.
- **Argument order.** `--add-dir` is variadic, so `-n` follows it to terminate
  the list and the opening prompt goes last - a positional reachable from
  `--add-dir` is read as another directory.
- **The shim root is under the app's data directory, not `%TEMP%`.** A shim
  contains junctions into real repositories, and a temp cleaner that follows a
  reparse point instead of unlinking it deletes the repo's `.claude/skills`.

Windows note: **directory junctions**, which need no elevation, rather than
symlinks, which do - created with `fs.symlinkSync(target, path, 'junction')`
rather than by shelling out to `mklink /J`. Copy as a fallback.

> [!note] Proven by the composition spike (2026-08-08)
> `--plugin-dir` accepts a synthesised junction-based shim: skills, agents, and
> commands from two composed overlays all resolved and invoked from the harness
> root. The platform namespaces everything automatically
> (`<plugin-name>:<skill>`), so cross-overlay name collisions are impossible.
> One caveat: **plugins do not carry the overlaid repo's CLAUDE.md** - and
> neither does `--add-dir`, measured later and found wanting. Helm composes
> them into `--append-system-prompt-file` instead. The composition this settled
> on is what Helm implements; 8.1 has the detail.

---

## 3. The Core Object: a Profile

Everything in Helm is organised around one saved, reusable thing.

```yaml
name: "Product core + reporting"
root: ~/.harness/dev              # cwd
overlays:                         # composed via --plugin-dir
  - repos/product-core
  - repos/product-reporting
access:                           # --add-dir
  - repos/product-core
  - repos/product-reporting
  - repos/product-mobile
model: opus
effort: high
permission_mode: auto
agent: null
mcp: [clickup]
opening_prompt: "/recap"
```

One click launches it. That composition is not expressible in the CLI today
without assembling the flags by hand every time, which is precisely the ceremony
worth eliminating.

Profiles live in SQLite, exportable to YAML so they travel with a harness.

---

## 4. The Surfaces

Three of them are the product - the launcher, the config console and the content
viewer - and the terminal is what they all point at. Settings (4.5) is the app's
own, added late because every surface above it had a setting with nowhere to
live. Pull requests (4.6) is the first surface added after v1, and the first
that shows something that is not on this machine.

### 4.1 Launcher

- Tree of harnesses and projects, auto-detected (`harness.yaml`, then `repos/*`,
  degrading gracefully to "just a folder")
- Saved profiles, pinned and ordered
- Session list from `history.jsonl` - **799 sessions across 36 projects** when
  the launcher was built, which `/resume` can never show you because it only
  sees the current directory
- Click a session to resume it into a tab

> [!note] Built 2026-08-09
> The index mirrors `history.jsonl` into SQLite incrementally, and marks each
> session with whether it can actually be reopened. Three findings shaped it,
> all measured on 2.1.225:
>
> - **`--resume <id>` is resolved against the working directory.** The same id
>   that resumes from the session's own folder reports "No conversation found
>   with session ID" and exits 1 from anywhere else. So resuming needs the
>   recorded directory to still exist, and a deleted folder is as fatal as a
>   reaped transcript - the launcher distinguishes the two.
> - **A transcript cannot be found by deriving its path from the project.** The
>   directory under `projects/` carries whatever casing the CLI was started
>   with and `history.jsonl` records its own; two transcripts in the measured
>   set live under a `...-repos-Product-Reporting` directory for sessions whose
>   recorded project is `...\repos\product-reporting`. The scan is by session id.
> - **Retention is 13%, not 9%** - 106 of 799. Still the reason resumability is
>   read off the disk on every pass rather than remembered.
>
> Search is `LIKE`, not FTS5: a filter box has to match `geofenc` inside
> `geofencing`, which a tokenising index does not. Measured p95 **3 ms** over
> 3,472 prompts against a 100 ms budget (`pnpm history-check`, HIST-4).

> [!note] What a row is called - 2026-08-15
> A row was titled with its opening prompt, and an opening prompt is not a
> subject. Measured over this machine's 1,011 sessions and 4,084 prompts:
> **291 sessions open on a bare slash command** (`/exit` 114, `/usage` 43,
> `/model` 23), 15 open on an empty submission, and 353 prompts are nothing but
> an `[Image #N]` placeholder where the subject was a screenshot.
>
> **There is no summary to borrow.** 0 of 275 surviving transcripts carry a
> `"type":"summary"` record - the types present are `message`, `assistant`,
> `user`, `tool_use`, `tool_result`, `text`, `thinking`, `mode` and
> `attachment` - so a title has to be derived. Reading past the opener to the
> first prompt that *says something* (`core/discovery/title.ts`) retitles
> **132 of the 1,011** and leaves the rest alone.
>
> Derivation cannot do all of it, and the counter-example is in this
> repository's own history: six sessions whose first substantive prompt
> genuinely is the same sentence, because they are check probes. So a session
> can also be **named by hand**, and that name lives in `history_names`, a
> table of its own - `indexHistory` empties `history_sessions` and rebuilds it
> in full on a reset, so anything authored that lived on it would last until
> the next pass. `pnpm history-check` HIST-10 forces that rebuild and reads the
> name back afterwards.
- Per-project git state at a glance: branch, dirty count, ahead/behind

> [!note] Harness templates - 2026-08-15
> A harness could be scaffolded from the launcher from the start, and the
> scaffold was three entries with no opinion in them, deliberately: a starter
> layout is one person's way of working. That argument still holds for the
> *default*, and it is why `minimal` stays built-in code rather than becoming an
> editable directory - nothing anybody puts in the templates directory can
> change or break the row that always works.
>
> What it does not hold for is somebody's **own** layout. So a template is a
> user-authored directory tree in `~/.config/helm/templates` (portable:
> `helm-data/templates` beside the exe, on the same `PORTABLE_EXECUTABLE_DIR`
> branch as `dataDir`, so a portable install stays self-contained and every
> check is isolated with no new mechanism). The New Harness dialog grows a
> picker, and the "What gets written" list stops being three lines in a
> component and is read from the engine that does the writing.
>
> **Substitution is `.tpl`-only**, and that restriction is the one design
> decision here worth the words. `x.yml.tpl` is written as `x.yml` with
> `{{NAME}}`, `{{CREATED_AT}}` and `{{TEMPLATE}}` filled in; every other file is
> copied byte for byte. A whole-file `replaceAll` over the tree would silently
> corrupt any template that legitimately contains `{{...}}` - a GitHub Actions
> workflow, a Jinja fixture, a Go template - in a file its author never thought
> of as a template. `pnpm template-check` TPL-4 creates from a fixture carrying
> exactly that and requires the file to arrive identical to the byte.
>
> Three more rules, each because the obvious alternative is wrong.
> `dot-claude/` is accepted as an alias for `.claude/`, since a template is a
> directory people keep in a repository and tooling drops dot directories. An
> empty folder is declared with a `.gitkeep`, which is *not* itself copied -
> folders arrive as the parents of files, so the marker exists to survive git
> rather than to be part of anybody's harness. And entries that are absolute,
> climb out with `..`, or are junctions are refused with a sentence: a template
> is a file that can travel, which is the same threat model the `repos:` key
> already refuses those three for.
>
> **What was deliberately cut**, having been designed and then removed before
> any of it was built: a creation manifest (`.helm-template.json`), per-file
> post-substitution hashes, a three-way template/disk/manifest compare, an
> update-from-template pass with a plan/apply split, and a preview-of-changes
> dialog. A template makes a harness; from that moment the harness belongs to
> the user and their agents, to change as they please. Helm records no history
> of it and re-applies nothing - anyone who wants that has git. `template:` in
> the manifest survives as **provenance only**: it is shown on the harness row
> and its pane, it is carried through the projects cache so it is right on the
> first painted frame, and nothing reads it back to decide anything.
>
> Applying is **honest rather than atomic**. A dozen files can fail on the
> eighth, so the writer goes in a deterministic order, reports what actually
> landed, and lists the rest as problems. A rollback would be four more deletes
> that can themselves fail, over a directory the user can perfectly well look
> at, finish or delete.

> [!note] Authoring a template - 2026-08-16
> A template is a plain directory the user can open in any editor, and that one
> fact decides what is worth building in the app. **There is no in-app file
> editor**, and there is deliberately no channel that reads or writes an
> arbitrary file inside a template: `shell:showItem` opens the folder and their
> own editor takes it from there. A tree view and an editor pane was the
> largest piece of the original design and the piece most redundant with a
> folder somebody already owns. If in-app editing ever comes back it comes back
> as "the config console accepts a template directory as a scope", not as a
> second editor.
>
> What is built is what a file manager cannot do.
>
> **The manager** - reachable from the New Harness dialog *and* from Settings,
> because templates are app-level and nobody should have to start creating a
> harness to rename one. It lists label, description, file count and age;
> creates (a `template.yaml` and nothing else - a starter file here would be
> Helm's opinion arriving inside the feature whose whole point is that the
> layout is yours); renames, deletes, and shows in Explorer. Metadata is a
> two-field form rather than a YAML box, because a misspelled `label:` drops a
> template out of the picker silently.
>
> **`.tpl` awareness**, which survives the editor being cut precisely because
> it is the one part of the format nobody can infer from a folder listing. The
> file list badges a `.tpl`, shows what each file becomes (`CLAUDE.md.tpl` →
> `CLAUDE.md`, `dot-claude/` → `.claude/`), names the three variables in a help
> line, and offers the rename that opts a file in. A binary is refused that
> rename: substitution reads a file as text and writes it back, so marking a
> PNG substitutable is arranging for it to be corrupted at creation time.
>
> **Skill import.** `ClaudeInventory` cannot feed this - it is counts and
> carries no names - so the seam is the config console: `config:scopes` lists
> every `.claude` tree Helm can see, `config:tree` names what is in one, and
> the picker is that tree with checkboxes. Every scope is a source, `~/.claude`
> included, and that is a **read**; the writes land inside the templates
> directory and nowhere else (`assertTemplateWritable`). A skill copies as its
> whole directory - the console's own `configUnit`, so "copy this skill" means
> there what it means in the console - as **plain files with no link back**,
> because a template travels and a reference to `~/.claude/skills/think`
> produces a different harness on a different machine and none at all on
> somebody else's.
>
> **Save this harness as a template**, and **import a folder as a template** -
> one operation with two sets of defaults. A preview lists every top-level
> entry with its recursive file count and byte size, and **nothing is copied
> until it is shown**: `.git`, `node_modules` and `harness.yaml` are listed and
> refused rather than pruned silently, `repos/` is listed and unticked but may
> be ticked, everything else is ticked and the user unticks what is instance
> data - Helm cannot tell a journal from a scaffold, so it asks. `.git` and
> `node_modules` are refused **at every depth** and are not merely defaults: a
> `.git` in a template puts one workspace's history into every harness made
> from it, and pruning them is also what bounds the walk that states the size.
> `harness.yaml` is refused rather than merely unticked because `applyTemplate`
> already refuses one, so copying it would author a template guaranteed to
> report a problem the first time anybody used it. A `dot-claude/` tree is
> copied **verbatim**: the alias is the author's choice, applied by the writer
> when a harness is made, and normalising it on the way in would undo the
> decision they made for whichever tool needed it.
>
> **A reparse point is unlinked, never walked** - every traversal asks
> `isSymbolicLink()` before `isDirectory()`, because a Windows junction answers
> yes to both. This is the overlay-shim rule in the second place it is
> load-bearing, and the deletion half is the unrecoverable one: a delete that
> walked into a junction removes the contents of a real repository.
> `removeTree` is written out rather than left to `fs.rm(..., { recursive:
> true })`, and that is measured rather than defensive - `pnpm template-check`'s
> own fixture teardown used the built-in call and was found **silently leaving
> a junction in place**, returning without error.
>
> Writes go through `writeSnapshottedFile` with a guard of this surface's own,
> exactly as the content viewer does it, so there is one write path in the app
> rather than a third with a third set of bugs. Deleting a *template* has no
> undo, and that is stated rather than half-provided: the snapshot table holds
> text and a template holds whatever its author put there.
>
> `pnpm template-check`'s **`authoring`** group is the regression test -
> TPL-12 to TPL-18, driven through the real manager. TPL-13 earns its byte
> comparison the way TPL-1 does, on its own fixture: clean, then a flipped
> source byte the same comparator must reject, then restored.

### 4.2 Config Console

The `.claude/` directory of whatever scope you point at, as a real interface.

- **Scope switcher:** user / harness root / project. Pick one, see its `.claude/`.
- Browse and edit `skills/`, `commands/`, `agents/`, `hooks/`, `settings.json`,
  `CLAUDE.md`, `.mcp.json`
- **Effective view:** given a profile, show what is *actually* active - which
  skills resolve and under which overlay namespace (deterministic per 8.1:
  `<overlay-name>:<skill-name>`), and which scope won for each setting (user vs
  project vs local) and why. This is the payoff of the composition model and the
  thing no file explorer can tell you.
- MCP managed by shelling out to `claude mcp add / get / add-json` rather than
  editing JSON by hand
- Every write snapshotted to SQLite first, with per-file undo history
- `claude doctor` surfaced as a health panel

> [!note] Built 2026-08-10
> Four views over one scope switcher - files, effective, MCP, health - and the
> only surface in Helm that writes to a `.claude` tree. Three findings shaped
> it, all measured on 2.1.225:
>
> - **Settings merge per leaf, not per key.** A project `settings.json` setting
>   `env.A` and a `settings.local.json` setting `env.B` yield a session with
>   both, and the local file wins where they collide. A view keyed by top-level
>   key would have reported `env` as wholly replaced, which is wrong in the
>   direction that loses settings. The effective view is keyed by `env.A`, and
>   the winner is read back out of a live session rather than assumed.
> - **`CLAUDE_CONFIG_DIR` moves the credentials too**, so the user layer cannot
>   be measured against a fixture home - a session pointed at one cannot log
>   in. `pnpm config-check` therefore borrows the real `~/.claude/settings.json`,
>   through the console's own snapshotted write, and hash-verifies it back.
> - **The JSON error position cannot be read out of V8's message.** On Node 24
>   a trailing comma reports `Unexpected token ',' ... is not valid JSON` with
>   no offset at all, and falling back to the end of the file marks a line
>   twenty below the mistake. Helm scans for the position itself.
>
> The namespace prediction needed no measurement - the composition spike
> settled it. Overlay
> skills resolve as `<overlay>:<skill>`, which is decidable from the profile,
> so the view predicts names rather than detecting collisions. `pnpm config-check`
> checks all of it against a second, independent read, and the effective view
> against a real session on haiku.

### 4.3 Content Viewer

Read what Claude writes without a detour through Explorer and a text editor.

- Rendered **markdown** with GFM: tables, task lists, callouts, code highlighting
- Rendered **HTML** in a sandboxed webview, for artifacts and generated reports
- Sources: `notes/` (the Obsidian vault - so `[[wikilinks]]` must resolve and be
  clickable), `context/*.yaml`, any `SKILL.md`, any file Claude produced
- Frontmatter parsed and shown as a header chip, not raw YAML noise
- Full-text search across notes and skills
- Edit-in-place with a split preview

#### Two modes, because a harness and a project are different questions

> [!note] Amended 2026-08-14 - the scope split
> The list above describes one surface, and building it produced **two**. Root
> discovery - the four named directories, then any other top-level directory
> that turned out to hold something readable - is a **curation** model, and
> curation is only correct for a harness. A harness's directories *are* the
> agent's knowledge layer, so "which of these is worth reading" has an answer.
>
> In a project the same rule produces neither a curated set nor a complete one.
> `packages/` appears because one package happens to carry a README; `src/`
> does not appear at all; and nothing on screen says what was left out. An
> arbitrary slice of a repository is worse than either extreme, and it is a
> heuristic that cannot be tuned into rightness - every rule that admits `src/`
> also admits `node_modules/`.
>
> So the pane has two modes and the scope's kind picks **only the default**:
>
> | | **Curated** | **Tree** |
> |---|---|---|
> | default for | a harness | a project |
> | offers | the four named roots, plus any other top-level directory a walk found content in | every entry, one directory per expand |
> | order | newest first inside a root - a notes directory is a journal | directories then names, the way a file tree is read |
> | bounds | an eager walk, `MAX_DEPTH` and `MAX_FILES` | none; nothing is read until it is opened |
> | omits | `repos/` - each repo is a scope in its own right | nothing. Ignored paths are listed, greyed and badged |
> | carries | wikilinks, frontmatter chips, full-text search | - |
>
> **Neither mode is locked to a kind.** A harness with a large `tools/` is worth
> walking as a tree, and a project's `docs/` is still a vault. The mode is a
> segmented control in the header with a caption naming the active rule, and it
> is remembered per scope.
>
> Three things the split forced, and they are the substance of it:
>
> - **Curation decides which *directories* are offered. It never decides which
>   files inside one are shown.** The old `contentFileKind` returned null for
>   anything it did not recognise and the walk used that as a filter, so an
>   agent's own `tools/*.py` was invisible in the pane meant for reading what
>   the agent wrote. A file's kind now decides how it **opens** - `source` and
>   `binary` join the four - and never whether it is **listed**. This is the
>   rule the config tree already drew with `TEXT_EXT`.
> - **Root discovery counts source as content**, so a directory holding nothing
>   but scripts is a found root. Binary still does not: a directory of PNGs is
>   not a place to go reading. And a **named root that is empty stays listed**
>   and says so, because dropping it would be the same silent omission one level
>   further down.
> - **Both modes carry a count in the header** - files and roots for curated,
>   top-level entries and ignored for the tree. That count is the direct answer
>   to "nothing on screen says what was left out".
>
> What the tree ignores is the **repository's** decision, not Helm's:
> `git check-ignore` is asked, so nested `.gitignore` files, `.git/info/exclude`
> and negations are all exactly right without a second implementation of a
> format that is easy to get subtly wrong. Where there is no git the built-in
> list takes over, and the pane says which of the two answered. Symlinked
> directories are listed and never followed, in both modes and for the reason
> the config tree does not follow them either: an overlay shim's junction points
> back into a real repository.
>
> **Full-text search stays the vault's feature.** Its corpus is the curated
> roots in both modes, and the status row says so along with which kinds had
> their bytes read - markdown, data, text and source, with names matched for
> every file and binary never read. Source is in because "where did the agent
> define X" is a vault question. Extending the corpus to everything a tree can
> reach would make it a code search engine over `node_modules`, which is a
> different product.

#### The editors: a textarea with an overlay, not a code editor

> [!note] Decided 2026-08-16
> Helm edits files in two places - the config console and the content viewer -
> and both are **one component**: a `<textarea>` with an `aria-hidden`
> highlighted `<pre>` under it, the textarea's own text transparent and its
> caret painted. Not CodeMirror, not Monaco. This is written down here because
> the argument had already evaporated once: it lived in a comment in
> `ConfigEditor.tsx`, the file was rewritten, and nothing in `packages/` or
> `docs/` carried it afterwards.
>
> Four reasons, in the order they matter:
>
> 1. **The read views already highlight with shiki.** CodeMirror tokenises with
>    Lezer - a different grammar family, different scopes, different themes - so
>    the same file would be coloured one way when read and another way when
>    edited. Two colour schemes for one file is worse than no colour in the
>    editor.
> 2. **Ten check sites drive these two boxes** through
>    `HTMLTextAreaElement.prototype`'s value setter - `configcheck.ts` eight
>    times, `contentcheck.ts` twice. The overlay keeps every one of them green
>    because the element they query is still there and still a textarea; an
>    editor framework breaks all ten at once.
> 3. **The overlay is what *enables* two of the features**, rather than being a
>    cost paid for them. Find-in-file paints its matches by wrapping the actual
>    characters in the underlay, and the line-number gutter is measured off the
>    underlay's line boxes - so both are wrap-aware by construction, with
>    nothing positioned by arithmetic and nothing that can drift.
> 4. **Bundle.** A megabyte of editor for a gutter. This was once the only
>    reason and is now the fourth.
>
> **The decision is held under a performance condition, and the condition is
> measurable.** If keystroke-to-glyph cannot be kept inside one frame on a
> textarea, that is new evidence and CodeMirror is back on the table.
> `pnpm highlight-check --only=latency` is the instrument: an `input` listener
> counts `requestAnimationFrame` callbacks to the first one where the painted
> layer holds what the box holds, and anything but 1 fails. Measured on this
> machine at three sizes, worst frame in each set: **7.5 ms** on a 9 KB file,
> **61 ms** on a 464 KB one, **12 ms** past the size ceiling. Colour arrives
> **157 ms** after the last keystroke on a 3,000-line file, against a ~250 ms
> target.
>
> Three mechanisms make that true and each is load-bearing:
>
> - **The underlay takes the raw text synchronously.** Keystrokes never wait for
>   a tokeniser, an IPC round trip or a debounce. When the tokeniser answers, a
>   common-prefix/common-suffix line diff keeps the colour of every line the
>   edit did not touch, so typing on line 40 of a 900-line file leaves 899 lines
>   coloured rather than dropping the document to grey for 110 ms per keypress.
> - **Highlighting runs in main, over debounced IPC** (`editor:highlight`),
>   through the same `core/src/content/highlight.ts` the read views use.
>   `highlightLines` is the same tokenise stopped a step earlier, handed over
>   per line. Main is externalised, so `import('@shikijs/langs/<name>')`
>   resolves through Node and **every grammar shiki ships is reachable with no
>   list to maintain**; a renderer-side highlighter would need a hand-written
>   map, capping the languages at whatever somebody remembered.
> - **Above a line threshold the coloured layer renders the visible window**,
>   and a full-file mirror underneath it - one text node, painting nothing -
>   is what places that window exactly in both wrap modes.
>
> **Above the size ceiling the whole overlay is dropped**, not just the colour,
> and that came out of the measurement rather than out of the design: with the
> underlay up, a keystroke into a 1.29 MB file took **1,920 ms** to reach the
> frame that painted it, because a text layer holding the file is laid out again
> on every one. Past the ceiling the textarea paints its own glyphs, the gutter
> and match painting go with the overlay, and the footer says so - **12 ms**.
> The criterion is "degrades rather than gets slow", and 1,920 ms was getting
> slow.
>
> Out of scope and written down so it does not creep: multi-cursor, code
> folding, autocomplete, diagnostics, a minimap, virtualised rendering beyond
> the window described above, and project-wide search-and-replace.

### 4.4 Terminal

`xterm.js` + `node-pty` hosting the **real** `claude` TUI, in tabs. Helm renders no
messages, parses no output, handles no permissions. It supplies the argv, the cwd,
and the environment, then gets out of the way.

A project pane also carries a plain **shell** in the project's directory - `git
status` and `pnpm dev`, not a session. Its executable is a setting with a
per-pane override, and the running one is named in the pane's header.

What a person may change about a terminal is font family, size, cursor shape,
whether the cursor blinks, and scrollback. What they may not change is the
**colours**: the 24-bit palette is Spike C's, fixed in both themes and asserted
pixel-for-pixel by `pnpm fidelity`, so making it settable would be a design
amendment rather than a row (DESIGN.md par. 6).

> [!note] Built 2026-08-11 - terminal preferences
> Font changes apply **live to every open terminal** - both registries, session
> panes and project shells - because a font is judged by looking at the thing
> you are going to read in it. A pane that is hidden takes the new settings and
> refits to nothing: a hidden container measures 0x0 and the fit guard refuses
> to act on that, so its pty hears about the new cell size when the pane comes
> back rather than being resized to one column in the meantime.
>
> The chosen family is **prepended** to the built-in stack, never substituted
> for it. A font picked for its letterforms is rarely picked for its
> box-drawing, and Claude Code's whole interface is box-drawing - so a font with
> holes in it loses a glyph at a time instead of taking the TUI down. There is
> no way to express "replace the stack" from the pane, on purpose. The pane
> hints when a family is not installed, and that hint is *measured*:
> `document.fonts.check` reports on the document's own `@font-face` rules and
> returns true for a family it has never heard of.
>
> `estimateGrid` - the pre-spawn guess that decides what size a pty opens at -
> reads the same settings, and had to be taught to measure the way xterm does.
> A canvas and a layout engine resolve a font stack by different rules and
> disagreed by 6% on this machine; the WebGL renderer then floors a cell to
> whole device pixels and FitAddon holds back a flat 14px for the overview
> ruler. With all three, the estimate lands on the fit exactly at 20px, where it
> was eight columns out before.
>
> Shell choice is a default setting plus a per-pane picker, and the resolver
> reads the setting **per open** rather than memoising it - only the
> auto-detection is remembered, and that is a fact about the machine. The
> filename substring test that decided a shell's arguments is replaced by a
> table keyed on the executable's own name: the old one gave `-NoLogo` to
> anything whose *path* contained `pwsh`, and `bash -NoLogo` prints a usage
> error and exits. Claude sessions are untouched by any of it - Helm hands the
> CLI its own pty.

### 4.5 Settings

Helm's own configuration, and the permanent home for all of it. Distinct from
the config console by ownership: 4.2 edits the `.claude` trees that belong to
Claude Code and are shared with every other client on the machine, this edits
the app.

A `{kind:'settings'}` workspace pane, opened by the gear in the title bar beside
the theme toggle, laid out as one scrolling page of titled groups:

- **Claude CLI** - the resolved executable, its version and whether that version
  is inside the tested range, "Locate manually…", and **Clear override**
- **Workspace** - the scan roots, with add *and remove*. Not the only way out
  any more: a folder that is itself a root carries the same removal on its own
  project pane - the "Scanned folder" panel, in 5's Portability note - which is
  where somebody looking at a folder they want gone actually is
- **Appearance** - theme, and what the status bar's usage segment shows
- **Updates** - this build's version, the newest release Helm has heard of, one
  sentence saying which of five things is true of the pair, the launch-check
  tick, **Check now** and **Release notes**
- **Terminal** - font family (with a hint when it is not installed), size,
  cursor shape, cursor blink, scrollback, and the default shell for project
  panes; then a preview well rendering a sample at the chosen font on the
  terminal's own ground. See 4.4 for what these do and why colour is not
  among them.

> [!note] Built 2026-08-11 - the settings pane
> Three things the app had been missing rather than three new settings:
> `claudePath` was reachable only during first run, so a wrong pick was
> permanent once `firstRunCompletedAt` was stamped; `roots:remove` had had a
> channel and a handler since first run landed and **no caller at all**; and
> the usage mode
> was reachable only by clicking the status bar until it landed on what you
> wanted.
>
> The two quick accessors stay. A control beside the thing it changes is worth
> having - what was missing was somewhere to find the setting when you are not
> already looking at it. Both write `settings:write` and the pane renders
> `settings:changed`, so they cannot disagree; `pnpm settings-check` clicks each
> one and watches the pane follow.
>
> `app_settings` is JSON-per-key and needed no migration. What it did need was
> **validation**: there was none, so `{theme:'purple'}` persisted and reached
> `nativeTheme.themeSource`. Writes now validate per key and a patch applies as
> one edit - one bad value writes none of them - while reads stay tolerant of
> unknown keys and unparseable values. Strict in, forgiving out: a row from
> another build is a fact about the past, a malformed write is a bug happening
> now.
>
> Internal state (`windowBounds`, `firstRunCompletedAt`) is deliberately not
> shown. Those are things Helm remembers, not things anyone chose.

> [!note] The workspace strip is remembered too (2026-08-11)
> `workspaceTabs` joins that internal group: which panes are open, the order
> they were arranged in, and which one was in front. Reordering a tab strip
> that forgets itself at every launch is arranging deck chairs, so the two
> belong together.
>
> Restoring is a **derivation, not a sync**. The saved strip stands in until
> something is opened, closed or moved, which is why the renderer holds
> `PaneRef[] | null` rather than `PaneRef[]`: "nothing arranged yet" and "every
> tab closed" are different states, and only the first should fall back to the
> last launch. An effect that copied the setting into state when it landed
> would paint an empty strip first and the real one after, and would need a
> latch to survive `settings:changed` firing on its own writes.
>
> The **session** strip is deliberately not saved. `before-quit` calls
> `sessions.shutdown()`, so no session outlives the app, and tabs pointing at
> processes that no longer exist are not a workspace restored - they are a row
> of dead tabs to close.
>
> A pane is written down as its fields, never as its tab id: a Windows path can
> contain a `#` and a `:`, so `pr:C:\work\helm#7` is an identity to compare and
> not a record to take apart. What is saved is the strip **on screen**
> (`openPanes`), so a tab whose project a rescan no longer finds does not come
> back on the next launch.

> [!note] Updates became a group, and gained a Check now (2026-08-12)
> The update check could only ever happen to you. It ran at launch, at most once
> a day, and if the throttle had not elapsed or the network was away there was
> no way to ask and nothing on screen saying so - the whole surface was one tick
> in Appearance and a line in the status bar that appeared only when a newer
> release existed. Three of the four states it can be in were invisible.
>
> So: an **Updates** group, and a **Check now** in it. The channel already
> existed and already kept no throttle; what was missing was anything that
> pressed it. It is deliberately unthrottled and deliberately live when
> `updateCheck` is off - the setting governs whether Helm asks *by itself*, not
> whether the user may, and a deliberate act that silently did nothing would be
> worse than no button. The network posture in section 5 is unchanged: same one
> connection, same payload, still no artefact fetched.
>
> The launch throttle (`lastUpdateCheckAt`) is **not** stamped by a manual
> check, and that is the load-bearing half. The bound is what earns the app the
> right to ask on its own; a button that moved it would let a person pressing it
> silently buy Helm another day of not asking.
>
> The outcome is one sentence in five states - `checking`, `unasked`, `newer`,
> `current`, `unreachable` - and `unreachable` is toned `todo`, never `warn`. A
> machine on a train has done nothing wrong, nothing is known to be out of date,
> and a warning triangle would be Helm blaming the network for a question Helm
> asked. It names the reason and says what could not be *asked*.
>
> `AppInfo` gained `releasesUrl` for the same reason. The link has to work in
> exactly the three states that produce no check result - up to date, could not
> ask, never asked - which are also the three where somebody most wants to go
> and look, so it cannot come from `UpdateCheck.url`.
>
> The renderer's hook keeps two results, not one. The status bar reads the last
> check that *completed*, so a failed manual check cannot take down a link a
> successful one put up; the pane reads the last check *attempted*, because
> "could not ask" is what a person who just pressed the button is owed.
> `pnpm settings-check --only=updates` is S-14 to S-18.

### 4.6 Pull requests

The first surface whose subject is not on this machine: the open pull requests
of every scanned repository whose `origin` is on github.com, a GitHub-shaped
detail tab for any one of them, and a button that starts a Claude Code session
reviewing it.

GitHub.com only, deliberately - there is no provider abstraction here and no
room reserved for one. A second forge would need a different fetch mechanism, a
different auth story and a different set of fields, and an interface guessed in
advance would be wrong about all three.

- **Sidebar** - a second global row under Session history, with the count on its
  second line (`12 open · 5 repos`) or the reason there is not one.
- **Pulls pane** - grouped by state of play rather than by repository. Every
  open pull request across every repository comes first, most recently touched
  first, each row carrying the repository it belongs to as a pill; then the
  repositories that could not be fetched, with their reasons; then the ones with
  nothing open, as chips ("Checked, nothing open."); then the ones being
  ignored, as dashed chips that tick themselves back on. A row is a state mark,
  `#42` and a title with `+a −d` pinned right, then the repository, author, age,
  `head → base` and the check tally underneath. Grouping by repository instead
  spends most of the pane printing the names of repositories with nothing in
  them, and puts the two rows that matter below the fold. No buttons on a row
  (house rule); the row itself opens the pull request.
- **Project pane** - the same rows for the one repository the pane is about,
  under a panel captioned with the slug and the age. The row is the same
  component (`PullRow`) *without* its repository pill: the pill says which list
  a row came out of, and here the panel already said. The panel is **absent**
  for a project the surface has nothing to say about - a folder with no
  github.com origin is most folders - and present with a sentence when the
  ignore list is what is keeping the rows away, which is why `IgnoredRepo`
  carries the paths it maps to. A pane scoped to one directory cannot look a
  slug up, and "no panel" on a project page would read as "no pull requests":
  the setting hiding itself, on a second surface.
- **Pull request tab** - one island: header facts, then Conversation, Commits
  and Files behind a segmented control, then the review row, separated by
  `.island-rule`s. Laid out as GitHub's own page is because that is the shape
  anybody opening it already knows. A state chip in hairline tones, the review
  decision in words beside the check tally, and "Open on GitHub".
- **Review** - the island's last section: one primary button, and a sentence
  naming the program, the working directory, the exact opening prompt and any
  model or effort flag *before* it is pressed.

**Everything goes through the user's own `gh`.** Helm never receives, stores or
reads a GitHub token: `gh` owns it, every fetch runs on it, and a sign-in is
detected **only from what `gh` reports on its own streams**. Nothing opens
`hosts.yml`, the keyring or `GH_TOKEN`. This is the same rule Claude's
credentials have, for the same reason, and it is why the surface shells out
rather than calling the API.

**"Signed out" and "cannot reach GitHub" are different answers and Helm must
not confuse them.** `gh auth status` cannot tell them apart: with no route to
github.com it exits 1 and reports the token as invalid, naming `gh auth login`
as the remedy for a credential that is fine. Measured on gh 2.86 - the same
token exits 0 a second later with the network restored. So the exit code is an
opinion and the **fetches** are the verdict: `classifyGhFailure` reads gh's
connection vocabulary off a failed `pr list` and splits `offline` from `auth`,
and `gh auth status` is consulted only when a sweep had nothing to fetch. Two
rules follow and both are load-bearing. Nothing on the `offline` branch may
name `gh auth login` - a user who runs it is told they are already signed in
and learns nothing. And only the absence of a `gh` **binary** may stop a pass:
a cached `authenticated: false` gating the sweep meant one dropped connection
turned the surface off until the app was restarted, because the re-check that
would have cleared it only ran after a fetch that no longer happened.

**Degradation is stale-with-age, not degrade-to-nothing** - which is the
opposite of the usage figures (4.4), and the difference is what the number
means. A plan percentage from two hours ago is a wrong number; a pull request
that was open two hours ago is a true fact about two hours ago. So a failed
fetch leaves the cached rows exactly where they are, puts the reason on the
repository that failed, and the age caption is **mandatory rather than
decorative**: `PullsSnapshot.fetchedAtMs` exists so that no surface can paint
the list without saying how old it is. No `gh` at all gets a sentence naming
where to get one; an unauthenticated one gets `gh auth login`.

**A repository can be ignored, and ignoring it is not a filter.**
`prIgnoredRepos` is a list of `owner/name` slugs, and it is applied *before* the
fetch: an ignored repository is a `gh` process that never starts, not a row
dropped from an answer already paid for. A denylist rather than an allowlist,
because appearing here is what discovery already means - a fresh clone shows up
without being enrolled, and going quiet takes a deliberate act. Keyed by slug
rather than by directory for the same reason the fetch is: one call covers every
checkout of a repository, and a slug survives being re-cloned somewhere else.
Matching is case-insensitive, because GitHub's names are.

Two things follow from the honesty rule above. The pane **names what it is not
showing** - an "Ignored" section beside "Quiet repos", because a repository
nobody looked at is not a repository with nothing open, and a list that silently
dropped one would read as a complete list. And the cached rows are **kept**:
they are true facts about the last time anybody looked, so ticking a repository
back on paints what it had with its age on it rather than an empty list, which
is stale-with-age applied to the user's own setting. The tick itself lives in
Settings → GitHub with the other settings; the pane carries only the untick's
undo, standing beside the thing it undoes.

**The review launch composes its prompt in main**, never in the window.
`pr:review` carries `{repoPath, number, cols, rows}` and nothing else - the
same shape `profile:launch` takes, and for the same reason: argv assembled in a
renderer is argv that can drift from what was saved. Main looks the pull request
up in its own cache, reads `prReviewPrompt` (default `/code-review {number}`,
the built-in skill) and `prCheckout` out of settings, optionally runs `gh pr
checkout` - refused outright on a dirty tree, because a tool that moves
somebody's uncommitted work is a tool they stop trusting - and passes the
rendered prompt as the trailing positional of an ordinary launch. `prReviewModel`
and `prReviewEffort` ride along the same way: read in main, emitted as `--model`
and `--effort` before the positional, and **null passes no flag at all** - a Helm
nobody has configured launches exactly what `claude` would have launched, and the
disclosure sentence names a flag only when there is one to name. From the
moment it starts it is a session tab like any other, and **Helm never reads the
review's output back**: 6 still applies, and a feature that needed to parse a
session is a feature that belongs somewhere else.

> [!note] Built 2026-08-11 - pull requests
> Four v1 limits, flagged rather than discovered later.
>
> **~~Inline diff-thread comments are invisible to `gh --json`.~~** *Superseded
> 2026-08-13 - see "The conversation carries the diff-line threads" below.* The
> JSON surface exposes issue-level comments and each review's summary body; the
> notes people leave on individual lines live on a review thread and are not in
> it at all. A `gh api` GraphQL query would reach them. The conversation said so
> at the bottom, because a conversation missing half its replies with no
> explanation reads as a bug.
>
> **`origin` only.** `upstream` and renamed remotes are unmapped - a cheap later
> extension, and one nobody has asked for yet.
>
> **~~No diff viewer.~~** *Superseded 2026-08-11 - see "The Files view shows the
> patch" below.* The Files view listed paths and line counts and handed the patch
> to the browser, on the grounds that a diff needs syntax, wrapping, whitespace
> modes and review threads, and half of one is worse than a link.
>
> **`{branch}` names `headRefName`**, which on a pull request opened from a fork
> does not exist in the local checkout unless checkout mode is on. The default
> template uses `{number}` alone for exactly that reason, and the setting's help
> text says so.
>
> `statusCheckRollup` is a GraphQL union whose members agree on nothing - a
> `CheckRun` has `status`/`conclusion`, a legacy `StatusContext` has `state`
> spelled differently, and GitHub adds members - so it is reduced defensively to
> `{total, failing, pending}` and paints **nothing at all** when it cannot be
> read. Null and `{total: 0}` are different facts and only one of them is safe
> to show as a green tick.
>
> `pnpm pr-check` is the regression test: five phases, four of them against a
> `gh` the repository wrote and one against the real one. The driver's own list
> of ids is the count.

> [!note] The Files view shows the patch (2026-08-11)
> Supersedes "No diff viewer" above, which was right about the reason and wrong
> about the size of what was missing.
>
> The four things that made a diff viewer hard are still not being done. There is
> **no syntax highlighting** - a diff row is plain mono text with a tint, which
> also keeps the tint the loudest thing in the row; **no whitespace modes**; **no
> side-by-side**; and **no review threads**, which is the `gh --json` limit above
> and is why the Files view still ends in a link to GitHub. (The threads half of
> that was lifted on 2026-08-13 - they are fetched and they are in Conversation.
> What the *Files* view still does not do is anchor a thread marker into the diff
> row it belongs to.) What is left after those is a patch, which is text: `gh pr
> diff` prints the whole of one, and turning it into rows is a parser with a test
> suite rather than a subsystem.
>
> Three decisions the shape rests on:
>
> - **The file list is the spine, the patch hangs off it.** `pr view --json
>   files` is the same fetch the header's counts come from, so the Files view is
>   built from that list and each file is *matched* to a patch by path. A view
>   built from the patch instead would disagree with its own header on exactly
>   the pull requests whose patch was capped.
> - **The cache holds the text, not the parse.** `pull_requests.diff` is what git
>   printed. A column of parsed hunks would be one version of `PullDiffLine`
>   frozen into a database that outlives it - the same call the rendered markdown
>   makes, and for the same reason.
> - **Every limit is counted and said.** A patch over `MAX_DIFF_BYTES` (2MB) is
>   cut at a line boundary and the view carries a sentence about it; a file past
>   `MAX_FILE_LINES` (1200) rows says how many it is not showing; a file the
>   patch does not describe keeps its row, its counts and its badge and says it
>   has no patch. A diff that quietly stopped halfway would read as complete.
>
> `statusCheckRollup` moved onto the **list** fetch in the same change, so a row
> can say which branch is green without being opened. It costs payload rather
> than requests - the rollups come back inside the query the poll already makes.

> [!note] The conversation carries the diff-line threads (2026-08-13)
> Supersedes "Inline diff-thread comments are invisible to `gh --json`" above.
> The limit was real and the follow-up it named is this one.
>
> Most of a review's substance is left on lines of the diff, and a `claude`
> review's output lands there almost entirely - so a Conversation without them
> painted a review as a bare verdict and a pull request as one nobody had said
> anything on. They are now a **third fetch**, beside `pr view` and `pr diff`
> and running with them: `gh api graphql` over `pullRequest.reviewThreads`.
> Still `gh`, still the user's own token, still no credential anywhere near Helm.
>
> **GraphQL and not the REST `pulls/{n}/comments` endpoint**, which `gh api`
> could equally have called. REST gives `in_reply_to_id` - enough to rebuild the
> threading - and carries neither `isResolved` nor `isOutdated`. A resolved
> thread painted identically to a live one reads as an objection nobody ever
> answered, which is a worse answer than no threads at all.
>
> **Both connections page and both are walked.** `reviewThreads` pages, and so do
> the comments inside each thread; the inner one is per thread and by node id, so
> reaching reply 51 of one thread does not re-fetch the fifty beside it. A pull
> request with a long review is exactly the case that breaks a fetch which takes
> the first page and stops.
>
> **The query is one line, and that is load-bearing.** On Windows a `gh`
> installed by scoop or npm is a batch file, so it is run through `cmd.exe /c` -
> and cmd ends its command line at the first newline whatever the quoting.
> Measured on 2.86 against a `.cmd` shim: a pretty-printed query arrived
> truncated at `query($owner: String!,` with every `-f` after it gone, the
> request was still made, and it exited 0.
>
> **`undefined` and `[]` are different facts and may never collapse.** The
> threads ride inside `PullDetail`, so every row cached before this shipped has
> no key for them - and `[]` on such a row would be Helm stating, about a pull
> request it has never asked the question of, that nobody annotated the diff.
> Absent is "not fetched" and paints a sentence naming the remedy; `[]` is
> "asked, and there are none" and paints nothing. `JSON.stringify` drops an
> undefined value, so the distinction survives the cache by construction, and
> `heldReviewThreads` is the one place it is read - anything that is not an array
> collapses to *not fetched*, which is the safe direction.
>
> **It degrades the PR way.** A thread query that fails keeps the threads it had
> with their age painted beside the reason, and leaves the body, the comments and
> the reviews alone. This is the opposite call to the one the patch makes, and
> the difference is what each is anchored to: a patch describes a file list that
> has just been replaced, while a thread is anchored to a path and a line and
> carries the hunk it was written against. Only a missing `gh` binary stops a
> pass (`PR-20`).
>
> A thread is **one entity** on screen - `path:line` in mono, its hunk as
> collapsed context and painted as text like every other diff on this surface,
> and the replies visibly subordinate to the note that started them. Threads
> merge into the conversation's chronology at their **first** comment, because a
> thread opened on Monday and replied to on Friday is a Monday remark. Resolved
> threads start collapsed; outdated ones do not, since outdated only means the
> diff moved.
>
> Still not done, and its own piece of work: **anchoring a thread marker into the
> Files view's diff rows**. It needs a thread's line matched onto a hunk whose
> numbering came from a different fetch, and the Files footer points at
> Conversation meanwhile.
>
> `pnpm pr-check` grew five checks for it (`PR-25` to `PR-29`), including a
> fixture of 120 threads one of which has 130 replies - past both page sizes,
> and asserted to be past them before the probe's pass is believed.

---

### 4.7 Browser

A dev-server viewport in a workspace tab (M16), and since M17 something a Claude
session can drive. The pane itself is described in the network posture above and
its rules live in CLAUDE.md; what follows is the agent half, because it is the
part with a security surface.

**What a session gets.** Ten tools, served by `main/browser-mcp.ts`:
`browser_open`, `browser_tabs`, `browser_snapshot`, `browser_screenshot`,
`browser_console`, `browser_click`, `browser_type`, `browser_press`,
`browser_evaluate` and `browser_close`. `browser_snapshot` is the one that makes
the rest work - a trimmed structural view of the page, each interesting node
carrying a `[ref=...]` that `browser_click` and `browser_type` take - because
finding an element by reading structure is cheaper in tokens and far more
reliable than squinting at a PNG. Click, type and press exist alongside
`browser_evaluate`, which makes them technically redundant, because an explicit
click is more reliable than generated JavaScript and enormously more legible in
a transcript.

**This is not Helm hosting a client.** Nothing here reads a session's output,
renders a message or answers a prompt. A session calls a tool the way it calls
any other MCP tool, and Helm's whole part is to be at the other end of it - the
same boundary the transcript archive was admitted under, from the other
direction. See 4.4 and CLAUDE.md's Scope.

**How a session reaches it.** An MCP endpoint over HTTP on `127.0.0.1`, on a
port the kernel picks per run, with a bearer token minted per *session*.
Registration is a per-session `--mcp-config` file written under Helm's data
directory and appended to the argv by `prepareLaunch`, so the composition stays
in the one place every other launch flag comes from. `claude mcp add-json -s
local` was rejected: it writes into the user's `~/.claude.json` on every launch
and leaves the entry behind. A Windows named pipe was rejected too - its default
ACL admits every process running as the same user, which is exactly the reach a
loopback port plus a token file already has, and it would cost a shim process
per session.

**The token is the identity.** Tabs a session opens carry its name in the tab
subtitle, and a tool drives only the tabs its own session opened - a tab the
user opened is a page they chose to be on, in a partition holding their cookies,
so it is not screenshot, scripted or closed by any tool. A session ending leaves
its tabs standing: the page is the user's then.

**Two reach controls that intersect.** `browserReach` (`web` | `local`,
default `web`) is where the pane may go at all. `browserMcpLocalOnly` (default
off) is where Claude's tools may go. An agent navigation is allowed only where
both allow it - the narrower wins, with no special cases, because both are
handed to the one `browserReachAllows` rather than written twice.
`browserMcp` (default on) is the whole endpoint's off switch, and off means no
bind, no token and no flag.

**What it cost to make a tab nobody is looking at driveable.** M16 measured that
`setVisible(false)` leaves a view capturable, scriptable and clickable. That
turned out to have an unstated precondition: the *document* has to have painted
once while the view was shown. A tab an agent opens is never mounted by the
window, so without something it has a zero viewport, an empty `capturePage` and
clicks that land on nothing - while `executeJavaScript` answers perfectly, so
nothing looks broken. Parking the view outside the window does not help
(occluded), and `enableDeviceEmulation` crashes the process. The answer is
`AGENT_PEEK`: the page loads into a full-size view positioned so that all but a
two-pixel corner falls outside the window and is clipped, and the view is hidden
- and only ever *moved*, never resized - once it has painted.

`pnpm browser-check` covers all of it: the endpoint and its 401s, the ten tools
driven over the wire independently of `claude`, every tool against a tab that is
never on screen, the four-cell reach matrix, the lifetime rules, argv hygiene,
and one real `claude` session asked to open the fixture and click a planted
element.

---

### 4.8 WSL targets

A profile chooses **where its sessions run**: this machine, or inside a WSL
distribution. A WSL target hosts the distro's own `claude` against the distro's
own `~/.claude`, and Helm stays a Windows process throughout - `wsl.exe` is the
program the pty opens and the CLI sits behind `--`.

The motivating machine is the ordinary one for this: the toolchain lives inside
Ubuntu, and a Windows-only Helm can only ever launch the Windows CLI.

> [!note] Measured 2026-09-02, before any of it was written
> Four questions decided the shape, and each answer removed work rather than
> adding it.
>
> - **A Windows directory junction resolves inside the distro.** It surfaces as
>   a symlink whose target is *already* translated - `skills ->
>   /mnt/c/.../.claude/skills` - and reads through it work. So the overlay shim
>   of section 2 crosses the boundary unchanged for a project on a Windows
>   drive, and `launch/overlay.ts` needed no WSL branch for that direction.
>
>   **The other direction does not, and it fails silently** - measured later the
>   same day, after the first sentence had been read as "overlays just work". A
>   junction whose *target* is a UNC path, which is what every project inside a
>   distribution has, is **created successfully** and then resolves to nothing:
>   `existsSync`, `lstat`, `realpath` and `readdir` all answer ENOENT.
>   `symlinkSync` does not throw, so the copy fallback that existed for
>   filesystems without reparse points never fired, and an overlay from a
>   distro-resident repo produced a `--plugin-dir` pointing at a dead link. A
>   session composed nothing and said nothing - the exact outcome section 2's
>   sweep rules exist to prevent, arriving through the one door nobody was
>   watching. `link` now **verifies** the junction resolves and falls back to a
>   copy, and the check is on the result rather than on the shape of the target,
>   so it also covers whatever else turns out to behave this way.
> - **Killing the Windows-side `wsl.exe` reaps the Linux process.** So "the main
>   process owns process lifetime" holds through the relay and `treeKill` needed
>   no second path.
> - **`wsl.exe --cd` accepts a Windows path** and translates it itself. That is
>   why a plan's `cwd` stays Windows-spelled - it is what the pty is opened with
>   - while its **argv** is translated, since those are the paths the CLI inside
>   the distro opens.
> - **The loopback endpoint is not reachable from a distro.** Measured on
>   default NAT networking with no `.wslconfig`: `127.0.0.1:<port>` fails,
>   because loopback only mirrors under `networkingMode=mirrored`, and the
>   gateway address fails too, because the server binds `127.0.0.1` and that
>   rule is not being loosened.
>
> The fourth is the only one with a user-visible consequence, and the response
> is **detect and name the fix** rather than an amendment. A WSL session is
> probed - `/dev/tcp` from inside the distro, which needs no `curl` a minimal
> image might not have - and where it cannot reach the endpoint it launches
> with **no `--mcp-config` at all** and a sentence naming
> `networkingMode=mirrored`. Nothing is minted for a session that could not use
> it: a token without a reachable listener is a live credential nothing can
> spend.
>
> The fix is now **offered as well as named**, in the settings pane's WSL group:
> Helm sets `networkingMode` under `[wsl2]` in `%USERPROFILE%\.wslconfig`,
> preserving every other key, section and comment in it, and copying the file to
> a timestamped `.helm.bak` beside itself before it writes - the config
> console's snapshot rule (section 7) applied to the one file Helm touches
> outside a `.claude` tree. Three things it deliberately is not. It is not a
> profile field, because `networkingMode` is machine-wide and a per-profile
> control would claim a scope it does not have. It is not an install step, for
> the reason section 7 gives about every other file Helm does not own. And it
> **never runs `wsl --shutdown`** as part of the write: that ends every WSL
> process on the machine, so it is a separate action behind a confirmation that
> says so. A file it cannot parse with confidence - a line it cannot read, two
> `[wsl2]` sections, two `networkingMode` keys - is reported and left alone.
> What the file says and whether a distro can reach the endpoint stay two
> facts on the pane, because `mirrored` written and WSL not yet restarted is
> the state a user is most often in.
>
> **The network posture in section 5 is unchanged.** The listener is still one
> socket on `127.0.0.1`, still two named servers, and nothing new is contacted.
> What a distro can or cannot reach is a fact about the machine's networking
> mode, not a change to what Helm binds.

Three things follow, and they are the whole of the mechanism:

- **`target` is on the profile**, as `windows` or `wsl:<distro>`, in one column
  and one YAML key through one codec. Null means Windows, which is what every
  profile written before targets existed means - so nothing migrated and nothing
  had to.
- **A resident path decides the target, and it is not a preference.** A project
  under `\\wsl$\<distro>\...` cannot run on Windows at all: `CreateProcess`
  refuses a UNC working directory (ENOENT, measured), so the launcher derives
  the target from the path and overrides whatever the profile said. The editor
  asks the same function and shows the answer with the control disabled, rather
  than offering a choice the launch would discard - and the chosen value is kept
  underneath, so editing the root back to a Windows path restores it. A root on
  a Windows drive stays a free choice, because running a `C:\` project inside a
  distro genuinely works.
- **Translation happens once, in `prepareLaunch`, after the disk work.** The
  shims, the composed memory file and the `--mcp-config` document are written by
  a Windows process in Windows spelling; only the argv naming them is
  translated. A path with no spelling inside the distro - a UNC path into a
  *different* distro, say - is **dropped with a warning** rather than passed
  through, because `--add-dir` naming a directory that is not there is a session
  silently granted nothing.
- **A distro's CLI is discovered inside it**, at its own `$HOME/.local/bin` or
  on a login shell's PATH, with the same warn-do-not-block posture section 7
  pins for the Windows one. A WSL target with no `claude` in the distro is the
  one place this is stricter: it names the distro and refuses, rather than
  opening a pty that closes.

#### The second `~/.claude`

The paragraph that used to sit here said this was not done, and it now is. A
distribution keeps a `.claude` of its own - its own `settings.json`, skills,
agents and commands, its own `history.jsonl`, its own `projects/` transcripts,
its own `sessions/` registry - and a session hosted there uses that one and
never this machine's. Until Helm read it, a WSL session launched and hosted
correctly and then vanished: absent from history, absent from the spend
estimate, a tab whose state dot never lit.

> [!note] Measured 2026-09-02, against a live distribution
> - **`\\wsl$\<distro>\home\me\.claude` is an ordinary directory.** `readdir`,
>   `stat`, read and write all work, and writes land with the right ownership.
>   So every reader in `discovery/`, `usage/`, `config/` and `registry/` works
>   over one **unchanged** - what they needed was a second path, not a WSL
>   implementation, and `wslClaudeHome` is the whole of the new mechanism. The
>   config console reads 94 files, 8 skills, 21 commands and 16 agents out of
>   one in 368ms.
> - **The effective view was simply wrong for a distro project before this.**
>   Same working directory, this machine's user layer: 0 skills, 0 commands, 0
>   agents. The distro's: 8, 21, 16.
> - **The history is where the work actually is.** 24 prompts in this machine's
>   `history.jsonl`, 3,539 in the distro's. Indexing both: 550 sessions, 3,563
>   prompts, 55 projects, 90ms.
> - **A distro records Linux-spelled working directories**, because that is what
>   its CLI saw. `statSync` on Windows resolves a leading `/` against the
>   current drive root, so `/home/me/harness` reads as absent - and
>   `projectExists` is what decides whether a conversation can be resumed at
>   all. Before translating: **7** resumable of 550. After: **190**.

Four rules follow.

- **The homes are found once and handed to every reader together.** The history
  index, the usage index and the session-registry join widen in one call, off
  the startup path - a `wsl.exe` per distribution is ~200ms cold and the window
  must not wait on it. They widen *together* because a session in the history
  whose tokens are missing from the spend is worse than either omission alone.
- **One index over many files, not one index per file.** `indexHistory` takes
  every source in a single pass, because two of its steps are whole-table
  operations and running them per file would have each pass undo the last. Rows
  carry no source column, so a file that shrank rebuilds everything - the rare
  case paying for the common one, rather than a column that would have to be
  right about rows written before it existed.
- **Resume reads the target off the transcript's path**, which is the evidence
  the project path is not: a session run *inside* a distro against `/mnt/c/work`
  records a `C:\work`-shaped directory and belongs to the distro all the same.
  The recorded directory is then translated once, at that same point, so a
  resumed distro session is indistinguishable from a launched one everywhere
  below.
- **A foreign registry is joined, never listed.** The `pid` in a distro's
  session record belongs to that distro's kernel; probing it against this
  machine's process table either misses a running session or matches an
  unrelated Windows process and calls a finished conversation live. So liveness
  comes from Helm instead - only records that join to a session Helm is hosting
  are used, and a hosted session is live because Helm holds the relay's pty.
  Asking the distro on the registry's 750ms timer would be a `wsl.exe` per pass,
  which is the budget rule of section 8 inverted.

#### The rest of the surface

Six things were asymmetric for the same underlying reason - a Windows process
assuming its own machine is the only one - and none of them was a missing
feature so much as a wrong answer.

- **A repository-local tool is reached one way, decided in one place.** The
  launcher's git state routed into a distribution; the pull-request sweep did
  not, and the result was a distro-resident repository whose branch and dirty
  count the sidebar showed while the PR pane reported it as having nothing.
  Measured 2026-09-03: from Windows with a `\\wsl$\...` working directory,
  `git remote get-url origin` exits 128 with `safe.directory 'undefined' not
  absolute`, and `gh repo view` fails the same way one level up. `readOrigin`
  returned null - which is also its answer for a folder that is not a
  repository, so the surface could not even say what was wrong. `repoCommand`
  in `discovery/git.ts` is now that single decision, and after it 11 of 16
  remotes read on the machine this was written against where 0 had before. Only
  `gh pr checkout` needs the routing beyond that; everything else names its
  repository with `--repo` and is cwd-independent, so it stays on this
  machine's gh and this machine's authentication. A checkout inside a
  distribution needs that distribution's own gh, signed in, and says so when it
  has neither.

- **A subprocess must be the distro's CLI.** Reading and editing a `.claude`
  tree over `\\wsl$\...` is `readFileSync` and `writeFileSync` and always
  worked; the four `claude mcp` calls in the config console did not, and all
  four **write**. Run from Windows against a distro project they registered the
  server in this machine's `~/.claude.json`, for a session that would never read
  it, and the console then re-read the wrong file and showed no change. The
  command is now chosen from the directory, and the snapshot follows it.
  `ClaudeCommand.hostCwd` exists because `CreateProcess` cannot be given the
  UNC path the command is *about*.
- **A sign-in inside WSL is a sign-in.** The setup pane asked only this
  machine's `~/.claude`, so somebody whose entire install lives in Ubuntu - the
  ordinary shape once the toolchain does - was told they were not signed in,
  beside a launcher that would have run their sessions. The distros are asked
  second, so a Windows answer never changes, and only ever turn a "no" into a
  "yes" that names the distribution. Still three existence questions and no
  credential opened.
- **A distro's home is offered as a scan root.** `~/harness` inside a
  distribution had to be pasted in by hand. `suggestRoots` now takes the homes
  from the host - core still neither spawns nor knows about WSL - and offers
  their `harness` and `.harness` directories on the same footing as this
  machine's. Never the home itself: that is the existing "never fall back to the
  home directory" rule, and it is worse over a UNC share.
- **"Holding nothing" is not an answer this pass may give about a WSL session.**
  The process walk enumerates Windows processes, and a distro-hosted session's
  pty is `wsl.exe` - so the walk does not fail, it succeeds and finds no
  children, which is the reassuring wrong answer section 8's rule forbids. Such
  a session now reads as *could not look*. Asking the distro instead would be a
  `wsl.exe` per pass on a timer, which inverts the budget that rule sits on.

- **The usage limits are ranked, not reconciled.** Every install caches the
  *same* account's `cachedUsageUtilization` in its own `~/.claude.json`, so the
  copies differ only in how recently that install made a request. This section
  previously said the limits came from this machine's file alone "because
  choosing between two would be a rule with nothing behind it" - which was
  wrong, and `fetchedAtMs` is the rule that was behind it. **The freshest fetch
  wins**, and the reading can name the install it came from.

  Ranked by fetch time only, never by which copy would paint a number: a stale
  or rolled-over freshest reading is the honest state of the account, and
  `usageView` remains the sole judge of what may be shown. A tie keeps this
  machine, which is passed first, so it resolves to the reading that needs no
  explanatory sentence. Nothing is ever blended or averaged - that would be a
  reading nobody took - and all-absent degrades to the first candidate's own
  reason. Consolidating the files was rejected outright: `~/.claude.json` holds
  onboarding state, a user id, per-project entries and MCP servers, so linking
  two installs' copies would make every unrelated key shared, and it would mean
  Helm writing into a tree it only reads.

  This is also what makes the percentage and the dollar figure describe the same
  thing, since the spend index already merges transcripts across homes.

**What this still does not do.** A `claude` somebody starts in a distro's own
terminal is not in the machine-wide sessions listing, for the liveness reason
above - the listing is about processes this machine can be asked about. Fixing
it means a batched liveness probe, one `wsl.exe` per distribution per pass on
the 4s watch-gated timer rather than the registry's 750ms one, and that is a
design rather than a patch. `runDoctor` still runs the Windows CLI, and is the
one thing here with no path to derive an answer from: `claude doctor` is about
an *installation*, so making it right means the health panel gaining an explicit
selector rather than a main-process change. There is **no `wsl-check`**: no
single real-window driver re-runs the measurements in this section. What does
cover parts of it, since 2026-09-03, is `settings-check --only=wsl` (the
`.wslconfig` control end to end, against a fixture profile) and
`usage-check --only=homes` (the freshest-reading rule across two homes); the
rest of the section is still held up by unit tests and by measurements taken by
hand.

**Two bugs the first run of those found**, both of the shape that only a
real-window driver finds:

- **`CLAUDE_CONFIG_DIR` did not stop the fan-out to distro homes.** The gate in
  `index.ts` was on `--claude-home` only, and `transcript-check` points itself
  with the variable - so a driver isolated from everything else pulled 123 real
  conversations out of the developer's Ubuntu into a bounded-storage probe, and
  T-4 failed for a reason unrelated to eviction. The rule now lives inside
  `wslHomes()`, so all four callers obey it: a process told which tree to read
  does not also read the ones inside every distribution.
- **The WSL group's state was mounted at app start, not with the pane.** Two
  comments in the tree disagreed about this and the code implemented the wrong
  one, which cost a `wsl.exe --list` on every launch for every user - and, worse
  for anyone using the control, meant `.wslconfig` was read **once per window**:
  nothing watches that file, so a file edited by hand went on being misreported
  until Helm restarted. `SettingsWithWsl` mounts the hook with the pane, so the
  read happens on every open. S-23 caught it by planting a fixture and asking
  what path was on screen.

---

## 5. Architecture

```
helm/
├── packages/
│   ├── core/        # headless. ZERO electron imports.
│   │   ├── launch/    profile → argv, overlay shim generation
│   │   ├── discovery/ harnesses, projects, skills, agents, sessions
│   │   ├── config/    read/write/snapshot .claude trees
│   │   └── store/     SQLite: profiles, snapshots, session index
│   ├── ui/          # React components
│   └── desktop/     # Electron: main + preload + renderer + pty host
```

| Layer | Choice |
|---|---|
| Shell | Electron |
| Language | TypeScript strict |
| UI | React + Vite + shadcn/ui + Tailwind |
| Terminal | `xterm.js` + `node-pty` |
| DB | `better-sqlite3` + Drizzle |
| Markdown | `remark`/`rehype` + `shiki` |
| Packaging | `electron-builder`, portable + NSIS |

**The one discipline:** `core/` never imports Electron. That keeps the mobile
option open and is what makes the app genuinely portable.

### Network posture

**Helm contacts nothing on its own initiative except the update check.
Everything else on the network happens because you asked for it: the
pull-request surface goes through your own `gh`, and the browser pane fetches
the page you navigate to.**

That replaced "Helm's own process opens exactly one outbound connection"
(decided 2026-08-15). The browser pane made the old claim false, and the answer
is an honest replacement rather than a carve-out: what people care about -
Helm does not phone home, there is no telemetry - is unchanged, and the app has
stopped claiming something it no longer does. The same wording appears in the
README, [PACKAGING.md](PACKAGING.md) and the `update:check` comment in
`shared/ipc.ts`, and CLAUDE.md's rule that all four move together stays.

- **The update check** reaches the GitHub releases API for a version number and
  a URL. It happens two ways and no
  others, and never on a timer - at launch, at most once a day
  (`UPDATE_CHECK_EVERY_MS`), when `updateCheck` is ticked; and when a person
  presses Check now in Settings → Updates, which is deliberately unthrottled and
  works with the tick off. `updateCheck` governs whether Helm asks by itself,
  not whether the user may, so with it off nothing leaves the machine unasked
  for. It fetches no artefact, replaces nothing and restarts nothing - the
  whole outcome is a version number and a line in the status bar. See
  [PACKAGING.md](PACKAGING.md) for why there is no auto-updater; every reason is
  about replacing the installed app, which this does not do.
- **The pull-request surface reaches GitHub through the user's own `gh` CLI**,
  on a schedule the user sets - `prPollMinutes`, five minutes by default, `0` to
  turn it off - plus a fetch when a pull request is opened and one when a review
  checks a branch out. Bytes therefore leave the machine without `update:check`
  being invoked, and Helm opens no socket of its own for any of it.
- **No credential of any kind is stored, read or handled.** Claude's sign-in is
  detected from the *existence* of an artefact, and GitHub's from what `gh`
  prints when it is asked to do something - its `auth status` exit code as an
  opinion, and its fetch failures as the verdict that overrules it. Nothing
  opens either. A remote URL carrying an embedded token is a credential too, and
  it is stripped before anything is written to the database.
- **The browser pane fetches the page you navigate to**, and nothing else. It
  is a dev-server viewport rather than a browser (M16): a `WebContentsView` in
  a partition of its own, `persist:helm-browser`, whose cookies and storage live
  under the app's data directory and which the renderer's session never shares.
  Every request behind it is a page somebody typed the address of or clicked a
  link to - Helm opens nothing there on its own initiative, the address bar
  never hands anything to a search engine, downloads are refused and handed to
  the system browser, and every permission the partition is asked for is denied.
  `browserReach` can confine the whole pane to `localhost`.
- **Helm listens on loopback, for the sessions it hosts, and nowhere else.**
  A Claude session Helm starts can drive that pane - open a page, read it,
  screenshot it, click, type and evaluate - and can ask what the other Claude
  Code sessions on this machine are doing. Both reach it through **one** MCP
  endpoint bound to `127.0.0.1` on a port the kernel picks for the run, serving
  two named servers (`helm-browser`, `helm-sessions`) on two routes. It is the
  app's **only inbound listener**. Every request needs a bearer token minted for
  one session and revoked when that session ends; there is no unauthenticated
  route; and each family has its own tick - `browserMcp` and `sessionMcp` - each
  of which means no route, no name in the launch's `--mcp-config` document and
  no tool in any list, with no bind and no token at all when both are off. An
  agent navigation is allowed only where `browserReach` **and**
  `browserMcpLocalOnly` both allow it - the narrower wins, so an agent can never
  reach further than the pane it is driving. The session tools are read-only and
  return **no part of any session's conversation**: no transcript, no prompt, no
  output, and not the argv a session was launched with, which carries both a
  review session's opening prompt and the path to that session's own bearer
  token. See 4.7 and CLAUDE.md's rules.
- **No credential of any kind is stored, read or handled**, and the browser
  partition is not an exception. It holds whatever cookies the sites you visit
  set, exactly as a browser profile does, and **Helm reads none of it**: nothing
  in the app opens that cookie jar, and the only thing it ever does to the
  partition is `clearStorageData` from the button in the pane.
- **Nothing else talks to anything.** No telemetry, no crash reporting, no
  fonts, no CDN. The renderer's `will-navigate` is prevented and its window-open
  handler denies, so a link in rendered content is inert without
  `shell:openExternal`, which is restricted to http, https and mailto. The
  browser views are the one exemption from that lock and they are exempted **by
  `webContents.id`**, in the guard itself, so the app's own renderers keep it.

  > [!note] Amended 2026-08-17 - a browser view may open a real window
  > "The window-open handler denies" stayed true of every web-contents in Helm
  > except a browser view, and stopped being true of those. It was measured
  > into changing by a bug report: a Google sign-in in the pane threw, and it
  > threw because a popup sign-in cannot work through a tab. Denied,
  > `window.open` returns `null` and every OAuth library reports a blocked
  > popup; the tab Helm opened in its place has no `window.opener`, so the
  > authorisation code has nothing to come back through. Both halves measured
  > on the fixture, both now asserted by `BR-39`.
  >
  > Only `window.open` **with features** - Chromium's `new-window` disposition -
  > makes a window. `target="_blank"` and a middle click are still Helm tabs,
  > which is what they mean everywhere else. The popup is on the same partition
  > under the same denied permissions and refused downloads, is in the same
  > `webContents.id` registry, and every navigation it makes goes through
  > `browserReachAllows` with the reach of the tab that opened it. It is never
  > an agent's: an agent tab's `window.open` still becomes another agent tab,
  > because an agent putting a window in front of somebody is a different thing
  > from an agent reaching an address. `BR-40` measures all three by counting
  > windows rather than by reading a policy.
  >
  > What did not change: the app's own renderers still get `null`, and nothing
  > here alters what Helm contacts on its own initiative, which is still only
  > the update check.

### Portability

- **Harness-agnostic** - detects `harness.yaml`, falls back to plain folders. No
  hardcoded paths, no `dev/` assumptions. A harness is *any* folder with a
  manifest; its optional `repos:` key names where the repositories are, so a
  folder that already holds repos at its top level can become one without
  hiding them.

  > [!note] Amended 2026-08-14 - what "falls back to plain folders" means
  > A root with no harness under it used to list its immediate children,
  > always. That is right for a directory of repositories and wrong for a
  > directory somebody picked meaning *this one*: adding a single tool
  > directory put its `data`, `scripts`, `src` and `tests` in the launcher and
  > nothing named after the folder that was picked.
  >
  > The container reading now needs evidence, and it comes off the children: a
  > child carrying `.git`, `.claude` or `CLAUDE.md` says the root is a
  > container and its siblings come with it. With none, the root is the
  > project - **the folder you picked is the thing that appears**. Those three
  > markers and no more; a list that grew to `package.json`, `pyproject.toml`
  > and whatever is next would be wrong for every ecosystem not yet in it, and
  > wrong silently. Every scan test from before the change passes unchanged,
  > which is what says this only ever narrows the old rule.
  >
  > A folder can also be taken back out, from a **Scanned folder** panel on its
  > own project pane - the Settings list of roots (4.5) was the only way, and
  > it is not where somebody looking at a folder they want gone goes looking.
  > Removal is a change to a setting: the rows go from the tree and from the
  > discovery cache, and nothing on disk is touched, which the panel says in
  > those words. `pnpm settings-check`'s S-22 is both halves.
- **Portable install** - single `.exe`, app data beside it when portable,
  `%APPDATA%` when installed. Both install-tested by `pnpm packaging-check --only=package`;
  the NSIS build is per-user and needs no elevation. See [PACKAGING.md](PACKAGING.md).
- **Shareable** - real first-run setup, nothing specific to the machine it was
  written on, README. Enforced rather than asserted: `pnpm packaging-check --only=audit`
  greps the checkout for personal paths and names, and proves it can catch one
  before believing that it found none.

### What 1.0 promises

Added for the 1.0.0 release, because a version number that stops disclaiming
invites the question and answering it by implication is how a promise gets made
by accident.

**1.0 promises one thing: an existing `helm.db` keeps working.** A newer Helm
opens a database an older one wrote, and it does that by construction rather
than by intention:

- Migrations only ever roll forward, are journalled by tag in
  `__helm_migrations`, and each runs in its own transaction, so a failure leaves
  the file on the last complete one rather than half-way through
  (`core/store/migrate.ts`). They are embedded in the bundle, so the exe carries
  its own and needs nothing shipped beside it.
- Settings reads are tolerant in both directions - an unknown key is ignored and
  a missing one falls back to its default - so a database written by an older
  *or a newer* build loads (`core/store/settings.ts`). Writes stay strict; the
  asymmetry is argued at that code site.

**Everything else is internal and may change in a patch release.** The overlay
shim layout, the `--mcp-config` document, the IPC channel contract, the
`app_settings` key set, the shape of an exported profile and the layout of the
templates directory are all Helm's own, and none of them is a format anything
outside Helm is asked to write.

Two of those are files a person edits by hand, so the distinction is worth
stating rather than leaving to be discovered - and in both cases what protects
the user is the same rule the settings table follows, not a version number.

**A template is a folder of ordinary files.** Helm's interest in it is `.tpl`
substitution and nothing else, and a directory that is only ever *read* cannot
be broken by a change to what Helm does with it. Nothing there is overwritten
either, because Helm keeps no hashes and so cannot tell an edited file from an
untouched one.

**An exported profile is read tolerantly.** `profileFromYaml` throws only for a
document that is not a profile at all - not a mapping, or missing `name` or
`root`. A field whose value this build does not recognise is *dropped*, not
fatal, because the alternative is refusing a whole file over one setting the
user can see and fix in the editor afterwards. So a profile written by another
version imports, minus anything this one cannot honour.

What none of this promises is the Claude Code CLI, which is a separate product
on its own release schedule. `CLAUDE_TESTED_RANGE` is a measurement, not a
dependency bound - outside it Helm warns and starts anyway (7).

---

## 6. Out of Scope for v1

- The Agent SDK, in any form
- Rendering messages, diffs, or permission dialogs
- Mobile, cloud sync, teams
- Transcript archival - **worth noting anyway: 106 transcripts survive for 799
  sessions, a 13% retention rate** (re-measured against the session index; the
  first count of 9% was taken by deriving transcript paths from the recorded
  project, which misses the ones whose directory was created under a different
  casing). Prompts persist in `history.jsonl`; the conversations are reaped.
  Strong v1.1 candidate, and a pure-win feature since an external process
  copying files cannot break anything. The launcher makes the case for it
  visible: 694 of its rows are history-only, and every one of them is a
  conversation that could have been kept.
- WIP dashboard (dirty repos, stale branches) beyond the git chips in the launcher

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| ~~**`--plugin-dir` may not accept a synthesised dir**~~ | **Closed by the composition spike.** Junction-based shims work; two overlays composed in one session. Copy fallback exists but was not needed. |
| ~~**Skill name collisions** across composed overlays~~ | **Closed by the composition spike.** The platform namespaces every overlay automatically (`<plugin-name>:<skill>`); same-named skills in two overlays coexist. Helm only sanitizes plugin manifest names. |
| ~~**Project CLAUDE.md not carried by `--plugin-dir`**~~ (a composition-spike finding) | **Closed when profiles were built, but not the way the mitigation guessed.** `--add-dir` does *not* pull in an overlaid repo's CLAUDE.md - measured on 2.1.225, a session launched from the harness root with both flags reported only the user and cwd instruction files. Helm composes the overlays' CLAUDE.md into one document and passes it to **`--append-system-prompt-file`**. A file, not `--append-system-prompt` inline: two repos here total 34 KB against a 32,767-character Windows command line. |
| **Junctions on Windows** | `mklink /J` needs no elevation. Fall back to copy + watch. |
| ~~**Native modules** (`node-pty`, `better-sqlite3`) vs portable exe~~ | **Closed by the packaging spike** (8.2). Both ship N-API prebuilds, so nothing is rebuilt against Electron's ABI and nothing compiles; the config that spike produced is what `electron-builder.yml` still holds. |
| **CLI flag drift** across Claude Code releases | Flags are a stable public surface, far safer than the 0.3.x SDK. Pin a tested version, assert on `claude --version` at startup. |
| ~~**TUI inside xterm.js** feels wrong (resize, mouse, colour)~~ | **Closed by the terminal-fidelity spike** (8.3). Fidelity holds; latency is within noise of no terminal at all. The residual risk moved: an *unconfigured* pane degrades the TUI five ways at once, so the configuration in `terminal.ts` and `ptyEnv` is load-bearing and each fix has a regression check. |

---

## 8. Spikes

Three timeboxed investigations, run before the app was built, against the three
assumptions that could each have killed it. All three came back GO. Their
findings are recorded here in full rather than as verdicts, because most of them
are the reason some piece of configuration in this repo looks the way it does -
and a line of configuration with no evidence behind it is a line somebody
deletes. The code refers to them by letter, which is what these three headings
are for.

### 8.1 Spike A - Composition. GO

Ran 2026-08-08. Synthesise an overlay plugin for a project's `.claude`
directory, launch `claude` from the harness root with `--plugin-dir`, confirm a
project skill resolves. *Everything depended on this.*

`--plugin-dir` accepts a synthesised junction-based shim: skills, agents and
commands from two composed overlays all resolved and were invoked from the
harness root. The platform namespaces everything automatically
(`<plugin-name>:<skill>`), which makes cross-overlay collisions impossible and
makes the effective view's namespace prediction decidable rather than measured.

One caveat, and it became the design: **plugins do not carry the overlaid repo's
CLAUDE.md.** `--add-dir` does not either - that was the mitigation this spike
guessed at, and building profiles proved it wrong. Helm composes the overlays'
CLAUDE.md into one document and passes `--append-system-prompt-file`.

Headless (`-p`) only. The first profile launch through the real form was the
interactive proof, and it is `pnpm profiles-check` that keeps it.

### 8.2 Spike B - Portable packaging with native modules. GO

Ran 2026-08-08 on Windows 11, Electron 43.3.0 (Node 24.18.1, ABI 148),
electron-builder 26.15.3.

Both native modules survive portable packaging. The packaged portable exe passed
every check when run from a path with spaces, with no admin and no installer:
SQLite WAL read/write, interactive pwsh in xterm.js via ConPTY (including input
synthesized as real renderer key events), pty+xterm resize reflected inside the
shell, and the real `claude` 2.1.225 TUI rendering to its input prompt.

#### The surprise: no ABI rebuild exists in this config

The assumed risk was "native addons must be rebuilt against Electron's ABI".
That is no longer true for either module:

- **better-sqlite3 13.0.3** has `gypfile: false`, no install script, and ships
  N-API prebuilds at `prebuilds/<platform>-<arch>.node`. Loads unchanged in
  Electron.
- **node-pty 1.1.0** ships N-API prebuilds at `prebuilds/win32-x64/` including
  its own ConPTY backend (`conpty.node`, `conpty/conpty.dll`,
  `conpty/OpenConsole.exe`) and winpty fallback (`winpty-agent.exe`,
  `winpty.dll`). Its binary loader checks `build/Release`, `build/Debug`, then
  `prebuilds/`.

Consequently `electron-builder.yml` sets **`npmRebuild: false`**. This is not
just an optimization - running `@electron/rebuild` actively **breaks** the
build: it tries to compile node-pty from source and dies on the winpty
`GetCommitHash.bat` gyp bug (`'GetCommitHash.bat' is not recognized...`). Do
not add `electron-builder install-app-deps` or `postinstall` rebuilds back.

**Version note:** node-pty 1.0.0 (the previous `latest`) has no prebuilds and
cannot be compiled by node-gyp on this machine at all. 1.1.0 is the floor.

#### asar / asarUnpack

```yaml
asarUnpack:
  - '**/node_modules/better-sqlite3/**'
  - '**/node_modules/node-pty/**'
```

Both modules must be unpacked: `process.dlopen` cannot load `.node` files from
inside the asar archive, and node-pty's helper *executables* (OpenConsole.exe,
winpty-agent.exe) must exist as real files to be spawned. electron-builder
signs the unpacked helper exes automatically.

#### Portable mode data location

The portable launcher extracts the app to `%TEMP%\<random>\` and sets
`PORTABLE_EXECUTABLE_DIR` to the directory containing the exe. The main process
detects that env var and redirects `userData` to `<exe dir>\helm-data\` -
verified: `helm.db` (WAL), screenshots and the selftest report all landed beside
the exe; nothing was written to `%APPDATA%`.

`process.execPath` in portable mode points at the temp extraction, so **never
derive app paths from execPath** - use `PORTABLE_EXECUTABLE_DIR` (portable) or
`app.getPath('userData')` (installed). The same mechanism is what every check
driver now uses for isolation.

#### Selftest harness

`Helm.exe --selftest` runs the whole proof unattended and exits 0/1: SQLite
roundtrip, pwsh marker echo, renderer-synthesized keystrokes, resize
verification (`[Console]::WindowWidth` inside the shell after
`pty.resize(120,30)`), then launches `claude`, auto-dismisses startup gates
(folder trust, MCP enablement) and waits for the version banner. Evidence goes
to `helm-data/spike-report.json` + `helm-data/screenshots/*.png`.

Two lessons encoded there for future TUI automation:

1. Claude's TUI interleaves cursor/style sequences *inside words* and positions
   text without emitting spaces - match against an ANSI-stripped buffer with
   `\s*`-tolerant regexes (`/Claude\s*Code\s*v\d/`).
2. Startup can present interactive gates (trust prompt, MCP server enablement)
   before the input prompt; a host must expect arbitrary dialogs, not a fixed
   startup sequence.

#### Builds

- `pnpm dist:win` → `dist-app/Helm-<version>-portable.exe` (~95 MB) and
  `Helm-<version>-setup.exe` (NSIS one-click, per-user, no elevation).
- Reproducible from a clean checkout with no build tools, Python or compiler,
  because nothing compiles.

What this spike did **not** do was install-test anything; that gap is closed by
`pnpm packaging-check`, and [PACKAGING.md](PACKAGING.md) is where the release
process lives now. Keep node-pty pinned >=1.1.0 and better-sqlite3 >=13, and
revisit `npmRebuild` only if a future dependency lacks N-API prebuilds.

### 8.3 Spike C - Claude TUI fidelity inside xterm.js. GO, embedded-first

Ran 2026-08-09 on Windows 11 (build 26100), Electron 43.3.0, xterm.js 6.0.0,
node-pty 1.1.0, Claude Code 2.1.225.

**Embedded-first is viable. No external-terminal fallback mode is needed.**

The real `claude` TUI runs in an embedded xterm.js + node-pty pane with no
observable loss of fidelity, and the pane is as fast as having no terminal at
all. Every deviation found was a *host configuration* problem - something Helm
must set, not something xterm.js or Claude Code gets wrong - and all of them are
fixed and re-verified in this repo.

Fidelity is not free, though: an unconfigured xterm.js pane degrades the TUI in
five separate ways at once. The deviations table below is the actual deliverable
of this spike.

#### How it was measured

Two automated drivers, both asserting on what xterm.js *parsed* - cell colours,
cell widths, wrap flags, buffer coordinates - rather than on a screenshot a
human has to squint at. Keystrokes and mouse events are synthesised as real
Chromium input events, so they travel the same path a user's typing does.

```
pnpm fidelity        # C1-C9, the terminal itself      -> helm-data/fidelity-report.json
pnpm claude-check    # D0-D7, the real claude TUI      -> helm-data/claude-report.json
pnpm shell           # the interactive pane, for the soak test
```

Both accept `--only=C5,C6` to re-run single checks, and both write their report
and screenshots to the app's data directory. The figures below are what they
measured; C8 and C9 assert against ceilings derived from them, so a regression
fails the check rather than waiting to be noticed in a table.

#### The terminal (`pnpm fidelity`), 9/9

| | Check | Evidence |
|---|---|---|
| C1 | 24-bit colour | Three RGB triples that exist nowhere in the 256-colour palette parsed as RGB cells **and** appeared as ~1,700 exact-match pixels each in the composited frame. Foreground and background both. |
| C2 | Unicode widths | A box padded on the assumption of Unicode 11 widths closed on column 13 in all six rows. `中` and `🚀` measured 2 cells, `─` and `█` measured 1. |
| C3 | Resize reflow | A 300-character line reassembled byte-identical from the wrap flags at 100, 132, 61 and back to 100 columns - including a shrink well below its original wrap point. |
| C4 | Keyboard | Ctrl-C `\x03` interrupted a running loop; `↑` recalled history; Esc cleared the line editor; Tab completed `Get-Chi` → `Get-ChildItem`; Shift+Enter now distinct from Enter. |
| C5 | Paste | Multi-line paste arrived bracketed (`ESC[200~ … ESC[201~`) with newlines normalised to CR; unbracketed when mode 2004 is off; 100 KB delivered to the child process losslessly in 64 ms. |
| C6 | Scrollback | Under streaming output, a wheel scroll parked the viewport at row 1136 and it stayed there while the buffer grew from 1473 to 3273 rows. `scrollToBottom` returned. |
| C7 | Selection | A synthetic mouse drag selected the exact row text; Ctrl-C copied it; the next Ctrl-C interrupted again. |
| C8 | Latency | 150 samples: round trip p50 **1.0 ms**, p95 **7.0 ms**, max 16.4 ms. The host's own share (keydown → byte handed to the pty) is p50 **0 ms**, p95 0.1 ms. |
| C9 | Throughput | 40,000 lines drained in **4,071 ms** at 100x30. |

#### The real TUI (`pnpm claude-check`), 8/8

| | Check | Evidence |
|---|---|---|
| D0 | Startup | Reaches the input prompt; startup gates (folder trust, MCP enablement) are arbitrary dialogs a host must expect, not a fixed sequence. |
| D1 | Resize | The composer rules redrew flush to column 99 / 131 / 71 / 99 at 100, 132, 72 and back to 100 - no ghost columns. |
| D2 | Colour | Claude emitted 5 distinct 24-bit colours and **zero** 256-palette colours on the first screen. |
| D3 | Composer | Typing renders; the first Ctrl-C interrupted the running turn and left the composer untouched; the second cleared it; the session survived both. |
| D4 | Overlays | Slash-command menu rendered and its highlight moved with arrow keys (verified by cell foreground colour, since the highlight is a colour change and not a text change); Esc dismissed it; `/help` rendered; the **`/resume` picker rendered in the alternate buffer** and responded to arrow keys. |
| D5 | Permission dialog | A Bash tool prompt rendered with its numbered options, moved with arrow keys, and cancelled on Esc - confirmed by the target directory not existing afterwards. |
| D6 | Shift+Enter | Inserts a newline instead of submitting (after the fix below). |
| D7 | Newline encodings | The composer accepts **all four** of `ESC CR`, `LF`, `CSI 13;2u` and `\`+CR as an inline newline. |

#### Deviations

Severity is what would happen if Helm shipped without the fix.

| # | Deviation | Severity | Status |
|---|---|---|---|
| 1 | **Shift+Enter is byte-identical to Enter.** xterm.js has no default encoding for the modifier, so both send `\r` and the composer *submits the prompt* instead of adding a line. | **High** - silently sends half-written prompts | **Fixed.** The pane binds Shift+Enter to `ESC CR`. D7 established the composer accepts it; D6 verifies the binding. |
| 2 | **Electron's default menu eats Ctrl-C.** The stock application menu binds Ctrl-C to the Edit→Copy role, which consumes the keydown before xterm sees it - the interrupt never reaches Claude. | **High** - no way to interrupt a turn | **Fixed.** `Menu.setApplicationMenu(null)`. |
| 3 | **Colour depth is not advertised by default.** Without `COLORTERM=truecolor` in the child environment, Ink resolves 256 colours and the whole theme shifts. | Medium - wrong colours everywhere | **Fixed** in `ptyEnv`. D2 confirms zero palette colours in use. |
| 4 | **Unicode 6 widths by default.** Without `allowProposedApi` + the Unicode 11 addon, emoji are measured one cell wide and every box-drawn surface - status line, dialogs, the composer - misaligns. | Medium - visibly broken UI | **Fixed.** C2 is the regression test. |
| 5 | **Inherited `CLAUDE_CODE_*` environment.** Launching Helm from inside a Claude Code session leaks `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` and friends into the hosted session, which then announces *"Transcript saving is off - inherited CLAUDE_CODE_CHILD_SESSION marker"* and stops writing a transcript. | Medium - silent data loss, and it defeats the v1.1 transcript-archive plan | **Fixed.** `ptyEnv` scrubs them. |
| 6 | **Ctrl-C is overloaded.** A terminal host has to choose between copy and interrupt. | Medium | **Implemented** to Windows Terminal's contract: Ctrl-C copies only while a selection is live, any other keystroke drops the selection, Ctrl-Shift-C/V always copy and paste. C7 covers all three transitions. |
| 7 | **`minimumContrastRatio` and `drawBoldTextInBrightColors`** would rewrite Claude's colours if left at anything but the passive setting. | Low | **Fixed** - both pinned explicitly, with comments saying why. |
| 8 | **node-pty prints `AttachConsole failed`** from `conpty_console_list_agent` when enumerating the console process list. | Low | **Not fixed.** node-pty has a built-in timeout fallback (it falls back to killing the shell pid alone), so the effect is stderr noise plus a marginally less thorough process-tree kill. Revisit if orphaned processes ever show up. |
| 9 | **Electron's own binary cannot host a process in a pty.** `electron.exe` run as node inside a ConPTY exits cleanly but its stdio never reaches the pseudoconsole - it is a `/SUBSYSTEM:WINDOWS` binary. | Low | **Informational.** Nothing Helm ships needs it; the spike's own sink/echo processes use `node.exe`. Worth remembering before planning any in-pane helper. |

#### On latency

The acceptance criterion was "indistinguishable from Windows Terminal in normal
use". Two measurements bound it:

- **Input.** Keydown to the painted frame carrying the echo is p50 1.0 ms, and
  the host's share of that is p50 0 ms / p95 0.1 ms. There is no room in those
  numbers for a perceivable difference - a 60 Hz frame is 16.7 ms.
- **Output.** 40,000 lines drain in 4,071 ms. The same workload through a
  consumer that does *nothing but read bytes and discard them* takes
  4,065-4,089 ms. The pane is within noise of having no terminal at all, so
  ConPTY and PowerShell are the bottleneck and no terminal can be meaningfully
  faster.

Windows Terminal could not be launched from the automation environment (MSIX
activation is blocked there), so the side-by-side number is the one measurement
this spike did not take. Given the floor above it cannot change the verdict, but
to fill it in, run this in Windows Terminal and compare against 4,071 ms:

```powershell
pwsh -NoLogo -NoProfile -Command '[Console]::SetWindowSize(100,30); $sw=[Diagnostics.Stopwatch]::StartNew(); 1..40000 | ForEach-Object { "line $_ the quick brown fox jumps over the lazy dog" } | Out-Host; "THROUGHPUT $($sw.ElapsedMilliseconds)"'
```

#### What automation cannot sign off

`pnpm shell` opens the interactive pane against this repo. A long real-session
soak is still owed a human verdict on:

- [ ] Latency *feels* right over a long session, not just in percentiles
- [ ] Diff rendering and syntax highlighting during real edits (this spike
      proved the colour path, not Claude's diff view specifically)
- [ ] Memory and responsiveness after a long session with heavy scrollback
- [ ] Anything that only shows up when a person is actually working

#### What it means for the repo

- **`src/renderer/src/terminal.ts` is the seed**, and it carries all five
  configuration fixes with a named regression check behind each.
- **Do not build an external-terminal fallback mode.** Nothing found here
  justifies the second code path.
- **`ptyEnv` is load-bearing.** Colour depth and environment scrubbing both live
  there, and both fail silently and confusingly when wrong.
- **The probe bridge is worth keeping.** Asserting on parsed cells rather than
  pixels is what made these checks trustworthy - three of the first-round
  "failures" were bugs in the tests, and the cell-level detail is what exposed
  them.

---

## Related

- [[reference-electron-migration-plan]] - prior Electron work in this harness
- `context/harness-map.yaml` - harness detection reads this when present

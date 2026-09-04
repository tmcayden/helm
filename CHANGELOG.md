# Changelog

What each release changed **for somebody using Helm**. One section per version,
newest first, and `.github/workflows/release.yml` publishes the section matching
the version being released as the release body.

Not a commit log. The commits are one click away under "Full changelog" on every
release page, and they include the checks, the fixtures and the refactors - all
of which matter to whoever works on Helm and none of which a person downloading
an exe has any use for. Deriving this from `git log` was tried through 0.4.0 and
produced fifty-nine lines, most of them naming probe ids.

A version with no section here does not release: the workflow fails rather than
publishing an empty body, because the step a person can skip is the step that
gets skipped.

## 1.2.1

Reopening a conversation that lives in a WSL distribution failed to start at
all. It works again, and a resume that has to do without Helm's own tools now
tells you instead of going quiet.

**Resuming a session inside a distribution**

- Picking a session from Session history whose conversation lives in a
  distribution now starts it. It used to hand the distribution's Claude Code a
  Windows path it could not read, and the session ended before it opened with
  an "MCP config file not found" error naming a path nothing had created.
- Such a resume now checks Helm's browser and session tools can be reached from
  the distribution, the same check a launch has always made. When they cannot,
  the session still opens and says so, rather than starting without them for no
  stated reason.

## 1.2.0

Helm can now run your sessions inside WSL. A profile picks where its Claude
Code runs - this machine, or a Linux distribution - and everything else about
Helm stays the same: tabs, the status dot, the sessions view and the browser
tools all work for a session that lives in Ubuntu.

**A profile chooses Windows or a distribution**

- The profile editor has a target: this machine, or a WSL distribution by name.
  A WSL profile hosts the distribution's own `claude`, signed in with the
  distribution's own account, in a folder inside the distribution. Profiles you
  already have keep running on Windows; nothing about them changed.
- Skills, commands and agents from a project inside a distribution reach the
  session exactly as they do for a Windows folder. Where Windows cannot link
  across the boundary, Helm copies instead, so a session never starts with its
  skills silently missing.
- The browser and session tools need WSL's mirrored networking to reach Helm.
  When they cannot, the session starts without them and the launch says why.
  Settings gains a WSL group that writes the one line to `.wslconfig` for you,
  keeping a backup beside it, and offers the WSL restart as a separate step you
  confirm.

**Folders inside a distribution get the right shell**

- The shell under a project that lives in WSL now opens that distribution's
  own login shell, in that folder. It used to try PowerShell there and fail.
  Windows folders keep whatever shell you chose in Settings.
- Branch and dirty-state chips for a repository inside a distribution now come
  from the distribution's git. Suggested scan roots include your distributions'
  home folders.

## 1.1.1

Pasting into a terminal put your text in twice, and copying could silently hand
you something you selected minutes ago. Both are fixed, and both turned out to
be the same missing line.

**Paste lands once**

- Ctrl+V and Ctrl+Shift+V now paste the clipboard once. Every paste used to
  arrive twice: a composer received your text doubled, and a shell ran the line
  twice.

**Copy gives you what you selected**

- A right-click anywhere in a terminal used to quietly break copying. From that
  moment Ctrl+C put whatever had been selected at the time of the right-click on
  your clipboard rather than what was selected now, it stayed that way for the
  life of the tab, and nothing on screen suggested anything had happened. Ctrl+C
  now copies the live selection.

## 1.1.0

Helm can now tell you what your agents are doing, and your agents can tell each
other. A tab says whether its session is working or waiting on you, a new
Sessions view lists every Claude Code session on the machine and what the ones
Helm started are holding, and Helm warns you before you put a second agent in a
working tree that already has one.

**A tab tells you whether it needs you**

- The dot beside a tab's name now says what that session is doing rather than
  only whether it is alive. Purple means the model is working. Amber means it
  is blocked on you, and hovering tells you why - a permission prompt, an open
  dialog - in the words the session itself used. Green means it has handed back
  and is waiting for your next message.
- A green ring instead of a filled dot means it has finished but left something
  running in the background. "Done" and "done, but a build is still going" are
  different answers to "can I close this", so they look different.
- If Helm cannot tell, it says nothing rather than guessing: the dot falls back
  to what it has always shown. A future Claude Code that renames a state will
  make Helm quieter, never wrong.

**A Sessions view, for the whole machine**

- New in the sidebar. It lists every Claude Code session running on this
  machine - not only the ones in Helm's tabs. A `claude` you started in Windows
  Terminal collides with a working tree exactly as hard as a tab does, so it is
  listed too, marked as one Helm did not start.
- For the sessions Helm started, you can see what each one is **holding**: the
  processes it launched and the ports they are listening on. This is the view
  that answers "is something already using 5173" and "did that agent leave a
  container up".
- Where Helm cannot see, it says so. A session it did not start has no process
  list, because Helm knows nothing about it. A tree it could not read says
  "unknown" rather than showing you an empty list that looks like "nothing is
  running".

**A warning before two agents share a working tree**

- Starting a session in a folder that already has one now says so first, and
  names what is running there - including sessions started outside Helm. Two
  agents editing one checkout is the mistake this exists to prevent, and it is
  much easier to avoid before you press the button than after.

**Sessions can see each other**

- A session running in Helm can now ask what the other sessions are doing, so
  it can stay out of their way - which working trees are busy, which ports are
  taken. It is read-only awareness and nothing more: sessions cannot talk to
  each other, hand each other work, or wait on each other.
- **No session can ever see another session's conversation.** Not its
  transcript, not its prompts, not its replies, and not the command lines of
  what it is running. A session can learn that another one is busy in a folder
  and holding a port. It cannot learn anything about what is being said.
- Switch it off in **Settings → Sessions** if you would rather your agents did
  not know about each other. Off means off - the tools are not offered at all.

**Sessions start again where an installed `claude` has a space in its path**

- If your `claude` came from npm and sits under a path with a space in it -
  `C:\Program Files`, or a user folder with a space - sessions could fail to
  start outright, with an error naming half the path to your CLI. Fixed. This
  affected every session on those installs, and naming a session with a space
  in it was enough to trigger it.

## 1.0.1

Signing in to a site inside Helm's browser used to break the browser. It no
longer does, and it now works.

**A page that closes itself no longer takes the pane with it**

- Closing itself is the last thing a sign-in window does when it finishes, and
  Helm handled it badly enough to lose the whole browser. What you saw was a
  Windows error dialog that came back as fast as you could dismiss it, and then
  a pane that stayed blank and refused every address you typed without saying
  why. Both are gone. A tab whose page closes itself simply closes.

**Sign-in popups work**

- Signing in with Google, GitHub or Microsoft now completes. It could not
  before: the site was told its popup had been blocked, and there was no way to
  get past that - which is what the sign-in that started all this was doing
  when it froze.
- A sign-in window shows the site it belongs to in its title bar, because it
  has no address bar to show you. It is on the same profile with the same
  refusals as the pane - no downloads, no permissions granted, and it can only
  reach where **Settings → Browser** already lets the pane reach.
- Links that open in a new tab are still tabs, not windows. Helm still opens
  nothing on its own, and a session driving the browser for you still cannot
  put a window in front of you.

**When something goes wrong with a tab, it says so**

- A browser tab that fails now tells you on the tab, rather than going quiet.
  One refusal had been reachable and shown nowhere at all - the limit of ten
  browser tabs - so clicking for an eleventh appeared to do nothing. It is now
  a notice you can read, and notices are legible over the tab strip instead of
  being drawn through it.

## 1.0.0

The version number stops disclaiming. 1.0 does not mean finished - it means
Helm is no longer a preview of itself, and that what is below is the shape it
was meant to have. Read **What 1.0 does not promise** at the bottom before you
read that as a guarantee; two of the things people reasonably expect from a
1.0 are not here, and saying so is the point of that section.

**A browser, in the window**

- Helm has a browser in it, beside your session rather than in another
  application. It is a **dev-server viewport** first: type a bare port number
  and it goes there, so `5173` is a valid address.
- It remembers the last page per project. A dev server's port belongs to the
  project, and typing it again every session was the papercut this exists to
  remove.
- It is deliberately not a general browser. Nothing downloads - a download is
  handed to your real browser instead. Every permission a page asks for is
  refused. The address bar never hands what you typed to a search engine: a
  page loads because you gave its address. Self-signed certificates are
  accepted for this machine and nowhere else, and there is no click-through
  for a bad one anywhere.
- **Settings → Browser** decides where it may go: anywhere you navigate it, or
  this machine only.
- It keeps its own logins, in its own profile under Helm's data directory,
  separate from your real browser. Nothing in Helm reads that profile; the one
  thing the app can do to it is the **clear** button in the pane.

**Claude can drive it**

- Ask the session beside you to open a page, read it, click something, fill a
  field or take a picture, and it will. Reading a page it has just changed, or
  finding out why a page is blank, no longer means you relaying it.
- Its tabs are labelled with the session that opened them, so with three
  sessions running you can tell whose page you are looking at.
- **A session drives only the tabs it opened itself.** A tab you opened is a
  page you chose to be on, in a profile holding your logins, and no tool can
  read, script or photograph it. Listing tabs is allowed; that is not driving.
- One tick in **Settings → Browser** turns the whole thing off, and off is a
  real off - no port is opened, no token exists, and sessions start exactly as
  they did before. A second tick keeps the tools on this machine even when the
  pane itself may go further.

**Harness templates**

- **New Harness** can start from a template instead of the bare scaffold, so
  the layout you always end up building is there on the first day.
- **Settings → Harness templates** manages them: create, rename, describe and
  delete, copy a skill you have already written into one out of any `.claude`
  tree Helm can see, or import a folder somebody sent you.
- **Save a harness you have been working in as a template**, ticking off what
  belongs to that particular harness rather than to the layout. The running
  total moves as you untick, so you can see what you are about to keep.
- Templates live in `~/.config/helm/templates` - beside the exe if you run the
  portable build, so a stick leaves nothing on a machine you plug it into.
  They are ordinary folders, and Helm opens them in Explorer for editing
  rather than pretending to be your editor.
- Only `.tpl` files are substituted. Everything else arrives byte for byte,
  which is what makes it safe to keep a workflow file full of `${{ ... }}` in
  a template.

**The editors**

- Source files are syntax highlighted, in the content viewer and in the config
  console, and in both themes.
- Editing behaves the way editing behaves: undo gives back what you typed
  rather than the whole box, brackets close, and indentation follows the line
  above.
- Quotes do not auto-close in prose files. `don't` becoming `don''t` in a
  CLAUDE.md is worse than a missing convenience.
- On a very large file the highlighting steps aside rather than the typing
  getting slow. A megabyte-and-a-quarter file used to take nearly two seconds
  to answer a keystroke; it now answers in about twelve milliseconds, without
  colour.

**Throughout**

- Every dialog in the app now paints the same overlay, so they dim the same
  way, sit in the same place and close on the same key.

**What Helm talks to**

> Helm contacts nothing on its own initiative except the update check.
> Everything else on the network happens because you asked for it: the
> pull-request surface goes through your own `gh`, and the browser pane fetches
> the page you navigate to.

There is no telemetry, no crash reporting, no fonts and no CDN. Turn the update
check off and Helm asks nothing by itself at all.

What is new in 1.0 is that Helm now also **listens**, on loopback, so the
sessions it hosts can reach the browser tools - `127.0.0.1` only, on a port the
operating system picks, with a token minted per session and revoked when that
session ends. There is no route that answers without one, not even a health
check. With the browser tools off it binds nothing.

**What 1.0 does not promise**

- **These builds are not code-signed, and 1.0 does not change that.** Windows
  will say **"Windows protected your PC"** on the download: **More info** →
  **Run anyway**. That warning is doing its job. If you would rather check than
  trust, both artefacts are built from the tagged commit by the release
  workflow and the run is linked from this page.
- **There is no auto-updater, deliberately.** Helm tells you when a release is
  out and links it; installing it is yours. An unsigned replacement installer
  would put that same SmartScreen prompt in front of every update, the portable
  build has no install location to replace, and a background restart would end
  a `claude` session you were in the middle of.
- **Your data keeps working, and that is the whole of the compatibility
  promise.** A newer Helm opens the database an older one wrote; settings it
  does not recognise are ignored rather than fatal, in both directions.
  Everything else - the internal file layouts, the exported profile format,
  what the app keeps where - is Helm's own and may change.

## 0.5.0

**Session history**

- A session is called what it was about. Rows were titled with the opening
  prompt, and an opening prompt is often `/exit`, `/usage` or an image you
  pasted - 291 of this machine's 1,011 sessions opened on a bare command. The
  title now reads past those to the first thing you actually said.
- You can name a session yourself, by double-clicking its title, and the name
  you give it is searchable alongside everything said in it. It survives the
  history being rebuilt from scratch.
- An archived conversation reads as a conversation: your messages and Claude's
  in bubbles down opposite sides, tool runs kept out of the way, timestamps
  under the message they belong to. It used to be a table.

**Content viewer**

- A code file is read inside the pane. It used to grow to the length of the
  file, which put the sideways scrollbar at the bottom of the *file* - you had
  to scroll through a minified payload to reach the bar that would move it
  sideways - and clipped the last line mid-glyph. It now scrolls in both
  directions inside its own well, with both bars at the edge of the pane.
- Source files can wrap, per file, from a toggle in the document header. A
  wrapped line hangs from its own indentation rather than from the margin, so
  a deeply nested line's continuation does not read as a new shallow one. Off
  by default, and both the default and the hang are under
  **Settings → Content**.
- A source file stays where you scrolled it. It used to snap back to the top a
  few seconds later, wrap on or off.

**Profiles**

- **Agent** is a picker over the agents that root and the projects composed
  into it would actually resolve - including the ones an overlay contributes,
  which arrive under a prefix you could not have guessed. It says what it does:
  it becomes `--agent` on the session's command line.
- **MCP servers** is a picker over the servers configured for that root, with
  the scope each comes from. It also says plainly what it does *not* do - the
  selection is saved with the profile and travels with its export, but it is
  not applied at launch, and the config console is where a session's servers
  are configured. Both fields used to be text boxes that said none of this.
- A saved agent or server the root no longer resolves is marked **unresolved**
  by name and kept. A profile written before the project that supplies its
  agent exists is a reasonable thing to have.
- The profile dialog no longer scrolls sideways on a shorter screen, which had
  been cutting the Compose and Access columns off the right edge.

**Config console**

- MCP servers configured for a project now appear. Claude Code records them
  against the directory you started it in, writing that path however it was
  given - and Helm was matching it one way only, so it missed the servers of
  very nearly every project and reported "no servers configured" for
  directories whose sessions had one loaded.

**Welcome**

- The empty workspace opens with the ship's wheel rather than the word "Helm"
  above it, which was saying the name twice to somebody already looking at
  the app.

## 0.4.0

**Folders**

- Adding a folder adds *that* folder. It used to add every subdirectory inside
  it, so pointing Helm at one tool directory filled the launcher with its
  `src`, `tests` and `data` and nothing named after the folder you picked.
- A scanned folder can be removed again, from its own project pane. Nothing on
  disk is deleted - it leaves Helm, and adding it back brings it all with it.
- Removing a folder now closes its terminal. It used to keep running, with no
  tab in front of it, until you quit.

**Pull requests**

- The Open section is a triage surface. Filter by title, number, branch, author
  or repository; group by repository or author; and open pull requests split
  into ACTIVE and STALE so one busy repository stops burying everything else.
- Stale rows collapse to one-line chips that keep their state dot and check
  tally, so a pull request with red CI is still visible while it is quiet.
- The cutoff is yours: **Settings → GitHub → stale cutoff**, from one day to
  ninety, or off for the single flat list exactly as it was.

**Config console**

- Create, rename and delete files in a `.claude` tree. A new skill scaffolds its
  directory and frontmatter; a rename moves a skill's whole directory; a delete
  is snapshotted first and restorable from the file's own history.
- A file opens as the object it is rather than as a box of text: `settings.json`
  as a form over its real keys, markdown rendered with its frontmatter as chips,
  and a hook showing which event fires it and from which settings block.
- Rows say whether the thing is live - shadowed by another scope, namespaced
  under an overlay, or overridden downstream - so the list stops reading as a
  directory listing.
- Files bundled beside a `SKILL.md` nest under their skill instead of landing in
  `Other`.
- The console no longer opens `.credentials.json` at all.

**Content viewer**

- A harness opens on the curated view; a project opens on a real file tree, read
  lazily as you expand it and greying what `.gitignore` excludes rather than
  hiding it. Either mode works from either kind, and the header says which rule
  is in force.
- Roots are badged and counted, and an empty one stays listed rather than
  vanishing.
- Every file inside a root is listed. Source files open in a source view instead
  of being hidden, so the scripts an agent writes into `tools/` are readable.

**Everywhere**

- Code blocks were rendering at double height throughout the app. Fixed.
- Every hover, cursor and pressed state was audited across all 194 controls.

## 0.3.0

**Projects**

- The project pane is the project's hub: links straight into Config and Content
  scoped to it, and the repository's own open pull requests listed on it.
- Pin the projects you actually open, above the harnesses.
- The project shell gets a third of the page and can be dragged, rather than
  that height being its ceiling.

**Sessions**

- Tabs say which session they are, and you can give one a better name.
- **Transcript archive.** Claude Code reaps its own transcripts on a schedule -
  on one machine, 91% of conversations were already gone. Helm now reads them
  before they are deleted and can render an archived one.

**Pull requests**

- The conversation shows the comments people leave on lines of the diff, not
  only the root-level ones.
- Ask Helm whether a newer release exists, and see what the answer was.

**Fixes**

- **Every hover state in the app was dead**, and had been for a while. Fixed.
  Every clickable control now takes the pointer and answers it.
- The tab strip has its scrollbar back.
- Dragging the session split no longer re-renders everything behind it, and
  resizing no longer pays for every row in the history.
- PowerShell is resolved properly instead of hoped for on `PATH`.
- Wikilinks render as the links people wrote them as.

## 0.2.3

- A dropped connection is no longer reported as a signed-out machine.

## 0.2.2

- Helm tells you when a newer release exists. Asking was previously
  unreachable.

## 0.2.1

- The project shell opened the wrong project's shell, and in split view there
  was none at all.
- PowerShell 7 installed from the Microsoft Store was invisible to Helm, so the
  shell started with no profile.
- A usage reading that is merely old now shows as a floor rather than showing
  nothing.

## 0.2.0

**Look**

- The Nocturne Islands design system across the whole app: split-view sessions,
  a project shell terminal, and a themed title bar.

**Settings**

- A settings pane behind the gear in the title bar, with six terminal settings
  that apply live to every open pane.
- Settings are validated on the way in; reads stay tolerant of rows written by
  another build.

**Pull requests**

- A Pull requests pane, sweeping the repositories Helm discovered for anything
  open, with a GitHub group in Settings.
- Open a pull request in a tab of its own, see its patch in a Files view, and
  review it with Claude from the tab it is open in.
- Ignore a repository and its pull requests stop being fetched at all.

## 0.1.0

First release.

- **Embedded terminal.** Claude Code runs in tabs, hosted rather than
  reimplemented.
- **Profiles and overlay composition** - the feature the whole app was a bet on.
- **Session launcher** - every session on the machine, with the resumable ones
  marked.
- **Config console** - any `.claude` tree as a real interface, and what a
  session would actually see.
- **Content viewer** - the vault, rendered, searchable and editable in place.
- **Usage in the status bar**, as a percentage of plan limits or as dated
  dollar estimates.
- First run locates `claude`, chooses roots and scaffolds a harness.

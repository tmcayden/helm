---
name: procedures
description: The repeatable multi-step jobs in Helm - adding an app setting, changing the database schema, and building a Windows release. Use when asked to add or change a setting, add or alter a table or column, run db:generate, or produce dist:win artefacts.
---

## Helm's procedures

Three jobs in this repository have a fixed order of steps, and each has a step
people skip. What follows is the order and the step.

## Adding an app setting

Four edits and no migration, because `app_settings` is JSON-per-key:

1. **The key and its default** in `AppSettings` / `DEFAULT_SETTINGS`
   (`core/src/types.ts`). That is the whole of the persistence step - there is
   no table change and no migration.
2. **A validator** in `SETTING_VALIDATORS` (`core/src/store/settings.ts`). The
   map is `Record<keyof AppSettings, ...>`, so a key with no validator does not
   compile, and a value that fails one writes nothing and throws. Add its valid
   *and* invalid cases to the table in `store.test.ts`.
3. **A row** in the matching group of `ui/src/components/SettingsPane.tsx`, with
   a `data-settings-*` hook so the driver can drive it.
4. **Only if the value drives something outside the database**, a branch in the
   `settings:write` ladder in `main/ipc.ts`. That ladder is the entire
   side-effect dispatch: theme retints the overlay, `claudePath` reaches the
   session host. A setting that only needs to be read back does not belong in
   it.

Then **extend `pnpm settings-check`**. This is the step that gets skipped: a
setting with no assertion in it is a setting nothing proves round-trips.

Two rules that shape all of the above:

- **Reads stay tolerant, writes stay strict.** Unknown keys are ignored and bad
  JSON falls back per key, because a row from another build is a fact about the
  past. A malformed write is a bug happening now, so it writes nothing and
  throws.
- **Internal state is not a setting.** `windowBounds` and `firstRunCompletedAt`
  live in the same table and are deliberately absent from the pane - they are
  things Helm remembers, not things anyone chose.

Settings for Helm go here. Anything that edits a `.claude` tree belongs to the
config console, and the two are not the same surface.

## Changing the schema

Edit `core/src/store/schema.ts`, then run `pnpm db:generate`.

The generated SQL is **embedded into the bundle**, not read from disk at
runtime, so a packaged exe carries its own migrations rather than needing files
shipped beside it. Skipping `db:generate` therefore produces a build whose code
expects a column its migrations never create.

## Cutting a release

Two edits and a merge:

1. **The version** in `packages/desktop/package.json`. That bump is the whole
   trigger - merging it to `main` tags it, builds on a clean runner and
   publishes. No tag to push, no button.
2. **A `## <version>` section in `CHANGELOG.md`**, which becomes the release
   body. **Without one the release fails**, deliberately: writing it is the step
   a person can skip.

Then run `pnpm packaging-check` green before merging. CI runs only the fast
tier - typecheck, lint, tests, build - so nothing else covers the checkout
audit, the first-run path or the portable exe.

**It cannot uninstall the Helm you are using, and that is why it is a gate you
can actually run.** There is no installer group in that suite and no `--only=`
reaches one. Verifying the NSIS package means installing it over the Helm on
this machine and uninstalling it again, which ends the Claude Code sessions Helm
is hosting - so it is a **tool run by name**, not a check:

```
pnpm verify:installer --yes                     # install, run, uninstall
pnpm verify:installer --yes --replace-running   # ... even with Helm open
```

It refuses without `--yes`, refuses again while Helm is running unless
`--replace-running`, and **leaves no installed Helm behind** - that is the
honest end state of verifying an uninstall, and it is why it is not in a suite.

It was once a group here, kept out of the default run by an opt-in list. That
was the wrong shape: a list is a thing somebody can add to, `--only=installer`
was a spelling away from a sweep, and the guard meant to catch the accident had
itself never run. It cost a session and an app reinstalled by hand. The rule is
structural now rather than careful - **a step that stops, removes or replaces
the installed app is a tool somebody asks for, never a group a suite reaches.**

`packaging-check` still prints a `PKG-2` line saying the installer was not
verified there, so "packaging-check green" cannot quietly come to mean "the
installer works". Run the tool deliberately, on a machine where nobody is
working, when a release **changes packaging** - electron-builder,
`electron-builder.yml`, the native modules, `dist-win.mjs`, or anything about
where files land. A release that changes none of those is not one the tool has
new information about, and CI already runs `verify-artifact.mjs` over both exes
on every publish.

**The changelog is for somebody deciding whether to download an exe.** Not a
commit log: no probe ids, no check names, no `pnpm` commands, no refactors, no
fixtures. The commits are one click away under "Full changelog" on every release
page. Group entries by what a reader would look for - the surface that changed -
and say what is different for them, not what was done to the repository.

This was learned the expensive way. Through 0.4.0 the body was `git log`
subjects, which put fifty-nine lines on the page, most of them naming a probe,
and three identical lines from one cherry-pick onto three branches. Deriving it
by path was tried and cannot work: the same file is touched for a reason a
reader sees and for a reason they never will. The workflow now refuses a section
carrying those fingerprints, but the guard only catches a pasted commit log -
whether an entry is worth telling anyone about is still yours to judge.

## Building a Windows release

`pnpm dist:win` goes through `scripts/dist-win.mjs`, never straight to
electron-builder.

electron-builder resolves the package manager with `which`, which prefers
`pnpm.EXE` over `pnpm.CMD` on Windows. A stale standalone pnpm shadowing the
managed one makes it fall back to the npm collector - and that path does not
fail. It warns, and ships an exe with **no `app.asar.unpacked`**, which dies on
its first `dlopen`. The wrapper checks that the resolved pnpm answers the
declared version.

`pnpm packaging-check --only=package` asserts the prebuilds are present in the
artefact regardless of how it was built, and `pnpm verify:artifact` unwraps a
finished exe and checks the same thing from the outside. Full release process:
[docs/PACKAGING.md](../../../docs/PACKAGING.md).

## Installing a build on this machine

Two commands, and the second has to outlive the app it replaces:

```
pnpm dist:win          # the artefacts, into packages/desktop/dist-app
pnpm install:local     # Helm closes, the setup exe runs, Helm comes back
```

`install:local` is `scripts/install-local.ps1`, and the shape of it is the
whole lesson. The installed Helm is usually hosting the very Claude Code session
that asked for the reinstall, the NSIS installer cannot replace a running app,
and a script started from a Helm tab is a child of that tab's pty - so it
**relaunches itself detached first**, then waits a grace period so the sentence
announcing the restart can land, asks Helm to close through its main window (so
`before-quit` runs and the store is released), force-stops it only if that has
not worked, runs `Helm-<version>-setup.exe /S`, and starts the installed Helm
again. It writes each step to `%TEMP%\helm-install-local.log`.

**The proof an install happened is `resources\app.asar` getting newer.** `/S`
exits 0 on a refused install too, so the exit code says nothing; the script
compares the asar's timestamp either side and fails loudly if it did not move.

**Do not copy `dist-app\win-unpacked\` over the install directory instead.** It
looks like it works - the app runs, the files are new - and it leaves
`Uninstall Helm.exe` from the previous install in place, with a file list that
no longer matches what is there. The one-click installer is per-user, needs no
elevation and takes seconds; there is no case for going round it.

This is a local install and not a release: no version bump, no changelog, no
tag. Cutting a release is its own section above.

/**
 * What a session launch is, before anything Electron-shaped touches it.
 *
 * A plain session launches one project at a time, so the only flag here is
 * `-n`. The shape is a spec object rather than a string of flags because a
 * profile composes overlays
 * into this same call - `--plugin-dir` per overlay, `--add-dir` per access
 * path - and argv assembly that started life inline in the main process would
 * have to be moved out of it first, untested, to get there.
 */

/** Long enough for "acme-reporting accruals", short enough to fit a tab. */
const MAX_NAME = 60

export interface SessionSpec {
  /** Working directory. Claude Code resolves all `.claude/` config from it. */
  cwd: string
  /** Display name, passed as `-n`. */
  name: string
  /** Appended verbatim after the generated flags. */
  extraArgs?: string[]
}

/**
 * Argv *after* the executable. The name is passed even when it was generated
 * rather than typed: an unnamed session shows up in `/resume` as its first
 * prompt, which is unrecognisable a day later and identical across every
 * session that started with `/recap`.
 */
export function buildClaudeArgs(spec: SessionSpec): string[] {
  return ['-n', sanitizeSessionName(spec.name), ...(spec.extraArgs ?? [])]
}

/**
 * Argv for reopening a conversation that already exists.
 *
 * Three things are deliberately absent.
 *
 * `-n` - resuming does not create a session, it continues one that already has
 * a name of its own. Passing one would rename the user's session as a side
 * effect of Helm having opened it. The tab's label comes from Helm's own row
 * instead.
 *
 * The working directory - it is not a flag. `--resume <id>` is resolved
 * against the cwd, and a session resumed from anywhere else reports "No
 * conversation found with session ID" and exits 1 (measured on 2.1.225). The
 * caller sets cwd to the directory history recorded, or does not launch.
 *
 * Everything else - a model, an effort level, an overlay set. The conversation
 * was had under whatever it was had under; a resume that quietly changed the
 * model would be a different session wearing the same id.
 *
 * The one thing that *is* passed is `--mcp-config`, when the host has written
 * one. It is not a property of the conversation being reopened - it names a
 * loopback port that only exists in this app run - so leaving it out would mean
 * a resumed session silently lacking the browser tools every other session has.
 *
 * That path must already be spelled the way the target's CLI will read it, the
 * same contract `buildLaunchArgs` has. **Call `prepareResume` rather than this**
 * unless you are the one doing the translating: this taking a Windows path
 * straight through to a distro is the bug `prepareResume` was added for.
 */
export function buildResumeArgs(sessionId: string, mcpConfigFile: string | null = null): string[] {
  const argv = ['--resume', sessionId]
  if (mcpConfigFile !== null) argv.push('--mcp-config', mcpConfigFile)
  return argv
}

/**
 * The CLI takes the name as one argv entry, so quoting is not a concern - but a
 * control or format character would corrupt the TUI that renders the name in a
 * picker later, and an empty name would silently make the next argv element the
 * value of `-n`.
 *
 * `\p{C}` rather than an explicit `\x00-\x1f` range: it also covers the
 * zero-width and bidi-override characters that a name pasted from a web page
 * carries, which are invisible in an input box and reorder a terminal row.
 */
export function sanitizeSessionName(name: string): string {
  const clean = name.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim()
  if (clean.length === 0) return 'session'
  return clean.length > MAX_NAME ? clean.slice(0, MAX_NAME).trimEnd() : clean
}

/**
 * `base`, or `base 2`, `base 3`... - whichever is free.
 *
 * Three sessions against one repo is the normal case, that being the point of
 * tabs, and `/resume` shows only the name - so uniqueness is what makes the
 * list readable. Compared case-insensitively because these names are read by a
 * person, not matched by a program.
 */
export function uniqueSessionName(base: string, taken: Iterable<string>): string {
  const used = new Set<string>()
  for (const name of taken) used.add(name.toLowerCase())

  const root = sanitizeSessionName(base)
  if (!used.has(root.toLowerCase())) return root

  for (let n = 2; ; n++) {
    const suffix = ` ${n}`
    // Trimmed to leave room for the suffix rather than trimmed after it: a root
    // already at the length cap would otherwise truncate back to itself and
    // this loop would never find a free name.
    const stem =
      root.length + suffix.length > MAX_NAME
        ? root.slice(0, MAX_NAME - suffix.length).trimEnd()
        : root
    const candidate = `${stem}${suffix}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

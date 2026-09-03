import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { applyTemplate, MINIMAL_TEMPLATE, templateIdProblems } from './templates'

/**
 * Making a harness, as opposed to finding one.
 *
 * Helm's minimum harness is a directory with a `harness.yaml` in it. That is
 * the whole definition - the manifest's contents are read when present and
 * decoration when not - which makes scaffolding one cheap enough to offer on
 * first run rather than asking the user to already have a workspace laid out.
 *
 * Two shapes, because there are two ways someone arrives here:
 *
 *   'new'     - a directory that does not exist yet. Gets `harness.yaml`,
 *               `repos/` and `.claude/`, and nothing else - or, given a
 *               `template:`, that template's tree and a manifest.
 *   'convert' - a directory that already holds repositories. Gets a
 *               `harness.yaml` and `repos: .` so the repos already sitting at
 *               its top level stay visible; without that key a harness only
 *               ever lists `repos/*` and converting a folder would hide
 *               everything in it. **Templates do not apply here**: converting
 *               is about a directory somebody already has, and writing a
 *               layout into it would be writing into their work.
 *
 * What is deliberately *not* in the minimal scaffold is a layout. No notes
 * convention, no rules, no starter skills, no CLAUDE.md - those are one
 * person's way of working, and a default that bakes them in is a default with
 * an opinion about someone else's workspace. A fuller layout is a named
 * `template:`, which the user writes and this applies (`templates.ts`).
 */

const HARNESS_MANIFEST = 'harness.yaml'

/** The manifest format this writer produces. Not Helm's version, nor the harness's. */
export const HARNESS_FORMAT_VERSION = '1'

/**
 * Reserved on Windows regardless of extension, and unusable as a directory
 * name even though `mkdir` reports something unhelpful when you try.
 */
const RESERVED_NAMES =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

// Spaces and dashes stay allowed - they are ordinary in a folder name, and
// CLAUDE.md requires paths with spaces to work. These are the ones Windows
// itself refuses.
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*]/

export interface CreateHarnessRequest {
  mode: 'new' | 'convert'
  /**
   * For 'new', the directory the harness is created *inside*. For 'convert',
   * the directory that becomes the harness.
   */
  dir: string
  /** For 'new', the directory name and the manifest's `name`. */
  name?: string | undefined
  /**
   * Recorded in `template:`, and in 'new' mode the tree that gets written.
   * Absent or `minimal` is the built-in scaffold; anything else names a
   * directory in `templatesDir`.
   */
  template?: string | undefined
  /**
   * Where the user's templates live. The host resolves it - see
   * `desktop/src/main/paths.ts` - because core does not know which of the four
   * run modes this is. Absent means only `minimal` can be built.
   */
  templatesDir?: string | undefined
}

export interface CreateHarnessResult {
  /** The harness directory, or null when nothing was written. */
  path: string | null
  /** Paths created, relative to `path`, in the order they were written. */
  created: string[]
  /**
   * What went wrong, as sentences.
   *
   * With `path` null this is why nothing was written. With `path` set it is a
   * **partial** template: the harness is there, `created` is what actually
   * landed in it, and these are the entries that did not. Multi-file writes can
   * fail halfway and this reports that rather than pretending a rollback
   * happened - see `applyTemplate`.
   */
  problems: string[]
  /**
   * The harness that was already there, when that is why nothing was written.
   *
   * Set only by `convert` meeting a directory that already has a manifest, and
   * it exists so the caller can tell that case apart from every other refusal
   * **without matching on the sentence in `problems`**.
   *
   * The distinction matters because the two need opposite handling. "This is
   * not a folder" is a mistake to report. "This is already a harness" is not a
   * failure at all - the thing the user asked for exists - and the useful
   * response is to make sure Helm can *see* it. That is a real gap on a machine
   * with WSL: a harness inside a distribution is never covered by a scan root,
   * because the roots are Windows paths and nothing adds a `\\wsl$\` one. So
   * the user is told their folder is already a harness while the launcher shows
   * no such harness anywhere, which reads as Helm contradicting itself.
   */
  existing: string | null
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Problems with a proposed directory name, as sentences. */
export function harnessNameProblems(name: string): string[] {
  const problems: string[] = []
  const trimmed = name.trim()
  if (trimmed === '') return ['A name is required.']
  if (trimmed === '.' || trimmed === '..') problems.push(`"${trimmed}" is not a folder name.`)
  if (ILLEGAL_NAME_CHARS.test(trimmed)) {
    problems.push('A name cannot contain \\ / : * ? " < > | or a path separator.')
  }
  if (RESERVED_NAMES.test(trimmed)) problems.push(`"${trimmed}" is a reserved device name on Windows.`)
  // Windows silently strips both, so a directory asked for as `dev.` is created
  // as `dev` and every path the caller then builds is wrong.
  if (trimmed.endsWith('.') || trimmed.endsWith(' ')) {
    problems.push('A name cannot end with a space or a dot.')
  }
  return problems
}

/**
 * The manifest, written by hand rather than through a YAML serialiser.
 *
 * Four keys, five when converting, and no comments: "the scaffold contains no
 * opinion" is a claim someone should be able to check by reading the file, and
 * the fewer things in it the shorter that reading is. JSON strings are valid
 * YAML double-quoted scalars, so `JSON.stringify` is the escaping.
 */
function manifestYaml(fields: {
  name: string
  template: string
  version: string
  created: string
  repos?: string | undefined
}): string {
  const lines = [
    `name: ${JSON.stringify(fields.name)}`,
    `template: ${JSON.stringify(fields.template)}`,
    `version: ${JSON.stringify(fields.version)}`,
    `created: ${JSON.stringify(fields.created)}`
  ]
  if (fields.repos !== undefined) lines.push(`repos: ${JSON.stringify(fields.repos)}`)
  return `${lines.join('\n')}\n`
}

/**
 * Whether a directory already holds repositories at its top level.
 *
 * Used only to decide whether a conversion needs `repos: .`: a folder that
 * already has a `repos/` subdirectory means what the default means, and
 * writing the key anyway would point the scanner at the wrong place.
 */
async function hasReposSubdir(dir: string): Promise<boolean> {
  return isDirectory(join(dir, 'repos'))
}

export async function createHarness(
  request: CreateHarnessRequest
): Promise<CreateHarnessResult> {
  const problems: string[] = []
  const dir = resolve(request.dir)

  if (request.mode === 'new') {
    const name = (request.name ?? '').trim()
    const template = (request.template ?? MINIMAL_TEMPLATE).trim() || MINIMAL_TEMPLATE
    problems.push(...harnessNameProblems(name))
    if (!(await isDirectory(dir))) problems.push(`${dir} is not a folder.`)
    if (template !== MINIMAL_TEMPLATE) {
      const idProblems = templateIdProblems(template)
      problems.push(...idProblems)
      if (request.templatesDir === undefined) {
        problems.push('Templates are not available in this run.')
      } else if (
        idProblems.length === 0 &&
        !(await isDirectory(join(request.templatesDir, template)))
      ) {
        // Asked here rather than left to `applyTemplate`, which is called after
        // the directory has been made: a template that is not there must leave
        // no directory behind, and "nothing was written" is only true before
        // the first `mkdir`.
        problems.push(`There is no template called "${template}".`)
      }
    }
    // Every refusal above is about the request, so none of them has written
    // anything: this is the last point at which "nothing happened" is true.
    if (problems.length > 0) return { path: null, created: [], problems, existing: null }

    const target = join(dir, name)
    if (await exists(target)) {
      // Not an overwrite, and not a silent merge either: an existing directory
      // here is either already a harness or someone else's data, and the caller
      // asked to create one rather than to adopt one.
      return {
        path: null,
        created: [],
        problems: [
          (await exists(join(target, HARNESS_MANIFEST)))
            ? `${target} is already a harness.`
            : `${target} already exists.`
        ],
        // Null even when the target *is* a harness, which is the one place this
        // field is deliberately not set. `existing` tells the caller "what you
        // asked for is already there, adopt it"; here the user asked to create a
        // **new** folder of a given name, and a directory of that name existing
        // is a collision rather than the thing they meant. The comment above is
        // the argument, and it did not stop being true when `convert` gained a
        // way to say the opposite.
        existing: null
      }
    }

    const created: string[] = []
    const createdAt = new Date().toISOString()
    await mkdir(target, { recursive: true })

    if (template === MINIMAL_TEMPLATE) {
      await mkdir(join(target, 'repos'), { recursive: true })
      created.push('repos')
      await mkdir(join(target, '.claude'), { recursive: true })
      created.push('.claude')
    } else {
      /*
       * The template's tree first, the manifest last.
       *
       * That order is the guarantee that `template:` is what Helm wrote:
       * a template supplying its own `harness.yaml` is refused by
       * `applyTemplate` rather than allowed to win, and writing ours after
       * means a partial apply still leaves a directory the launcher can see and
       * the user can finish or delete. `repos/` and `.claude/` are not created
       * here - a template is the whole of its own layout, and the two
       * directories the minimal scaffold makes are its opinion, not Helm's.
       */
      const applied = await applyTemplate({
        templatesDir: request.templatesDir as string,
        template,
        target,
        values: { NAME: name, CREATED_AT: createdAt, TEMPLATE: template }
      })
      created.push(...applied.created)
      problems.push(...applied.problems)
    }

    await writeFile(
      join(target, HARNESS_MANIFEST),
      manifestYaml({
        name,
        template,
        version: HARNESS_FORMAT_VERSION,
        created: createdAt
      }),
      'utf8'
    )
    created.push(HARNESS_MANIFEST)
    return { path: target, created, problems, existing: null }
  }

  // convert
  if (!(await isDirectory(dir))) {
    return { path: null, created: [], problems: [`${dir} is not a folder.`], existing: null }
  }
  if (await exists(join(dir, HARNESS_MANIFEST))) {
    return {
      path: null,
      created: [],
      problems: [`${dir} is already a harness.`],
      existing: dir
    }
  }

  const created: string[] = []
  const reposAtTopLevel = !(await hasReposSubdir(dir))
  await writeFile(
    join(dir, HARNESS_MANIFEST),
    manifestYaml({
      name: (request.name ?? '').trim() || basename(dir),
      // Always `minimal`, whatever the caller passed. A conversion writes a
      // manifest and a `.claude/` into a directory somebody already has, and
      // recording a template a converted folder was never built from would be
      // provenance that is simply untrue.
      template: MINIMAL_TEMPLATE,
      version: HARNESS_FORMAT_VERSION,
      created: new Date().toISOString(),
      ...(reposAtTopLevel ? { repos: '.' } : {})
    }),
    'utf8'
  )
  created.push(HARNESS_MANIFEST)

  if (!(await isDirectory(join(dir, '.claude')))) {
    await mkdir(join(dir, '.claude'), { recursive: true })
    created.push('.claude')
  }
  return { path: dir, created, problems: [], existing: null }
}

/**
 * How many directories a conversion would expose, so the UI can say what is
 * about to happen instead of asking the user to trust it. Counted the way the
 * scanner counts, minus the dot directories it skips.
 */
export async function countTopLevelFolders(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).length
  } catch {
    return 0
  }
}

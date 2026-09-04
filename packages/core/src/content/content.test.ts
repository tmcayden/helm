import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseNoteFrontmatter } from './frontmatter'
import { renderMarkdown } from './markdown'
import { readContentDir } from './filetree'
import { contentScope, readContentTree } from './roots'
import { buildCorpus, searchCorpus } from './search'
import { assertContentWritable } from './write'
import { buildWikiIndex, headingSlug, parseWikilink, resolveWikilink } from './wikilinks'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'helm-content-'))
  mkdirSync(join(root, 'notes'), { recursive: true })
  mkdirSync(join(root, '.claude', 'skills', 'think'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'repos', 'other', 'notes'), { recursive: true })

  writeFileSync(
    join(root, 'notes', 'alpha.md'),
    ['---', 'type: journal', 'date: 2026-08-10', 'tags: [helm, notes]', '---', '', '# Alpha', '', 'Links to [[beta]] and [[nowhere]].', ''].join('\n')
  )
  writeFileSync(join(root, 'notes', 'beta.md'), '# Beta\n\nAlpha mentions geofencing here.\n')
  writeFileSync(join(root, '.claude', 'skills', 'think', 'SKILL.md'), '---\nname: think\n---\n\n# think\n')
  writeFileSync(join(root, 'docs', 'SPEC.md'), '# Spec\n')
  writeFileSync(join(root, 'README.md'), '# Readme\n')
  writeFileSync(join(root, 'repos', 'other', 'notes', 'hidden.md'), '# Hidden\n')

  // A directory of nothing but scripts, and a directory of nothing but bytes.
  // The pair is the discovery rule drawn: source counts as content, binary does
  // not, and asserting only the first would pass a rule that offered every
  // directory on the disk.
  mkdirSync(join(root, 'tools'), { recursive: true })
  writeFileSync(join(root, 'tools', 'rebuild.py'), '# rebuild\nprint("ok")\n')
  writeFileSync(join(root, 'tools', 'notes.png'), 'not really a png')
  mkdirSync(join(root, 'screenshots'), { recursive: true })
  writeFileSync(join(root, 'screenshots', 'one.png'), 'not really a png')

  // An empty named root. It has to stay on the list and say it is empty.
  mkdirSync(join(root, 'context'), { recursive: true })
  return root
}

describe('frontmatter', () => {
  it('parses lists and leaves the body behind', () => {
    const parsed = parseNoteFrontmatter('---\ntype: journal\ntags: [a, b]\n---\n\n# Title\n')
    expect(parsed.present).toBe(true)
    expect(parsed.body.trim()).toBe('# Title')
    expect(parsed.fields.find((f) => f.key === 'tags')?.values).toEqual(['a', 'b'])
  })

  it('treats an unclosed fence as a document, not as frontmatter', () => {
    const parsed = parseNoteFrontmatter('---\nnot closed\n\n# Title\n')
    expect(parsed.present).toBe(false)
    expect(parsed.body).toContain('# Title')
  })

  it('reports a broken block rather than letting it render as text', () => {
    const parsed = parseNoteFrontmatter('---\n: : :\n\ta\n---\nbody\n')
    expect(parsed.present).toBe(true)
    expect(parsed.error).not.toBeNull()
    expect(parsed.body.trim()).toBe('body')
  })
})

describe('wikilinks', () => {
  const files = [
    { path: 'C:/v/notes/beta.md', relPath: 'notes/beta.md', slug: 'beta' },
    { path: 'C:/v/docs/beta.md', relPath: 'docs/beta.md', slug: 'beta' },
    { path: 'C:/v/notes/gamma.md', relPath: 'notes/gamma.md', slug: 'gamma' }
  ] as never
  const index = buildWikiIndex(files)

  it('splits heading before alias', () => {
    const link = parseWikilink('note#Section|Read this')
    expect(link.target).toBe('note')
    expect(link.heading).toBe('Section')
    expect(link.label).toBe('Read this')
  })

  it('resolves by bare name', () => {
    expect(resolveWikilink(index, parseWikilink('gamma'))).toBe('C:/v/notes/gamma.md')
  })

  it('prefers a path spelling over a name collision', () => {
    expect(resolveWikilink(index, parseWikilink('docs/beta'))).toBe('C:/v/docs/beta.md')
  })

  it('breaks a link with no note behind it', () => {
    expect(resolveWikilink(index, parseWikilink('nothing-here'))).toBeNull()
  })

  it('slugs headings the same way on both ends', () => {
    expect(headingSlug('The Mechanism: what it does')).toBe('the-mechanism-what-it-does')
  })
})

describe('renderMarkdown', () => {
  it('never emits the frontmatter as text', async () => {
    const out = await renderMarkdown('---\ntype: journal\n---\n\n# Hello\n')
    expect(out.html).not.toContain('type: journal')
    expect(out.html).toContain('<h1')
    expect(out.frontmatter.present).toBe(true)
    expect(out.frontmatter.fields[0]).toEqual({ key: 'type', value: 'journal', values: ['journal'] })
  })

  it('reads a leading --- as a rule, not as metadata, when it is not a note', async () => {
    // A pull request description is not a file in a vault: three dashes at the
    // top of one are a horizontal rule, and reading them as frontmatter eats
    // everything down to the next set.
    const source = '---\nA section somebody wrote.\n---\n\nAnd the rest.\n'

    const asNote = await renderMarkdown(source)
    const asProse = await renderMarkdown(source, { frontmatter: false })

    expect(asNote.frontmatter.present).toBe(true)
    expect(asNote.html).not.toContain('A section somebody wrote.')

    expect(asProse.frontmatter.present).toBe(false)
    expect(asProse.html).toContain('A section somebody wrote.')
    expect(asProse.html).toContain('And the rest.')
    expect(asProse.html).toContain('<hr>')
  })

  it('renders GFM tables and keeps task list state', async () => {
    const out = await renderMarkdown(
      ['| a | b |', '| --- | --- |', '| 1 | 2 |', '', '- [x] done', '- [ ] not done', ''].join('\n')
    )
    expect(out.counts.tables).toBe(1)
    expect(out.counts.taskItems).toBe(2)
    expect(out.counts.taskItemsChecked).toBe(1)
    expect(out.html).toContain('checked')
  })

  it('highlights a fenced block and labels its language', async () => {
    const out = await renderMarkdown('```ts\nconst a: number = 1\n```\n')
    expect(out.counts.codeBlocks).toBe(1)
    expect(out.counts.highlightedBlocks).toBe(1)
    expect(out.html).toContain('data-language="typescript"')
    expect(out.html).toContain('--shiki-dark')
  })

  it('leaves an unknown language as plain text without failing', async () => {
    const out = await renderMarkdown('```notalanguage\nhello\n```\n')
    expect(out.counts.codeBlocks).toBe(1)
    expect(out.counts.highlightedBlocks).toBe(0)
    expect(out.unknownLanguages).toEqual(['notalanguage'])
  })

  it('marks a broken wikilink and resolves a live one', async () => {
    const index = buildWikiIndex([
      { path: 'C:/v/notes/beta.md', relPath: 'notes/beta.md', slug: 'beta' }
    ] as never)
    const out = await renderMarkdown('See [[beta]] and [[missing]].\n', { index })
    expect(out.counts.wikilinks).toBe(2)
    expect(out.counts.brokenWikilinks).toBe(1)
    expect(out.html).toContain('data-wikilink-path="C:/v/notes/beta.md"')
    expect(out.html).toContain('wikilink-broken')
  })

  it('does not treat a bracket inside code as a wikilink', async () => {
    const out = await renderMarkdown('Inline `[[not a link]]` stays.\n')
    expect(out.counts.wikilinks).toBe(0)
    expect(out.html).toContain('[[not a link]]')
  })

  /**
   * `[[…]]` is not markdown, so remark parses what is inside it and the
   * brackets land in different nodes. Every one of these rendered as literal
   * text and counted as no link at all; the vault had one, and `CONT-4`'s two
   * parsers disagreeing by exactly one is what found it.
   */
  it('finds a wikilink whose alias remark split into its own node', async () => {
    const index = buildWikiIndex([
      { path: 'C:/v/notes/beta.md', relPath: 'notes/beta.md', slug: 'beta' }
    ] as never)
    for (const alias of ['`code`', '**bold**', '_thin_']) {
      const out = await renderMarkdown(`See [[beta|${alias}]] now.\n`, { index })
      expect(out.counts.wikilinks, alias).toBe(1)
      expect(out.counts.brokenWikilinks, alias).toBe(0)
      expect(out.html, alias).toContain('data-wikilink-path="C:/v/notes/beta.md"')
      expect(out.html, alias).not.toContain('[[')
    }
  })

  /**
   * The text after a spanned link's `]]` has to be scanned again rather than
   * pushed out as prose. The first cut of the fix did push it, which traded the
   * link it had just recovered for the next one along and left the total
   * unchanged - a fix that measures as a no-op rather than as a regression.
   */
  it('still finds an ordinary wikilink following a spanned one', async () => {
    const index = buildWikiIndex([
      { path: 'C:/v/notes/beta.md', relPath: 'notes/beta.md', slug: 'beta' },
      { path: 'C:/v/notes/gamma.md', relPath: 'notes/gamma.md', slug: 'gamma' }
    ] as never)
    const out = await renderMarkdown('Off [[beta|`alias`]], then see [[gamma]] after.\n', { index })
    expect(out.counts.wikilinks).toBe(2)
    expect(out.counts.brokenWikilinks).toBe(0)
    expect(out.links.map((link) => link.target)).toEqual(['beta', 'gamma'])
    expect(out.html).toContain('data-wikilink-path="C:/v/notes/gamma.md"')
  })

  /** A label is text: the alias's own markup is flattened away, not nested. */
  it('labels a spanned link with its alias text and no markup', async () => {
    const index = buildWikiIndex([
      { path: 'C:/v/notes/beta.md', relPath: 'notes/beta.md', slug: 'beta' }
    ] as never)
    const out = await renderMarkdown('See [[beta|`project-pane-hub`]].\n', { index })
    expect(out.links[0]?.label).toBe('project-pane-hub')
    expect(out.html).toContain('>project-pane-hub</a>')
    expect(out.html).not.toContain('<code>')
  })

  it('leaves an unclosed or block-spanning bracket pair as the text it is', async () => {
    for (const source of [
      'A stray [[open `bracket` with no closer.\n',
      'A pair [[across `code`\n\nand a paragraph]] break.\n'
    ]) {
      const out = await renderMarkdown(source)
      expect(out.counts.wikilinks, source).toBe(0)
      expect(out.html, source).toContain('[[')
    }
  })

  it('renders a callout as an admonition, not a quotation', async () => {
    const out = await renderMarkdown('> [!warning] Supersedes the SDK draft\n> The body.\n')
    expect(out.counts.callouts).toBe(1)
    expect(out.html).toContain('data-callout="warning"')
    expect(out.html).toContain('Supersedes the SDK draft')
    expect(out.html).not.toContain('[!warning]')
  })

  it('shows tags and ignores hashes that are not tags', async () => {
    const out = await renderMarkdown('A #helm tag, see https://x.test/#frag and issue #12.\n')
    expect(out.tags).toEqual(['helm'])
  })

  it('strips a script a note contains', async () => {
    const out = await renderMarkdown('Hello\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n')
    expect(out.html).not.toContain('<script')
    expect(out.html).not.toContain('onerror')
  })

  it('gives every heading an anchor a wikilink can aim at', async () => {
    const out = await renderMarkdown('# One\n\n## Two Words\n')
    expect(out.headings.map((h) => h.slug)).toEqual(['one', 'two-words'])
    expect(out.html).toContain('data-heading="two-words"')
  })
})

describe('readContentTree', () => {
  it('finds the named roots, the scope root, and nothing inside repos/', () => {
    const root = fixture()
    try {
      const tree = readContentTree(contentScope(root, 'harness', 'fixture'))
      const roots = tree.roots.map((r) => r.relPath).sort()
      expect(roots).toContain('notes')
      expect(roots).toContain('docs')
      expect(roots).toContain('.claude/skills')
      expect(roots).toContain('')
      expect(tree.files.some((f) => f.relPath.startsWith('repos/'))).toBe(false)
      const alpha = tree.files.find((f) => f.slug === 'alpha')
      expect(alpha?.noteType).toBe('journal')
      expect(alpha?.tags).toEqual(['helm', 'notes'])
      expect(alpha?.title).toBe('Alpha')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('offers a directory of nothing but scripts, and not one of nothing but bytes', () => {
    const root = fixture()
    try {
      const tree = readContentTree(contentScope(root, 'harness', 'fixture'))
      const rels = tree.roots.map((r) => r.relPath)
      expect(rels).toContain('tools')
      expect(rels).not.toContain('screenshots')
      // Both sides of the pair have to be real for the assertion to mean
      // anything: `screenshots/` must exist and have been walked.
      expect(tree.files.some((f) => f.relPath === 'screenshots/one.png')).toBe(false)
      expect(tree.roots.find((r) => r.relPath === 'tools')?.offer).toBe('discovered')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists every file inside a root it offers, binary included', () => {
    const root = fixture()
    try {
      const tree = readContentTree(contentScope(root, 'harness', 'fixture'))
      const inTools = tree.files.filter((f) => f.root === 'tools').map((f) => f.relPath)
      expect(inTools).toContain('tools/rebuild.py')
      expect(inTools).toContain('tools/notes.png')
      expect(tree.files.find((f) => f.relPath === 'tools/rebuild.py')?.kind).toBe('source')
      expect(tree.files.find((f) => f.relPath === 'tools/notes.png')?.kind).toBe('binary')
      expect(tree.files.find((f) => f.relPath === 'tools/rebuild.py')?.ext).toBe('py')
      // A file that is not prose keeps its whole name: "rebuild" is a viewer
      // editing the name of a file somebody is looking for by its full one.
      expect(tree.files.find((f) => f.relPath === 'tools/rebuild.py')?.title).toBe('rebuild.py')
      expect(tree.files.find((f) => f.relPath === 'tools/notes.png')?.title).toBe('notes.png')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('gives a dotfile a name rather than an empty one', () => {
    const root = fixture()
    try {
      writeFileSync(join(root, 'tools', '.gitignore'), 'out/\n')
      const tree = readContentTree(contentScope(root, 'harness', 'fixture'))
      const dotfile = tree.files.find((f) => f.relPath === 'tools/.gitignore')
      expect(dotfile).toBeDefined()
      expect(dotfile?.title).toBe('.gitignore')
      expect(dotfile?.slug).toBe('.gitignore')
      expect(dotfile?.kind).toBe('source')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an empty named root on the list, badged named', () => {
    const root = fixture()
    try {
      const tree = readContentTree(contentScope(root, 'harness', 'fixture'))
      const context = tree.roots.find((r) => r.relPath === 'context')
      expect(context).toBeDefined()
      expect(context?.files).toBe(0)
      expect(context?.offer).toBe('named')
      // Discriminating: the fixture's `context/` really is empty, so a rule
      // that dropped empty roots would have failed the line above.
      expect(tree.files.some((f) => f.root === 'context')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('readContentDir', () => {
  it('lists every entry, marks ignored ones rather than dropping them', async () => {
    const root = fixture()
    try {
      mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
      const listing = await readContentDir(contentScope(root, 'project'), '', {
        ignoreSource: 'default'
      })
      const names = listing.entries.map((e) => e.name)
      expect(names).toContain('node_modules')
      expect(names).toContain('README.md')
      // `repos/` is descended by the tree even though the curated view drops it.
      expect(names).toContain('repos')
      expect(listing.entries.find((e) => e.name === 'repos')?.ignored).toBe(false)
      expect(listing.entries.find((e) => e.name === 'node_modules')?.ignored).toBe(true)
      expect(listing.ignored).toBeGreaterThan(0)
      expect(listing.ignoreSource).toBe('default')
      // Directories first, then names.
      const firstFile = listing.entries.findIndex((e) => !e.directory)
      const lastDir = listing.entries.map((e) => e.directory).lastIndexOf(true)
      expect(lastDir).toBeLessThan(firstFile)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not walk eagerly - one directory per call', async () => {
    const root = fixture()
    try {
      const top = await readContentDir(contentScope(root, 'project'), '', {
        ignoreSource: 'default'
      })
      expect(top.entries.every((e) => !e.relPath.includes('/'))).toBe(true)
      const notes = await readContentDir(contentScope(root, 'project'), 'notes', {
        ignoreSource: 'default'
      })
      expect(notes.entries.map((e) => e.name).sort()).toEqual(['alpha.md', 'beta.md'])
      expect(notes.entries[0]?.relPath).toBe('notes/alpha.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The gitignore half, against a real repository.
   *
   * A fixture with `git init` and a `.gitignore`, because the claim is that the
   * *repository* decides - and the only way to be wrong about that quietly is
   * to assert it against a list written in this file. The fallback list is
   * asserted to disagree first: `secrets/` is in no built-in list, so a green
   * result here cannot be the fallback passing under another name.
   */
  it('takes its ignores from the repository when there is one', async () => {
    const root = fixture()
    try {
      const git = spawnSync('git', ['init', '-q'], { cwd: root, windowsHide: true })
      if (git.error) return // No git on this machine; the fallback path is covered above.
      writeFileSync(join(root, '.gitignore'), 'secrets/\n*.tmp\n')
      mkdirSync(join(root, 'secrets'), { recursive: true })
      writeFileSync(join(root, 'secrets', 'a.txt'), 'x')
      writeFileSync(join(root, 'scratch.tmp'), 'x')

      const fallback = await readContentDir(contentScope(root, 'project'), '', {
        ignoreSource: 'default'
      })
      expect(fallback.entries.find((e) => e.name === 'secrets')?.ignored).toBe(false)
      expect(fallback.entries.find((e) => e.name === 'scratch.tmp')?.ignored).toBe(false)

      const listing = await readContentDir(contentScope(root, 'project'), '')
      expect(listing.ignoreSource).toBe('gitignore')
      expect(listing.entries.find((e) => e.name === 'secrets')?.ignored).toBe(true)
      expect(listing.entries.find((e) => e.name === 'secrets')?.ignoredBy).toBe('gitignore')
      expect(listing.entries.find((e) => e.name === 'scratch.tmp')?.ignored).toBe(true)
      expect(listing.entries.find((e) => e.name === 'notes')?.ignored).toBe(false)
      // `.git` is never listed as readable content whatever git says about it.
      expect(listing.entries.find((e) => e.name === '.git')?.ignored).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * The junction rule, which is the same one the config tree and the curated
   * walk follow: an overlay shim's subdirectories are junctions into real
   * repositories, so a tree that walked one would list another project's files
   * as this scope's - and one pointing at an ancestor would not finish.
   *
   * Windows-first, so this plants a real junction with `mklink /J`. The row is
   * still *listed* - that is the point of the whole surface - and marked as a
   * link; what is refused is reading through it.
   */
  it('lists a junction and refuses to read through it', async () => {
    const root = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'helm-content-outside-'))
    try {
      writeFileSync(join(outside, 'somebody-elses-note.md'), '# Not this scope\n')
      const link = join(root, 'linked')
      const made = spawnSync('cmd', ['/c', 'mklink', '/J', link, outside], { windowsHide: true })
      if (made.status !== 0) return // Not Windows, or no permission to make one.

      const top = await readContentDir(contentScope(root, 'project'), '', {
        ignoreSource: 'default'
      })
      const row = top.entries.find((entry) => entry.name === 'linked')
      expect(row).toBeDefined()
      expect(row?.link).toBe(true)

      // The fixture has to be discriminating: the junction really does lead to
      // a file, so a refusal is a refusal rather than an empty directory.
      const behind = await readContentDir(contentScope(outside, 'project'), '', {
        ignoreSource: 'default'
      })
      expect(behind.entries.map((entry) => entry.name)).toContain('somebody-elses-note.md')

      const through = await readContentDir(contentScope(root, 'project'), 'linked', {
        ignoreSource: 'default'
      })
      expect(through.error).toMatch(/link out of this scope/)
      expect(through.entries).toEqual([])
    } finally {
      // `rm` the junction rather than walking it - the rule CLAUDE.md states
      // about anything that removes a shim applies to a test that plants one.
      rmSync(join(root, 'linked'), { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a path that escapes the scope', async () => {
    const root = fixture()
    try {
      const listing = await readContentDir(contentScope(root, 'project'), '../..')
      expect(listing.error).toMatch(/outside this scope/)
      expect(listing.entries).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('search', () => {
  it('matches inside a word and reports the line', () => {
    const root = fixture()
    try {
      const tree = readContentTree(contentScope(root))
      const corpus = buildCorpus(root, tree.files)
      const result = searchCorpus(corpus, 'geofenc', true)
      expect(result.totalMatches).toBe(1)
      expect(result.hits[0]?.lines[0]?.text).toContain('geofencing')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('finds a non-markdown file by name without reading its contents', () => {
    const root = fixture()
    try {
      mkdirSync(join(root, 'notes'), { recursive: true })
      writeFileSync(join(root, 'notes', 'dashboard.html'), '<style>notes { color: red }</style>')

      const tree = readContentTree(contentScope(root))
      const corpus = buildCorpus(root, tree.files)

      // Found by what it is called...
      const byName = searchCorpus(corpus, 'dashboard', true)
      expect(byName.hits.map((hit) => hit.relPath)).toContain('notes/dashboard.html')
      expect(byName.hits.find((hit) => hit.relPath.endsWith('.html'))?.nameMatch).toBe(true)

      // ...and never by what is inside it. `notes` appears in that stylesheet
      // and must not put the file in the results on those grounds.
      const byBody = searchCorpus(corpus, 'color: red', true)
      expect(byBody.hits.map((hit) => hit.relPath)).not.toContain('notes/dashboard.html')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('assertContentWritable', () => {
  // Pure path arithmetic over the host's own `path`, so the scope is spelled the
  // way this host spells an absolute path.
  const V = process.platform === 'win32' ? 'C:/v' : '/v'
  const OTHER = process.platform === 'win32' ? 'C:/other' : '/other'

  it('refuses a path outside the scope', () => {
    expect(() => assertContentWritable(`${V}`, `${OTHER}/notes/a.md`)).toThrow(/not inside/)
  })

  it('refuses a nested repository', () => {
    expect(() => assertContentWritable(`${V}`, `${V}/repos/x/notes/a.md`)).toThrow(/not content/)
  })

  it('refuses a file it cannot read as content', () => {
    expect(() => assertContentWritable(`${V}`, `${V}/notes/a.exe`)).toThrow(/binary/)
  })

  it('allows a script, which is a file the agent wrote', () => {
    expect(() => assertContentWritable(`${V}`, `${V}/tools/rebuild.py`)).not.toThrow()
  })

  it('allows an extensionless file, which is text until the bytes say otherwise', () => {
    expect(() => assertContentWritable(`${V}`, `${V}/LICENSE`)).not.toThrow()
  })

  it('allows a note and a skill', () => {
    expect(() => assertContentWritable(`${V}`, `${V}/notes/a.md`)).not.toThrow()
    expect(() => assertContentWritable(`${V}`, `${V}/.claude/skills/x/SKILL.md`)).not.toThrow()
  })
})

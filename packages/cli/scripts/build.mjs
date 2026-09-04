import { build, context } from 'esbuild'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * One bundle with core compiled in, the way the desktop build compiles core
 * (TERMINAL.md 10). `splitting` keeps the commands lazy: `--version` and the
 * pickers never load the store or core's content graph (shiki, remark), which
 * is where core's ~760ms import cost lives.
 */
const options = {
  entryPoints: [join(root, 'src/main.ts')],
  outdir: join(root, 'dist'),
  entryNames: 'helm',
  chunkNames: 'chunks/[name]-[hash]',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['better-sqlite3'],
  // A CJS dependency in the graph calls `require`, which an ESM bundle has no
  // global for; `createRequire` gives it one rooted at the bundle.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);'
    ].join('\n')
  },
  define: { __HELM_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info'
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await build(options)
}

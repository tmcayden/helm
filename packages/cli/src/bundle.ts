import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * The built `dist/helm.mjs` this process is running, through any symlink. The
 * entry file rather than `import.meta.url`, because the bundle is split into
 * chunks and a command's own module is under `dist/chunks/`.
 */
export function bundleFile(): string {
  return realpathSync(process.argv[1] as string)
}

/** `packages/nvim`, beside `packages/cli`, for the lazy.nvim spec. */
export function nvimPluginDir(bundle: string = bundleFile()): string {
  return resolve(dirname(bundle), '..', '..', 'nvim')
}

export function nvimSpec(dir: string): string {
  return `{ dir = "${dir}", name = "helm.nvim" }`
}

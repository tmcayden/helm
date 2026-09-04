import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where the terminal edition keeps things (TERMINAL.md 10): XDG data for what
 * Helm writes for itself, XDG config for what a person edits. `HELM_DATA_DIR`
 * and `HELM_CONFIG_DIR` are the isolation a check or a test needs - the CLI
 * analogue of `PORTABLE_EXECUTABLE_DIR`.
 */
function fromEnv(name: string): string | null {
  const value = process.env[name]
  return value !== undefined && value.trim() !== '' ? value : null
}

export function dataDir(): string {
  return (
    fromEnv('HELM_DATA_DIR') ??
    join(fromEnv('XDG_DATA_HOME') ?? join(homedir(), '.local', 'share'), 'helm')
  )
}

export function configDir(): string {
  return fromEnv('HELM_CONFIG_DIR') ?? join(fromEnv('XDG_CONFIG_HOME') ?? join(homedir(), '.config'), 'helm')
}

export const dbFile = (): string => join(dataDir(), 'helm.db')
export const shimRoot = (): string => join(dataDir(), 'overlays')
export const harnessIndexFile = (): string => join(dataDir(), 'harnesses.json')
export const templatesDir = (): string => join(configDir(), 'templates')
export const tmuxSnippet = (): string => join(configDir(), 'helm.tmux')
export const zshSnippet = (): string => join(configDir(), 'helm.zsh')

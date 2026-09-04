import type {
  ConfigFile,
  ConfigLive,
  ConfigScope,
  ConfigSnapshotMeta,
  ConfigWriteReason,
  EffectiveView
} from '@helm/core/types'

/**
 * The `--json` shapes helm.nvim paints from (TERMINAL.md 6). The plugin reads
 * these and nothing else, so a field here is a contract: core's own types are
 * carried through unchanged and only the CLI's additions are spelled out.
 */

/** `helm config tree <scope> --json`. `files` is core's `ConfigTree.files`, each with its live state joined on. */
export interface ConfigTreeJson {
  scope: ConfigScope
  /** The profile whose effective view decided `live`, or null when no single profile encloses the scope. */
  profile: string | null
  files: Array<ConfigFile & { live: ConfigLive | null }>
  errors: string[]
  scannedAt: string
}

/** `helm config doctor --json`: the whole `EffectiveView`, plus how the profile was chosen and what a launch would run. */
export interface ConfigDoctorJson {
  profile: { name: string; harness: string; file: string; root: string; resolvedBy: 'flag' | 'tmux' | 'harness' }
  view: EffectiveView
  /** Argv after `claude`, planned without touching the shim directory. */
  argv: string[]
  /**
   * True when a real launch also passes `--append-system-prompt-file` with the
   * overlays' composed CLAUDE.md. That file is written by the launch itself,
   * so its path is not predicted here.
   */
  composesMemory: boolean
}

/** `helm config snapshot <file> --json`: the row taken before the editor writes. */
export interface ConfigSnapshotJson {
  ok: true
  id: number
  path: string
  scopePath: string
  /** The history key: relative to `scopePath`, forward-slashed. */
  filePath: string
  reason: ConfigWriteReason
  bytes: number
}

/** `helm config snapshot --list <file> --json`. */
export interface ConfigSnapshotListJson {
  path: string
  scopePath: string
  filePath: string
  snapshots: ConfigSnapshotMeta[]
}

// ---------------------------------------------------------------------------
// profile check, doctor, install
// ---------------------------------------------------------------------------

export type ProblemLevel = 'error' | 'warning'

export interface ProfileProblem {
  level: ProblemLevel
  message: string
  /** The document key the problem is about, when it is about one. */
  field?: string
  /** 1-based line of that key in the file, when the parser could place it. */
  line?: number
}

/** `helm profile check <file> --json`; what helm.nvim runs on save. */
export interface ProfileCheckReport {
  file: string
  /** False when any problem is an error. Warnings alone leave it true. */
  ok: boolean
  problems: ProfileProblem[]
}

/** One row of `helm doctor --json`. */
export interface DoctorRow {
  name: string
  /** True is healthy, false is a finding, null is "could not look". Never merged. */
  ok: boolean | null
  detail: string
}

export interface DoctorReport {
  ok: boolean
  rows: DoctorRow[]
}

/** `helm install --json`. */
export interface InstallReport {
  written: string[]
  skipped: string[]
  backups: string[]
  templates: { seeded: boolean; dir: string }
  symlink: string | null
  /** The lazy.nvim spec, printed and never written. */
  nvimSpec: string
  problems: string[]
}

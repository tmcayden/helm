import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function insideGitRepo(dir) {
  for (let at = dir, previous = null; at !== previous; previous = at, at = join(at, '..')) {
    if (existsSync(join(at, '.git'))) return true
  }
  return false
}

// Repos sit either directly under the parent or one level down in repos/,
// so the scan goes two deep and stops at the first one it finds.
function hasChildRepo(dir) {
  let children
  try {
    children = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return false
  }
  for (const child of children) {
    const path = join(dir, child.name)
    if (existsSync(join(path, '.git'))) return true
    let grandchildren
    try {
      grandchildren = readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    if (grandchildren.some((entry) => existsSync(join(path, entry.name, '.git')))) return true
  }
  return false
}

export const RULES = {
  'parent-of-repos': {
    describe: 'a directory holding repositories, itself outside any git tree',
    test: (dir) => (insideGitRepo(dir) ? 'it is inside a git repository' : hasChildRepo(dir) ? null : 'it holds no repositories')
  },
  'inside-git-repo': {
    describe: 'a directory inside a git repository',
    test: (dir) => (insideGitRepo(dir) ? null : 'it is not inside a git repository')
  }
}

/** Null when the directory is allowed, else why it is not. */
export function locationProblem(location, dir) {
  if (location.kind === 'anywhere') return null
  if (location.kind === 'pinned') return location.path === dir ? null : `it is pinned to ${location.path}`
  return RULES[location.rule].test(dir)
}

import { describe, expect, it } from 'vitest'
import { repoCommand } from './git'

/**
 * How a repository-local tool is reached, which is one decision shared by two
 * surfaces because they disagreed when it was two.
 *
 * The launcher's git state already routed into a distribution; the pull-request
 * sweep did not, so a distro-resident repository showed a branch and a dirty
 * count while the PR pane reported it as having nothing to fetch. Measured
 * 2026-09-03: from Windows with a `\\wsl$\...` working directory, `git remote
 * get-url origin` exits 128 with `safe.directory 'undefined' not absolute`, and
 * `gh repo view` fails the same way one level up. `readOrigin` returned null,
 * which is the same answer it gives for a folder that is not a repository at
 * all - so the surface could not even say what was wrong.
 *
 * Its own file rather than appended to `git.test.ts`, which is about the
 * `--porcelain=v2` parse: this is about the spawn, and the two share nothing.
 */
describe('repoCommand', () => {
  const UBUNTU_WORK = '\\\\wsl$\\Ubuntu\\home\\me\\work'

  it('runs the program directly for a path on this machine', () => {
    expect(repoCommand('C:\\repos\\helm', 'git')).toEqual({
      file: 'git',
      prefix: [],
      cwd: 'C:\\repos\\helm'
    })
  })

  it('routes into the distribution a path lives inside, and sets no cwd', () => {
    // The absent cwd is the load-bearing half. `CreateProcess` cannot take a
    // UNC working directory, and `execFile` does not fail honestly there - it
    // spawns with the directory silently defaulted (measured: `cmd.exe` says
    // "UNC paths are not supported. Defaulting to Windows directory."), so a
    // command would run somewhere nobody chose.
    expect(repoCommand(UBUNTU_WORK, 'git')).toEqual({
      file: 'wsl.exe',
      prefix: ['-d', 'Ubuntu', '--cd', '/home/me/work', '--', 'git']
    })
  })

  it('carries whichever program was asked for', () => {
    // `gh pr checkout` is the one gh call that is about a directory rather than
    // about a `--repo` slug, so it needs exactly the routing git needs.
    expect(repoCommand(UBUNTU_WORK, 'gh').prefix).toEqual([
      '-d',
      'Ubuntu',
      '--cd',
      '/home/me/work',
      '--',
      'gh'
    ])
  })

  it('reads the wsl.localhost spelling too', () => {
    expect(repoCommand('\\\\wsl.localhost\\Debian\\srv\\app', 'git')).toEqual({
      file: 'wsl.exe',
      prefix: ['-d', 'Debian', '--cd', '/srv/app', '--', 'git']
    })
  })

  it('gives the distro its own spelling of a path under the automount root', () => {
    // `\\wsl$\Ubuntu\mnt\c\work` is this machine's `C:\work` seen from inside
    // the distro, and `--cd` has to carry what the distro calls it.
    expect(repoCommand('\\\\wsl$\\Ubuntu\\mnt\\c\\work', 'git').prefix).toContain('/mnt/c/work')
  })

  it('falls back to the plain program for a UNC share that is not a distro', () => {
    // Better the honest failure of the Windows tool than a `--cd` naming a
    // directory no distribution has.
    expect(repoCommand('\\\\fileserver\\share\\repo', 'git')).toEqual({
      file: 'git',
      prefix: [],
      cwd: '\\\\fileserver\\share\\repo'
    })
  })
})

import { describe, expect, it } from 'vitest'
import { isLinuxPath, toWindowsPath, toWslPath, wslDistroOf } from './path'

const ubuntu = { distro: 'Ubuntu' }

describe('toWslPath', () => {
  it('translates a drive path to the automount root', () => {
    expect(toWslPath('C:\\.harness\\gse\\repos\\helm', ubuntu)).toBe(
      '/mnt/c/.harness/gse/repos/helm'
    )
  })

  it('lowercases the drive letter, because /mnt does', () => {
    expect(toWslPath('D:\\Work', ubuntu)).toBe('/mnt/d/Work')
  })

  it('accepts a drive path already written with forward slashes', () => {
    // The CLI writes `history.jsonl` entries both ways; see `projectEntry`.
    expect(toWslPath('C:/work/repo', ubuntu)).toBe('/mnt/c/work/repo')
  })

  it('translates a bare drive root', () => {
    expect(toWslPath('C:\\', ubuntu)).toBe('/mnt/c')
  })

  it('honours a moved automount root', () => {
    expect(toWslPath('C:\\work', { distro: 'Ubuntu', automountRoot: '/windows' })).toBe(
      '/windows/c/work'
    )
  })

  it('leaves a path the distro already spells alone', () => {
    // A profile rooted at a distro-resident directory carries this verbatim,
    // and translating it a second time would produce /mnt nonsense.
    expect(toWslPath('/home/me/work', ubuntu)).toBe('/home/me/work')
  })

  it('unwraps a UNC path into the distro it names', () => {
    expect(toWslPath('\\\\wsl$\\Ubuntu\\home\\me\\.claude', ubuntu)).toBe('/home/me/.claude')
  })

  it('accepts the wsl.localhost spelling', () => {
    expect(toWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me', ubuntu)).toBe('/home/me')
  })

  it('matches the distro name case-insensitively', () => {
    expect(toWslPath('\\\\wsl$\\ubuntu\\home\\me', ubuntu)).toBe('/home/me')
  })

  it('refuses a UNC path into a different distro', () => {
    // `/home/me` in Debian is not `/home/me` in Ubuntu, and a session in one
    // pointed at the other would silently open the wrong directory.
    expect(toWslPath('\\\\wsl$\\Debian\\home\\me', ubuntu)).toBeNull()
  })

  it('refuses a relative path rather than guessing a working directory', () => {
    expect(toWslPath('repos\\helm', ubuntu)).toBeNull()
  })
})

describe('toWindowsPath', () => {
  it('translates an automounted path back to its drive', () => {
    expect(toWindowsPath('/mnt/c/work/repo', ubuntu)).toBe('C:\\work\\repo')
  })

  it('translates a bare mounted drive', () => {
    expect(toWindowsPath('/mnt/c', ubuntu)).toBe('C:\\')
  })

  it('reaches a distro-resident path over UNC', () => {
    expect(toWindowsPath('/home/me/.claude', ubuntu)).toBe('\\\\wsl$\\Ubuntu\\home\\me\\.claude')
  })

  it('reaches the distro root', () => {
    expect(toWindowsPath('/', ubuntu)).toBe('\\\\wsl$\\Ubuntu')
  })

  it('honours a moved automount root', () => {
    // Without this the path is not a drive at all and belongs on the UNC route.
    expect(toWindowsPath('/mnt/c/work', { distro: 'Ubuntu', automountRoot: '/windows' })).toBe(
      '\\\\wsl$\\Ubuntu\\mnt\\c\\work'
    )
  })

  it('refuses a path that is not the distro\u2019s to spell', () => {
    expect(toWindowsPath('C:\\work', ubuntu)).toBeNull()
  })
})

describe('round trips', () => {
  it('returns a drive path unchanged', () => {
    const windows = 'C:\\.harness\\gse\\repos\\helm'
    const linux = toWslPath(windows, ubuntu)
    expect(linux).not.toBeNull()
    expect(toWindowsPath(linux as string, ubuntu)).toBe(windows)
  })

  it('returns a distro path unchanged', () => {
    const linux = '/home/me/work'
    const windows = toWindowsPath(linux, ubuntu)
    expect(windows).not.toBeNull()
    expect(toWslPath(windows as string, ubuntu)).toBe(linux)
  })
})

describe('isLinuxPath', () => {
  it('splits the two spellings', () => {
    expect(isLinuxPath('/home/me')).toBe(true)
    expect(isLinuxPath('C:\\work')).toBe(false)
    expect(isLinuxPath('\\\\wsl$\\Ubuntu\\home')).toBe(false)
  })
})

describe('wslDistroOf', () => {
  it('names the distro a UNC path lives in', () => {
    expect(wslDistroOf('\\\\wsl$\\Ubuntu\\home\\me\\harness')).toBe('Ubuntu')
    expect(wslDistroOf('\\\\wsl.localhost\\Debian\\srv')).toBe('Debian')
  })

  it('is null for a path on this machine', () => {
    // A drive path is this machine's, and a bare `/home/me` is ambiguous -
    // every distro has one - so neither may name a distro.
    expect(wslDistroOf('C:\\work\\repo')).toBeNull()
    expect(wslDistroOf('/home/me/work')).toBeNull()
  })
})

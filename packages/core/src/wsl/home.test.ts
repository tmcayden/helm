import { describe, expect, it } from 'vitest'
import type { WslHome } from '../types'
import { claudeHomeFor, resolveRecordedPath, wslClaudeHome, wslHomeOf } from './home'

const UBUNTU: WslHome = {
  distro: 'Ubuntu',
  home: '/home/caydenh',
  claudeHome: '\\\\wsl$\\Ubuntu\\home\\caydenh\\.claude'
}
const DEBIAN: WslHome = {
  distro: 'Debian',
  home: '/root',
  claudeHome: '\\\\wsl$\\Debian\\root\\.claude'
}

describe('wslClaudeHome', () => {
  it('spells a distro home as a path this process can open', () => {
    expect(wslClaudeHome('Ubuntu', '/home/caydenh')).toBe(
      '\\\\wsl$\\Ubuntu\\home\\caydenh\\.claude'
    )
  })

  it('handles root, whose home is one segment', () => {
    expect(wslClaudeHome('Debian', '/root')).toBe('\\\\wsl$\\Debian\\root\\.claude')
  })

  it('tolerates the trailing whitespace a shell echo leaves', () => {
    expect(wslClaudeHome('Ubuntu', '  /home/me\n')).toBe('\\\\wsl$\\Ubuntu\\home\\me\\.claude')
  })

  it('refuses a home that is not an absolute Linux path', () => {
    // A probe that half-answered. Better no scope than one browsing `C:\.claude`.
    expect(wslClaudeHome('Ubuntu', 'home/me')).toBeNull()
    expect(wslClaudeHome('Ubuntu', 'C:\\Users\\me')).toBeNull()
    expect(wslClaudeHome('Ubuntu', '')).toBeNull()
  })

  it('refuses an empty distro name', () => {
    expect(wslClaudeHome('   ', '/home/me')).toBeNull()
  })

  it('does not translate a home under the automount root back to a drive', () => {
    // `$HOME=/mnt/c/Users/me` is a real, if odd, configuration - and it means
    // the distro's `~/.claude` genuinely *is* the Windows one. Saying so is
    // correct; inventing a `\\wsl$\` path for it would not be.
    expect(wslClaudeHome('Ubuntu', '/mnt/c/Users/me')).toBe('C:\\Users\\me\\.claude')
  })
})

describe('wslHomeOf', () => {
  it('pairs both spellings', () => {
    expect(wslHomeOf('Ubuntu', '/home/caydenh')).toEqual(UBUNTU)
  })

  it('is null for a probe that found no home', () => {
    expect(wslHomeOf('Ubuntu', null)).toBeNull()
  })
})

describe('resolveRecordedPath', () => {
  const homes = [UBUNTU, DEBIAN]
  const on = (...paths: string[]) => {
    const set = new Set(paths.map((p) => p.toLowerCase()))
    return (path: string) => set.has(path.toLowerCase())
  }

  it('leaves a path this machine can already open alone', () => {
    // Including the `\\wsl$\` spelling, which is already openable.
    const never = () => false
    expect(resolveRecordedPath('C:\\repos\\helm', homes, never)).toBe('C:\\repos\\helm')
    expect(resolveRecordedPath('\\\\wsl$\\Ubuntu\\home\\me', homes, never)).toBe(
      '\\\\wsl$\\Ubuntu\\home\\me'
    )
  })

  it('spells a distro-recorded directory so this process can stat it', () => {
    // The case that had 214 conversations reading as unresumable: the CLI
    // recorded the directory as it saw it, and Windows resolves a leading
    // slash against the current drive root.
    expect(
      resolveRecordedPath(
        '/home/caydenh/harness',
        homes,
        on('\\\\wsl$\\Ubuntu\\home\\caydenh\\harness')
      )
    ).toBe('\\\\wsl$\\Ubuntu\\home\\caydenh\\harness')
  })

  it('tries every distro, because a Linux path names none of them', () => {
    expect(resolveRecordedPath('/srv/app', homes, on('\\\\wsl$\\Debian\\srv\\app'))).toBe(
      '\\\\wsl$\\Debian\\srv\\app'
    )
  })

  it('is null when no distro has it, so the session reads as unresumable', () => {
    expect(resolveRecordedPath('/home/gone/project', homes, () => false)).toBeNull()
  })

  it('is null with no distros at all rather than falling back to the raw path', () => {
    // Returning `/home/me/x` would hand `statSync` a path Windows resolves to
    // `C:\home\me\x`, which is how this was wrong before.
    expect(resolveRecordedPath('/home/me/x', [], () => true)).toBeNull()
  })

  it('translates a distro path back to the drive it is mounted from', () => {
    // A session run inside a distro against `/mnt/c/work` recorded that, and
    // the directory it names is an ordinary Windows one.
    expect(resolveRecordedPath('/mnt/c/work', homes, on('C:\\work'))).toBe('C:\\work')
  })
})

describe('claudeHomeFor', () => {
  const homes = [UBUNTU, DEBIAN]

  it('is null for a path on this machine, so the Windows home stays the default', () => {
    expect(claudeHomeFor('C:\\work\\helm', homes)).toBeNull()
    expect(claudeHomeFor('D:\\repos', homes)).toBeNull()
  })

  it('finds the distro a path lives inside', () => {
    expect(claudeHomeFor('\\\\wsl$\\Ubuntu\\home\\caydenh\\harness', homes)).toEqual(UBUNTU)
    expect(claudeHomeFor('\\\\wsl$\\Debian\\srv\\app', homes)).toEqual(DEBIAN)
  })

  it('matches the distro name case-insensitively', () => {
    // What a folder picker gives back when the path was typed by hand.
    expect(claudeHomeFor('\\\\wsl$\\ubuntu\\home\\caydenh', homes)).toEqual(UBUNTU)
  })

  it('reads the `wsl.localhost` spelling too', () => {
    expect(claudeHomeFor('\\\\wsl.localhost\\Ubuntu\\home\\caydenh', homes)).toEqual(UBUNTU)
  })

  it('is null for a distro no probe answered for', () => {
    // Not installed here, or it failed to start. A guessed home would be a
    // scope browsing a directory that does not exist.
    expect(claudeHomeFor('\\\\wsl$\\Alpine\\home\\me', homes)).toBeNull()
    expect(claudeHomeFor('\\\\wsl$\\Ubuntu\\home\\me', [])).toBeNull()
  })
})

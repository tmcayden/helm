import { describe, expect, it } from 'vitest'
import { readWslConfig, setNetworkingMode } from './wslconfig'

/**
 * The file under test is the one that rewrites a file Helm does not own, so
 * every case here is a way somebody's `.wslconfig` could be damaged: a comment
 * dropped, a section swallowed, a value written twice, a file with two answers
 * in it picked between silently.
 */

/** The text of a successful edit, or a failure the assertion will name. */
function edited(text: string, mode: string): string {
  const result = setNetworkingMode(text, mode)
  expect(result.ok, result.ok ? '' : result.problem).toBe(true)
  return result.ok ? result.text : ''
}

describe('readWslConfig', () => {
  it('reports nothing for an absent file', () => {
    // An absent file and an empty one are the same text and the same answer.
    // The caller says which of the two it was; this cannot know.
    expect(readWslConfig('')).toEqual({
      networkingMode: null,
      hasWsl2Section: false,
      refusal: null
    })
  })

  it('reads the value under [wsl2]', () => {
    const text = '[wsl2]\nnetworkingMode=mirrored\n'
    expect(readWslConfig(text)).toEqual({
      networkingMode: 'mirrored',
      hasWsl2Section: true,
      refusal: null
    })
  })

  it('does not read a value from another section', () => {
    // `networkingMode` means nothing under `[experimental]`, and reporting it
    // would tell a user their machine mirrors loopback when it does not.
    const text = '[experimental]\nnetworkingMode=mirrored\n'
    expect(readWslConfig(text).networkingMode).toBeNull()
    expect(readWslConfig(text).hasWsl2Section).toBe(false)
  })

  it('is case-insensitive about the section and the key', () => {
    expect(readWslConfig('[WSL2]\nNetworkingMode = NAT\n').networkingMode).toBe('NAT')
  })

  it('takes the value up to an inline comment', () => {
    expect(readWslConfig('[wsl2]\nnetworkingMode=nat # tried mirrored once\n').networkingMode).toBe(
      'nat'
    )
  })

  it('reports a [wsl2] section that sets no networking mode', () => {
    const text = '[wsl2]\nmemory=8GB\n'
    expect(readWslConfig(text)).toEqual({
      networkingMode: null,
      hasWsl2Section: true,
      refusal: null
    })
  })

  it('refuses a file with a line it cannot read', () => {
    const facts = readWslConfig('[wsl2]\nmemory=8GB\nthis is not ini\n')
    expect(facts.refusal).toContain('Line 3')
  })

  it('refuses a file with two [wsl2] sections', () => {
    const facts = readWslConfig('[wsl2]\nmemory=8GB\n\n[wsl2]\nnetworkingMode=nat\n')
    expect(facts.refusal).toContain('more than one `[wsl2]`')
    // Still says what is in there: refusing without stating the value leaves a
    // user with nothing to act on.
    expect(facts.networkingMode).toBe('nat')
  })

  it('refuses a file with two networkingMode keys in one section', () => {
    const facts = readWslConfig('[wsl2]\nnetworkingMode=nat\nnetworkingMode=mirrored\n')
    expect(facts.refusal).toContain('more than one `networkingMode`')
  })

  it('refuses text that is not text', () => {
    expect(readWslConfig('[wsl2]\n\0\0\0').refusal).toContain('not text')
  })
})

describe('setNetworkingMode', () => {
  it('creates the file when there is nothing there', () => {
    expect(edited('', 'mirrored')).toBe('[wsl2]\nnetworkingMode=mirrored\n')
  })

  it('appends a [wsl2] section to a file that has other sections', () => {
    const text = '[experimental]\nsparseVhd=true\n'
    expect(edited(text, 'mirrored')).toBe(
      '[experimental]\nsparseVhd=true\n\n[wsl2]\nnetworkingMode=mirrored\n'
    )
  })

  it('adds the key to an existing [wsl2] without disturbing its other keys', () => {
    const text = '[wsl2]\nmemory=8GB\nprocessors=4\nkernelCommandLine=vsyscall=emulate\n'
    expect(edited(text, 'mirrored')).toBe(
      '[wsl2]\nmemory=8GB\nprocessors=4\nkernelCommandLine=vsyscall=emulate\nnetworkingMode=mirrored\n'
    )
  })

  it('adds the key inside [wsl2] rather than at the end of the file', () => {
    // The failure this prevents is a `networkingMode` written under whatever
    // section happens to be last, where WSL does not read it.
    const text = '[wsl2]\nmemory=8GB\n\n[experimental]\nsparseVhd=true\n'
    expect(edited(text, 'mirrored')).toBe(
      '[wsl2]\nmemory=8GB\nnetworkingMode=mirrored\n\n[experimental]\nsparseVhd=true\n'
    )
  })

  it('puts the key straight under a [wsl2] that has no keys of its own', () => {
    expect(edited('[wsl2]\n\n[experimental]\nsparseVhd=true\n', 'mirrored')).toBe(
      '[wsl2]\nnetworkingMode=mirrored\n\n[experimental]\nsparseVhd=true\n'
    )
  })

  it('keeps every comment, and the blank lines between sections', () => {
    const text = [
      '# Written by hand on 2026-08-01.',
      '[wsl2]',
      '; 8GB is enough for the toolchain',
      'memory=8GB',
      '',
      '# Nothing below here is Helm’s business',
      '[experimental]',
      'sparseVhd=true',
      ''
    ].join('\n')
    expect(edited(text, 'mirrored')).toBe(
      [
        '# Written by hand on 2026-08-01.',
        '[wsl2]',
        '; 8GB is enough for the toolchain',
        'memory=8GB',
        'networkingMode=mirrored',
        '',
        '# Nothing below here is Helm’s business',
        '[experimental]',
        'sparseVhd=true',
        ''
      ].join('\n')
    )
  })

  it('replaces an existing value in place, keeping spelling, spacing and the inline comment', () => {
    const text = '[wsl2]\n  NetworkingMode = nat  # the default\nmemory=8GB\n'
    expect(edited(text, 'mirrored')).toBe(
      '[wsl2]\n  NetworkingMode = mirrored  # the default\nmemory=8GB\n'
    )
  })

  it('writes nothing when the value is already what was asked for', () => {
    const text = '[wsl2]\nnetworkingMode=mirrored\n'
    const result = setNetworkingMode(text, 'mirrored')
    expect(result).toEqual({ ok: true, text, changed: false })
  })

  it('keeps CRLF line endings, including on the line it adds', () => {
    const text = '[wsl2]\r\nmemory=8GB\r\n'
    expect(edited(text, 'mirrored')).toBe('[wsl2]\r\nmemory=8GB\r\nnetworkingMode=mirrored\r\n')
  })

  it('keeps a file that ends without a newline ending without one', () => {
    expect(edited('[wsl2]\nmemory=8GB', 'mirrored')).toBe('[wsl2]\nmemory=8GB\nnetworkingMode=mirrored')
  })

  it('sets the mode back to nat, which is the way out of having set it', () => {
    expect(edited('[wsl2]\nnetworkingMode=mirrored\n', 'nat')).toBe('[wsl2]\nnetworkingMode=nat\n')
  })

  it('rewrites nothing in a file it could not read', () => {
    const text = '[wsl2]\nmemory=8GB\nthis is not ini\n'
    const result = setNetworkingMode(text, 'mirrored')
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.problem).toContain('Line 3')
  })

  it('rewrites nothing in a file with two answers in it', () => {
    const result = setNetworkingMode('[wsl2]\nnetworkingMode=nat\n\n[wsl2]\nmemory=8GB\n', 'mirrored')
    expect(result.ok).toBe(false)
  })

  it('leaves a file it rewrote in a state it can read back', () => {
    // The round trip is the property that matters: an edit that produced text
    // this module then refused would be a file nobody could fix from inside
    // Helm.
    const text = '# note\n[wsl2]\nmemory=8GB\n\n[experimental]\nsparseVhd=true\n'
    const facts = readWslConfig(edited(text, 'mirrored'))
    expect(facts).toEqual({ networkingMode: 'mirrored', hasWsl2Section: true, refusal: null })
  })
})

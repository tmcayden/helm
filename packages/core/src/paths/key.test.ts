import { describe, expect, it } from 'vitest'
import { pathKey, samePathKey } from './key'

describe('pathKey', () => {
  it('folds case on Windows, where two spellings are one directory', () => {
    expect(pathKey('C:\\Repos\\Api', 'win32')).toBe('c:\\repos\\api')
    expect(samePathKey('C:\\Repos\\Api', 'c:\\repos\\API', 'win32')).toBe(true)
  })

  it('keeps a \\\\wsl$\\ key spelled as it was, lower-cased only', () => {
    expect(pathKey('\\\\wsl$\\Ubuntu\\home\\Me', 'win32')).toBe('\\\\wsl$\\ubuntu\\home\\me')
  })

  it('leaves a path alone on Linux, where case is a different directory', () => {
    expect(pathKey('/home/me/Tool/SRC', 'linux')).toBe('/home/me/Tool/SRC')
    expect(samePathKey('/home/me/Tool', '/home/me/tool', 'linux')).toBe(false)
    expect(samePathKey('/home/me/tool', '/home/me/tool', 'linux')).toBe(true)
  })

  it('defaults to the host it is running on', () => {
    expect(pathKey('A/B')).toBe(process.platform === 'win32' ? 'a/b' : 'A/B')
  })
})

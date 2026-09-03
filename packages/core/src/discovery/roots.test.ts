import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WslHome } from '../types'
import { suggestRoots } from './roots'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'helm-roots-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * A `WslHome` whose Linux `$HOME` translates back to a real directory on this
 * machine, so the distro suggestions can be measured with no distro installed.
 *
 * `/mnt/<letter>/...` is the automount spelling of a Windows path and
 * `toWindowsPath` maps it back to the drive it came from - which is the same
 * translation a `\\wsl$\` home goes through, over a directory that is actually
 * there. A check that needed WSL would be a check that never ran.
 */
function homeAt(path: string, distro = 'Ubuntu'): WslHome {
  const [drive, ...rest] = path.split(/[\\/]/)
  const linux = `/mnt/${(drive ?? '').replace(':', '').toLowerCase()}/${rest.join('/')}`
  return { distro, home: linux, claudeHome: join(path, '.claude') }
}

const windowsOnly = describe.skipIf(process.platform !== 'win32')

describe('suggestRoots', () => {
  it('offers no distro suggestion when the host hands in no homes', async () => {
    await mkdir(join(root, 'harness'), { recursive: true })
    const suggested = await suggestRoots(root)
    expect(suggested.some((path) => path.includes('helm-roots-'))).toBe(false)
  })

  it('suggests the parent of the harness it is running inside', async () => {
    await mkdir(join(root, 'work', 'alpha'), { recursive: true })
    await writeFile(join(root, 'work', 'alpha', 'harness.yaml'), 'name: alpha\n')
    const suggested = await suggestRoots(join(root, 'work', 'alpha'))
    expect(suggested[0]?.toLowerCase()).toBe(join(root, 'work').toLowerCase())
  })

  it('never suggests a bare home directory', async () => {
    const suggested = await suggestRoots(root, [homeAt(root)])
    expect(
      suggested.some((path) => path.toLowerCase() === root.toLowerCase())
    ).toBe(false)
    expect(suggested.some((path) => path.toLowerCase() === homedir().toLowerCase())).toBe(false)
  })
})

windowsOnly('a distro home the host hands in', () => {
  it("suggests the distro's undotted `~/harness`, which is where the work is", async () => {
    await mkdir(join(root, 'harness'), { recursive: true })
    const suggested = await suggestRoots(root, [homeAt(root)])
    expect(suggested.map((path) => path.toLowerCase())).toContain(
      join(root, 'harness').toLowerCase()
    )
  })

  it("suggests the distro's `~/.harness` too", async () => {
    await mkdir(join(root, '.harness'), { recursive: true })
    const suggested = await suggestRoots(root, [homeAt(root)])
    expect(suggested.map((path) => path.toLowerCase())).toContain(
      join(root, '.harness').toLowerCase()
    )
  })

  it('offers nothing for a distro whose home holds neither', async () => {
    await mkdir(join(root, 'src'), { recursive: true })
    const suggested = await suggestRoots(root, [homeAt(root)])
    expect(suggested.some((path) => path.toLowerCase().startsWith(root.toLowerCase()))).toBe(false)
  })

  it('offers every distro that has one, in the order the host listed them', async () => {
    const one = join(root, 'one')
    const two = join(root, 'two')
    await mkdir(join(one, 'harness'), { recursive: true })
    await mkdir(join(two, 'harness'), { recursive: true })
    const suggested = await suggestRoots(root, [homeAt(one, 'Ubuntu'), homeAt(two, 'Debian')])
    const lower = suggested.map((path) => path.toLowerCase())
    expect(lower.indexOf(join(one, 'harness').toLowerCase())).toBeGreaterThanOrEqual(0)
    expect(lower.indexOf(join(two, 'harness').toLowerCase())).toBeGreaterThan(
      lower.indexOf(join(one, 'harness').toLowerCase())
    )
  })

  it('keeps the local guesses ahead of any distro one', async () => {
    await mkdir(join(root, 'work', 'alpha'), { recursive: true })
    await writeFile(join(root, 'work', 'alpha', 'harness.yaml'), 'name: alpha\n')
    await mkdir(join(root, 'harness'), { recursive: true })
    const suggested = await suggestRoots(join(root, 'work', 'alpha'), [homeAt(root)])
    expect(suggested[0]?.toLowerCase()).toBe(join(root, 'work').toLowerCase())
    expect(suggested.at(-1)?.toLowerCase()).toBe(join(root, 'harness').toLowerCase())
  })

  it('skips a home that cannot be spelled for this process rather than guessing', async () => {
    await mkdir(join(root, 'harness'), { recursive: true })
    // A relative `$HOME` is not a path `toWindowsPath` can answer for, and a
    // suggestion invented from one would be a scan root nobody chose.
    const bad: WslHome = { distro: 'Ubuntu', home: 'home/me', claudeHome: '' }
    const suggested = await suggestRoots(root, [bad, homeAt(root)])
    expect(suggested.map((path) => path.toLowerCase())).toContain(
      join(root, 'harness').toLowerCase()
    )
    expect(suggested.every((path) => !path.includes('home/me'))).toBe(true)
  })
})

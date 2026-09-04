import { findEnclosingHarness } from '@helm/core'
import { mergeHarnessRoots, readHarnessIndex } from './harnesses.ts'
import { harnessIndexFile } from './paths.ts'
import { readAllProfiles, type ProfileEntry } from './profiles.ts'

/** Every harness the CLI knows: the index, plus the one enclosing the cwd. */
export async function knownHarnesses(cwd: string = process.cwd()): Promise<string[]> {
  return mergeHarnessRoots(readHarnessIndex(harnessIndexFile()), [await findEnclosingHarness(cwd)])
}

export async function knownProfiles(): Promise<ProfileEntry[]> {
  return readAllProfiles(await knownHarnesses())
}

/**
 * The key two paths are compared by when the question is "the same directory?".
 *
 * Windows filesystems are case-insensitive, so `C:\Repos\Api` and `c:\repos\api`
 * are one directory and every set, map and dedupe over paths in Helm folds case
 * before comparing. On Linux they are two directories, and folding them would
 * quietly merge two projects into one - so the fold is the platform's, not a
 * constant: lower-cased on `win32`, the path itself everywhere else.
 *
 * Case only. Separator folding is a different question, answered where the two
 * spellings genuinely arrive by different routes (`projectEntry`, `samePath`),
 * and `\\wsl$\` UNC keys keep the spelling they have always had on Windows.
 *
 * The platform is a parameter so a test on either host can exercise the other
 * branch rather than skipping it.
 */
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.toLowerCase() : path
}

/** Whether two paths name one directory on this platform, by case alone. */
export function samePathKey(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return pathKey(a, platform) === pathKey(b, platform)
}

import type { WslConfigEdit, WslConfigFacts } from '../types'

/**
 * Reading and rewriting `%USERPROFILE%\.wslconfig` - the text, and nothing else.
 *
 * The file is the one lever over the fact measured on 2026-09-02 and recorded
 * in SPEC 4.8: a distro on the default NAT networking mode cannot reach Helm's
 * loopback endpoint at all, so a WSL session launches with no `--mcp-config`
 * and no tools. `networkingMode=mirrored` under `[wsl2]` is the fix, and
 * `unreachableEndpointNote` in `desktop/main/wsl.ts` is the sentence this
 * module automates.
 *
 * It is pure on purpose - text in, text out, no `node:` imports - for the
 * reason `wsl/path.ts` is: this is the half that has to be *tested*, and the
 * half where a mistake destroys a file Helm does not own. The host does the
 * reading, the backup and the writing (`desktop/main/wslconfig.ts`).
 *
 * Three rules shape all of it, and every one of them is a way somebody else's
 * file gets damaged:
 *
 *   1. **Nothing already in the file is lost.** It is an INI file a user may
 *      have `memory`, `processors`, `kernelCommandLine` or whole other sections
 *      in, and comments they wrote to remind themselves why. Unknown keys,
 *      unknown sections, comments, blank lines, indentation, key spelling,
 *      inline comments and line-ending style all survive a write - the edit is
 *      one line changed or one line added, never a re-serialisation of a parsed
 *      model. A round trip through a `Record<string, string>` would silently
 *      drop every comment in the file, which is why there is no such model
 *      here.
 *   2. **A file this cannot read with confidence is not rewritten.** A line
 *      that is neither blank, a comment, a section header nor `key=value`, two
 *      `[wsl2]` sections, or two `networkingMode` keys inside one - in each of
 *      those Helm would be guessing which half of the file WSL honours.
 *      `refusal` carries the sentence and the caller shows it instead of
 *      offering the write, so the user edits their own file by hand.
 *   3. **Absent is absent, not "nat".** A missing file and a missing key both
 *      mean the platform default is in force, and the *default* is a fact about
 *      the WSL build rather than about this file. So `networkingMode` is null
 *      and the sentence says the file does not set it, which is the same rule
 *      the usage figures follow: paint nothing rather than a wrong value.
 *
 * What none of this answers is whether the endpoint is reachable *right now*.
 * That is `describeWslDistro`'s question - a connect either works or it does
 * not - and a file saying `mirrored` before WSL has restarted is exactly the
 * state a user needs to see, so the two are never merged.
 */

/** A section header line: `[wsl2]`, with whatever spacing around it. */
const SECTION = /^\s*\[\s*([^\]]*?)\s*\]\s*$/

/**
 * A `key = value` line, split so a rewrite can put the value back between the
 * parts it must not touch.
 *
 * Four capture groups because four things are preserved: the indentation, the
 * key as the user spelled it, the spacing around `=`, and anything trailing -
 * which is where an inline comment lives. WSL's parser takes the value up to
 * the comment, so a rewrite that dropped the tail would delete a comment, and
 * one that kept it inside the value would write `mirrored # why` as the value.
 */
const ENTRY = /^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)(.*)$/

/** `#` and `;` both start a comment; WSL writes `#` and INI convention has both. */
const COMMENT = /^\s*[#;]/

/** The value the fix needs, and the name of the section it belongs under. */
export const WSL2_SECTION = 'wsl2'
export const NETWORKING_MODE_KEY = 'networkingMode'

/** A value's inline comment, so a rewrite keeps it and the value drops it. */
function splitTrailingComment(rest: string): { value: string; tail: string } {
  const at = rest.search(/[#;]/)
  if (at < 0) return { value: rest.trimEnd(), tail: rest.slice(rest.trimEnd().length) }
  const value = rest.slice(0, at)
  return { value: value.trimEnd(), tail: rest.slice(value.trimEnd().length) }
}

/**
 * One `[wsl2]` `networkingMode` line, located rather than parsed out.
 *
 * Index into the line array, because the rewrite edits that line in place.
 */
interface Located {
  line: number
  value: string
}

/**
 * What the text says, and whether Helm may rewrite it.
 *
 * `text` being empty is the absent-file case as far as this function is
 * concerned; the caller decides whether that is "no file" or "an empty file",
 * because those read differently in a sentence and identically here.
 */
export function readWslConfig(text: string): WslConfigFacts {
  // A NUL is the same test `readConfigFileContent` uses for the config
  // console: this is not text, so it is not an INI file, and the one safe
  // answer is to refuse rather than to guess at an encoding.
  if (text.includes('\0')) {
    return {
      networkingMode: null,
      hasWsl2Section: false,
      refusal: 'That file is not text, so Helm will not rewrite it.'
    }
  }

  const lines = text.split(/\r?\n/)
  let section: string | null = null
  const wsl2Sections: number[] = []
  const found: Located[] = []
  const unreadable: number[] = []

  for (const [index, line] of lines.entries()) {
    if (line.trim() === '' || COMMENT.test(line)) continue

    const header = SECTION.exec(line)
    if (header) {
      section = (header[1] ?? '').toLowerCase()
      if (section === WSL2_SECTION) wsl2Sections.push(index)
      continue
    }

    const entry = ENTRY.exec(line)
    if (!entry) {
      unreadable.push(index)
      continue
    }
    if (section === WSL2_SECTION && (entry[2] ?? '').toLowerCase() === NETWORKING_MODE_KEY.toLowerCase()) {
      found.push({ line: index, value: splitTrailingComment(entry[4] ?? '').value })
    }
  }

  const refusal = refuse(unreadable, wsl2Sections, found)
  return {
    // The value is still reported when the file is refused: the whole point of
    // refusing is to say what is there and let the user edit it, and "Helm
    // will not touch this" with no statement of what it holds is a dead end.
    networkingMode: found[0]?.value === undefined || found[0].value === '' ? null : found[0].value,
    hasWsl2Section: wsl2Sections.length > 0,
    refusal
  }
}

/** The one sentence saying why a file is too odd to touch, or null. */
function refuse(
  unreadable: readonly number[],
  wsl2Sections: readonly number[],
  found: readonly Located[]
): string | null {
  const first = unreadable[0]
  if (first !== undefined) {
    return (
      `Line ${String(first + 1)} of .wslconfig is neither a comment, a section nor a ` +
      'key=value setting, so Helm cannot tell what rewriting it would change. Edit the file by hand.'
    )
  }
  if (wsl2Sections.length > 1) {
    return (
      'There is more than one `[wsl2]` section in .wslconfig. Which one WSL honours is not ' +
      'something Helm should guess at, so it will not rewrite the file. Edit it by hand.'
    )
  }
  if (found.length > 1) {
    return (
      'There is more than one `networkingMode` under `[wsl2]` in .wslconfig. Helm will not ' +
      'pick which of them to change - edit the file by hand.'
    )
  }
  return null
}

/**
 * The text with `networkingMode` set, or a refusal.
 *
 * Three shapes, in the order they are tried, and each does the least it can:
 *
 *   - **The key is there.** Its value is replaced and its line is otherwise
 *     untouched, so `  NetworkingMode = nat  # tried mirrored once` comes back
 *     as `  NetworkingMode = mirrored  # tried mirrored once`.
 *   - **`[wsl2]` is there and the key is not.** The line is inserted at the end
 *     of that section's own keys - before the blank lines that separate it from
 *     whatever follows, so a file's spacing is not closed up.
 *   - **Neither.** A `[wsl2]` section is appended at the end, after a blank
 *     line, which is the only shape that adds a section at all.
 *
 * `changed: false` is a real outcome and not a no-op to hide: the file already
 * says what was asked for, and the caller has something to say about that -
 * usually that WSL has not restarted yet.
 */
export function setNetworkingMode(text: string, mode: string): WslConfigEdit {
  const facts = readWslConfig(text)
  if (facts.refusal !== null) return { ok: false, problem: facts.refusal }

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  // A file that ends with a newline splits to a trailing empty element. It is
  // kept and re-joined rather than trimmed, so a write neither adds nor removes
  // the final newline the user's editor left there.
  const located = locate(lines)

  if (located.entry !== null) {
    const line = lines[located.entry] ?? ''
    const entry = ENTRY.exec(line)
    // Unreachable: `locate` found this line with the same regex. Guarded rather
    // than asserted because the alternative is a `!` that silently writes
    // `undefined` into somebody's configuration file.
    if (!entry) return { ok: false, problem: 'Helm could not re-read that line of .wslconfig.' }
    const { value, tail } = splitTrailingComment(entry[4] ?? '')
    if (value === mode) return { ok: true, text, changed: false }
    lines[located.entry] = `${entry[1] ?? ''}${entry[2] ?? ''}${entry[3] ?? ''}${mode}${tail}`
    return { ok: true, text: lines.join(eol), changed: true }
  }

  if (located.sectionEnd !== null) {
    lines.splice(located.sectionEnd, 0, `${NETWORKING_MODE_KEY}=${mode}`)
    return { ok: true, text: lines.join(eol), changed: true }
  }

  // Appending to a file with no `[wsl2]`. The blank line is what stops the new
  // section reading as part of whichever one the file ended in.
  const body = text === '' ? '' : text.replace(/(\r?\n)+$/, '') + eol + eol
  return {
    ok: true,
    text: `${body}[${WSL2_SECTION}]${eol}${NETWORKING_MODE_KEY}=${mode}${eol}`,
    changed: true
  }
}

/**
 * Where the write goes: the existing key's line, or the end of `[wsl2]`'s keys.
 *
 * `sectionEnd` is an insertion index one past the section's last non-blank
 * line, so the blank lines and comments between one section and the next stay
 * where the user put them. A comment sitting immediately above the *next*
 * section header belongs to that section as far as a reader is concerned, and
 * insertion before it would put a `[wsl2]` key under somebody's note about
 * `[experimental]`.
 */
function locate(lines: readonly string[]): { entry: number | null; sectionEnd: number | null } {
  let section: string | null = null
  let sectionEnd: number | null = null
  let header0 = -1
  let lastKey: number | null = null

  for (const [index, line] of lines.entries()) {
    const header = SECTION.exec(line)
    if (header) {
      // A `[wsl2]` with no keys of its own takes the line straight after its
      // header, rather than after whatever blank lines follow it - a key
      // separated from its own section by an empty line reads as belonging to
      // nothing.
      if (section === WSL2_SECTION && sectionEnd === null) {
        sectionEnd = (lastKey ?? header0) + 1
      }
      section = (header[1] ?? '').toLowerCase()
      header0 = index
      lastKey = null
      continue
    }
    if (line.trim() === '' || COMMENT.test(line)) continue
    const entry = ENTRY.exec(line)
    if (!entry) continue
    if (section === WSL2_SECTION) {
      lastKey = index
      if ((entry[2] ?? '').toLowerCase() === NETWORKING_MODE_KEY.toLowerCase()) {
        return { entry: index, sectionEnd: null }
      }
    }
  }

  // `[wsl2]` was the last section in the file, so its end was never closed by
  // another header.
  if (section === WSL2_SECTION && sectionEnd === null) {
    sectionEnd = (lastKey ?? header0) + 1
  }
  return { entry: null, sectionEnd }
}

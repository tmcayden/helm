import { describe, expect, it } from 'vitest'
import type { WslHome } from '../types'
import { INOTIFY_READY, claudeTreeOf, inotifyWatchArgs, parseInotifyLine } from './inotify'

const home: WslHome = {
  distro: 'Ubuntu',
  home: '/home/me',
  claudeHome: '\\\\wsl$\\Ubuntu\\home\\me\\.claude'
}

const uuid = '0a0a0a0a-0b0b-4c0c-8d0d-0e0e0e0e0e0e'

describe('inotifyWatchArgs', () => {
  it('runs inotifywait through --exec, so no shell re-parses the format', () => {
    const args = inotifyWatchArgs(home)
    expect(args.slice(0, 3)).toEqual(['-d', 'Ubuntu', '--exec'])
    expect(args).not.toContain('--')
    expect(args).not.toContain('bash')
  })

  it('is unbuffered, monitoring, recursive, and rooted at the whole .claude tree', () => {
    const args = inotifyWatchArgs(home)
    expect(args.slice(3, 5)).toEqual(['stdbuf', '-o0'])
    expect(args).toContain('-m')
    expect(args).toContain('-r')
    expect(args.at(-1)).toBe('/home/me/.claude')
  })

  it('tolerates a home with a trailing slash', () => {
    expect(claudeTreeOf({ ...home, home: '/home/me/' })).toBe('/home/me/.claude')
  })

  it('names the readiness sentence inotifywait prints', () => {
    expect(INOTIFY_READY).toBe('Watches established')
  })
})

describe('parseInotifyLine', () => {
  it('history.jsonl is a history event whatever happened to it', () => {
    for (const flags of ['CLOSE_WRITE,CLOSE', 'CREATE', 'DELETE', 'MOVED_TO']) {
      expect(parseInotifyLine(`${flags}|/home/me/.claude/history.jsonl`, home)).toEqual({
        kind: 'history'
      })
    }
  })

  it('a transcript under a project directory is a transcript event, spelled for Windows', () => {
    const line = `CLOSE_WRITE,CLOSE|/home/me/.claude/projects/-home-me-app/${uuid}.jsonl`
    expect(parseInotifyLine(line, home)).toEqual({
      kind: 'transcript',
      op: 'changed',
      isDir: false,
      path: `\\\\wsl$\\Ubuntu\\home\\me\\.claude\\projects\\-home-me-app\\${uuid}.jsonl`
    })
  })

  it('DELETE and MOVED_FROM are removals; CREATE, MOVED_TO and CLOSE_WRITE are changes', () => {
    const file = `/home/me/.claude/projects/-home-me-app/${uuid}.jsonl`
    const op = (flags: string): string | undefined => {
      const event = parseInotifyLine(`${flags}|${file}`, home)
      return event?.kind === 'transcript' ? event.op : undefined
    }
    expect(op('DELETE')).toBe('removed')
    expect(op('MOVED_FROM')).toBe('removed')
    expect(op('CREATE')).toBe('changed')
    expect(op('MOVED_TO')).toBe('changed')
    expect(op('CLOSE_WRITE,CLOSE')).toBe('changed')
  })

  it('a project directory is a directory event, and so is projects/ itself', () => {
    expect(
      parseInotifyLine('MOVED_TO,ISDIR|/home/me/.claude/projects/-home-me-renamed', home)
    ).toEqual({
      kind: 'transcript',
      op: 'changed',
      isDir: true,
      path: '\\\\wsl$\\Ubuntu\\home\\me\\.claude\\projects\\-home-me-renamed'
    })
    expect(parseInotifyLine('DELETE,ISDIR|/home/me/.claude/projects', home)).toEqual({
      kind: 'transcript',
      op: 'removed',
      isDir: true,
      path: '\\\\wsl$\\Ubuntu\\home\\me\\.claude\\projects'
    })
    // A file called `projects` is not the directory.
    expect(parseInotifyLine('CREATE|/home/me/.claude/projects', home)).toBeNull()
  })

  it('ignores everything under the tree that is not history or a session transcript', () => {
    const ignored = [
      // The credential beside every session record. A name, never opened; dropped here.
      'CLOSE_WRITE,CLOSE|/home/me/.claude/sessions/1234.abcdef.key',
      'CLOSE_WRITE,CLOSE|/home/me/.claude/sessions/1234.json',
      'CLOSE_WRITE,CLOSE|/home/me/.claude/settings.json',
      // Subagent transcripts and tool results live below the project directory.
      `CLOSE_WRITE,CLOSE|/home/me/.claude/projects/-home-me-app/${uuid}/subagents/agent-1.jsonl`,
      'CREATE,ISDIR|/home/me/.claude/projects/-home-me-app/tool-results',
      // Not a session id.
      'CLOSE_WRITE,CLOSE|/home/me/.claude/projects/-home-me-app/notes.jsonl',
      'CREATE|/home/me/.claude/projects/-home-me-app/.lock',
      // A directory event with a file's flags, or the reverse.
      `CREATE,ISDIR|/home/me/.claude/projects/-home-me-app/${uuid}.jsonl`
    ]
    for (const line of ignored) expect(parseInotifyLine(line, home), line).toBeNull()
  })

  it('ignores anything outside the tree, and lines with no separator', () => {
    expect(parseInotifyLine('CLOSE_WRITE,CLOSE|/home/me/other/history.jsonl', home)).toBeNull()
    expect(parseInotifyLine('CLOSE_WRITE,CLOSE|/home/me/.claude2/history.jsonl', home)).toBeNull()
    expect(parseInotifyLine('Setting up watches.', home)).toBeNull()
    expect(parseInotifyLine('', home)).toBeNull()
    expect(parseInotifyLine('|/home/me/.claude/history.jsonl', home)).toBeNull()
  })

  it('a CRLF line parses the same', () => {
    expect(parseInotifyLine('CLOSE_WRITE,CLOSE|/home/me/.claude/history.jsonl\r', home)).toEqual({
      kind: 'history'
    })
  })
})

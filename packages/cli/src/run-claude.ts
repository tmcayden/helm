import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { finishSession, readGitBranch, startSession } from '@helm/core'
import { withStore } from './store.ts'
import { warn } from './output.ts'

export interface ClaudeRun {
  name: string
  cwd: string
  argv: string[]
  claudeSessionId: string | null
}

/**
 * The CLI is the pty host (TERMINAL.md 4): the row is written **before** the
 * process starts, so a session that dies at once still happened, and the exit
 * is recorded by the wrapper that spawned it.
 *
 * Node cannot exec(2), so `claude` is a child with inherited stdio and this
 * process stays as its parent for the whole session. The terminal delivers
 * keyboard signals to the foreground process group, which both processes are
 * in, so a SIGINT from the tty already reaches the child on its own - and
 * `claude` puts the tty in raw mode, where Ctrl-C is a byte it reads rather
 * than a signal, so forwarding SIGINT would hand it a second interrupt it never
 * asked for. The wrapper therefore ignores SIGINT and forwards SIGTERM and
 * SIGHUP, which arrive from `kill` and a closing terminal and would otherwise
 * end the wrapper while the session it is recording runs on unrecorded.
 */
export async function runClaude(run: ClaudeRun): Promise<number> {
  const branch = await readGitBranch(run.cwd)
  const row = withStore((store) =>
    startSession(store, {
      name: run.name,
      cwd: run.cwd,
      branch,
      argv: run.argv,
      claudeSessionId: run.claudeSessionId
    })
  )

  const exitCode = await new Promise<number>((done) => {
    const child = spawn('claude', run.argv, { cwd: run.cwd, stdio: 'inherit' })
    const forward = (signal: NodeJS.Signals) => () => {
      child.kill(signal)
    }
    const onTerm = forward('SIGTERM')
    const onHup = forward('SIGHUP')
    const onInt = () => {}
    process.on('SIGTERM', onTerm)
    process.on('SIGHUP', onHup)
    process.on('SIGINT', onInt)
    const release = () => {
      process.off('SIGTERM', onTerm)
      process.off('SIGHUP', onHup)
      process.off('SIGINT', onInt)
    }
    child.on('error', (err) => {
      release()
      warn(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'claude is not on PATH - install Claude Code and sign in with `claude` first.'
          : `claude could not be started: ${err.message}`
      )
      done(127)
    })
    child.on('exit', (code, signal) => {
      release()
      done(code ?? (signal ? 128 + signalNumber(signal) : 1))
    })
  })

  withStore((store) => finishSession(store, row.id, { exitCode }))
  return exitCode
}

function signalNumber(signal: NodeJS.Signals): number {
  return constants.signals[signal] ?? 0
}

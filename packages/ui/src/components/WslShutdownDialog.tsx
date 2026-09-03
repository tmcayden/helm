import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { cn } from '../lib/cn'
import { TerminalIcon } from './icons'
import { Overlay } from './Overlay'

export interface WslShutdownDialogProps {
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The confirmation before `wsl --shutdown`.
 *
 * A dialog rather than a launch-disclosure sentence, which is the opposite of
 * the call DESIGN.md's "launch disclosure" makes for the launch warning - and
 * the difference is which mistake is possible. Sharing a working tree is
 * sometimes exactly what somebody means to do, so a sentence beside the button
 * is the honest shape there. This button ends **other people's processes**: an
 * editor, a dev server, a build, a Claude Code session running inside a
 * distribution and part way through something. That is not a state anybody
 * clicks into on purpose while reading past a sentence, and it is the one thing
 * on the settings pane with no way back.
 *
 * Cancel takes the focus and the destructive button carries the tone in its
 * text and hover wash rather than in a fill, the same recipe
 * `ConfirmSessionDialog` uses - see DESIGN.md par. 3 for why the accepting
 * button is never solid.
 *
 * **Nothing is enumerated.** Helm cannot see what is running inside a
 * distribution it did not spawn into - and a list of the ones it *can* see
 * would read as the whole cost of pressing this, which is the reassuring-wrong-
 * answer failure CLAUDE.md pins for the process tree ("could not look" and
 * "nothing there" are never merged). So the dialog says what the command does
 * and leaves the survey to the person who knows what they have open.
 */
export function WslShutdownDialog({ onConfirm, onCancel }: WslShutdownDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Focus lands on Cancel, not on the destructive button - a stray Enter must
  // not end somebody's build.
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  return (
    <Overlay
      role="alertdialog"
      aria-label="Restart WSL?"
      data-wsl-shutdown-dialog
      className="max-w-[440px]"
      onDismiss={onCancel}
    >
      <div className="px-[22px] pt-[18px]">
        <header className="flex items-start gap-[9px]">
          <TerminalIcon width={13} height={13} className="mt-[3px] shrink-0 text-accent" />
          <h2 className="text-[15px] leading-[1.35] font-medium tracking-tight text-fg">
            Restart WSL?
          </h2>
        </header>

        <p className="mt-2 text-[12px] leading-[1.55] text-fg-muted">
          <code className="font-mono text-[11px] text-fg">wsl --shutdown</code> ends{' '}
          <strong className="font-medium text-fg">every WSL process on this machine</strong> - every
          distribution, and everything running inside one: editors, servers, builds, and any Claude
          Code session in a distro, Helm&rsquo;s own included. Nothing is saved first and nothing is
          restarted for you.
        </p>
        <p className="mt-2 text-[12px] leading-[1.55] text-fg-muted">
          Helm cannot see what is running in there, so check yourself before you press it. The
          networking change is already written either way - it applies the next time WSL starts,
          whether that is now or the next time you open a session.
        </p>
      </div>

      <footer className="mx-[22px] mt-4 flex shrink-0 items-center justify-end gap-2 border-t border-border py-3.5">
        <button
          ref={cancelRef}
          type="button"
          data-wsl-shutdown-cancel
          onClick={onCancel}
          className={cn(
            'rounded-well border border-border-strong px-3.5 py-1.5 text-[12px] text-fg',
            'transition-colors hover:bg-hover',
            // `:focus` rather than the global `:focus-visible`, for the reason
            // `ConfirmSessionDialog`'s Cancel gives: focus is placed here by
            // script, which Chromium does not count as visible focus, so the
            // default action would otherwise be marked by nothing.
            'focus:border-accent focus:outline-none'
          )}
        >
          Cancel
        </button>
        <button
          type="button"
          data-wsl-shutdown-accept
          onClick={onConfirm}
          className={cn(
            'rounded-well border border-danger/50 px-3.5 py-1.5 text-[12px] font-medium',
            'text-danger transition-colors hover:bg-danger/10'
          )}
        >
          Shut WSL down
        </button>
      </footer>
    </Overlay>
  )
}

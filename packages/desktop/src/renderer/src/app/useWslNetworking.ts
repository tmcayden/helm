import { useCallback, useEffect, useState } from 'react'
import type { WslDistro, WslNetworkingMode, WslNetworkingState, WslProbe } from '@helm/core/types'
import type { WslSettingsState } from '@helm/ui'
import { helm } from './bridge'

/**
 * The settings pane's WSL group, as state.
 *
 * Two reads with very different costs, which is why they are two channels and
 * why only one of them happens on mount:
 *
 * - `%USERPROFILE%\.wslconfig` is one small file, so it is read when the pane
 *   first asks and again after every write. Nothing watches it: a user who
 *   edits it in another editor while this pane is open presses a button here
 *   next, and the write's own reply is a fresh read.
 * - `wsl:distros` is one `wsl.exe` and touches no distribution, so it is asked
 *   on mount. `wsl:probe` **starts** the distro it asks about, so it is asked
 *   only when somebody presses Check - a settings pane that booted every
 *   distribution on the machine to paint itself would be the failure the two
 *   channels exist to prevent.
 *
 * Mounted with the pane rather than at app start, for the same reason: nothing
 * about WSL is read until somebody opens the surface that shows it.
 */
export interface WslNetworkingHook extends WslSettingsState {
  setMode: (mode: WslNetworkingMode) => void
  probe: (distro: string) => void
  shutdown: () => void
}

export function useWslNetworking(): WslNetworkingHook {
  const [networking, setNetworking] = useState<WslNetworkingState | null>(null)
  const [distros, setDistros] = useState<readonly WslDistro[]>([])
  const [probes, setProbes] = useState<Record<string, WslProbe>>({})
  const [probing, setProbing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void helm.invoke('wsl:networking').then((state) => {
      if (live) setNetworking(state)
    })
    // An empty list is the ordinary answer on a machine with no WSL, so a
    // failure here is the same answer and not a sentence anybody needs.
    void helm
      .invoke('wsl:distros')
      .catch(() => [])
      .then((found) => {
        if (live) setDistros(found)
      })
    return () => {
      live = false
    }
  }, [])

  const setMode = useCallback((mode: WslNetworkingMode) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    void helm
      .invoke('wsl:setNetworking', { mode })
      .then((result) => {
        setNetworking(result.state)
        setError(result.error)
        setNotice(outcome(result.ok, result.unchanged, result.backupPath, mode))
        // Every probe answer this window is holding was about the networking
        // mode that has just changed, so keeping them would paint a stale
        // "could not reach" beside a file that now says mirrored. Main forgets
        // its own memo on the same write.
        if (result.ok && !result.unchanged) setProbes({})
      })
      .catch((err: unknown) => {
        setError(`Helm could not change .wslconfig: ${String(err)}`)
      })
      .finally(() => {
        setBusy(false)
      })
  }, [])

  const probe = useCallback((distro: string) => {
    setProbing(distro)
    // `refresh`, always: this is somebody asking again *because* they changed
    // something, and a memoised answer is the one thing they are not asking
    // for.
    void helm
      .invoke('wsl:probe', { distro, refresh: true })
      .then((answer) => {
        setProbes((held) => ({ ...held, [distro]: answer }))
      })
      .catch(() => {
        // The probe's own "no" is a `WslProbe` with a problem on it, so an
        // outright rejection is an IPC failure - nothing to report about WSL.
      })
      .finally(() => {
        setProbing(null)
      })
  }, [])

  const shutdown = useCallback(() => {
    // Reached only from the pane's confirmation dialog; see `WslShutdownDialog`
    // for why the question is a dialog and not a sentence.
    setNotice(null)
    setError(null)
    void helm
      .invoke('wsl:shutdown')
      .then((result) => {
        setError(result.error)
        if (result.ok) setNotice('WSL has been shut down. The next session starts it again.')
        // Everything WSL knew about itself is gone with it, this window's probe
        // answers included.
        setProbes({})
      })
      .catch((err: unknown) => {
        setError(`\`wsl --shutdown\` could not be run: ${String(err)}`)
      })
  }, [])

  return { networking, distros, probes, probing, busy, notice, error, setMode, probe, shutdown }
}

/**
 * What the write did, in one sentence.
 *
 * The backup path is in it because that is the whole of "there is a way back",
 * and a copy nobody is told the name of is a copy nobody can use. The
 * unchanged case is stated rather than swallowed: the file already said this,
 * and the useful next fact is that WSL still has to restart.
 */
function outcome(
  ok: boolean,
  unchanged: boolean,
  backupPath: string | null,
  mode: WslNetworkingMode
): string | null {
  if (!ok) return null
  if (unchanged) return `.wslconfig already set networkingMode=${mode}. Nothing was written.`
  const written = `Wrote networkingMode=${mode}. It applies the next time WSL starts.`
  return backupPath === null
    ? `${written} There was no .wslconfig before this, so deleting it is the way back.`
    : `${written} The file as it was is at ${backupPath}.`
}

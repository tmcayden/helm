import { SettingsPane, type SettingsPaneProps } from '@helm/ui'
import type { JSX } from 'react'
import { useWslNetworking } from './useWslNetworking'

/**
 * The settings pane, with its WSL group's state mounted alongside it.
 *
 * This wrapper exists for one reason: **the WSL group's two reads happen when
 * the pane opens, not when the app starts.** `useWslNetworking` says so in its
 * own header and always meant to, but it was called in `App`'s body - which
 * mounts once, for the window's life - and `App` carried a second comment
 * saying that was deliberate. Two comments disagreeing is one of them being
 * wrong, and this is the one that was: the pane is a conditional render on the
 * active pane, so a hook mounted with it runs its reads on every open.
 *
 * Two things were wrong while it was mounted at the top, and the second is the
 * one a user meets.
 *
 * - `wsl:distros` is a `wsl.exe` on the **start-up path**, paid by every user
 *   on every launch whether or not they ever open Settings or have any
 *   interest in WSL. It is cheap and it touches no distribution, which is why
 *   it went unnoticed; it is still a process spawn nobody asked for.
 * - `%USERPROFILE%\.wslconfig` was read **once per window**. Nothing watches
 *   that file - deliberately, it is one small file and a watch on it would be a
 *   watch on the user's profile directory - so a file edited in another editor
 *   was a file this pane went on misreporting until Helm was restarted. The
 *   only thing that refreshed it was Helm's own write, which is the one case
 *   where the truth was already known.
 *
 * Found by `settings-check`'s S-23, on its first run, in the way a check is
 * supposed to find things: the probe planted a fixture `.wslconfig`, remounted
 * the pane and asked what path was on screen, and got the real one back.
 *
 * The props are forwarded whole rather than named individually - `SettingsPane`
 * has around eighty and none of the others is this component's business.
 */
export type SettingsWithWslProps = Omit<
  SettingsPaneProps,
  'wsl' | 'onWslNetworkingModeChange' | 'onWslProbe' | 'onWslShutdown'
>

export function SettingsWithWsl(props: SettingsWithWslProps): JSX.Element {
  const wsl = useWslNetworking()
  return (
    <SettingsPane
      {...props}
      wsl={wsl}
      onWslNetworkingModeChange={wsl.setMode}
      onWslProbe={wsl.probe}
      // Reached only from the group's own confirmation, which names what
      // `wsl --shutdown` terminates.
      onWslShutdown={wsl.shutdown}
    />
  )
}

/**
 * The two files `helm install` writes and `helm doctor` compares against
 * (TERMINAL.md 5 and 10). The header line is how a file is known to be Helm's:
 * install refuses to overwrite one without it, because that is a file somebody
 * else wrote.
 */
export const SNIPPET_HEADER = '# helm: written by helm install; do not edit'

/**
 * The `helm` key table. Short-lived things are popups, long-lived things are
 * panes. `c` picks in a popup and opens the pane from inside it, the way `p`
 * does, because a shell one-liner nested inside a tmux single-quoted string
 * cannot quote an empty result, and an empty result is the cancel.
 *
 * The status-right append is guarded: `-ga` appends on every `source-file`,
 * and the user's `prefix r` re-sources the whole config.
 */
export const TMUX_SNIPPET = `${SNIPPET_HEADER}
bind-key Space switch-client -T helm
bind-key -T helm p display-popup -E -w 80% -h 60% -d '#{pane_current_path}' 'helm pick profile'
bind-key -T helm h display-popup -E -w 80% -h 60% -d '#{pane_current_path}' 'helm menu'
bind-key -T helm e split-window -h -c '#{pane_current_path}' 'helm view effective'
bind-key -T helm c display-popup -E -w 80% -h 60% -d '#{pane_current_path}' 'helm pick scope --view'
bind-key -T helm u split-window -h -c '#{pane_current_path}' 'helm view config --user'
bind-key -T helm Escape switch-client -T root
if-shell -F '#{m:*HELM*,#{status-right}}' '' "set-option -ga status-right '#{?#{==:#{client_key_table},helm},#[reverse] HELM #[noreverse],}'"
`

/**
 * The `claude` wrapper measured in the spike, verbatim, plus Helm's Space chord
 * for a user whose zsh already has a chord table. The table is usually bound
 * before this file is sourced, so the key is bound here too when the widget is
 * there to bind it to. The key goes through a variable because zsh keeps the
 * quotes of a quoted subscript as part of the key.
 */
export const ZSH_SNIPPET = `${SNIPPET_HEADER}
claude() {
\tlocal profile=\${HELM_PROFILE:-}
\tif [[ $1 == -n ]]; then profile=n; shift; fi
\tif [[ -z $profile && -n $TMUX ]]; then
\t\tprofile=$(tmux show-option -wqv @helm_profile)
\t\t[[ -n $profile ]] || profile=$(tmux show-option -qv @helm_profile)
\tfi
\tif [[ -n $profile && $profile != n ]]; then
\t\texec helm launch "$profile" -- "$@"
\tfi
\tcommand claude "$@"
}
if (( \${+tmux_chords} )); then
\thelm_chord=' '
\ttmux_chords[$helm_chord]='helm menu'
\t(( \${+widgets[tmux-chord]} )) && bindkey "^A$helm_chord" tmux-chord
\tunset helm_chord
fi
`

export const TMUX_SOURCE_LINE = (file: string): string => `source-file ${file}`
export const ZSH_SOURCE_LINE = (file: string): string => `[ -f ${file} ] && source ${file}`

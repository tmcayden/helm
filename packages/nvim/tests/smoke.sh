#!/bin/sh
# Headless checks for helm.nvim. Exits non-zero on the first failure; skips
# cleanly when nvim is absent so `pnpm test` on a machine without it is unaffected.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)

if ! command -v nvim >/dev/null 2>&1; then
  echo "smoke: nvim is not on PATH - skipped."
  exit 0
fi
if [ ! -f "$repo/packages/cli/dist/helm.mjs" ]; then
  echo "smoke: packages/cli/dist/helm.mjs is not built - run pnpm -F @helm/cli build first."
  exit 1
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/helm-nvim-smoke.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

# Everything runs against a scratch data directory and a scratch harness, so
# nothing here reads or writes the user's own ~/.claude tree or store.
export HELM_DATA_DIR="$scratch/data"
export HELM_CLI="$(command -v node) $repo/packages/cli/dist/helm.mjs"
mkdir -p "$scratch/harness/.helm/profiles" "$scratch/harness/.claude/skills/demo" "$scratch/tree/.claude"
printf 'name: smoke\n' > "$scratch/harness/harness.yaml"
printf 'overlays: []\naccess: []\nmodel: opus\neffort: high\n' > "$scratch/harness/.helm/profiles/smoke.yaml"
printf -- '---\ndescription: demo\n---\n# demo\n' > "$scratch/harness/.claude/skills/demo/SKILL.md"
printf '{"env":{"A":"1"}}\n' > "$scratch/tree/.claude/settings.json"
cd "$scratch/harness"

run() {
  nvim --headless -u NONE --cmd "set rtp^=$here" -c 'runtime plugin/helm.lua' "$@" 2>&1
}

fail() {
  echo "smoke: FAIL - $1"
  exit 1
}

for uri in profiles effective history "config/$scratch/harness"; do
  out=$(run -c "edit helm://$uri" \
    -c 'lua print(vim.bo.buftype, vim.bo.bufhidden, vim.bo.swapfile, vim.bo.modifiable, vim.bo.readonly, vim.bo.modified, vim.api.nvim_buf_line_count(0), vim.b.helm_kind)' \
    -c 'lua print(vim.api.nvim_buf_get_lines(0, 0, 1, false)[1])' -c qa)
  case "$out" in
    *"nofile wipe false false true false"*) ;;
    *) fail "helm://$uri buffer options: $out" ;;
  esac
  case "$out" in
    *"could not be painted"*) fail "helm://$uri painted a failure: $out" ;;
  esac
  echo "smoke: helm://$uri painted"
done

out=$(run -c "edit helm://config" -c 'lua print(vim.api.nvim_buf_get_lines(0, 0, 1, false)[1])' -c qa)
case "$out" in
  *"could not be painted"*) echo "smoke: a failing buffer paints its sentence" ;;
  *) fail "helm://config without a scope should paint the failure: $out" ;;
esac

# Diagnostics: a deliberately bad effort becomes a diagnostic after :write.
printf 'overlays: []\naccess: []\nmodel: opus\neffort: extreme\n' > "$scratch/harness/.helm/profiles/bad.yaml"
out=$(run -c "edit $scratch/harness/.helm/profiles/bad.yaml" -c write -c 'sleep 1500m' \
  -c 'lua local d = vim.diagnostic.get(0); print("diagnostics", #d, d[1] and d[1].message or "")' -c qa)
case "$out" in
  *"diagnostics 0"*|*"diagnostics nil"*) fail "no diagnostic for effort: extreme: $out" ;;
  *"diagnostics "*) echo "smoke: profile diagnostics set" ;;
  *) fail "diagnostics run: $out" ;;
esac

# Snapshot on write: the row is taken, and a refused snapshot aborts the write.
run -c "edit $scratch/tree/.claude/settings.json" -c 'normal! ggA ' -c write -c qa >/dev/null
rows=$(node "$repo/packages/cli/dist/helm.mjs" config snapshot --list "$scratch/tree/.claude/settings.json" --json | grep -c '"reason"')
[ "$rows" -eq 1 ] || fail "expected one snapshot row after a write, saw $rows"
echo "smoke: snapshot taken before the write"

printf 'x\0y' > "$scratch/tree/.claude/bin"
cp "$scratch/tree/.claude/bin" "$scratch/before.bin"
run -c "edit ++bin $scratch/tree/.claude/bin" -c 'normal! ggA z' -c write -c 'qa!' >/dev/null || true
cmp -s "$scratch/tree/.claude/bin" "$scratch/before.bin" || fail "a refused snapshot did not abort the write"
echo "smoke: refused snapshot aborted the write"

echo "smoke: ok"

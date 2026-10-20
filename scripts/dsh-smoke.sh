#!/usr/bin/env bash
# dsh-hyperliquid — fresh-profile smoke: install the packed tarball into a
# throwaway DSH_HOME, verify the composed config carries the plugin row,
# then boot `dsh web` and check HTTP boot, client plugin activation, and
# that the desk panel actually renders (sidebar entry → .dhl-root → chart
# canvas). Adapted from dsh-bots' scripts/dsh-smoke.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
WEB_PID=""

cleanup() {
  if [ -n "$WEB_PID" ]; then kill "$WEB_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

if [ -z "${DSH_BIN:-}" ] && [ -x "$HOME/.local/bin/dsh" ]; then
  candidate_version="$("$HOME/.local/bin/dsh" --version 2>/dev/null || true)"
  case "$candidate_version" in
    0.2.*|0.3.*|0.4.*|[1-9].*) DSH_BIN="$HOME/.local/bin/dsh" ;;
  esac
fi
DSH_BIN="${DSH_BIN:-$(command -v dsh)}"
if [ "${DSH_SMOKE_ALLOW_LEGACY:-0}" != "1" ]; then
  case "$("$DSH_BIN" --version)" in
    0.2.*|0.3.*|0.4.*|[1-9].*) ;;
    *) echo "FAIL embedded Conversation smoke requires DSH 0.2 or newer; set DSH_BIN to a compatible binary"; exit 1 ;;
  esac
fi
NODE_BIN="${NODE_BIN:-node}"
PORT="${SMOKE_PORT:-4099}"

echo "== build client artifact =="
(cd "$ROOT" && "$NODE_BIN" scripts/build-client.mjs)

echo "== pack plugin ($TMP) =="
(cd "$ROOT" && npm pack --pack-destination "$TMP" >/dev/null)
TGZ="$(ls "$TMP"/dsh-hyperliquid-*.tgz | head -1)"
echo "packed: $TGZ"

export DSH_HOME="$TMP/dsh-home"
# Keep the smoke hermetic: private pnpm store AND cache inside the temp dir,
# so the run never touches (or depends on) the user's global pnpm state
# (~/Library/pnpm + ~/Library/Caches/pnpm).
export npm_config_store_dir="$TMP/pnpm-store"
export npm_config_cache="$TMP/cache/npm"
export XDG_CACHE_HOME="$TMP/cache"
mkdir -p "$npm_config_store_dir" "$npm_config_cache"
mkdir -p "$TMP/home"

echo "== install packed plugin into a fresh DSH profile =="
"$DSH_BIN" plugin --profile web add "$TGZ"

echo "== verify the plugin row exists in the composed config =="
"$DSH_BIN" --profile web --dump-config | grep -q 'dsh-hyperliquid'
echo "PASS plugin appears in DSH config"

echo "== boot dsh web with the plugin loaded (bounded retry, 40s cap) =="
HOME="$TMP/home" "$DSH_BIN" web --port "$PORT" --no-open >"$TMP/web.log" 2>&1 &
WEB_PID=$!

ready=0
for _ in $(seq 1 40); do
  # dsh requires the per-process browser token even for this local probe.
  url="$(grep -m1 -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[^[:space:]]+' "$TMP/web.log" || true)"
  if [ -n "$url" ] && curl --noproxy '*' -sf "$url" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then break; fi
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "FAIL dsh web did not become ready within 40s"
  sed -E 's/token=[^[:space:]]+/token=[redacted]/g' "$TMP/web.log" | tail -40
  exit 1
fi
echo "PASS dsh web booted with the plugin loaded (HTTP 200)"

printf '%s' "$url" | "$NODE_BIN" "$ROOT/scripts/dsh-client-smoke.mjs"

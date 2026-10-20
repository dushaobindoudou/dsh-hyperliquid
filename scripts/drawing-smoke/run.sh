#!/usr/bin/env bash
# Real-host drawing smoke: pack the plugin into a throwaway DSH profile, then
# drive the chart in headless Chrome — interactions, a host restart, every
# drawing tool, fill rationale dots and a pan performance budget.
#   npm run smoke:drawing        (needs dsh ≥ 0.2 and Chrome)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TMP="$(mktemp -d)"; WEB_PID=""
cleanup() { if [ -n "$WEB_PID" ]; then kill "$WEB_PID" 2>/dev/null || true; fi; rm -rf "$TMP"; }
trap cleanup EXIT
DSH_BIN="${DSH_BIN:-$(command -v dsh)}"; NODE_BIN="${NODE_BIN:-node}"; PORT="${SMOKE_PORT:-4099}"
(cd "$ROOT" && "$NODE_BIN" scripts/build-client.mjs >/dev/null)
(cd "$ROOT" && npm pack --pack-destination "$TMP" >/dev/null 2>&1)
# SMOKE_TGZ=/path/to/dsh-hyperliquid-x.y.z.tgz tests a published build instead of this checkout.
TGZ="${SMOKE_TGZ:-$(ls "$TMP"/dsh-hyperliquid-*.tgz | head -1)}"
export DSH_HOME="$TMP/dsh-home" npm_config_store_dir="$TMP/pnpm-store" npm_config_cache="$TMP/cache/npm" XDG_CACHE_HOME="$TMP/cache"
export DRAWING_SMOKE_STATE="$TMP/phase1-state.json"
mkdir -p "$npm_config_store_dir" "$npm_config_cache" "$TMP/home"
"$DSH_BIN" plugin --profile web add "$TGZ" >/dev/null
boot() {
  : > "$TMP/web.log"
  HOME="$TMP/home" "$DSH_BIN" web --port "$PORT" --no-open >"$TMP/web.log" 2>&1 &
  WEB_PID=$!; url=""
  for _ in $(seq 1 90); do
    url="$(grep -m1 -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[^[:space:]]+' "$TMP/web.log" || true)"
    if [ -n "$url" ] && curl --noproxy '*' --max-time 3 -sf "$url" >/dev/null 2>&1; then return 0; fi
    if ! kill -0 "$WEB_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  echo "FAIL dsh web did not become ready"
  sed -E 's/(token=)[^[:space:]]+/\1[redacted]/g' "$TMP/web.log" | tail -n 20
  exit 1
}
run() { echo "== $1"; printf '%s' "$url" | "$NODE_BIN" "$HERE/$1"; }
boot
if [ "${DRAWING_SMOKE_ONLY:-}" = "basics" ]; then run basics.mjs; exit 0; fi
if [ "${DRAWING_SMOKE_ONLY:-}" = "navigation" ]; then run navigation.mjs; exit 0; fi
if [ "${DRAWING_SMOKE_ONLY:-}" = "research" ]; then run research.mjs; exit 0; fi
# DRAWING_SMOKE_ONLY=basics,research runs just those phases, in order, on one host.
if [ -n "${DRAWING_SMOKE_ONLY:-}" ]; then IFS=, read -ra ONLY <<< "$DRAWING_SMOKE_ONLY"; for phase in "${ONLY[@]}"; do run "$phase.mjs"; done; exit 0; fi
run phase1.mjs
kill "$WEB_PID"; wait "$WEB_PID" 2>/dev/null || true; WEB_PID=""
boot
run phase2.mjs
run basics.mjs
run settings.mjs
run research.mjs
run phase3.mjs
run tools2.mjs
run fills.mjs
run phase4.mjs
run phase5.mjs
run touch.mjs
run trackpad.mjs
run webkit.mjs
run perf.mjs
echo "drawing smoke: all phases passed"

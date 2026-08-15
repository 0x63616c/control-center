#!/usr/bin/env bash
# Open Text Your Ex in a cmux browser pane to the right, framed as an iPhone 16 Pro Max.
#
# Run this from a REAL cmux terminal pane (your interactive shell), NOT via Claude's `!`
# or a background agent - cmux rejects CLI calls whose process ancestry isn't a
# cmux-hosted shell (manaflow-ai/cmux#3089), which is why the agent couldn't do it.
#
#   ./scripts/open-pane.sh                 # default: iPhone 16 Pro Max (440x956)
#   DEVICE=16pro ./scripts/open-pane.sh    # or 16, 16promax, default
#
set -euo pipefail

WEB_PORT="${WEB_PORT:-5173}"
API_PORT="${API_PORT:-8787}"
DEVICE="${DEVICE:-16promax}"
URL="http://localhost:${WEB_PORT}/?device=${DEVICE}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\033[1;33m[open-pane]\033[0m %s\n' "$*"; }

# ── 1. Make sure the app is actually running ───────────────────────────────
if curl -sf "http://localhost:${WEB_PORT}/" >/dev/null 2>&1; then
  say "app already running on :${WEB_PORT}"
else
  say "app not up - starting it with Tilt…"
  if command -v tilt >/dev/null 2>&1; then
    ( cd "$REPO_ROOT" && nohup tilt up --stream >/tmp/tye-tilt.log 2>&1 & )
  else
    say "tilt not found, falling back to 'bun run dev'"
    ( cd "$REPO_ROOT" && nohup bun run dev >/tmp/tye-dev.log 2>&1 & )
  fi
  say "waiting for :${WEB_PORT} and :${API_PORT}…"
  for _ in $(seq 1 60); do
    if curl -sf "http://localhost:${WEB_PORT}/" >/dev/null 2>&1 \
       && curl -sf "http://localhost:${API_PORT}/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  curl -sf "http://localhost:${WEB_PORT}/" >/dev/null 2>&1 || { say "app failed to come up - check /tmp/tye-tilt.log"; exit 1; }
  say "app is up"
fi

# ── 2. Open the cmux browser pane to the right ─────────────────────────────
say "opening cmux browser pane → ${URL}"
opened=no
if cmux new-pane --type browser --direction right --url "$URL" --focus true; then
  opened=yes
else
  say "cmux new-pane failed; trying 'cmux open'…"
  if cmux open "$URL"; then opened=yes; fi
fi

if [ "$opened" != yes ]; then
  cat <<EOF

cmux CLI refused the connection. Two fallbacks:
  1. Open a browser pane in cmux manually (split right) and paste:
       ${URL}
  2. If the CLI is wedged from long uptime (cmux#2890), restarting cmux.app
     clears it - but that tears down all live panes, so only if you're okay with that.
EOF
  exit 1
fi

# ── 3. Check the pane actually came up ─────────────────────────────────────
say "verifying the pane…"
sleep 1
if cmux list-pane-surfaces 2>/dev/null | grep -qiE "browser|5173"; then
  say "✓ browser surface is present in the workspace"
elif cmux list-panes 2>/dev/null | grep -qi browser; then
  say "✓ browser pane is present"
else
  say "pane opened, but couldn't confirm it via list-panes (it should be visible on the right)"
fi
# Re-confirm the app endpoint is serving the framed view
if curl -sf "$URL" >/dev/null 2>&1; then
  say "✓ app responds at ${URL}"
fi
say "done - Text Your Ex loaded to the right as iPhone ${DEVICE}. Take a look 👀"

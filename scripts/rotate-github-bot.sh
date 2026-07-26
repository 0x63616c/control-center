#!/usr/bin/env bash
# Interactive rotation for the www-software-factory-bot GitHub App credentials (#125).
#
# Regenerate the values in the App settings UI first:
#   https://github.com/settings/apps/www-software-factory-bot
#     - Private keys   -> Generate a private key (downloads a .pem), delete the old
#     - Client secrets -> Generate a new client secret, delete the old
#     - Webhook        -> Change the secret to a fresh random value
#
# Then run this and paste the two values when prompted. The .pem is picked up
# from disk (newest matching file in ~/Downloads by default) rather than pasted,
# because it is multi-line.
#
# Usage: scripts/rotate-github-bot.sh [--pem <path>]
#
# Nothing is echoed: prompts are silent, values go straight into SOPS, and the
# only output is which vault keys changed. Skip any prompt by pressing Enter and
# that credential is left alone — so rotating just the webhook secret is fine.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SET_SECRET="$REPO_ROOT/scripts/set-secret.sh"

PEM_PATH=""
if [ "${1:-}" = "--pem" ]; then
  PEM_PATH="${2:?--pem needs a path}"
fi

# Newest www-software-factory-bot*.pem in ~/Downloads, if the caller did not say.
if [ -z "$PEM_PATH" ]; then
  PEM_PATH="$(find "$HOME/Downloads" -maxdepth 1 -name 'www-software-factory-bot*.pem' -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null | head -1 || true)"
fi

echo "Rotating www-software-factory-bot credentials."
echo "Press Enter at any prompt to leave that credential unchanged."
echo

rotated=()

# read -rsp keeps the paste off the screen and out of shell history.
read -rsp "New client secret: " CLIENT_SECRET
echo
if [ -n "$CLIENT_SECRET" ]; then
  printf '%s\n' "$CLIENT_SECRET" | "$SET_SECRET" GITHUB_BOT_APP__CLIENT_SECRET
  rotated+=("GITHUB_BOT_APP__CLIENT_SECRET")
fi
unset CLIENT_SECRET

read -rsp "New webhook secret: " WEBHOOK_SECRET
echo
if [ -n "$WEBHOOK_SECRET" ]; then
  printf '%s\n' "$WEBHOOK_SECRET" | "$SET_SECRET" GITHUB_BOT_APP__WEBHOOK_SECRET
  rotated+=("GITHUB_BOT_APP__WEBHOOK_SECRET")
  WEBHOOK_ROTATED=1
fi
unset WEBHOOK_SECRET

if [ -n "$PEM_PATH" ] && [ -f "$PEM_PATH" ]; then
  read -rp "Use private key $PEM_PATH? [y/N] " USE_PEM
  if [ "$USE_PEM" = "y" ] || [ "$USE_PEM" = "Y" ]; then
    # Base64 so the multi-line PEM survives as a single vault value, matching
    # the APNs / App Store Connect .p8 handling.
    base64 < "$PEM_PATH" | tr -d '\n' | "$SET_SECRET" GITHUB_BOT_APP__PRIVATE_KEY_PEM
    rotated+=("GITHUB_BOT_APP__PRIVATE_KEY_PEM")
  fi
else
  echo "No .pem found in ~/Downloads; pass --pem <path> to rotate the private key."
fi

echo
if [ ${#rotated[@]} -eq 0 ]; then
  echo "Nothing rotated."
  exit 0
fi

echo "Updated in secrets/vault.yaml:"
for k in "${rotated[@]}"; do echo "  - $k"; done
echo
echo "Next:"
echo "  git add secrets/vault.yaml && git commit -m 'chore(secrets): rotate github bot credentials'"
echo "  push, merge — the deploy rolls the k8s Secret."

if [ -n "${WEBHOOK_ROTATED:-}" ]; then
  cat <<'NOTE'

⚠️  Webhook secret rotated. The running api still verifies against the OLD
    secret until the deploy lands, so deliveries in that window get a 401 and
    GitHub does NOT retry them automatically.

    After the deploy, open the App's Advanced -> Recent Deliveries and hit
    Redeliver on anything that failed. Replaying is safe: incoming_webhook is
    keyed on the delivery id, so a redelivery cannot duplicate a row.
NOTE
fi

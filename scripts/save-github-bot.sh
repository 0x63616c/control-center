#!/usr/bin/env bash
# Stores the www-software-factory-bot GitHub App credentials in the SOPS vault (#125).
#
# Reads the JSON that scripts/create-github-bot-app.ts wrote (the App-manifest
# conversion response), so no value is ever typed, pasted or echoed.
#
# Usage:
#   scripts/save-github-bot.sh <conversion-json>            # after creating the App
#   scripts/save-github-bot.sh <conversion-json> <install-id>
#
# The installation id only exists after the App is installed on the repo, so it
# is an optional second argument; re-run with it once the install is done.
#
# Idempotent: re-running just re-sets the vault fields. That is also the rotation
# path - regenerate the private key / client secret / webhook secret in the App
# settings UI, drop them into a JSON file of the same shape, and re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SET_SECRET="$REPO_ROOT/scripts/set-secret.sh"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <conversion-json> [installation-id]" >&2
  exit 1
fi

JSON="$1"
INSTALL_ID="${2:-}"

if [ ! -f "$JSON" ]; then
  echo "Error: $JSON not found" >&2
  exit 1
fi

# The PEM is multi-line; base64 it so it survives as a single vault value, the
# same handling the APNs / App Store Connect .p8 keys already use.
set_from_json() {
  local key="$1" jq_path="$2"
  local value
  value="$(jq -r "$jq_path" "$JSON")"
  if [ -z "$value" ] || [ "$value" = "null" ]; then
    echo "Error: $jq_path missing from $JSON" >&2
    exit 1
  fi
  printf '%s\n' "$value" | "$SET_SECRET" "$key"
}

echo "Storing GitHub App credentials from $JSON ..."
set_from_json GITHUB_BOT_APP__APP_ID '.id'
set_from_json GITHUB_BOT_APP__CLIENT_ID '.client_id'
set_from_json GITHUB_BOT_APP__CLIENT_SECRET '.client_secret'
set_from_json GITHUB_BOT_APP__WEBHOOK_SECRET '.webhook_secret'
set_from_json GITHUB_BOT_APP__PRIVATE_KEY_PEM '.pem | @base64'

if [ -n "$INSTALL_ID" ]; then
  printf '%s\n' "$INSTALL_ID" | "$SET_SECRET" GITHUB_BOT_APP__INSTALLATION_ID
else
  echo "No installation id given; re-run with it once the App is installed."
fi

echo "Done. Commit the re-encrypted secrets/vault.yaml."

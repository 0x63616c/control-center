#!/usr/bin/env bash
# Flashes infra/esphome/ble-proxy.yaml to 192.168.0.211 over OTA. WiFi SSID
# comes from the SOPS vault, password from 1Password (op read) — both land in
# a secrets.yaml inside a mktemp -d scratch dir, used once, then deleted.
# 192.168.0.211 is a UniFi DHCP reservation for this device's MAC, so the IP
# never changes. Only for changes that can't break connectivity (no antenna/
# RF/WiFi/board edits) — see infra/esphome/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/infra/esphome/ble-proxy.yaml"
DEVICE="192.168.0.211"

command -v op >/dev/null 2>&1 || { echo "error: 1Password CLI (op) not installed" >&2; exit 1; }
op whoami >/dev/null 2>&1 || { echo "error: not signed in to 1Password — run 'op signin' first" >&2; exit 1; }

WIFI_SSID="$(SOPS_AGE_KEY=$(security find-generic-password -a "$USER" -s "age-world-wide-webb-private-key" -w) \
  sops exec-env "$ROOT/secrets/vault.yaml" 'echo "$WIFI_MAIN_CREDENTIALS__SSID"')"
[ -n "$WIFI_SSID" ] || { echo "error: WIFI_MAIN_CREDENTIALS__SSID missing from vault" >&2; exit 1; }

WIFI_PASSWORD="$(op read "op://Private/WiFI - world-wide-webb/wireless network password")"
[ -n "$WIFI_PASSWORD" ] || { echo "error: could not read WiFi password from 1Password" >&2; exit 1; }

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

cp "$CONFIG" "$SCRATCH/ble-proxy.yaml"
umask 077
cat > "$SCRATCH/secrets.yaml" <<EOF
wifi_ssid: "$WIFI_SSID"
wifi_password: "$WIFI_PASSWORD"
EOF

echo "Flashing ble-proxy.yaml to $DEVICE over OTA..."
~/.local/bin/uvx esphome run "$SCRATCH/ble-proxy.yaml" --device "$DEVICE"

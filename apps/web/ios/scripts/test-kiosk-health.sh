#!/usr/bin/env bash
# Red/green guard for the kiosk recovery logic (www-bwoy).
#
# Compiles the UIKit-free KioskHealth core alongside its test driver with
# swiftc and runs it. No Xcode project, scheme, or simulator required, so it
# can run anywhere a Swift toolchain exists (dev box; optionally CI later).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$here/../App/App"
tests="$here/../App/AppTests"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found , skipping kiosk-health guard (install Xcode CLT to run it)" >&2
  exit 0
fi

bin="$(mktemp -d)/kiosk-health-tests"
trap 'rm -rf "$(dirname "$bin")"' EXIT

# KioskHealth.swift is pure Foundation; the test file owns @main.
swiftc -O \
  "$app/KioskHealth.swift" \
  "$app/PanelDiagnosticsModels.swift" \
  "$tests/KioskHealthTests.swift" \
  -o "$bin"
"$bin"

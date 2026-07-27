#!/usr/bin/env bash
# Guard for the CI product-image builds: amd64-only, native, no emulation.
# The home-server Talos node is x86 and is the only deploy target (the arm64
# Mac mini was retired 2026-07-25), so an arm64 leg is pure wasted CI time and
# a QEMU fallback would make bun builds OOM/timeout-prone.
set -euo pipefail
f=.github/workflows/ci.yml
a=.github/actions/build-product-image/action.yml

grep -q 'linux/amd64' "$a" || { echo "FAIL: build action must target linux/amd64"; exit 1; }
# NOTE: `\b` sits at a word/non-word boundary, and '4'|'-' IS such a boundary,
# so a bare `grep -q 'ubuntu-24.04\b'` also matches 'ubuntu-24.04-arm'. Anchor
# on the literal value at EOL so it's disjoint from the arm64 runner string.
grep -qE 'runs-on: ubuntu-24\.04$' "$f" || { echo "FAIL: amd64 build runner missing"; exit 1; }

! grep -q 'ubuntu-24.04-arm' "$f" || { echo "FAIL: arm64 runner leg is back"; exit 1; }
! grep -q 'linux/arm64' "$f" "$a" || { echo "FAIL: arm64 build platform is back"; exit 1; }
# Match the `uses:` line only, so the explanatory comments (which name the
# action) don't trip the guard.
! grep -qE '^\s*(-\s+)?uses:.*setup-qemu-action' "$f" "$a" || { echo "FAIL: QEMU emulation is back"; exit 1; }
! grep -q 'imagetools create' "$f" || { echo "FAIL: manifest-merge job is back (single-arch needs none)"; exit 1; }

echo "PASS"

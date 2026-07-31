#!/usr/bin/env bash
# Guards the regression smoke case itself when Docker is unavailable locally.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
smoke="$script_dir/smoke.sh"

grep -Fq 'bun run check resolves Go on PATH' "$smoke"
grep -Fq 'bun run check' "$smoke"
grep -Fq 'REPO_DIR' "$smoke"
grep -Fq -- '--mount "type=bind,src=$REPO_DIR,dst=/mnt/repo,readonly"' "$smoke"
grep -Fq 'cp -R /mnt/repo/. /work/repo' "$smoke"

#!/usr/bin/env bash
# Verifies the separately named target image and its per-command credential
# readers. The shared toolchain/uid/workspace contract is still asserted by
# the legacy image smoke because the target intentionally carries the same
# repository toolchain during the additive migration.
set -euo pipefail

cd "$(dirname "$0")"
img="${1:-sf-run-worker:local}"

../sandbox/smoke.sh "$img"

cred_dir="$(mktemp -d)"
trap 'rm -rf "$cred_dir"' EXIT
printf '%s' 'bot[bot]' >"$cred_dir/login"
printf '%s' 'smoke-token' >"$cred_dir/token"
chmod 0755 "$cred_dir"
chmod 0644 "$cred_dir/login" "$cred_dir/token"

docker run --rm --platform linux/amd64 \
  --entrypoint /bin/sh \
  --mount "type=bind,src=$cred_dir,dst=/var/run/secrets/software-factory/github,readonly" \
  "$img" -eu -c '
    command -v run-worker >/dev/null
    command -v git-credential-projected >/dev/null
    command -v gh >/dev/null
    test "$(git config --system credential.helper)" = /usr/local/bin/git-credential-projected
    credential="$(printf "protocol=https\nhost=github.com\n\n" | git-credential-projected get)"
    case "$credential" in
      *"username=bot[bot]"*"password=smoke-token"*) ;;
      *) exit 1 ;;
    esac
    gh --version >/dev/null
  '

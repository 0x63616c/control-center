#!/usr/bin/env bash
# Asserts the sandbox image's contract with internal/clients/k8s, against a
# built image rather than against the Dockerfile that claims to produce it.
#
# Everything here is a fact some Go code already depends on: exec.go execs
# argv directly (no shim, since #434 deleted it — step 3 of the
# software-factory migration), transfer.go execs tar/test/cat, podspec.go pins
# uid 1000 and mounts an emptyDir at /work. A unit test cannot reach any of
# them — the image is the unit.
#
# /work is mounted as a tmpfs here, because that is what an emptyDir does to it:
# anything baked under /work at build time is MASKED at runtime. Running these
# without the mount would pass on an image that fails in the cluster.
#
# Usage: images/sandbox/smoke.sh [image]
set -euo pipefail

IMG="${1:-sf-sandbox:local}"
# /work is mounted the way a kubelet mounts an emptyDir under `fsGroup: 1000`:
# owned root:1000, setgid, GROUP-writable — NOT owned by the sandbox uid. The
# difference is load-bearing. A uid-owned tmpfs passes checks that the real pod
# fails, which is exactly how a permission bug reaches the first live ticket.
RUN=(docker run --rm --platform linux/amd64
  --tmpfs "/work:uid=0,gid=1000,mode=2775")

fail=0
check() { # check <name> <expected-exit> <cmd...>
  local name="$1" want="$2"
  shift 2
  local out got
  set +e
  out="$("${RUN[@]}" "$IMG" "$@" 2>&1)"
  got=$?
  set -e
  if [ "$got" != "$want" ]; then
    printf 'FAIL %s: exit %s, want %s\n%s\n' "$name" "$got" "$want" "$out" >&2
    fail=1
    return
  fi
  printf 'ok   %s\n' "$name"
  [ -n "$out" ] && printf '     %s\n' "$out"
  return 0
}

# The four argv-only contracts, plus the toolchains a ticket needs to build and
# test this repo.
# A LOOP, not `command -v a b c`. That form is vacuous, and HOW it is vacuous
# depends on the shell — measured, because the wrong mechanism in a comment is
# how the next person writes the same bug somewhere else:
#
#   dash (this check, run via `sh`)  reads the FIRST name and ignores the rest:
#                                    `command -v tar nope` 0, `nope tar` 127
#   bash (this FILE's shebang)       reads them all and exits 0 if ANY resolves:
#                                    both orders 0
#   zsh                              exits 1 if any is missing — would have
#                                    caught the original
#
# So the one-liner this replaces asserted `tar` and nothing else here, and would
# have asserted "at least one of nine" in a bash script. Every other binary
# could have vanished with the suite still green either way. A check that cannot
# fail is worse than no check, because it reads as verified.
check "every binary the worker's argv names is on PATH" 0 \
  /usr/bin/env sh -c '
    for b in tar test cat git bun bunx node go; do
      command -v "$b" >/dev/null || { echo "missing: $b"; exit 1; }
    done'

# GNU tar specifically: transfer.go extracts relative names with -C /, and the
# two tars differ on leading-slash handling and on delayed set-stat failures.
check "tar is GNU tar" 0 \
  /usr/bin/env sh -c 'tar --version | head -1 | grep -q "GNU tar"'

# podspec.go pins runAsUser/runAsGroup/fsGroup to 1000. Read's ownership
# invariant — `test -e` exiting 1 means absent, not unreadable — holds only
# while one uid owns everything written under /work.
check "runs as uid/gid 1000" 0 \
  /usr/bin/env sh -c '[ "$(id -u)" = 1000 ] && [ "$(id -g)" = 1000 ]'

# The remote-process checks that used to live here were deleted with the
# removed pods/exec mechanism (#434, step 3). The embedded worker now holds a
# real os/exec.Cmd it can cancel directly.

# WORKDIR is the sandbox worker's cwd. It must be writable BY THE
# SANDBOX UID under a kubelet-shaped mount, which is the whole reason it is
# /work and not the checkout: a WORKDIR the runtime has to create inside the
# emptyDir is created as root, mode 0755, and the sandbox cannot write it.
check "the stage cwd is the sandbox root and the sandbox uid can write it" 0 \
  /usr/bin/env sh -c '[ "$(pwd)" = /work ] && touch ./cwd-probe'

# The other half of that contract: a directory the PROCESS creates under /work
# is owned by the process, which is why the clone can create its own checkout.
check "a directory the process creates under /work is writable by it" 0 \
  /usr/bin/env sh -c 'mkdir -p /work/repo && touch /work/repo/probe'

# The pinned versions are both asserted and logged: a bump is visible in the
# run log, while a failed or empty version command fails the named check.
check "pinned tool versions" 0 \
  /usr/bin/env sh -c '
    bun_version="$(bun --version)" || { echo "bun --version failed"; exit 1; }
    [ -n "$bun_version" ] || { echo "bun --version returned empty output"; exit 1; }

    bunx_version="$(bunx --version)" || { echo "bunx --version failed"; exit 1; }
    [ -n "$bunx_version" ] || { echo "bunx --version returned empty output"; exit 1; }

    node_version="$(node --version)" || { echo "node --version failed"; exit 1; }
    [ -n "$node_version" ] || { echo "node --version returned empty output"; exit 1; }

    go_version="$(go version)" || { echo "go version failed"; exit 1; }
    [ -n "$go_version" ] || { echo "go version returned empty output"; exit 1; }

    git_version="$(git --version)" || { echo "git --version failed"; exit 1; }
    [ -n "$git_version" ] || { echo "git --version returned empty output"; exit 1; }

    echo "bun $bun_version | bunx $bunx_version | node $node_version | $go_version | $git_version"
  '

# A real Playwright page screenshot proves that the browser bundle is outside
# the masked /work mount, that uid 1000 can discover it, and that Chromium's
# shared libraries are complete. The CLI launches headless by default; a native
# browser window or its tab chrome would require a separate display/compositor
# and is not what Playwright page screenshots capture.
check "Playwright Chromium writes a non-empty headless screenshot" 0 \
  /usr/bin/env sh -c '
    screenshot=/tmp/sandbox-playwright-smoke.png
    rm -f "$screenshot"
    test "$PLAYWRIGHT_BROWSERS_PATH" = /ms-playwright
    bunx --yes playwright@1.60.0 screenshot \
      "data:text/html,%3Ch1%3Esandbox%20screenshot%3C%2Fh1%3E" \
      "$screenshot"
    test -s "$screenshot"
  '

# `install-deps chromium` supplies Xvfb on Trixie; the Dockerfile adds xauth,
# which `xvfb-run` needs and the resolver does not. Keep a headed browser open
# under a display larger than the 1366x1024 panel viewport: the acceptance
# checklist calls out that browser chrome otherwise steals vertical pixels.
# Playwright's `open` command is headed unless PWTEST_CLI_HEADLESS is set, and
# `timeout` must therefore expire. A launch failure exits before 5 seconds and
# fails this check instead of being mistaken for a working display.
check "Playwright opens a headed 1366x1024 Chromium window under Xvfb" 124 \
  /usr/bin/env sh -c '
    timeout 5 xvfb-run -a -s "-screen 0 1400x1100x24" \
      bunx --yes playwright@1.60.0 open \
        --viewport-size "1366,1024" \
        --user-data-dir /tmp/sandbox-playwright-headed-profile \
        "data:text/html,%3Ch1%3Eheaded%20sandbox%20browser%3C%2Fh1%3E"
  '

# Vitest's forks pool reaches this exact Bun compatibility path. Checking only
# `node` on PATH would miss a broken Bun-to-Node handoff.
check "Bun can fork a Node child" 0 \
  /usr/bin/env sh -c '
    probe_dir="$(mktemp -d)"
    trap "rm -rf \"$probe_dir\"" EXIT
    printf "process.exit(0)\\n" > "$probe_dir/child.cjs"
    bun -e "
      import { fork } from \"node:child_process\";
      const child = fork(process.argv[1], [], {
        execPath: \"node\",
        stdio: \"ignore\",
      });
      child.once(\"error\", (error) => {
        console.error(error);
        process.exit(1);
      });
      child.once(\"exit\", (code, signal) => {
        process.exit(code === 0 && signal === null ? 0 : 1);
      });
    " "$probe_dir/child.cjs"
  '

exit "$fail"

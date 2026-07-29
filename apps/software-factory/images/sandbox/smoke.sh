#!/usr/bin/env bash
# Asserts the sandbox image's contract with internal/clients/k8s, against a
# built image rather than against the Dockerfile that claims to produce it.
#
# Everything here is a fact some Go code already depends on: exec.go execs
# /usr/local/bin/sandbox-exec, transfer.go execs tar/test/cat, podspec.go pins
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
# A LOOP, not `command -v a b c`. That form checks only its FIRST argument and
# exits 0 — verified in this image: `command -v tar definitely-not-a-binary`
# exits 0, and reversing the arguments exits 127. The one-liner this replaces
# therefore asserted `tar` and nothing else, so every other binary here could
# have vanished with the suite still green. A check that cannot fail is worse
# than no check, because it reads as verified.
check "every binary the worker's argv names is on PATH" 0 \
  /usr/bin/env sh -c '
    for b in tar test cat git bun go codex sandbox-exec pgrep; do
      command -v "$b" >/dev/null || { echo "missing: $b"; exit 1; }
    done'

# Stage liveness is `pgrep -f <result path>` (B5). If pgrep is absent the runner
# does not error — it reports "nothing running" and the retry starts a SECOND
# copy of a stage that never stopped. `-f` specifically, since the match is
# against codex's full argv rather than its process name.
check "pgrep matches against a full argv, which is how stage liveness works" 0 \
  /usr/bin/env sh -c 'sleep 30 & sleep 0.2; pgrep -f "sleep 30" >/dev/null'

# GNU tar specifically: transfer.go extracts relative names with -C /, and the
# two tars differ on leading-slash handling and on delayed set-stat failures.
check "tar is GNU tar" 0 \
  /usr/bin/env sh -c 'tar --version | head -1 | grep -q "GNU tar"'

# podspec.go pins runAsUser/runAsGroup/fsGroup to 1000. Read's ownership
# invariant — `test -e` exiting 1 means absent, not unreadable — holds only
# while one uid owns everything written under /work.
check "runs as uid/gid 1000" 0 \
  /usr/bin/env sh -c '[ "$(id -u)" = 1000 ] && [ "$(id -g)" = 1000 ]'

# THE one this image is most likely to ship broken: no .exec directory can be
# baked, because the emptyDir masks it. Without the shim's mkdir the pidfile
# never appears, --kill is a silent no-op, and kill-on-cancel is defeated while
# still logging that a kill was attempted.
check "the shim creates its pidfile's parent under a masked /work" 0 \
  sandbox-exec --pidfile /work/.exec/smoke.pid -- \
  /usr/bin/env sh -c 'test -s /work/.exec/smoke.pid'

# The stage success/failure signal is the child's exit code, relayed through
# the shim and out through remotecommand.
check "the shim forwards a zero child status" 0 sandbox-exec --pidfile /work/.exec/t.pid -- /bin/true
check "the shim forwards a non-zero child status" 1 sandbox-exec --pidfile /work/.exec/f.pid -- /bin/false

# --kill must reach the whole tree: a stage's real cost is what codex spawns.
check "--kill stops the process group, not just the child" 0 \
  /usr/bin/env sh -c '
    sandbox-exec --pidfile /work/.exec/k.pid -- /usr/bin/env sh -c "sleep 60 & echo \$! > /work/gc.pid; wait" &
    # Bounded: an image whose shim never writes a pidfile must FAIL here, not
    # hang the whole suite waiting for a file that is never coming.
    for _ in $(seq 200); do [ -s /work/.exec/k.pid ] && [ -s /work/gc.pid ] && break; sleep 0.05; done
    [ -s /work/.exec/k.pid ] || { echo "no pidfile appeared"; exit 1; }
    [ -s /work/gc.pid ] || { echo "the grandchild never started"; exit 1; }
    gc=$(cat /work/gc.pid)
    sandbox-exec --kill /work/.exec/k.pid
    for _ in $(seq 100); do kill -0 "$gc" 2>/dev/null || exit 0; sleep 0.1; done
    echo "grandchild $gc survived"; exit 1'

# WORKDIR is the cwd every `codex exec` inherits — pods/exec runs with the
# container's cwd and podspec.go sets no WorkingDir. It must be writable BY THE
# SANDBOX UID under a kubelet-shaped mount, which is the whole reason it is
# /work and not the checkout: a WORKDIR the runtime has to create inside the
# emptyDir is created as root, mode 0755, and the sandbox cannot write it.
check "the stage cwd is the sandbox root and the sandbox uid can write it" 0 \
  /usr/bin/env sh -c '[ "$(pwd)" = /work ] && touch ./cwd-probe'

# The other half of that contract: a directory the PROCESS creates under /work
# is owned by the process, which is why the clone can create its own checkout.
check "a directory the process creates under /work is writable by it" 0 \
  /usr/bin/env sh -c 'mkdir -p /work/repo && touch /work/repo/probe'

# The pinned versions, echoed so a bump is visible in the run log rather than
# only in a diff.
check "pinned tool versions" 0 \
  /usr/bin/env sh -c 'echo "codex $(codex --version) | bun $(bun --version) | $(go version) | $(git --version)"'

exit "$fail"

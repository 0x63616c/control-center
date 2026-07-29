# syntax=docker/dockerfile:1

# The per-ticket sandbox (ADR-0011): a session that stages `codex exec` into,
# not a batch job. The pod's command is `sleep infinity` and every stage arrives
# as a pods/exec, so nothing in here is an entrypoint in the usual sense.
#
# Everything the worker runs inside this image is a contract with
# internal/clients/k8s, and every one of those contracts is argv-only — no shell
# is ever invoked by the worker, on any path:
#
#   /usr/local/bin/sandbox-exec   cmd/sandbox-exec — the pidfile shim that makes
#                                 a stage killable (exec.go: shimPath)
#   tar                           file-in, `tar -xf - -C /` (transfer.go)
#   test                          the file-existence probe (transfer.go)
#   cat                           file-out (transfer.go)
#   pgrep                         stage liveness, `pgrep -f <result path>` (B5).
#                                 LOAD-BEARING, not a nicety: it is the only way
#                                 the runner knows a stage is already running, so
#                                 without it every retry re-runs a live stage.
#                                 Asserted at build time below.
#
# A shell IS present, because `codex exec`'s own job is running shell commands
# on the agent's behalf. "No shell" is a rule about how the WORKER invokes this
# image, not about what the image contains — an image without one could not run
# a single ticket.
#
# amd64 only. The home-server Talos node is the only deploy target and it is
# x86; CI builds --platform linux/amd64 on a native runner.

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: the shim, and the Go toolchain the runtime stage borrows.
#
# The version comes from the image tag rather than a second declaration, and it
# is deliberately the same Go the worker is built with and the same one go.mod
# declares: a ticket that edits this module is tested inside this sandbox, so a
# toolchain skew here shows up as a test failure the reviewer cannot reproduce.
FROM golang:1.26.5-trixie AS build
WORKDIR /src

# The module has no vendor directory, so deps come from the proxy. Copied
# separately from the source so a source-only edit reuses the download layer.
COPY apps/software-factory/go.mod apps/software-factory/go.sum ./
RUN go mod download

COPY apps/software-factory/ ./
# Static: the shim is copied into a different base than it was built in, and a
# dynamically linked one would depend on that base's libc by accident.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/sandbox-exec ./cmd/sandbox-exec

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: the sandbox itself.
FROM debian:trixie-slim

# Pinned by version AND by checksum. A version tag alone is a moving target for
# a GitHub release asset, and this image executes what it downloads.
#
# codex is pinned to the version ADR-0011's auth behaviour was verified against
# (§"Auth: one refresh token, in exactly one place"). Bumping it means re-testing
# the blanked-refresh_token path, not just editing this number.
ARG CODEX_VERSION=0.145.0
ARG CODEX_SHA256=bfaf13c9ba34f2ad764e4a916c49cf7177aeba329cf0f719e2227566fc8d662a
# bun matches the version CI and the rest of this repo build with
# (.github/workflows/ci.yml, oven-sh/setup-bun). A ticket's `bun install` must
# resolve the same lockfile the reviewer's machine does.
ARG BUN_VERSION=1.2.19
ARG BUN_SHA256=c3d3c14e9a5ec83ff67d0acfe76e4315ad06da9f34f59fc7b13813782caf1f66

# GNU tar, coreutils (test, cat) and a shell come from the base image. Added
# here: git, because `implement` pushes a branch and GitHub is the durable state
# between stages; ca-certificates for the OpenAI and GitHub APIs; curl and unzip
# for the two downloads below; passwd for groupadd/useradd, which trixie-slim
# omits; procps for pgrep.
#
# procps is a DIRECT dependency of this image, not a convenience. B5's stage
# liveness probe is `pgrep -f <result path>`, and debian:trixie-slim ships no
# pgrep, no pkill and no ps — measured against the base image, not assumed. Its
# absence has to fail this build, because it does not fail at runtime: a missing
# pgrep reports "no stage running", and the retry starts a second copy of a
# stage that never stopped, two models writing one result file. What that probe
# does and does not answer — liveness, never identity — is in ../README.md.
#
# The assertions below are the point of failing here rather than at 2am. One
# call per binary, because the multi-name form asserts less than it reads as:
# `RUN` execs `/bin/sh -c`, and in dash `command -v a b c` checks only its FIRST
# name (in bash it checks all and exits 0 if ANY resolves). Either way a single
# line naming four would assert one and imply four.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        passwd \
        procps \
        unzip \
    && rm -rf /var/lib/apt/lists/* \
    && command -v pgrep >/dev/null \
    && command -v tar >/dev/null \
    && command -v test >/dev/null \
    && command -v cat >/dev/null

RUN curl -fsSL -o /tmp/codex.tar.gz \
        "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz" \
    && echo "${CODEX_SHA256}  /tmp/codex.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/codex.tar.gz -C /tmp \
    && install -m 0755 /tmp/codex-x86_64-unknown-linux-musl /usr/local/bin/codex \
    && rm -rf /tmp/codex.tar.gz /tmp/codex-x86_64-unknown-linux-musl \
    && codex --version

RUN curl -fsSL -o /tmp/bun.zip \
        "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
    && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp \
    && install -m 0755 /tmp/bun-linux-x64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun.zip /tmp/bun-linux-x64 \
    && bun --version

# The Go toolchain, taken from the build stage rather than downloaded again, so
# it cannot drift from the version this module declares.
COPY --from=build /usr/local/go /usr/local/go
# Prepended, not replaced: the base image's PATH is what puts tar, test and
# cat where the worker's argv expects them.
ENV PATH=/usr/local/go/bin:$PATH
ENV GOTOOLCHAIN=local

COPY --from=build /out/sandbox-exec /usr/local/bin/sandbox-exec

# uid/gid 1000, and it is a contract, not a convention: podspec.go pins
# runAsUser/runAsGroup/fsGroup to 1000 (sandboxUID) so that Read's ownership
# invariant holds — `test -e` exiting 1 must mean absent rather than unreadable,
# which is only true while one uid owns everything it writes under /work.
RUN groupadd --gid 1000 sandbox \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash sandbox

# /work is an emptyDir at runtime, so this directory is MASKED the moment the
# pod starts and nothing baked under it survives. It exists for the `docker run`
# case and to document the mount point — the shim creates its own pidfile
# directory at runtime precisely because this one does not survive.
RUN install -d -o 1000 -g 1000 -m 0755 /work

ENV HOME=/home/sandbox

# WORKDIR is the working directory every `codex exec` inherits: pods/exec runs
# with the container's cwd, and podspec.go sets no WorkingDir, so this is it.
#
# It is /work — the mount root — and DELIBERATELY NOT the repo checkout, which
# is the obvious-looking choice and is a trap. A WORKDIR the runtime has to
# create inside the emptyDir is created by the RUNTIME, as root, mode 0755:
#
#   $ docker run --tmpfs '/work:uid=0,gid=1000,mode=2775' <img with WORKDIR /work/repo> \
#       sh -c 'ls -ldn /work/repo; touch /work/repo/probe'
#   drwxr-sr-x 2 0 1000 ... /work/repo
#   touch: cannot touch '/work/repo/probe': Permission denied
#
# — so the sandbox uid could not write its own checkout, and every clone, build
# and test would fail as a permission error dressed up as a broken tool. /work
# itself is group-writable because the kubelet applies fsGroup 1000 to the
# emptyDir, and a directory the PROCESS creates under it is owned by the
# process. So the checkout is created by whatever clones it, at work.RepoDir,
# and the stage is pointed there with `codex --cd`.
WORKDIR /work
USER 1000:1000

# Mirrors podspec.go's Command so `docker run` behaves like the pod does. The
# pod sets its own, so this is documentation with a fallback, not a default the
# cluster relies on.
CMD ["sleep", "infinity"]

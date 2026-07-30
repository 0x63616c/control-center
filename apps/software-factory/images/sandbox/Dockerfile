# syntax=docker/dockerfile:1

# The per-ticket sandbox (ADR-0011): a session that stages `codex exec` into,
# not a batch job. The pod's command is its own embedded Temporal worker
# (cmd/sandbox-worker, #434 step 3) — not `sleep infinity` with stages
# arriving over pods/exec, which is what this image ran before Sessions
# replaced that transport.
#
# The argv this embedded worker itself invokes is a contract with
# internal/clients/local (the codex CLI it execs directly, as a local
# subprocess), and the git/gh argv CloneRepo still reaches remotely through
# internal/clients/k8s until #431 decides otherwise (see that package's
# exec.go). Either way, no shell is ever invoked, on any path:
#
#   tar                           file-in, `tar -xf - -C /` (transfer.go)
#   test                          the file-existence probe (transfer.go)
#   cat                           file-out (transfer.go)
#   printenv                      SF_BRANCH, read back rather than recomputed,
#                                 so CloneRepo notices if this pod's branch ever
#                                 disagrees with what SandboxTemplate.Spec baked
#                                 into it (clone.go: sandboxBranch, #383).
#   git                           clone, checkout -b, `config --local
#                                 credential.helper` and push work.RepoDir on
#                                 the branch above (clone.go). A credential file
#                                 is written first with Write/tar, never argv,
#                                 so the token never appears in a command line
#                                 or a log line. It is never removed either:
#                                 `implement` pushes as the model, from inside
#                                 this pod, long after CloneRepo has returned,
#                                 and the local credential.helper config this
#                                 sets is what its BARE `git push` — no `-c` of
#                                 its own — authenticates through.
#   rm                            clears a partial checkout before a retried
#                                 clone (clone.go).
#
# A shell IS present, because `codex exec`'s own job is running shell commands
# on the agent's behalf. "No shell" is a rule about how the WORKER invokes this
# image, not about what the image contains — an image without one could not run
# a single ticket.
#
# The pidfile shim that used to make a remote exec killable, and pgrep — the
# liveness probe that used to stand in for a real process handle — are both
# gone (#434, step 3 of the software-factory migration: Temporal Sessions
# replace the pods/exec reattach path they existed for; the embedded worker
# holds a real os/exec.Cmd instead).
#
# amd64 only. The home-server Talos node is the only deploy target and it is
# x86; CI builds --platform linux/amd64 on a native runner.

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: the embedded worker binary, and the Go toolchain the runtime stage
# borrows.
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
# The embedded worker binary this pod runs as its own Command (#434 step 3) —
# NOT cmd/worker, which is the main, control-plane worker's own binary and
# does not belong in this image. Same flags images/worker/Dockerfile builds
# cmd/worker with.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/sandbox-worker ./cmd/sandbox-worker

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
# gh is what `propose` opens the pull request with (#414). It authenticates
# through a hosts.yml CloneRepo writes into the pod, NOT through git's
# credential store — gh has no code path that reads one, so the installation
# token has to reach it in gh's own format. See clone.go: ghHostsPath.
ARG GH_VERSION=2.96.0
ARG GH_SHA256=83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60
# golangci-lint, pinned to what CI pins (.github/workflows/ci.yml:363,
# `version: v2.12.2`) for the same reason that comment gives: a rule that
# fires on one and not the other teaches people to distrust the wall.
ARG GOLANGCI_LINT_VERSION=2.12.2
ARG GOLANGCI_LINT_SHA256=8df580d2670fed8fa984aac0507099af8df275e665215f5c7a2ae3943893a553

# GNU tar, coreutils (test, cat, printenv, rm) and a shell come from the base
# image. Added here: git, because CloneRepo checks the ticket's repository out
# and pushes its branch before any stage runs, and `implement` later commits
# and pushes to that same checkout; ca-certificates for the OpenAI and GitHub
# APIs; curl and unzip for the two downloads below; passwd for
# groupadd/useradd, which trixie-slim omits; gcc and libc6-dev so
# `CGO_ENABLED=1 go test -race` can link inside this image (#428) — both
# listed explicitly rather than relied on as a transitive pull-in of `gcc`,
# since that could change under a base-image bump. Verified below by a CGO
# smoke build, not just `command -v gcc`, which would only prove the compiler
# is on PATH and not that it can actually link a cgo package.
#
# procps (pgrep) is no longer installed here: it existed solely for B5's
# pgrep-based stage-liveness probe, deleted along with the rest of the
# reattach path in #434 (step 3 — Sessions give the embedded worker a real
# process handle, so there is nothing left to pgrep for).
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
        gcc \
        git \
        libc6-dev \
        passwd \
        unzip \
    && rm -rf /var/lib/apt/lists/* \
    && command -v tar >/dev/null \
    && command -v test >/dev/null \
    && command -v cat >/dev/null \
    && command -v gcc >/dev/null \
    && command -v git >/dev/null \
    && command -v printenv >/dev/null \
    && command -v rm >/dev/null

RUN curl -fsSL -o /tmp/codex.tar.gz \
        "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz" \
    && echo "${CODEX_SHA256}  /tmp/codex.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/codex.tar.gz -C /tmp \
    && install -m 0755 /tmp/codex-x86_64-unknown-linux-musl /usr/local/bin/codex \
    && rm -rf /tmp/codex.tar.gz /tmp/codex-x86_64-unknown-linux-musl \
    && codex --version

RUN curl -fsSL -o /tmp/gh.tar.gz \
        "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    && echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
    && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_amd64" \
    && gh --version

RUN curl -fsSL -o /tmp/bun.zip \
        "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
    && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp \
    && install -m 0755 /tmp/bun-linux-x64/bun /usr/local/bin/bun \
    && ln -s bun /usr/local/bin/bunx \
    && rm -rf /tmp/bun.zip /tmp/bun-linux-x64 \
    && bun --version \
    && bunx --version

RUN curl -fsSL -o /tmp/golangci-lint.tar.gz \
        "https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI_LINT_VERSION}/golangci-lint-${GOLANGCI_LINT_VERSION}-linux-amd64.tar.gz" \
    && echo "${GOLANGCI_LINT_SHA256}  /tmp/golangci-lint.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/golangci-lint.tar.gz -C /tmp \
    && install -m 0755 "/tmp/golangci-lint-${GOLANGCI_LINT_VERSION}-linux-amd64/golangci-lint" /usr/local/bin/golangci-lint \
    && rm -rf /tmp/golangci-lint.tar.gz "/tmp/golangci-lint-${GOLANGCI_LINT_VERSION}-linux-amd64" \
    && golangci-lint --version

# The Go toolchain, taken from the build stage rather than downloaded again, so
# it cannot drift from the version this module declares.
COPY --from=build /usr/local/go /usr/local/go
# Prepended, not replaced: the base image's PATH is what puts tar, test and
# cat where the worker's argv expects them.
ENV PATH=/usr/local/go/bin:$PATH
ENV GOTOOLCHAIN=local

# Proves #428's actual claim — that a cgo package LINKS in this image — rather
# than just that `gcc` resolves on PATH. `command -v gcc` above would pass even
# if libc6-dev were missing and the link step failed; this would not.
RUN printf 'package main\nimport "C"\nfunc main() {}\n' > /tmp/cgo_check.go \
    && CGO_ENABLED=1 go build -o /tmp/cgo_check /tmp/cgo_check.go \
    && rm -f /tmp/cgo_check.go /tmp/cgo_check

# The pod's own embedded Temporal worker (#434 step 3): polls this run's
# per-ticket queue via workflow.CreateSession, and is what CMD below actually
# runs — see podspec.go's sandboxWorkerBinaryPath, which is a contract with
# this exact install path.
COPY --from=build /out/sandbox-worker /usr/local/bin/sandbox-worker

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

# Mirrors podspec.go's Command (sandboxWorkerBinaryPath) so `docker run`
# behaves like the pod does. The pod sets its own, so this is documentation
# with a fallback, not a default the cluster relies on.
CMD ["/usr/local/bin/sandbox-worker"]

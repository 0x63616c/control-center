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
# omits.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        passwd \
        unzip \
    && rm -rf /var/lib/apt/lists/*

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
WORKDIR /work
USER 1000:1000

# Mirrors podspec.go's Command so `docker run` behaves like the pod does. The
# pod sets its own, so this is documentation with a fallback, not a default the
# cluster relies on.
CMD ["sleep", "infinity"]

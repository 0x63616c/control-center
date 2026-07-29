# Images

Two images, one path filter (`apps/software-factory/**`), both amd64-only — the
home-server Talos node is the only deploy target and it is x86.

| | |
|---|---|
| `worker/` | the Temporal worker. distroless static, nonroot uid 65532, no shell. |
| `sandbox/` | the per-ticket sandbox. debian-slim, uid 1000, a shell and the toolchains. |

## What the sandbox ships, and why

E1 (#341) left these undecided. Decided here:

- **`sandbox-exec`** (`../cmd/sandbox-exec`) — the pidfile shim `exec.go` execs.
  Without it a stage is unkillable, because pods/exec never reports a remote PID.
- **GNU `tar`, `test`, `cat`** — the argv `transfer.go` uses for file-in, the
  existence probe and file-out. From the base image; asserted by `smoke.sh`.
- **`git`** — `implement` pushes its branch, which is what makes GitHub the
  durable state between stages.
- **`bun` and the Go toolchain** — this repo is both, so a ticket that cannot
  build or test one half of it cannot be worked. Go is copied from the builder
  stage so it cannot drift from `go.mod`; bun matches the version CI pins.
- **A shell.** `codex exec`'s job is running shell commands on the agent's
  behalf. The argv-only rule constrains how the *worker* invokes this image, not
  what the image contains.

Not shipped: linters and formatters beyond the toolchains. CI is the
authoritative wall, and a ticket that needs one can install it.

**The repo is not baked in, and neither is `bun install`.** The sandbox clones
at stage time with the installation token it holds, so an image is never stale
against `main` and never carries a lockfile's `node_modules` from build day.

## Pins

`codex` is pinned to the version ADR-0011's auth behaviour was verified against,
by version *and* sha256. Bumping it means re-testing the blanked-`refresh_token`
path, not just editing a number.

## Verifying

```sh
docker build --platform linux/amd64 -f apps/software-factory/images/sandbox/Dockerfile -t sf-sandbox:local .
apps/software-factory/images/sandbox/smoke.sh sf-sandbox:local
```

`smoke.sh` mounts a tmpfs over `/work`, because that is what the pod's emptyDir
does to it. Anything baked under `/work` is masked at runtime; running the
checks without the mount passes on an image that fails in the cluster.

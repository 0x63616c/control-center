# Images

Eight images, one path filter (`apps/software-factory/**`), all amd64-only — the
home-server Talos node is the only deploy target and it is x86.

| | |
|---|---|
| `worker/` | the Temporal worker. distroless static, nonroot uid 65532, no shell. |
| `sandbox/` | the per-ticket sandbox. debian-slim, uid 1000, a shell and the toolchains. |
| `run-worker/` | the additive target per-Run Session worker. It retains the sandbox toolchain but reads renewable GitHub and checkpoint capabilities from projected Secret directories. |
| `relay/` | the stateless GitHub webhook fan-out edge service. distroless static, nonroot uid 65532. |

## What the sandbox ships, and why

E1 (#341) left these undecided. Decided here:

- **GNU `tar`, `test`, `cat`** — the argv `transfer.go` uses for file-in, the
  existence probe and file-out. From the base image; asserted by `smoke.sh`.
- **`git`** — `implement` edits, tests and commits; a workflow-owned repository
  operation publishes that commit, making GitHub the durable state between stages.
- **`bun`/`bunx`, Node and the Go toolchain** — this repo is both, so a ticket
  that cannot build or test one half of it cannot be worked. Bun remains the
  repository's package/runtime command and `bunx` is required by the root
  `prepare` lifecycle hook. Node lets Vitest's `forks` pool create its child
  processes through Bun's `node:child_process` compatibility layer. Go is
  copied from the builder stage so it cannot drift from `go.mod`; bun matches
  the version CI pins.
- **`gcc` and `libc6-dev`** — without them `CGO_ENABLED=1 go test -race`
  cannot link, which is exactly what CI's authoritative gate runs (#428). A
  build-time CGO smoke build proves the link path works, not just that `gcc`
  is on `PATH`.
- **`golangci-lint`**, pinned to the same version CI pins
  (`.github/workflows/ci.yml`, `version: v2.12.2`) — a lint rule that fires in
  CI and not in the sandbox teaches people to distrust the wall.
- **`sqlc`** — checksum-pinned so agents can regenerate committed Go query code
  after SQL changes.
- **Playwright Chromium** — the exact `playwright@1.60.0` browser registry
  bundle, including Chromium, its headless shell, and ffmpeg, is extracted to
  root-owned `/ms-playwright` and discovered through
  `PLAYWRIGHT_BROWSERS_PATH`. Chromium's Debian Trixie libraries come from
  Playwright's own `install-deps chromium` resolver; each downloaded browser
  archive is version- and SHA-256-pinned in the Dockerfile. This lets the
  uid-1000 sandbox take real headless page screenshots. Playwright's resolver
  also supplies Xvfb, and smoke verifies the full Chromium binary remains open
  in a headed 1366×1024 page viewport on a 1400×1100 virtual display. A
  Playwright page screenshot does not itself include native browser tab/window
  chrome; the headed check exists so agent-browser-style window sessions have a
  runnable display rather than silently falling back to an undersized viewport.
- **A shell.** The typed `exec_command` tool accepts explicit argv and some
  repository tasks legitimately need an allowlisted shell. The model never
  receives an implicit shell command string from the worker.

Not shipped: formatters beyond the toolchains. CI is the authoritative wall,
and a ticket that needs one can install it.

**The repo is not baked in, and neither is `bun install`.** `CloneRepo` clones
into `work.RepoDir` with a short-lived GitHub App installation token, so an
image is never stale against `main` and never carries a lockfile's
`node_modules` from build day.

**The pod's command is its own embedded Temporal worker (#434 step 3).** The
image ships `cmd/sandbox-worker` at `/usr/local/bin/sandbox-worker`, and
`podspec.go`'s `Command` runs it directly — no shell, no `sleep infinity`.
Per-run values — which branch to publish, the ticket, the run id, and which
per-ticket Temporal queue to poll — reach it as env on the *pod*
(`SandboxSpec.Env`, set by whoever creates the sandbox) and are read by that
process at start, not by anything baked into the image at build time.

## Runtime invariants

Recorded here because this is the first of the software-factory PRs in the merge
order, so it is where a reader looks first. Each is measured, not reasoned.

**Repository tools are confined to the checkout.** The image's `WORKDIR` is
`/work`, but `agenttools.NewToolsets` is rooted at `work.RepoDir`
(`/work/repo`). Path validation refuses traversal and working directories
outside that root.

`WORKDIR` deliberately is not `/work/repo` itself: a `WORKDIR` the container
runtime has to create inside the `/work` emptyDir is created **by the runtime,
as root**, and the sandbox uid then cannot write its own checkout. Measured
with `WORKDIR /work/repo` under this mount: `drwxr-sr-x 0 1000` — 2755 rather
than 0755 because the setgid bit is inherited from `/work`, and `touch` from
uid 1000 is refused.
`/work` is group-writable because the kubelet applies `fsGroup: 1000`, and a
directory the *process* creates under it is owned by that process — so the clone
creates `work.RepoDir`, and nothing pre-creates it.

Permissions are the reason it works this way. Credentials are not: the tools
container shares `/work` with the repository container but cannot see its
private home directory or projected secrets. The agent may commit in the
shared checkout, but only the fixed repository operation publishes it.

**Model calls do not run here.** The sandbox image contains no Codex binary and
receives no provider credential. The embedded worker registers only the typed
`agent.tool` activity. Direct Responses calls run on the main worker; a
Temporal Session routes tool activities to this ticket's pod, where
`exec.CommandContext` provides a real cancellable process handle. The pod's
second container owns credentialed clone and publish operations and never
executes model-selected commands.

## Provider independence

There is no provider binary pin in this image. Provider transport and OAuth
compatibility are tested in the main worker's `codexresponses` and `codexauth`
packages; the sandbox contract is only its typed tool activity and toolchains.

## Verifying

```sh
docker build --platform linux/amd64 -f apps/software-factory/images/sandbox/Dockerfile -t sf-sandbox:local .
apps/software-factory/images/sandbox/smoke.sh sf-sandbox:local
```

`smoke.sh` mounts a tmpfs over `/work`, because that is what the pod's emptyDir
does to it. Anything baked under `/work` is masked at runtime; running the
checks without the mount passes on an image that fails in the cluster.
It also launches the baked Playwright Chromium against a `data:` URL and asserts
the resulting PNG is non-empty, then keeps a headed Chromium window open under
Xvfb at a display size that leaves room for browser chrome.

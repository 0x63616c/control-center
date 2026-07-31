# Images

Three images, one path filter (`apps/software-factory/**`), all amd64-only — the
home-server Talos node is the only deploy target and it is x86.

| | |
|---|---|
| `worker/` | the Temporal worker. distroless static, nonroot uid 65532, no shell. |
| `sandbox/` | the per-ticket sandbox. debian-slim, uid 1000, a shell and the toolchains. |
| `relay/` | the stateless GitHub webhook fan-out edge service. distroless static, nonroot uid 65532. |

## What the sandbox ships, and why

E1 (#341) left these undecided. Decided here:

- **GNU `tar`, `test`, `cat`** — the argv `transfer.go` uses for file-in, the
  existence probe and file-out. From the base image; asserted by `smoke.sh`.
- **`git`** — `implement` pushes its branch, which is what makes GitHub the
  durable state between stages.
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
- **A shell.** `codex exec`'s job is running shell commands on the agent's
  behalf. The argv-only rule constrains how the *worker* invokes this image, not
  what the image contains.

Not shipped: formatters beyond the toolchains. CI is the authoritative wall,
and a ticket that needs one can install it.

**The repo is not baked in, and neither is `bun install`.** The sandbox clones
at stage time with the installation token it holds, so an image is never stale
against `main` and never carries a lockfile's `node_modules` from build day.
Nothing performs that clone yet — #383 owns it, and `work.RepoDir` is the agreed
destination.

**The pod's command is its own embedded Temporal worker (#434 step 3).** The
image ships `cmd/sandbox-worker` at `/usr/local/bin/sandbox-worker`, and
`podspec.go`'s `Command` runs it directly — no shell, no `sleep infinity`.
Per-run values — which branch to push, the ticket, the run id, and which
per-ticket Temporal queue to poll — reach it as env on the *pod*
(`SandboxSpec.Env`, set by whoever creates the sandbox) and are read by that
process at start, not by anything baked into the image at build time.

## Invariants a stage depends on

Recorded here because this is the first of the software-factory PRs in the merge
order, so it is where a reader looks first. Each is measured, not reasoned.

**The stage's cwd must be inside the repository checkout.** `codex exec` in a
directory that is not a git repo prints `Not inside a trusted directory and
--skip-git-repo-check was not specified` and **dies before any model call** —
verified in this image against an empty `/work`; with a real repo at the cwd the
check passes and it proceeds to auth. The image's `WORKDIR` is `/work`, which is
*not* a checkout, so the stage has to run with its cwd inside one — B5 does
that with **`codex --cd work.RepoDir`** (`/work/repo`). The requirement is the
cwd, not the flag: a plain `cd /work/repo` satisfies the same check, measured. Without that flag every stage fails identically
and it looks like the model failing at the task rather than a misconfiguration.

`WORKDIR` deliberately is not `/work/repo` itself: a `WORKDIR` the container
runtime has to create inside the `/work` emptyDir is created **by the runtime,
as root**, and the sandbox uid then cannot write its own checkout. Measured
with `WORKDIR /work/repo` under this mount: `drwxr-sr-x 0 1000` — 2755 rather
than 0755 because the setgid bit is inherited from `/work`, and `touch` from
uid 1000 is refused.
`/work` is group-writable because the kubelet applies `fsGroup: 1000`, and a
directory the *process* creates under it is owned by that process — so the clone
creates `work.RepoDir`, and nothing pre-creates it.

Permissions are the reason it works this way; they are not the reason worth
remembering. `/work` also holds the run's scaffolding — the rendered prompt, the
schema and the result file. A checkout rooted at
`/work` would put all of that **inside the git working tree**, one `git add -A`
away from committing a rendered prompt into the branch `implement` pushes. That
argument survives any change to how the runtime creates directories.

**Nothing clones the repository yet.** `work.RepoDir` names the destination; no
track owns putting a repo there — #383 tracks it.

**The remote process-management shim is gone (#434, step 3 of the
software-factory migration).** It existed to let the main worker find and
cancel a Codex process across `pods/exec`, which offers no real process handle
of its own. Temporal Sessions replace the mechanism: the embedded worker that
now runs a stage holds a real `os/exec.Cmd` in its own process.

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

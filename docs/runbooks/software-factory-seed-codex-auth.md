# Runbook: seeding the codex credential (#344)

The one manual credential step in the software-factory. Everything here is staged
except the value itself, which only you can supply.

**Prerequisite:** the deploy chain (#366 → #368 → #369) is merged and
`software-factory` actually has a Deployment. Before that lands the namespace is
empty (`No resources found`) and there is nothing for the Secret to serve.

> This runbook is deliberately a separate file from
> `docs/runbooks/software-factory-first-run.md` (#345) — that one covers the first
> live run, this one covers the credential it depends on. Fold them together once
> both have landed if that reads better.

---

## 0. The names, and where they come from

Every name below is read off the code that consumes it, not off memory. If you
change one, change it in the file cited beside it.

**Read the `infra/` rows on `origin/sf/e2-f1`, not on `main`.** That branch is the
one that defines them and it has not merged: on `main`,
`infra/src/software-factory.ts` defines the namespace alone —
`CODEX_AUTH_SECRET_NAME`, `WORKER_SERVICE_ACCOUNT` and the `resourceNames` pin are
not there at all.

**Constant names, no line numbers, deliberately.** Earlier revisions of this table
cited `sf/e2-f1` by line and the numbers went stale twice in a single day — both
times without the branch merging, and both times with every *value* unchanged. A
line number on an unmerged branch is a coordinate into something still being
written. The names are stable, greppable, and already the thing that matters:

```sh
git fetch origin sf/e2-f1
git grep -n 'CODEX_AUTH_SECRET_NAME\|WORKER_SERVICE_ACCOUNT\|SOFTWARE_FACTORY_NAMESPACE' \
  origin/sf/e2-f1 -- infra/src/software-factory.ts
```

The first three hits are the `const` lines; their string literals are the Value
column above. If a literal has changed, this runbook is wrong and the literal
wins — it is what the Role and the worker both read.

| What | Value | Defined as | In |
|---|---|---|---|
| Namespace | `software-factory` | `SOFTWARE_FACTORY_NAMESPACE` | `infra/src/software-factory.ts` (also on `main`) |
| Secret name | `codex-auth` | `CODEX_AUTH_SECRET_NAME` | `infra/src/software-factory.ts` (`sf/e2-f1` only) |
| Deployment | `software-factory-worker` | `WORKER_SERVICE_ACCOUNT`, reused as the Deployment's `metadata.name` | `infra/src/software-factory.ts` (`sf/e2-f1` only) |
| Pod label | `app=software-factory-worker` | `workerLabels` | `infra/src/software-factory.ts` (`sf/e2-f1` only) — what §1's wait selects on |
| Credential key | `auth.json` | `CredentialKey` | `apps/software-factory/internal/clients/codexauth/state.go` (on `main`) |
| Lease key | `refresh_state.json` | `StateKey` | same file — **the seed must NOT write this** |

The Secret name is load-bearing twice over: the worker's Role pins `secrets`
`get`/`update` to it via `resourceNames: [CODEX_AUTH_SECRET_NAME]`, and
`infra/test/software-factory.test.ts` asserts that resolves to `["codex-auth"]`.

### The name now reaches the worker as config

An earlier revision of this runbook recorded a gap here: F1 injected
`CODEX_AUTH_SECRET_NAME` into the worker's environment but no Go file read it.
**That has been closed** — D1 merged (`ef18840b1`), and on `main`
`internal/config/worker.go` declares `envCodexAuthSecret`, lists it in
`workerEnvNames()`, reads it in `LoadWorker`, and — the part that matters
operationally — requires it non-empty in `Validate()`.

So the name is not spelled twice anywhere. Both the RBAC pin and the worker's env
value derive from the one `CODEX_AUTH_SECRET_NAME` constant, and a deploy that
forgets to inject it fails at **worker startup** with `CODEX_AUTH_SECRET_NAME is
required`, rather than silently at the first stage that needs a credential.

What that does *not* cover, and what is therefore still yours to get right: this
runbook creating the Secret under a name the constant does not use. Nothing
validates the operator's typing. §3 says what that looks like.

---

## 1. Seed it

The credential comes from `codex login` on your Mac, which writes
`~/.codex/auth.json`. Confirm it exists — **do not open it**:

```sh
test -f ~/.codex/auth.json && echo present
stat -f '%Sp %z bytes' ~/.codex/auth.json     # mode should be -rw-------
```

Then, from the LAN (there is no SSH to home-server; `kubectl` only):

```sh
# 1. If a previous seed exists, take the worker down first — see §4 on ordering.
kubectl -n software-factory scale deploy/software-factory-worker --replicas=0

# 1b. WAIT FOR IT TO ACTUALLY GO. `scale` returns as soon as the API server
#     accepts the change; it does not wait for the pod. The worker's
#     terminationGracePeriodSeconds is 120 (TERMINATION_GRACE_SECONDS, sized above
#     the drain window), so without this there is a two-minute window in which
#     the next two commands race a worker that is still alive.
kubectl -n software-factory wait --for=delete pod \
  -l app=software-factory-worker --timeout=180s

# 2. Replace the Secret WHOLESALE. Delete-then-create is deliberate: it clears
#    refresh_state.json, which a merge would leave behind to halt the next refresh.
kubectl -n software-factory delete secret codex-auth --ignore-not-found

kubectl -n software-factory create secret generic codex-auth \
  --from-file=auth.json="$HOME/.codex/auth.json"

# 3. Bring it back.
kubectl -n software-factory scale deploy/software-factory-worker --replicas=1
```

On a **first** seed you can skip both `scale` commands — there is nothing running
yet — and the wait is harmless either way: with no matching pod it exits 0
immediately (checked against this cluster's empty namespace, 0.2s). The 180s
timeout is deliberately above the 120s grace period, so a worker that takes the
full grace to drain still finishes inside it. If the wait ever times out, **stop**:
something is holding the pod open, and everything below assumes it is gone.

Three properties of that `create` that are not incidental:

- **The value is read from a file path, never a shell argument.** `--from-literal`
  would put a live refresh token into your shell history and into the process
  table for every user on the box. `--from-file` hands `kubectl` a path and lets
  it do the reading.
- **Nothing is piped.** The usual
  `create --dry-run=client -o yaml | kubectl apply -f -` idiom works, but it moves
  the base64 credential through a pipe on your workstation, and any failure part
  way leaves it in a shell buffer. Delete-then-create avoids that entirely. The
  cost is a few seconds with no Secret, which §4's ordering already covers.
- **`--from-file=auth.json=…` fixes the key name.** Without the `auth.json=`
  prefix `kubectl` derives the key from the basename, which happens to be right
  here and would silently stop being right if the source file were ever renamed.

**Never write `refresh_state.json` yourself.** That key is the lease. The seed's
job is to clear it, which deleting the Secret does; populating it would hand the
worker a lease nobody holds.

---

## 2. Verify — without printing it

Check the key names only. This prints keys, never values:

```sh
kubectl -n software-factory get secret codex-auth \
  -o go-template='{{range $k,$v := .data}}{{$k}}{{"\n"}}{{end}}'
```

Expect exactly one line, `auth.json`. If `refresh_state.json` also appears, the
replace did not happen wholesale — go back to §1.

Check the length is plausible:

```sh
kubectl -n software-factory get secret codex-auth \
  -o go-template='{{len (index .data "auth.json")}}{{"\n"}}'
```

That is the base64 length; it should be exactly `4 * ceil(n/3)` where `n` is
`wc -c < ~/.codex/auth.json`. Compare the two numbers rather than eyeballing a
magnitude — matching arithmetic proves the whole file arrived, and a plain "looks
big enough" does not.

**`len` inside the template, not `| wc -c`.** The obvious form is
`-o jsonpath='{.data.auth\.json}' | wc -c`, and it gives the same number — but it
puts the whole base64 credential on stdout and relies on `wc` to swallow it. One
dropped suffix, one `tee`, one shell that logs pipelines, and it is on your
terminal. Counting inside the template means the value never leaves `kubectl`;
only the integer does. That is the same objection §1 makes to piping, applied to
the check rather than the write.

`index .data "auth.json"` also sidesteps a trap worth knowing if you reach for
`jsonpath` anyway: the key contains a dot, so it must be written `auth\.json`
there, and the unescaped form reads the dot as a field separator and returns
**0 bytes, exit 0, no error** — a check that passes for a Secret that is empty.

Both commands here were checked against a synthetic `DUMMY-NOT-A-SECRET` file with
`--dry-run=client`, so nothing reached the cluster: the key listing printed
`auth.json` and nothing else, and the length came back exactly `4 * ceil(n/3)`.

> **Never `-o yaml` and never `describe` on a Secret.** Both print `data` in full.
> `-o json` likewise. The two commands above are the whole safe surface, and both
> count inside the template: key names via `go-template`, one key's length via
> `go-template` and `len`. Nothing here pipes a value anywhere. This repo
> has leaked secrets twice through commands that read as harmless — judge what
> lands on the terminal, not whether the verb is read-only.

---

## 3. What a wrong seed looks like

Two different layers fail in two different ways. Knowing which you are looking at
saves an hour.

**Worker side — the Secret is missing, empty, or not the shape codexauth expects.**
You get `ErrUnseeded`, which wraps `work.ErrPermanent`
(`internal/clients/codexauth/errors.go`), so Temporal does **not** retry: the
activity fails once, permanently, and the stage stops. The message names the exact
field, and by construction never contains the value
(`internal/clients/codexauth/authfile.go:83-97`, "The value never reaches the error
message"). You will see one of:

| Message fragment | Meaning |
|---|---|
| `the auth.json key is absent or empty` | Secret exists, key missing — check §2's key listing |
| `the auth.json key does not hold a JSON object` | truncated or wrong file |
| `auth.json carries no "tokens" object` | not a codex `auth.json` |
| `auth.json's tokens.access_token is absent / not a string / is blank` | required, non-blank |
| `auth.json's tokens.refresh_token is … is blank` | **you seeded a sandbox copy, not the real one** — see below |
| `codex refresh token was rejected` | seed parsed, token is spent or revoked. Re-run `codex login` |
| `the secret holding auth.json does not exist` | **you seeded under the wrong name** — the worker looked up `codex-auth` and found nothing. §0 |

Note the last row is `NotFound`, **not** `Forbidden`, and an earlier revision of
this runbook said the opposite. Since D1 merged, the worker asks for whichever
name `CODEX_AUTH_SECRET_NAME` carries and its Role is pinned to that same
constant, so the two cannot disagree — the request is always permitted and simply
finds nothing (`internal/clients/k8s/secret.go` maps `IsNotFound` to
`work.ErrSecretNotFound`; `codexauth/source.go` renders it as the message above,
wrapping `ErrUnseeded`). A `Forbidden` here would mean something has edited the
Role or the env var independently of the constant, which is a different bug from
the one you are probably chasing.

The blank-`refresh_token` case is worth naming because it is the plausible mistake:
the service *derives* the sandbox copy by blanking `tokens.refresh_token` to `""`,
never by removing the key. So a blanked file is a valid-looking `auth.json` that
the CLI will happily parse — it is just the wrong copy. **The stored Secret must
carry the real, live refresh token.** `authfile.go:44-46` calls this out: "a worker
holding one has been given the wrong copy."

**Sandbox side — the composed file inside the pod is malformed.** Different
signature entirely: `codex exec` exits **1 with completely empty stdout**, the
cause on stderr only, after retrying roughly **104 times in ~35s** against
`auth.openai.com`. If you see a stage burn ~35 seconds and produce no output at
all, that is this, not the worker-side path above. It does not degrade gracefully
because `OPENAI_API_KEY` is the only `AuthDotJson` field without
`#[serde(default)]` (verified against `codex-cli rust-v0.145.0`) — a malformed
file means the sandbox simply never starts.

---

## 4. Ordering, and the clock you just started

**The Secret must exist before the worker pod starts.** The worker resolves the
credential on its first stage; if the Secret is absent the stage fails permanently
(`ErrUnseeded` is not retryable), so a missing seed does not resolve itself when
you create the Secret a minute later — it burns the ticket. On a first bring-up,
seed *before* scaling the Deployment up. On a re-seed, §1 scales to 0 first for
the same reason — and then *waits for the pod to be gone*, which is the same
ordering argument one step finer. A worker still draining inside its 120s grace
period may be mid-refresh, holding a compare-and-swap on the Secret's
`resourceVersion`. Replace the Secret underneath it and either that refresh fails
with a cause that points nowhere useful, or it succeeds and writes a rotation
derived from the *old* token straight over the credential you just seeded. That is
the same outcome as the Pulumi hazard below, arriving through a different door.

**A credential left idle is not indefinitely valid.** What triggers a refresh is
the access token's own `exp`: codex refreshes only within five minutes of it
(`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES`, `manager.rs:181`, ADR-0011:181-183),
and measured tokens carry multi-day lifetimes. So the longer the factory sits
unused, the likelier it is that the first run after the gap is the one that
refreshes — and if that refresh fails, you are re-running `codex login`, not
debugging the worker.

Do not reason from `last_refresh`. It is a timestamp this service writes and
carries forward, and `authfile.go:213-214` records that the CLI does not read it
for a well-formed file. An earlier draft of this runbook gave an 8-day
`last_refresh` staleness rule; it is not cited anywhere in this repository and the
condition above is the one that is, so it has been removed rather than left as the
only uncited number in the file.

**Mode.** The CLI writes `auth.json` `0600` and whatever composes the file inside a
sandbox should match. A Kubernetes Secret is not a file mode, but anything that
lands this on disk needs to be `0600`.

**Pulumi must never own this Secret.** The refresh token rotates on first use, so a
value committed to git or to a stack is a corpse within a day, and a later
`pulumi up` would seed that corpse over a healthy credential — the reasoning is
in `CODEX_AUTH_SECRET_NAME`'s own doc comment in `infra/src/software-factory.ts`.
Out of band is the design, not an omission.

---

Refs #344

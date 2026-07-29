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

## 0. The three names, and where they come from

Every name below is read off the code that consumes it, not off memory. If you
change one, change it in the file cited beside it.

| What | Value | Source |
|---|---|---|
| Namespace | `software-factory` | `infra/src/software-factory.ts:42` (`SOFTWARE_FACTORY_NAMESPACE`) |
| Secret name | `codex-auth` | `infra/src/software-factory.ts:60` (`CODEX_AUTH_SECRET_NAME`) |
| Credential key | `auth.json` | `apps/software-factory/internal/clients/codexauth/state.go:18` (`CredentialKey`) |
| Lease key | `refresh_state.json` | `apps/software-factory/internal/clients/codexauth/state.go:22` (`StateKey`) — **the seed must NOT write this** |
| Deployment | `software-factory-worker` | `infra/src/software-factory.ts:50` + `:358` (`WORKER_SERVICE_ACCOUNT`, reused as the Deployment name) |

The Secret name is load-bearing twice over. The worker's Role pins `secrets`
`get`/`update` to it by `resourceNames`:

```
infra/src/software-factory.ts:272    resourceNames: [CODEX_AUTH_SECRET_NAME],
infra/test/software-factory.test.ts:153   expect(rule.resourceNames).toEqual(["codex-auth"]);
```

A Secret created under any other name is not a Secret the worker is allowed to
read. It will not fail as "wrong credential" — it will fail as `Forbidden`.

### Known gap: nothing reads `CODEX_AUTH_SECRET_NAME` yet

F1 injects the name into the worker's environment:

```
infra/src/software-factory.ts:397   { name: "CODEX_AUTH_SECRET_NAME", value: CODEX_AUTH_SECRET_NAME },
```

but as of `sf/d1-composition` **no Go file reads that variable**. It is absent
from `internal/config/worker.go`'s env list, and the only occurrence of the
literal `codex-auth` in the Go tree is a test constant
(`internal/clients/k8s/secret_test.go:26`). `cmd/worker/main.go` does not wire
`codexauth` up at all yet.

This does not block seeding — the RBAC grant and the Secret name are what the
seed has to match, and those agree. But whoever wires the credential into the
composition root must read the name from that env var rather than hardcoding it a
third time. Two spellings of this name is exactly the failure the comment at
`software-factory.ts:57` warns about.

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

# 2. Replace the Secret WHOLESALE. Delete-then-create is deliberate: it clears
#    refresh_state.json, which a merge would leave behind to halt the next refresh.
kubectl -n software-factory delete secret codex-auth --ignore-not-found

kubectl -n software-factory create secret generic codex-auth \
  --from-file=auth.json="$HOME/.codex/auth.json"

# 3. Bring it back.
kubectl -n software-factory scale deploy/software-factory-worker --replicas=1
```

On a **first** seed, skip both `scale` commands — there is nothing running yet.

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
  -o jsonpath='{.data.auth\.json}' | wc -c
```

That is the base64 length; it should be exactly `4 * ceil(n/3)` where `n` is
`wc -c < ~/.codex/auth.json`. Compare the two numbers rather than eyeballing a
magnitude — matching arithmetic proves the whole file arrived, and a plain "looks
big enough" does not. `jsonpath` emits no trailing newline, so the count is exact
rather than one over.

Both commands above were checked against a dummy 107-byte file: the key listing
printed `auth.json` and nothing else, and the length came back `144`, which is
`4 * ceil(107/3)`. Note the `\.` escape — the key contains a dot, and the
unescaped form reads it as a field separator, returning **0 bytes silently**.
Without the escape this check passes for a Secret that is empty.

> **Never `-o yaml` and never `describe` on a Secret.** Both print `data` in full.
> `-o json` likewise. The two commands above are the whole safe surface: key names
> via `go-template`, one key's length via a single escaped `jsonpath`. This repo
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
| `Forbidden` on `secrets get` | wrong Secret name — RBAC pins `codex-auth`, §0 |

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
the same reason.

**The staleness clock starts at seed time.** The CLI refreshes proactively once
`last_refresh` is more than **8 days** old, so a credential seeded and then left
idle is not indefinitely valid. If the factory sits unused for over a week, expect
the first run after that to refresh — and if that refresh fails, you are re-running
`codex login`, not debugging the worker.

**Mode.** The CLI writes `auth.json` `0600` and whatever composes the file inside a
sandbox should match. A Kubernetes Secret is not a file mode, but anything that
lands this on disk needs to be `0600`.

**Pulumi must never own this Secret.** The refresh token rotates on first use, so a
value committed to git or to a stack is a corpse within a day, and a later
`pulumi up` would seed that corpse over a healthy credential
(`infra/src/software-factory.ts:52-58`). Out of band is the design, not an
omission.

---

Refs #344

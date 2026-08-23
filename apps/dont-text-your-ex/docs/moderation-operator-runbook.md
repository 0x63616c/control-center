# Private moderation operator runbook

This is the only moderation review plane. It is a machine-readable CLI inside the production API
pod; there is deliberately no public HTTP list, read, or resolution route.

## Safety contract

- Run commands only through `kubectl exec` in `deploy/api` in namespace `dont-text-your-ex`.
  That pod is the shipped runtime with both the Postgres credential and versioned moderation
  narrative keyring mounted.
- Every command must include `--acknowledge-production`. The CLI also refuses to run unless
  `APP_ENV=production` and Kubernetes' in-pod runtime marker is present.
- `list` never decrypts or prints a narrative. `show` deliberately prints one plaintext narrative;
  use it only when review requires it. Do not pipe `show` to CI, a ticket, chat, `tee`, or a log file,
  and clear sensitive terminal scrollback after review.
- Output is one JSON document on stdout. Errors are redacted machine codes and never include a
  narrative or exception detail.
- The fixed audit actor is `operator:calum-peter-webb`. It is not a public app user or foreign key.

## 1. List the active queue

```sh
kubectl --context home-server -n dont-text-your-ex exec deploy/api -- \
  bun run --cwd apps/dont-text-your-ex/apps/api moderation:admin --acknowledge-production list
```

Only `submitted` and `reviewing` reports appear. The response contains metadata and
`hasNarrative`, never ciphertext or plaintext narrative.

## 2. Explicitly inspect one report

Copy one `reportId` from the list result. This is the only command that decrypts content.

```sh
kubectl --context home-server -n dont-text-your-ex exec deploy/api -- \
  bun run --cwd apps/dont-text-your-ex/apps/api moderation:admin --acknowledge-production \
  show abr_REPLACE_WITH_32_HEX_CHARACTERS
```

AES-256-GCM authenticates the stored key version, nonce, ciphertext/tag, and report ID as AAD.
The command fails closed if the key version is unavailable or the envelope/report ID was altered.

## 3. Move through the review state machine

The only valid path is:

```text
submitted -> reviewing -> resolved
                       \-> dismissed
```

Start review:

```sh
kubectl --context home-server -n dont-text-your-ex exec deploy/api -- \
  bun run --cwd apps/dont-text-your-ex/apps/api moderation:admin --acknowledge-production transition \
  abr_REPLACE_WITH_32_HEX_CHARACTERS reviewing
```

Finish with exactly one terminal status:

```sh
kubectl --context home-server -n dont-text-your-ex exec deploy/api -- \
  bun run --cwd apps/dont-text-your-ex/apps/api moderation:admin --acknowledge-production transition \
  abr_REPLACE_WITH_32_HEX_CHARACTERS resolved
```

Use `dismissed` instead of `resolved` only when that is the review outcome. Repeating the current
transition is safe and returns `"changed":false`; skipping `reviewing` or changing a terminal
outcome fails with `invalid_status_transition`. Every real transition appends an immutable event.

## Verification and incident handling

1. Run `show` for the same ID and confirm the status plus audit events and actor identity.
2. Run `list`; terminal reports must no longer appear.
3. Ordinary authenticated app users must continue receiving HTTP 404 for guessed moderation read
   and resolution paths. Never add an HTTP operator route to work around CLI access.
4. If the CLI or decryption fails, stop. Do not copy database ciphertext or key material out of the
   pod. Record only the redacted error code and investigate the pod's secret mounts/deployment.

Terminal outcomes are intentionally irreversible in this slice. Restricting or blocking a target is
not coupled to resolution; that requires a separate policy, authorization, notification, expiry, and
reversal design before implementation.

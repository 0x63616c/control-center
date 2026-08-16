# Don’t Text Your Ex P01 decision analysis — 2026-08-16

This read-only analysis turns the two most consequential P01 technical choices
into explicit, implementable contracts. It does not replace Calum’s required
legal/product confirmations.

## Account deletion

### Current-schema hazards

- `jars.created_by` references `users` with `ON DELETE CASCADE`. A raw user
  deletion therefore deletes every jar that user created and, through jar
  cascades, friends’ memberships, slips, reports, evidence, and activity:
  `apps/dont-text-your-ex/apps/api/src/db/migrations/0001_initial.sql`.
- `jars.closed_by` uses the default restrictive reference, so deleting a user
  who closed a retained jar can fail:
  `apps/dont-text-your-ex/apps/api/src/db/migrations/0006_close_jar.sql`.
- `activity.actor_id`, `activity.target_id`, and `slips.reported_by` are raw IDs;
  an unplanned delete can leave dangling identifiers.
- Sessions, ex labels, memberships, slips, and reports cascade from the user;
  report evidence cascades from reports. OTPs are keyed by phone and require
  explicit cleanup.
- The native Apple bridge exposes only an identity token plus a boolean saying
  an authorization code existed. It does not return the authorization code
  required for revocation:
  `ios/App/App/AppleSignInPlugin.swift` and
  `apps/frontend/src/native/appleSignIn.ts`.

### Options

1. **Full cascade — rejected.** Delete the user and every owned jar. This is
   simplest but destroys friends’ data and can fail or leave dangling IDs.
2. **Anonymous tombstone — rejected as the default.** Clear obvious profile and
   auth fields but retain a stable deleted-user row plus all shared authored
   history. It preserves group history but retains account-associated UGC and is
   materially riskier under Apple’s account-deletion guidance unless a specific,
   disclosed legal-retention duty exists.
3. **Selective erasure with deterministic succession — recommended, awaiting
   owner confirmation.** Preserve the shared container and every other user’s
   data; physically delete the departing account, identifiers, membership, and
   authored/linked UGC.

### Recommended Option 3 contract

- Revoke Sign in with Apple first, then perform one locked database transaction.
  A transient Apple failure leaves the database unchanged. Never log the
  authorization code, Apple subject, client secret, or revocation token.
- Physically delete the `users` row, all sessions, ex labels, OTPs, and every
  membership for the user. Every old session becomes invalid immediately.
- For an owned jar with another active member, retain the jar and promote exactly
  one successor: the active non-deleting member with the lowest `(joined_at,id)`.
  Make `created_by` nullable with `ON DELETE SET NULL`; do not falsely claim the
  successor created it. Rotate invite capability/expiry. Reset creator-authored
  jar name/rule to neutral text.
- Delete an owned jar with no other active member. Do not appoint a former member
  as caretaker by default.
- Preserve a shared closed jar for active friends, set deleted `created_by` and
  `closed_by` references to null, and apply the same successor rule.
- Delete the departing user’s slips. Where that user reported another person’s
  retained slip, null `reported_by` and erase the contributed note while keeping
  the other person’s accepted amount.
- Delete every report where the user is accuser or accused and cascade its
  evidence. Delete activity rows that identify the user or reference a deleted
  report. Preserve only unrelated/system activity.
- Let totals fall by the removed member’s tally. Do not retain an anonymous
  per-person tally without an explicit disclosed retention basis.
- Re-registration with the same Apple subject creates a new internal user ID,
  fresh profile, and no restored memberships/history.

Calum must confirm: this data consequence; the successor rule; no former-member
caretaker; immediate deletion; fresh re-registration; and any exact legal
retention exception (fields, purpose, duration, access, disclosure). Without a
specified obligation, the implementation deletes the data.

Machine acceptance for P03 includes real-Postgres owner/member/former-member and
closed-jar matrices; exact before/after row inventories; friend-row hashes
unchanged; invite rotation; old-token 401; concurrent/idempotent deletion;
transaction fault injection; Apple success/already-revoked/transient failure;
fresh re-registration; and log/contract scans for secrets and Apple identifiers.

Apple sources:

- https://developer.apple.com/support/offering-account-deletion-in-your-app/
- https://developer.apple.com/app-store/review/guidelines/ (5.1.1(v))

## Moderation operator plane

### Decision

Use a private typed `moderationctl` command plus a committed runbook for V1. Do
not expose an operator HTTP route or admin UI.

The current public Cloudflare route sends every `/api` path to the product API,
while product auth supports only ordinary-user bearer sessions. Adding
`/api/admin` would create a new internet attack surface without an operator
identity model. The deployed API image already contains Bun and the application
source and has the database credential mounted, so a typed command can run in
the current API pod without distributing a new secret.

The command must call the same deep moderation module used by tests; it must not
issue ad-hoc SQL. V1 operations are `queue`, redacted `show`, explicit evidence
view, and `resolve`. Decisions include `dismiss`, `remove_content`,
`restrict_account`, and `remove_content_and_restrict_account`.

Every action requires case ID, expected version, action, reason, operator ID,
idempotency key, and explicit production confirmation. It transactionally
changes state and appends an immutable audit row. Default output and ntfy alerts
contain only redacted metadata/opaque IDs—never report text, images, names,
Apple IDs, sessions, credentials, or authorization data.

The committed wrapper must require `home-server`, namespace
`dont-text-your-ex`, a running API pod, and a recorded `kubectl auth whoami`.
The current single-operator root of trust is the cluster-admin credential held
by Calum. This is intentionally a V1 limitation, not least privilege; add a
separate Cloudflare-Access-protected operator plane before adding operators or
when report volume makes the runbook impractical.

Acceptance includes real-Postgres queue/decision/idempotency/concurrency tests;
ordinary authenticated and unauthenticated `/api/admin/*`, `/api/operator/*`,
and `/api/moderation/queue` probes returning 404; no operator route/service/host
in rendered infrastructure; redacted CLI output; a two-user local drill; a
production synthetic case causing one non-PII ntfy alert; removal/restriction
proof; immutable audit row; PII-free Loki result; moderation metrics; and backup
plus isolated restore of cases, blocks, audit rows, and outbox state.

This operator-plane choice is a technical architecture decision. Calum still
must set the moderation response target, escalation path, and public support
contact.


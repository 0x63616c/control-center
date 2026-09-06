# Account deletion data and restore map

This is the W00 table-by-table design input for
`AccountDeletionWorkflow`. It describes present tables, the tables introduced
by the Temporal delivery, ordering, backup behavior, and proof obligations. No
deletion migration may ship until the shared-jar decision at the end is marked
approved in both this document and the release-control decision ledger.

The threat model is product-level programmatic linkage. After erasure, no live
product row, API DTO, push, activity, recap, log field, metric label, workflow
ID/input/result/memo/search attribute, or stable cross-row key may identify or
programmatically relink the deleted person. This does not claim to erase what
another person remembers or prevent inference from an amount and timestamp.

## Acceptance ordering

One authenticated transaction performs these steps before returning
`accepted`:

1. Lock the user row and reject new concurrent product mutations.
2. Validate fresh Sign in with Apple authorization when usable credentials
   exist; legacy missing-token behavior is presented before confirmation.
3. Insert one `account_deletion_requests` row and one
   `account_deletion_cleanup_items` manifest per associated workflow/history.
4. After authentication and the database inserts, durably stage a signed,
   pseudonymous deletion-intent file before committing the transaction. A normal
   rollback removes that intent. Restore replay deliberately honors an intent
   left by a process or host failure, resolving the unavoidable cross-store
   commit ambiguity in favor of the authenticated deletion instruction rather
   than resurrecting the account. After commit, atomically publish the final
   journal record and remove the intent before returning acknowledgement. A
   publication failure withholds acknowledgement; a retry republishes the
   committed record, and the durable deletion workflow also publishes the
   completed form. Restore replay tolerates multiple valid records for one HMAC
   and erases the identity exactly once.
5. Transfer encrypted Apple revocation material to the deletion request.
6. Mark the account `deleting`, delete every session, suppress pending device
   delivery, and append exactly one `account.deletion_requested` event.

The workflow then ends/suppresses associated work from the manifest, performs
one idempotent local-erasure transaction, records `locally_erased`, attempts
Apple revocation for up to 24 hours, destroys revocation material, and records
`complete` or `manual_action_required`. A separate sweep deletes associated
Temporal histories and finally the deletion workflow history. Local erasure
continues even when Apple is unavailable.

## Present and planned data map

| Store | Personal/linking data | Required deletion behavior | Retained behavior and reason |
|---|---|---|---|
| `users` | internal ID, Apple subject, phone, name, color, emoji, photo, auth provider, timezone | lock synchronously; physically delete after dependent rows are handled | none |
| `user_exes` | private labels linked to user | delete | none |
| `otps` | phone and code | delete rows for the account phone before deleting user | none |
| `sessions` | bearer token and user ID | delete every row in acceptance transaction | none |
| `device_registrations` | user ID, encrypted APNs token, HMAC fingerprint, build/failure metadata | mark inactive/suppress in acceptance; delete token, fingerprint, and row during local erasure | none |
| `notification_preferences` | user/category choices | delete | none |
| `memberships` | user ID, role, tally, streak start/share choice | exact row outcome follows the approved shared-jar decision; never retain a user ID | only unlinkable numeric shared history if approved |
| `membership_tenures` | membership/user participation windows | exact row outcome follows membership; never retain a cross-jar deleted-person key | unlinkable jar-local dates only if approved and required for an authorized recap |
| `jars` | creator/closer IDs and creator-authored name/rule; invite capability | owned open jars follow approved decision; null creator/closer references, erase creator-authored text, invalidate invite; delete sole-member jars | container and unrelated friends' data only if another active member remains |
| `slips` | user/reporter IDs, note, ex label, source, amount/time | erase IDs, note, label, and reporter contribution or delete row per approved shared-history decision | amount/time may remain only as unlinkable jar-local numeric history if approved |
| `reports` | accuser/accused IDs, anonymous linkage, note, status, amount | pending becomes expired internally with `account_deleted`; erase/delete IDs and note; terminal row outcome follows approved shared-history decision | terminal numeric outcome only if approved and unlinkable |
| `report_evidence` | uploaded image payload | delete whenever the user is accuser, accused, or evidence author | none |
| `activity` | actor/target/report IDs, generated or authored text, amount, ex label, note | delete linked report activity; erase IDs and all authored/private text; exact numeric row outcome follows approved decision | system/numeric jar history only if unlinkable |
| `jar_milestones` | jar-local threshold and time | no user field; delete if jar is deleted | retain with retained jar |
| `rescue_interventions` | user ID and private intervention state/times | suppress notification, terminate workflow, delete row | none |
| `streak_achievements` | membership/user-linked private streak | delete | none |
| `jar_recaps` | immutable snapshot | delete or rewrite any snapshot containing a deleted-person dimension; numeric jar-only snapshot may remain only if it cannot link the person | authorized jar aggregate only |
| `jar_recap_recipients` | recap/user authorization | delete rows for user | unrelated active recipients remain |
| `notifications` | recipient/target IDs and category/stage | suppress in acceptance, terminate open workflow, delete rows involving user | none |
| `notification_delivery_intents` and attempts | device link, delivery/failure metadata | suppress, then delete with notification/device | none |
| `domain_event` | opaque aggregate IDs and failure metadata | pending user-associated work is suppressed or marked dispatched after no-op; delete rows whose aggregate is erased once recovery is impossible | unrelated events remain; no arbitrary payload exists |
| `account_deletion_requests` | deletion ID, encrypted revocation material, state/times | destroy revocation ciphertext at terminal Apple outcome; remove operational row after cleanup/history proof and tombstone publication | opaque completion receipt may remain through evidence window |
| `account_deletion_cleanup_items` | deletion ID and workflow/history IDs | mark each cleanup outcome; delete after all associated histories and deletion workflow history are proven absent | none after proof |
| `deletion_restore_tombstones` | deletion ID, HMAC(user ID), HMAC-version reference, completion/expiry | retain 31 days, purge after every containing 30-day backup has expired | prevents resurrection from a backup; forbidden for sign-in/relink |
| API/backend logs | risk of accidentally logged IDs/content | structured fields must omit identity/content for these paths; delete any deliberately indexed live user field if introduced | service/error class and opaque operation ID per documented Loki retention |
| frontend logs/crash reports | device/user-content risk | deletion UI and adapters never log credentials/content; document provider retention and delete an indexed live identifier if one exists | non-identifying diagnostics per provider policy |
| Prometheus metrics | label-cardinality/linkage risk | user, jar, report, device, Apple, and deletion IDs are forbidden labels | aggregate counters/histograms only |
| Temporal histories | opaque aggregate IDs can still be account-associated through cleanup manifest | authorized sweeper deletes every inventoried history after durable terminal proof | 90-day namespace retention is fallback, not deletion mechanism |
| NFS Postgres backups | pre-erasure database contents | enforce 30-day rolling purge; restore only into isolated scratch; replay all unexpired tombstones before any traffic | disaster recovery for disclosed 30-day period |

## Foreign-key migration rules

- Remove `ON DELETE CASCADE` from `jars.created_by`; make `created_by` nullable
  with `ON DELETE SET NULL` after owned-jar handling.
- Change `jars.closed_by` to nullable `ON DELETE SET NULL`.
- Every retained numeric row that formerly referenced the user either becomes
  nullable `ON DELETE SET NULL` or is copied into a new jar-local aggregate and
  the user-linked row is deleted. A dangling raw ID is never accepted.
- Reports involving the user are transitioned/redacted before their user
  references are removed. Evidence is always deleted.
- Do not create a shared anonymous-user row or a stable deleted-user key. That
  would preserve programmatic linkage across jars.
- The HMAC tombstone is isolated from product queries and cannot satisfy a
  foreign key or participate in authentication.

## Restore tombstone journal

The live table alone is insufficient: a backup taken before deletion cannot
contain a tombstone created afterward. Each accepted deletion therefore also
publishes one atomic, signed JSON record under the product's restricted NFS
erasure-journal path. The record contains only:

- schema version;
- opaque deletion request ID;
- HMAC of the deleted internal user ID;
- HMAC key version;
- completion time;
- expiry time; and
- integrity signature/version.

The raw user ID and Apple subject are forbidden. The HMAC and signing keys are
dedicated External Secrets mounted only into deletion/restoration processes.
Old key versions remain available only while an unexpired tombstone names them.
The API first uses write-then-rename to create `<deletion-id>.intent`, then uses
the same durable atomic-write pattern for `<deletion-id>.json` after the database
commit. Both file kinds are signed and restore-authoritative, preventing a crash
immediately before or after the commit from creating a resurrection window. The
intent is removed after final publication, or after an observed transaction
rollback. The restore tool:

1. restores the database into a network-isolated scratch namespace;
2. loads every unexpired journal record;
3. computes versioned HMACs for restored user IDs;
4. reruns the idempotent local-erasure operation for matches;
5. proves no match or private derivative remains;
6. records row-count/invariant evidence; and
7. destroys only the scratch environment.

No restored database may receive application traffic before this gate passes.
The journal and live tombstone expire 31 days after local erasure, one day after
the newest allowed backup containing the user has expired.

## Approved shared-jar and external-revocation decision

Two committed documents previously conflicted:

1. The Temporal delivery contract closes owned open jars, performs immediate
   local erasure, preserves only unlinkable numeric shared history, and retries
   Apple revocation afterward.
2. The later App Store P01 analysis recommends promoting the earliest active
   member, deleting the departing member's tallies/linked history, and requiring
   Apple revocation before changing the database.

Calum approved the recommended release defaults on 2026-08-22. The resulting
contract deliberately combines the user-visible shared-jar behavior from option
2 with the outage-safe ordering from option 1:

- An owned jar survives when another active member remains. Exactly one
  successor is selected by the lowest `(joined_at,id)` among active
  non-deleting members. This changes authorization ownership only; it does not
  rewrite `created_by` or claim the successor authored the jar.
- Creator-authored jar name/rule are reset to neutral text, creator/closer
  references are nulled, and the invite capability is rotated. The departing
  person's membership, tally, slips, reports/evidence, linked activity, private
  labels, and other authored/linked content are erased. Unrelated friends' rows
  remain.
- A jar with no other active member is deleted; former members are not promoted.
- Local erasure is immediate and cannot wait on Apple availability. Fresh Apple
  authorization is captured when available; revocation is attempted and then
  retried durably for up to 24 hours, after which the request enters
  `manual_action_required`. Revocation material is destroyed at the terminal
  outcome and never logged.
- Re-registration with the same Apple subject creates a fresh internal account
  with no restored memberships or history. No unspecified legal-retention
  exception applies.

**Status:** `OWNER APPROVED`<br>
**Decision:** active-member succession + immediate local erasure + durable Apple retry<br>
**Attributed to/date:** Calum Peter Webb, 2026-08-22

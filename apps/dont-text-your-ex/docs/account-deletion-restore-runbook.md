# Account-deletion restore gate

Never restore a Don’t Text Your Ex backup into a namespace that can receive
application traffic. The restored database is untrusted until the signed
external erasure journal has been replayed successfully.

## Required order

1. Create a disposable, network-isolated scratch namespace with no Ingress,
   Service, API, frontend, or Temporal worker.
2. Restore the selected PostgreSQL backup into the scratch database.
3. Mount the restricted erasure journal read/write and mount the versioned HMAC
   and signing keyrings read-only.
4. Confirm the journal mount contains final `.json` records and any durable
   `.intent` records left by a crash. Never delete an intent manually: it is a
   signed deletion instruction and is deliberately replayed to prevent
   resurrection across an ambiguous database commit.
5. Run the API image's `restore:replay` command with:

   - `DTYE_RESTORE_MODE=isolated-scratch`
   - `DTYE_RESTORE_TRAFFIC_DISABLED=true`
   - `DATABASE_URL` pointing only to the scratch database
   - `ERASURE_JOURNAL_DIR`
   - `RESTORE_TOMBSTONE_HMAC_KEYRING_FILE`
   - `RESTORE_TOMBSTONE_SIGNING_KEYRING_FILE`

6. Require a zero exit code and one redacted JSON result containing
   `status:"passed"`, `remainingRawReferences:0`, and the scanned/erased counts.
   The tool fails closed for a damaged signature, missing key version, remaining
   HMAC match, or remaining exact raw user reference. Multiple valid records for
   one HMAC are treated as an expected at-least-once publication retry and erase
   the restored identity once.
7. Save the redacted result, database backup identifier, image digest, and
   namespace deletion proof as restore evidence. Never save raw user IDs,
   Apple subjects, tokens, HMACs, or journal contents.
8. Destroy the scratch namespace and its volumes. A replayed scratch database
   is evidence only; it is never promoted into production.

The hourly account-deletion history sweep removes expired final and intent files and
its opaque operational database rows only after the 31-day tombstone expiry and
after every inventoried Temporal history is marked deleted.

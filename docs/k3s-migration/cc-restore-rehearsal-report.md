# Control Center DB restore rehearsal report (www-jtp0.7.6)

Template + record for the pre-cutover restore rehearsal. The cutover preflight
(`scripts/cc-cutover-preflight.sh`) requires a COMPLETED, non-empty copy of this
report. It starts RED (placeholders below) and is only valid once filled with real
captured output. Do NOT mark a section green without pasting the actual evidence.

> Rule: `scripts/pg-snapshot-restore.sh` refuses `production`/`control-center` as a
> scratch target, so a rehearsal can never overwrite the live DB. The rehearsal
> proves the restore path; the real cutover (www-jtp0.7.7) is a separate runbook.

## 1. Inputs

- Date / operator: `<TODO>`
- Source dump file: `<TODO e.g. control_center-YYYYMMDD-HHMMSS.dump>`
- Scratch cluster name: `<TODO e.g. cc-restore-scratch>`
- Tooling commit: `<TODO git rev>`

## 2. Table inventory (source)

Paste the source table list + counts (`pg-snapshot-restore.sh` writes
`source-counts.tsv`):

```
<TODO paste source-counts.tsv>
```

## 3. Restore + row-count comparison

Command:

```bash
OUTPUT_DIR=./.pg-snapshots scripts/pg-snapshot-restore.sh \
  --source production --scratch cc-restore-scratch
```

Side-by-side result (must end with `COUNTS MATCH`):

```
<TODO paste the side-by-side count output>
```

- [ ] Every non-system table count matches source vs scratch.
- [ ] `drizzle.__drizzle_migrations` count matches (migrations applied).

## 4. Semantic checks

Run the IDENTICAL file on source and scratch, then diff:

```bash
psql -d control_center -f scripts/cc-cutover-semantic-checks.sql > source-semantic.txt   # source
psql -d <scratch-db> -f scripts/cc-cutover-semantic-checks.sql > scratch-semantic.txt    # scratch
diff source-semantic.txt scratch-semantic.txt
```

Confirm each AC-named area survived:

- [ ] `device_state`: inventory + per-row desired/reported intact (lights are DB-authoritative).
- [ ] `integration_sync_status`: every integration heartbeat present.
- [ ] `weather_reading` / `weather_daily_reading`: latest reads survive.
- [ ] `lamp_mode`: singleton mode + speed survive (party re-arms correctly).
- [ ] `job`: queue status visible; no surprise `locked`/`running` rows carried in.

Diff output (expected: empty, or explained):

```
<TODO paste diff output>
```

## 5. Outcome

- [ ] Row counts identical.
- [ ] Semantic diff clean (or every difference explained and benign).
- [ ] Source DB + pgdata untouched (rollback artifact preserved).

Rehearsal verdict: `<TODO PASS / FAIL>`

Once this report is PASS and pasted with real evidence, set
`CC_REHEARSAL_REPORT=docs/k3s-migration/cc-restore-rehearsal-report.md` for the
cutover preflight.

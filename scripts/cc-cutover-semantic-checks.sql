-- Control Center cutover semantic validation (www-jtp0.7.6 / www-jtp0.7.7).
--
-- Row counts (pg-snapshot-restore.sh) prove NOTHING moved silently; these
-- queries prove the moved data is SEMANTICALLY intact and the system is safe to
-- resume writing against. Run the IDENTICAL file against both the source
-- (pre-cutover, read-only) and the restored product CNPG, and diff the output.
--
-- Run:  psql -d control_center -v ON_ERROR_STOP=1 -f scripts/cc-cutover-semantic-checks.sql
-- (or pipe through `kubectl exec ... -- psql ...`). Reads only; writes nothing.
--
-- Every block prints `check | <name>` then its rows so a plain `diff` of the two
-- captures is meaningful. A check that returns ZERO rows where the source had
-- rows is a RED flag (data dropped on restore).

\pset pager off
\pset footer off
\timing off

-- device_state: the lights are DB-authoritative (desiredState is source of truth).
-- Verify the managed device inventory + that desired/reported survived, and that
-- no row lost its desired intent it had before (NULL desired only where expected).
SELECT 'check' AS check, 'device_state.inventory' AS name;
SELECT kind, count(*) AS rows,
       count(*) FILTER (WHERE desired_state IS NOT NULL) AS with_desired,
       count(*) FILTER (WHERE reported_state IS NOT NULL) AS with_reported,
       count(*) FILTER (WHERE available) AS available
FROM device_state
GROUP BY kind
ORDER BY kind;

SELECT 'check' AS check, 'device_state.ids' AS name;
SELECT id, kind, entity_id,
       (desired_state IS NOT NULL) AS has_desired,
       (reported_state IS NOT NULL) AS has_reported
FROM device_state
ORDER BY id;

-- integration_sync_status: per-integration heartbeat. The cutover must not reset
-- or drop heartbeats; a missing integration here means a worker will re-seed and
-- could re-drive devices unexpectedly.
SELECT 'check' AS check, 'integration_sync_status' AS name;
SELECT * FROM integration_sync_status ORDER BY 1;

-- Weather: latest reads must survive so the tile is not blank post-cutover.
SELECT 'check' AS check, 'weather_reading.summary' AS name;
SELECT kind,
       count(*) AS rows,
       max(recorded_at) AS latest_recorded_at
FROM weather_reading
GROUP BY kind
ORDER BY kind;

SELECT 'check' AS check, 'weather_daily_reading.summary' AS name;
SELECT count(*) AS rows, max(recorded_at) AS latest_recorded_at
FROM weather_daily_reading;

-- lamp_mode: singleton table; party mode is durable across restarts via this row.
-- The exact mode + speed must survive so the worker re-arms the correct state.
SELECT 'check' AS check, 'lamp_mode' AS name;
SELECT * FROM lamp_mode ORDER BY 1;

-- Job queue safety: the async job table must NOT carry stale locked/running rows
-- across a cutover (a job locked by a now-dead worker would never be reclaimed in
-- a way the operator expects). Report by status + any still-locked rows so the
-- operator can decide to requeue. NOT a hard failure, an explicit visibility check.
SELECT 'check' AS check, 'job.by_status' AS name;
SELECT status, count(*) AS rows
FROM job
GROUP BY status
ORDER BY status;

SELECT 'check' AS check, 'job.locked' AS name;  -- expect 0 during a write freeze
SELECT id, type, status, locked_by, run_after
FROM job
WHERE locked_by IS NOT NULL OR status = 'running'
ORDER BY id;

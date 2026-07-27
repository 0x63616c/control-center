-- One-time data purge (#251): the ha_ble ingest path (Renpho scale over a BLE
-- proxy, polled via Home Assistant) was retired in #245 in favour of the
-- direct Withings API ingest, which is now the sole writer of
-- weight_measurement. The hard-DELETE hazard the deleted_at tombstone exists
-- to avoid -- ingest re-seeing the same HA sensor state and re-inserting the
-- row -- no longer applies: that writer is gone from the codebase, so nothing
-- can resurrect these rows. This is not a reversal of the append-only policy
-- for the live withings_api path, just a named exception for a decommissioned
-- source's historical rows.
DELETE FROM "weight_measurement" WHERE "source" = 'ha_ble';

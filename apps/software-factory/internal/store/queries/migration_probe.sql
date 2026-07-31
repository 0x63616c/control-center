-- name: MigrationProbeExists :one
SELECT EXISTS (SELECT 1 FROM migration_probe) AS exists;

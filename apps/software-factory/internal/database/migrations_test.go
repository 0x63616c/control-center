package database

import (
	"context"
	"database/sql"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestApplyMigrationsCreatesProbeTable(t *testing.T) {
	databaseURL := config.DatabaseURL()
	if databaseURL == "" {
		t.Skip(config.DatabaseURLEnv + " is not set")
	}

	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatalf("open PostgreSQL connection: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close PostgreSQL connection: %v", err)
		}
	})

	ctx := context.Background()
	if err := ApplyMigrations(ctx, db); err != nil {
		t.Fatalf("apply embedded migrations: %v", err)
	}

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open PostgreSQL pool: %v", err)
	}
	t.Cleanup(pool.Close)

	exists, err := store.New(pool).MigrationProbeExists(ctx)
	if err != nil {
		t.Fatalf("query migration probe table: %v", err)
	}
	if !exists {
		t.Error("migration probe table does not exist")
	}
}

func TestTicketActiveStateRequiresRunOwnership(t *testing.T) {
	databaseURL := config.DatabaseURL()
	if databaseURL == "" {
		t.Skip(config.DatabaseURLEnv + " is not set")
	}

	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatalf("open PostgreSQL connection: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close PostgreSQL connection: %v", err)
		}
	})
	ctx := context.Background()
	if err := ApplyMigrations(ctx, db); err != nil {
		t.Fatalf("apply embedded migrations: %v", err)
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open PostgreSQL pool: %v", err)
	}
	t.Cleanup(pool.Close)

	for _, state := range []string{"working", "review"} {
		if _, err := pool.Exec(ctx, "INSERT INTO ticket (title, body, state) VALUES ($1, '', $2)", "legacy "+state, state); err != nil {
			t.Fatalf("insert legacy %s ticket: %v", state, err)
		}
	}
	if _, err := pool.Exec(ctx, "INSERT INTO ticket (title, body, state) VALUES ('missing owner', '', 'active')"); err == nil {
		t.Fatal("insert active ticket without run ownership succeeded")
	}

	var ticketID int64
	if err := pool.QueryRow(ctx, "INSERT INTO ticket (title, body, state) VALUES ('ownership', '', 'open') RETURNING id").Scan(&ticketID); err != nil {
		t.Fatalf("insert open ticket: %v", err)
	}
	runID := uuid.New()
	if _, err := pool.Exec(ctx, "INSERT INTO run (id, ticket_id, started_at) VALUES ($1, $2, CURRENT_TIMESTAMP)", runID, ticketID); err != nil {
		t.Fatalf("insert run: %v", err)
	}
	if _, err := pool.Exec(ctx, "UPDATE ticket SET active_run_id = $1 WHERE id = $2", runID, ticketID); err == nil {
		t.Fatal("add active run owner without active state succeeded")
	}
	if _, err := pool.Exec(ctx, "UPDATE ticket SET state = 'active', active_run_id = $1 WHERE id = $2", runID, ticketID); err != nil {
		t.Fatalf("activate ticket with run ownership: %v", err)
	}
}

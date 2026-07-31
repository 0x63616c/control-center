package database

import (
	"context"
	"database/sql"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
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

	store, err := store.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open PostgreSQL pool: %v", err)
	}
	t.Cleanup(store.Close)

	exists, err := store.MigrationProbeExists(ctx)
	if err != nil {
		t.Fatalf("query migration probe table: %v", err)
	}
	if !exists {
		t.Error("migration probe table does not exist")
	}
}

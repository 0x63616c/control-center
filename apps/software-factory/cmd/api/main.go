// Command api serves the Software Factory's typed HTTP API.
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/danielgtaylor/huma/v2/humacli"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/spf13/cobra"

	factoryapi "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/api"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/database"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/telemetry"
)

const buildVersion = "development"

func main() {
	cli := newCLI(os.Stdout, os.Stderr)
	cli.Run()
}

// newCLI puts the spec dump on Huma's Cobra root. The command constructs only
// the contract, making generation independent of database and network boot.
func newCLI(stdout, stderr io.Writer) humacli.CLI {
	cli := humacli.New(func(hooks humacli.Hooks, _ *struct{}) {
		hooks.OnStart(func() {
			if err := run(); err != nil {
				slog.New(slog.NewJSONHandler(stderr, nil)).Error("the API stopped", slog.String("error", err.Error()))
			}
		})
	})
	cli.Root().AddCommand(&cobra.Command{
		Use:   "openapi",
		Short: "Print the OpenAPI spec",
		RunE: func(_ *cobra.Command, _ []string) error {
			return writeOpenAPI(stdout)
		},
	})
	return cli
}

func writeOpenAPI(writer io.Writer) error {
	spec, err := factoryapi.New(buildVersion).OpenAPIYAML()
	if err != nil {
		return fmt.Errorf("generate OpenAPI 3.1 document: %w", err)
	}
	if _, err := writer.Write(spec); err != nil {
		return fmt.Errorf("write OpenAPI 3.1 document: %w", err)
	}
	return nil
}

func run() error {
	cfg, err := config.LoadAPI()
	if err != nil {
		return fmt.Errorf("reading API configuration: %w", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))

	db, err := sql.Open("pgx", cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("opening PostgreSQL connection: %w", err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("pinging PostgreSQL before API startup: %w", err)
	}
	if err := database.ApplyMigrations(ctx, db); err != nil {
		return fmt.Errorf("applying PostgreSQL migrations before API startup: %w", err)
	}

	registry := prometheus.NewRegistry()
	registry.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	_ = telemetry.NewMetrics(registry)
	metricsListener, err := net.Listen("tcp", cfg.MetricsAddr)
	if err != nil {
		return fmt.Errorf("listening for metrics on %s (METRICS_ADDR): %w", cfg.MetricsAddr, err)
	}
	go func() {
		if err := http.Serve(metricsListener, promhttp.HandlerFor(registry, promhttp.HandlerOpts{})); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("the metrics server stopped", slog.String("error", err.Error()))
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	mux.Handle("/", factoryapi.New(buildVersion).Handler())

	listener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return fmt.Errorf("listening for API requests on %s (API_ADDR): %w", cfg.ListenAddr, err)
	}
	logger.Info("API starting", slog.String("address", cfg.ListenAddr))
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serving API requests: %w", err)
	}
	return nil
}

// Command codec serves Temporal's remote payload codec protocol.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/payloads"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/telemetry"
)

const softwareFactoryTemporalNamespace = "software-factory"

func main() {
	if err := run(); err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("the codec service stopped", slog.String("error", err.Error()))
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.LoadCodec()
	if err != nil {
		return fmt.Errorf("reading codec service configuration: %w", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	store, err := blobs.NewHTTPStore(cfg.BlobsURL, nil)
	if err != nil {
		return fmt.Errorf("opening HTTP blob store: %w", err)
	}
	listener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return fmt.Errorf("listening for codec requests on %s (LISTEN_ADDR): %w", cfg.ListenAddr, err)
	}
	logger.Info("codec service starting", slog.String("address", cfg.ListenAddr), slog.String("blobs_url", cfg.BlobsURL))

	server := &http.Server{
		Handler:           newHandler(store, cfg.CORSOrigins),
		ReadHeaderTimeout: 5 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()

	shutdown, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serving codec requests: %w", err)
		}
	case <-shutdown.Done():
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			return fmt.Errorf("shutting down codec server: %w", err)
		}
	}
	return nil
}

func newHandler(store blobs.Store, origins []string) http.Handler {
	codec := payloads.Handler(store, telemetry.NewMetrics(prometheus.NewRegistry()))
	mux := http.NewServeMux()
	// Temporal UI 2.52.1 appends /encode or /decode to the configured endpoint
	// without expanding {namespace}. Serve that literal segment while also
	// accepting a future expanded software-factory path; the X-Namespace check
	// prevents the cluster-level UI setting from decoding another namespace.
	mux.Handle("/{namespace}/encode", softwareFactoryCodec(codec))
	mux.Handle("/{namespace}/decode", softwareFactoryCodec(codec))
	mux.HandleFunc("/healthz", func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	})
	return cors(origins, mux)
}

func softwareFactoryCodec(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		pathNamespace := request.PathValue("namespace")
		if pathNamespace != "{namespace}" && pathNamespace != softwareFactoryTemporalNamespace {
			http.NotFound(writer, request)
			return
		}
		if request.Header.Get("X-Namespace") != softwareFactoryTemporalNamespace {
			http.Error(writer, "namespace is not allowed", http.StatusForbidden)
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func cors(origins []string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		origin := request.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(writer, request)
			return
		}
		if !slices.Contains(origins, origin) {
			http.Error(writer, "origin is not allowed", http.StatusForbidden)
			return
		}

		writer.Header().Set("Access-Control-Allow-Origin", origin)
		writer.Header().Set("Access-Control-Allow-Methods", http.MethodPost)
		writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Namespace")
		writer.Header().Set("Access-Control-Allow-Credentials", "true")
		writer.Header().Set("Vary", "Origin")
		if request.Method == http.MethodOptions {
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(writer, request)
	})
}

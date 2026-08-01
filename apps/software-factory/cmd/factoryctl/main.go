// Command factoryctl provides explicit, inert-until-invoked operational gates
// for the software-factory v0 cutover.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	tlog "go.temporal.io/sdk/log"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/github"
	temporalapi "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/temporal"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/config"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/cutover"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/githubpolicy"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/telemetry"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	err := run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr)
	stop()
	if err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("factoryctl refused the operation", slog.String("error", err.Error()))
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: factoryctl cutover|verify-github-policy")
	}
	switch args[0] {
	case "cutover":
		return runCutover(ctx, args[1:], stdout, stderr)
	case "verify-github-policy":
		return runPolicyVerification(args[1:], stdin, stdout)
	default:
		return fmt.Errorf("unknown factoryctl command %q", args[0])
	}
}

func runCutover(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("factoryctl cutover", flag.ContinueOnError)
	flags.SetOutput(stderr)
	mode := flags.String("mode", string(cutover.ModeInventory), "inventory, dry-run, or apply")
	grace := flags.Duration("grace-period", 30*time.Second, "cooperative cancellation and termination confirmation window")
	requireReady := flags.Bool("require-ready", false, "fail unless the final inventory is activation-ready")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected cutover arguments: %v", flags.Args())
	}

	dependencies, closeRuntime, err := buildLiveDependencies(ctx, stderr)
	if err != nil {
		return err
	}
	defer closeRuntime()

	report, executeErr := cutover.Execute(ctx, dependencies, cutover.Options{Mode: cutover.Mode(*mode), GracePeriod: *grace})
	if err := json.NewEncoder(stdout).Encode(report); err != nil {
		return fmt.Errorf("writing cutover report: %w", err)
	}
	if executeErr != nil {
		return executeErr
	}
	if *requireReady && !report.Ready {
		return &cutover.NotReadyError{Report: report}
	}
	return nil
}

func buildLiveDependencies(ctx context.Context, stderr io.Writer) (cutover.Dependencies, func(), error) {
	workerConfig, err := config.LoadWorker()
	if err != nil {
		return cutover.Dependencies{}, func() {}, fmt.Errorf("reading in-cluster worker configuration: %w", err)
	}
	githubConfig, err := config.LoadGitHub()
	if err != nil {
		return cutover.Dependencies{}, func() {}, fmt.Errorf("reading in-cluster GitHub App configuration: %w", err)
	}
	logger := slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: workerConfig.LogLevel}))

	pool, err := pgxpool.New(ctx, workerConfig.DatabaseURL)
	if err != nil {
		return cutover.Dependencies{}, func() {}, fmt.Errorf("constructing the factory database pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return cutover.Dependencies{}, func() {}, fmt.Errorf("pinging the factory database: %w", err)
	}
	blobStore, err := blobs.NewHTTPStore(workerConfig.BlobsURL, nil)
	if err != nil {
		pool.Close()
		return cutover.Dependencies{}, func() {}, fmt.Errorf("opening the Temporal payload blob store: %w", err)
	}
	temporal, err := temporalapi.Dial(temporalapi.Options{
		HostPort: workerConfig.TemporalHostPort, Namespace: workerConfig.TemporalNamespace,
		Logger: tlog.NewStructuredLogger(logger),
	}, blobStore, telemetry.NewMetrics(prometheus.NewRegistry()))
	if err != nil {
		pool.Close()
		return cutover.Dependencies{}, func() {}, fmt.Errorf("dialling Temporal: %w", err)
	}
	githubClient, err := github.New(githubConfig, clock.System{}, logger)
	if err != nil {
		temporal.Close()
		pool.Close()
		return cutover.Dependencies{}, func() {}, fmt.Errorf("building the GitHub App client: %w", err)
	}
	closeRuntime := func() {
		temporal.Close()
		pool.Close()
	}
	return cutover.LiveDependencies(temporal, workerConfig.TemporalNamespace, githubClient, store.New(pool), clock.System{}), closeRuntime, nil
}

func runPolicyVerification(args []string, stdin io.Reader, stdout io.Writer) error {
	flags := flag.NewFlagSet("factoryctl verify-github-policy", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	appID := flags.String("app-id", "", "GitHub App numeric id")
	if err := flags.Parse(args); err != nil {
		return err
	}
	parsedAppID, err := strconv.ParseInt(*appID, 10, 64)
	if err != nil || parsedAppID <= 0 {
		return fmt.Errorf("--app-id must be a positive integer")
	}
	var rulesets []githubpolicy.Ruleset
	decoder := json.NewDecoder(stdin)
	if err := decoder.Decode(&rulesets); err != nil {
		return fmt.Errorf("decoding detailed GitHub rulesets: %w", err)
	}
	report := githubpolicy.Verify(rulesets, parsedAppID)
	if err := json.NewEncoder(stdout).Encode(report); err != nil {
		return fmt.Errorf("writing GitHub policy report: %w", err)
	}
	if !report.Ready {
		return errors.New("GitHub policy is not ready for autonomous merge")
	}
	return nil
}

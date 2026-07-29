package main

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// The paths the worker serves. They are constants because a scrape config and
// a probe in the Deployment quote them, and a renamed path is a metric that
// stops arriving without anything failing.
const (
	pathMetrics = "/metrics"
	pathHealthz = "/healthz"
)

// observability is everything this process serves over HTTP: its metrics, and
// a liveness endpoint.
//
// It is deliberately not the service's interface — the worker takes its work
// from Temporal, not from a request — so this handler answers two questions
// and nothing else. Readiness is not among them: a worker that has started is
// polling, and there is no traffic to gate on it being ready for.
func observability(gatherer prometheus.Gatherer) http.Handler {
	mux := http.NewServeMux()
	mux.Handle(pathMetrics, promhttp.HandlerFor(gatherer, promhttp.HandlerOpts{}))
	mux.HandleFunc(pathHealthz, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		// The body is for a human running curl; the kubelet reads the status.
		_, _ = w.Write([]byte("ok\n"))
	})
	return mux
}

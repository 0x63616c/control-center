# Don’t Text Your Ex Temporal operations

The product worker runs in Kubernetes namespace `dont-text-your-ex`, connects to
the shared Temporal frontend, and polls task queue exactly `main` in Temporal
namespace `dont-text-your-ex`. Closed histories have 90-day namespace retention.

W01 registers one UTC Schedule, `dtye_health`, which starts
`DtyeHealthCheckWorkflow` once per minute. The workflow calls the local health
activity five times and returns `{ status: "healthy", checks: 5 }`. It depends on
no external integration.

On boot, the worker upserts declared `dtye_` schedules and deletes only removed
Schedule definitions with that prefix. It never deletes unmanaged schedules,
Control Center `app_` schedules, or workflow execution histories. Schedule
deletion, execution termination, history deletion, product-data retention, and
account erasure are separate operations.

Useful production checks:

```sh
kubectl --context home-server -n dont-text-your-ex get pods
kubectl --context home-server -n dont-text-your-ex logs deploy/temporal-worker
kubectl --context home-server -n temporal port-forward svc/temporal-ui 8080:8080
```

The worker has a 20-second SDK shutdown grace period inside Kubernetes' bounded
pod termination. Its app metrics are scraped directly from the pod on port 9464;
Temporal SDK metrics use the shared in-cluster OTel collector and retain
namespace/task-queue labels.

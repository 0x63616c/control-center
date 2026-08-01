# Software factory v0 cutover

> **NOT YET EXECUTED.** PR 7 deploys the inert tooling only. Do not run `--mode
> apply`, activate the target registrations, or merge PR 8 until its reviewed
> cutover window.

This is the one-time boundary between the legacy `FactoryDispatcher` /
`FactoryWorkTicket` histories and the target Run/Step/Attempt system. It runs
inside the existing worker container, so the operator never reads database,
Temporal, or GitHub App secret values locally. There is no SSH to home-server.

## 1. Prove the PR 7 tool is deployed

From the repository root, after PR 7 is deployed and the worker rollout is
healthy:

```sh
kubectl -n software-factory rollout status deployment/software-factory-worker
cutover_dir="$(mktemp -d /tmp/software-factory-v0-cutover.XXXXXX)"
kubectl -n software-factory exec deployment/software-factory-worker -- \
  /usr/local/bin/factoryctl cutover --mode inventory \
  >"${cutover_dir}/01-inventory.json"
jq . "${cutover_dir}/01-inventory.json"
```

The direct `/usr/local/bin/factoryctl` execution proves the binary is in the
deployed worker image. Inventory mode is read-only. Retain `cutover_dir` as the
operational artifact directory for the whole window.

## 2. Rehearse the exact changes without mutation

```sh
kubectl -n software-factory exec deployment/software-factory-worker -- \
  /usr/local/bin/factoryctl cutover --mode dry-run --grace-period 30s \
  >"${cutover_dir}/02-dry-run.json"
jq '{ready, before, actions}' "${cutover_dir}/02-dry-run.json"
```

The plan must enumerate every legacy dispatcher/Ticket execution, every open
legacy factory PR with auto-merge enabled, and every `working` or `review`
Ticket together with every still-open legacy database Run. Dry-run makes no
signals, cancels, terminations, GitHub mutations, or database writes.

## 3. Verify GitHub policy locally

Obtain the public numeric App ID from the GitHub App settings page or the
approved configuration record. Do not print or decrypt the App key.

```sh
apps/software-factory/scripts/verify-github-policy.sh \
  --repository 0x63616c/world-wide-webb \
  --app-id '<github-app-id>' \
  --branch main \
  >"${cutover_dir}/03-github-policy.json"
jq . "${cutover_dir}/03-github-policy.json"
```

The verifier exits non-zero unless an active approval ruleset names the App as
a pull-request bypass actor and a separate active ruleset retains a non-empty
required-check set that the App cannot bypass. That set must contain every
check named by `DefaultTargetRunPolicy`, currently `test-software-factory`;
unrelated required checks do not satisfy the gate. A non-ready report blocks
PR 8.

## 4. Apply during the reviewed PR 8 cutover window

This is the first mutating step. Confirm PR 8 is reviewed, CI is green, and no
new legacy work should be admitted. Then run exactly once; safe retries use the
same command.

```sh
kubectl -n software-factory exec deployment/software-factory-worker -- \
  /usr/local/bin/factoryctl cutover --mode apply --grace-period 30s \
  >"${cutover_dir}/04-apply.json"
jq . "${cutover_dir}/04-apply.json"
```

Apply pauses the old dispatcher and queries its applied configuration until
the workflow acknowledges the cutover pause, disables auto-merge on open
legacy factory PRs, requests cancellation of old Ticket workflows,
force-terminates survivors, proves every termination closed, and terminates
and proves closure of the old dispatcher. It then transactionally records
still-open database Runs as failed historical Runs and reopens only the exact
`working`/`review` Ticket state/version snapshots it inventoried. A race or
surviving workflow returns a non-zero exit with the machine-readable non-ready
report preserved.

## 5. Final deployment refusal gate

```sh
kubectl -n software-factory exec deployment/software-factory-worker -- \
  /usr/local/bin/factoryctl cutover --mode inventory --require-ready \
  >"${cutover_dir}/05-ready.json"
jq -e '.ready == true and (.after.workflows | length) == 0 and
  (.after.sandboxes | length) == 0 and
  ([.after.pullRequests[] | select(.autoMergeEnabled)] | length) == 0 and
  (.after.tickets | length) == 0 and
  (.after.runs | length) == 0' "${cutover_dir}/05-ready.json"
```

Do not merge PR 8 unless both this command and the GitHub policy verifier exit
zero. PR 8 owns target activation and the final legacy-history backfill; this
runbook does not activate either one.

## Failure and retry

- Keep every JSON artifact. The command writes no credentials or secret values.
- Fix the reported dependency or stale state and rerun `--mode apply`. Completed
  operations are idempotent and disappear from the next inventory.
- Never mark a legacy Run successful during repair. `done` Tickets remain
  untouched.
- If any old workflow remains open, stop. Do not deploy target registrations or
  work around `--require-ready`.

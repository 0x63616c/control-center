# Software factory v0 cutover

> **ACTIVATED.** Sections 1 through 6 are the retained historical procedure for
> the completed legacy cutover. Their old workflow, sandbox, `factoryctl`, and
> PR 8 names are intentionally explicit so retained JSON artifacts remain
> interpretable. Do not rerun those retired commands. Section 7 is the permanent
> post-main evidence gate for the activated runtime.

This is the one-time boundary between the legacy `FactoryDispatcher` /
`FactoryWorkTicket` histories and the target Run/Step/Attempt system. It runs
inside the existing worker container, so the operator never reads database,
Temporal, or GitHub App secret values locally. There is no SSH to home-server.

## 1. Prove the hardened inert tool is deployed

From the repository root, after the hardened inert tooling is deployed and the
worker rollout is healthy:

```sh
kubectl -n software-factory rollout status deployment/software-factory-worker
cutover_dir="$(mktemp -d /tmp/software-factory-v0-cutover.XXXXXX)"
kubectl -n software-factory exec deployment/software-factory-worker -- \
  /usr/local/bin/factoryctl cutover --mode inventory \
  >"${cutover_dir}/01-inventory.json"
jq -e '.version == 2' "${cutover_dir}/01-inventory.json" >/dev/null
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
jq -e '.version == 2' "${cutover_dir}/02-dry-run.json" >/dev/null
jq '{ready, before, actions}' "${cutover_dir}/02-dry-run.json"
```

The plan must enumerate every legacy dispatcher, Ticket, and AgentWorkflow
execution; every sandbox pod owned by a legacy workflow; every open legacy
factory PR with auto-merge enabled; and every `working` or `review` Ticket
together with every still-open legacy database Run. Dry-run makes no signals,
cancels, terminations, pod deletions, GitHub mutations, or database writes.

## 3. Plan the GitHub policy change locally

The reviewed public IDs are pinned below. The command is read-only unless
`--apply` is present and does not read or print the App key.

```sh
apps/software-factory/scripts/configure-github-policy.sh \
  --repository 0x63616c/world-wide-webb \
  --approval-ruleset-id 20075698 \
  --app-id 4399553 \
  --user-id 6991398 \
  --branch main \
  >"${cutover_dir}/03-github-policy-plan.json"
jq -e '.version == 1 and .mode == "dry-run" and
  [.operations[].kind] ==
    ["create_checks_ruleset", "add_app_approval_bypass"]' \
  "${cutover_dir}/03-github-policy-plan.json"
```

The helper refuses unexpected approval-rule, bypass-actor, target-branch, or
existing checks-ruleset state. The reviewed change creates a separate active
ruleset that requires only `test-software-factory` and has no bypass actors,
then adds GitHub App `4399553` to approval ruleset `20075698` as an Integration
with `pull_request` bypass. The existing User `6991398` `always` bypass and
pull-request review rule remain unchanged.

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
force-terminates surviving Ticket and AgentWorkflow executions, proves every
termination closed, deletes only UID-pinned legacy sandbox pods, and terminates
and proves closure of the old dispatcher. It preserves target Run Worker pods.
It then transactionally records still-open database Runs as failed historical
Runs and reopens only the exact `working`/`review` Ticket state/version
snapshots it inventoried. A race or surviving workflow or sandbox returns a
non-zero exit with the machine-readable non-ready report preserved.

## 5. Apply and verify the GitHub policy gate

The helper deliberately creates and verifies the non-bypassable checks ruleset
before it adds the approval bypass. Safe retries are idempotent.

```sh
apps/software-factory/scripts/configure-github-policy.sh \
  --repository 0x63616c/world-wide-webb \
  --approval-ruleset-id 20075698 \
  --app-id 4399553 \
  --user-id 6991398 \
  --branch main \
  --apply \
  >"${cutover_dir}/05-github-policy-apply.json"
jq -e '.version == 1 and .mode == "apply"' \
  "${cutover_dir}/05-github-policy-apply.json"

apps/software-factory/scripts/verify-github-policy.sh \
  --repository 0x63616c/world-wide-webb \
  --app-id 4399553 \
  --branch main \
  >"${cutover_dir}/05-github-policy-verify.json"
jq -e '.version == 1 and .ready == true and
  .approvalRuleset == "main-require-codeowner-approval" and
  (.requiredChecks | index("test-software-factory")) != null' \
  "${cutover_dir}/05-github-policy-verify.json"
```

The verifier exits non-zero unless the active approval ruleset names the App
as a pull-request bypass actor and a separate active ruleset retains every
check named by `DefaultTargetRunPolicy` in a ruleset the App cannot bypass.
Unrelated required checks do not satisfy the gate.

## 6. Final deployment refusal gate

```sh
kubectl -n software-factory exec deployment/software-factory-worker -- \
  /usr/local/bin/factoryctl cutover --mode inventory --require-ready \
  >"${cutover_dir}/06-ready.json"
jq -e '.version == 2 and .ready == true and
  (.after.workflows | length) == 0 and
  (.after.sandboxes | length) == 0 and
  ([.after.pullRequests[] | select(.autoMergeEnabled)] | length) == 0 and
  (.after.tickets | length) == 0 and
  (.after.runs | length) == 0' "${cutover_dir}/06-ready.json"
```

Do not merge PR 8 unless both this command and the post-apply GitHub policy
verifier exit zero. PR 8 owns target activation and the final legacy-history
backfill; this runbook does not activate either one.

## 7. Gate 10: prove the activated runtime after main

Run every command below from the same shell after the activation merge reaches
`main`. Keep the resulting files with the six historical cutover artifacts.
This gate is not satisfied by a green pull-request run or by a successful
Pulumi command alone.

### 7.1 Standalone release, main deployment, and all seven image paths

First prove the checked release against GitHub's stable Release, its checksum,
the tag's resolved commit, and every SemVer image tag. Then bind WWW evidence
to the current `main` commit and require its production deployment to pass.
The standalone Release gate is the build/test owner: its `gate` job runs the
real Temporal Session integration and the durable `AgentWorkflow` E2E using
direct Responses calls. WWW no longer substitutes embedded build jobs as that
evidence, and the retired Codex CLI execution design is not accepted.

```bash
gate10_dir="${gate10_dir:-$(mktemp -d /tmp/software-factory-v0-gate10.XXXXXX)}"
printf 'Gate 10 artifacts: %s\n' "${gate10_dir}"
release_manifest=infra/software-factory-release.json
release_version="$(jq -er .version "${release_manifest}")"
release_commit="$(jq -er .commit "${release_manifest}")"
scripts/verify-software-factory-release.sh \
  "${release_version}" "${release_manifest}" \
  >"${gate10_dir}/07-release-digests.json"
release_run_id="$(gh run list \
  --repo 0x63616c/software-factory \
  --workflow .github/workflows/release.yml \
  --branch "${release_version}" \
  --commit "${release_commit}" \
  --event push \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"
test -n "${release_run_id}"
gh run view "${release_run_id}" \
  --repo 0x63616c/software-factory \
  --json headSha,status,conclusion,jobs \
  >"${gate10_dir}/07-release-actions.json"
jq -e --arg sha "${release_commit}" '
  .headSha == $sha and
  .status == "completed" and
  .conclusion == "success" and
  (["gate", "publish"] -
    [.jobs[] | select(.conclusion == "success") | .name] | length) == 0 and
  ([.jobs[] |
    select(.name | startswith("images (")) |
    select(.conclusion == "success")] | length) == 7
' "${gate10_dir}/07-release-actions.json"

activation_sha="$(gh api repos/0x63616c/world-wide-webb/commits/main --jq .sha)"
activation_run_id="$(gh run list \
  --repo 0x63616c/world-wide-webb \
  --workflow .github/workflows/ci.yml \
  --branch main \
  --commit "${activation_sha}" \
  --event push \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"
test -n "${activation_run_id}"
gh run watch "${activation_run_id}" \
  --repo 0x63616c/world-wide-webb --exit-status
gh run view "${activation_run_id}" \
  --repo 0x63616c/world-wide-webb \
  --json headSha,status,conclusion,jobs \
  >"${gate10_dir}/07-main-actions.json"
jq -e --arg sha "${activation_sha}" '
  .headSha == $sha and
  .status == "completed" and
  .conclusion == "success" and
  (["deploy-home-server"] -
    [.jobs[] | select(.conclusion == "success") | .name] | length) == 0
' "${gate10_dir}/07-main-actions.json"
```

Capture the five static factory Deployments, the relay Deployment, and the Run
Worker image passed to generation pods. The deployed set must equal the seven
producer-owned repository and digest pairs in the checked release, not merely
look digest-pinned.

```bash
kubectl -n software-factory get deployments \
  software-factory-worker \
  software-factory-api \
  software-factory-blobs \
  software-factory-codec \
  software-factory-web \
  -o json >"${gate10_dir}/07-factory-deployments.json"
kubectl -n webhook-relay get deployment relay -o json \
  >"${gate10_dir}/07-relay-deployment.json"
jq -s '
  {
    static: (
      [.[0].items[].spec.template.spec.containers[].image] +
      [.[1].spec.template.spec.containers[].image]
    ),
    runWorker: (
      .[0].items[] |
      select(.metadata.name == "software-factory-worker") |
      .spec.template.spec.containers[] |
      .env[] |
      select(.name == "RUN_WORKER_IMAGE") |
      .value
    )
  }
' "${gate10_dir}/07-factory-deployments.json" \
  "${gate10_dir}/07-relay-deployment.json" \
  >"${gate10_dir}/07-images.json"
jq -n -e \
  --slurpfile deployed "${gate10_dir}/07-images.json" \
  --slurpfile release "${release_manifest}" '
  ([$deployed[0].static[], $deployed[0].runWorker] | sort) ==
  ([$release[0].images[] | (.image + "@" + .digest)] | sort)
'
```

### 7.2 API rollout and migration 11

The API Deployment uses `pulumi.com/skipAwait`, so wait for it explicitly.
The API applies embedded migrations before binding its health endpoint. Record
both the healthy rollout and the database's latest applied migration:

```bash
kubectl -n software-factory rollout status \
  deployment/software-factory-api --timeout=5m
kubectl -n software-factory wait \
  --for=condition=available deployment/software-factory-api --timeout=5m
kubectl -n software-factory get deployment software-factory-api -o json \
  >"${gate10_dir}/07-api-deployment.json"
db_pod="$(kubectl -n software-factory get cluster software-factory-postgres \
  -o jsonpath='{.status.currentPrimary}')"
test -n "${db_pod}"
kubectl -n software-factory exec "${db_pod}" -c postgres -- \
  psql -U postgres -d software_factory -Atc \
  'SELECT MAX(version_id) FROM goose_db_version WHERE is_applied' \
  >"${gate10_dir}/07-migration-version.txt"
test "$(tr -d '[:space:]' <"${gate10_dir}/07-migration-version.txt")" = "11"
```

### 7.3 Worker readiness and acknowledged Dispatcher policy

`/readyz` becomes healthy only after the control worker has published and
received acknowledgement for the complete Dispatcher policy, reconciled the
maintenance Schedule, and started the main worker. Prove the endpoint and then
query the running Dispatcher for the exact live policy:

```bash
kubectl -n software-factory rollout status \
  deployment/software-factory-worker --timeout=5m
kubectl -n software-factory wait \
  --for=condition=available deployment/software-factory-worker --timeout=5m
kubectl -n software-factory port-forward \
  deployment/software-factory-worker 19090:9464 \
  >"${gate10_dir}/07-worker-port-forward.log" 2>&1 &
readyz_pid=$!
cleanup_readyz() {
  kill "${readyz_pid}" 2>/dev/null || true
  wait "${readyz_pid}" 2>/dev/null || true
}
trap cleanup_readyz EXIT
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:19090/readyz \
    >"${gate10_dir}/07-worker-readyz.txt"; then
    break
  fi
  sleep 1
done
test "$(tr -d '[:space:]' <"${gate10_dir}/07-worker-readyz.txt")" = "ready"
cleanup_readyz
trap - EXIT

temporal_cli() {
  local pod="sf-gate10-temporal-${RANDOM}"
  kubectl -n temporal run "${pod}" --quiet --restart=Never \
    --image=temporalio/admin-tools:1.31.2 --command -- \
    temporal --address temporal-server:7233 \
    --namespace software-factory \
    --codec-endpoint http://codec.software-factory.svc.cluster.local:8080 "$@" \
    >/dev/null
  if ! kubectl -n temporal wait --for=jsonpath='{.status.phase}'=Succeeded \
    "pod/${pod}" --timeout=90s >/dev/null; then
    kubectl -n temporal logs "${pod}" >&2 || true
    kubectl -n temporal delete pod "${pod}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
    return 1
  fi
  if kubectl -n temporal logs "${pod}"; then
    kubectl -n temporal delete pod "${pod}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
    return 0
  fi
  kubectl -n temporal delete pod "${pod}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  return 1
}
temporal_cli workflow query \
  --workflow-id software-factory-target-dispatcher \
  --type target-dispatcher-policy \
  --output json >"${gate10_dir}/07-dispatcher-policy-query.json"
jq -e '.queryResult[0]' \
  "${gate10_dir}/07-dispatcher-policy-query.json" \
  >"${gate10_dir}/07-dispatcher-policy.json"
jq -e '
  .Policy.Paused == false and
  .Policy.MaxInFlight == 1 and
  .Policy.Run.RequiredChecks == ["test-software-factory"] and
  (.Fingerprint | type == "string" and length == 64) and
  .Draining == false
' "${gate10_dir}/07-dispatcher-policy.json"
```

### 7.4 Explicitly unpause and execute MaintainFactory

Worker startup preserves the Schedule's live paused state, so reconciliation
alone is not activation evidence. Explicitly unpause it, verify its definition,
trigger one action, and wait for that exact action to complete:

```bash
temporal_cli schedule toggle \
  --schedule-id software-factory-maintain \
  --unpause \
  --reason 'v0 activation Gate 10'
temporal_cli schedule describe \
  --schedule-id software-factory-maintain \
  --output json >"${gate10_dir}/07-maintain-before-trigger.json"
jq -e '
  .schedule.state.paused != true and
  (.schedule.spec.interval | length) == 1 and
  .schedule.spec.interval[0].interval == "300s" and
  .schedule.action.startWorkflow.workflowId == "software-factory-maintain" and
  .schedule.action.startWorkflow.workflowType.name == "MaintainFactory" and
  .schedule.action.startWorkflow.taskQueue.name == "software-factory" and
  .schedule.policies.overlapPolicy == "SCHEDULE_OVERLAP_POLICY_SKIP"
' "${gate10_dir}/07-maintain-before-trigger.json"
previous_maintain_run_id="$(jq -r \
  '.info.recentActions[-1].startWorkflowResult.runId // empty' \
  "${gate10_dir}/07-maintain-before-trigger.json")"

temporal_cli schedule trigger --schedule-id software-factory-maintain
for attempt in $(seq 1 30); do
  temporal_cli schedule describe \
    --schedule-id software-factory-maintain \
    --output json >"${gate10_dir}/07-maintain-after-trigger.json"
  maintain_workflow_id="$(jq -r '.info.recentActions[-1].startWorkflowResult.workflowId // empty' \
    "${gate10_dir}/07-maintain-after-trigger.json")"
  maintain_run_id="$(jq -r '.info.recentActions[-1].startWorkflowResult.runId // empty' \
    "${gate10_dir}/07-maintain-after-trigger.json")"
  if test -n "${maintain_workflow_id}" && \
    test -n "${maintain_run_id}" && \
    test "${maintain_run_id}" != "${previous_maintain_run_id}"; then
    temporal_cli workflow describe \
      --workflow-id "${maintain_workflow_id}" \
      --run-id "${maintain_run_id}" \
      --output json >"${gate10_dir}/07-maintain-workflow.json"
    if jq -e '.workflowExecutionInfo.status == "WORKFLOW_EXECUTION_STATUS_COMPLETED"' \
      "${gate10_dir}/07-maintain-workflow.json" >/dev/null; then
      break
    fi
  fi
  sleep 2
done
jq -e '.workflowExecutionInfo.status == "WORKFLOW_EXECUTION_STATUS_COMPLETED"' \
  "${gate10_dir}/07-maintain-workflow.json"
```

### 7.5 API legacy-state and orphan checks

Use the authenticated public API, not a direct database projection, for the
last lifecycle proof. The first assertion rejects every retired Ticket state.
The second fetches every Ticket's Run history and proves that an `active`
Ticket has exactly one active Run while every non-active Ticket has none. It
also rejects a terminal Run without one of the four target outcomes:

```bash
factory_api='https://factory.worldwidewebb.co/api'
cloudflared access curl "${factory_api}/v1/tickets" \
  >"${gate10_dir}/07-api-tickets.json"
jq -e '
  all(.tickets[]; .state | IN("open", "active", "done", "failed"))
' "${gate10_dir}/07-api-tickets.json"

: >"${gate10_dir}/07-api-ticket-runs.jsonl"
while IFS= read -r ticket_id; do
  cloudflared access curl "${factory_api}/v1/tickets/${ticket_id}/runs" \
    >"${gate10_dir}/07-api-runs-${ticket_id}.json"
  jq -cn \
    --argjson ticket "$(jq --argjson id "${ticket_id}" \
      '.tickets[] | select(.id == $id)' \
      "${gate10_dir}/07-api-tickets.json")" \
    --argjson history "$(cat "${gate10_dir}/07-api-runs-${ticket_id}.json")" \
    '{ticket: $ticket, runs: $history.runs}' \
    >>"${gate10_dir}/07-api-ticket-runs.jsonl"
done < <(jq -r '.tickets[].id' "${gate10_dir}/07-api-tickets.json")

jq -s -e '
  all(.[];
    ([.runs[] | select(.active)] | length) ==
      (if .ticket.state == "active" then 1 else 0 end) and
    all(.runs[];
      if .active then
        .outcome == ""
      else
        .outcome | IN("succeeded", "canceled", "exhausted", "failed")
      end
    )
  )
' "${gate10_dir}/07-api-ticket-runs.jsonl"
```

Gate 10 passes only when every assertion above exits zero and every named
artifact is retained. The `MaintainFactory` action is part of the proof: an
unpaused definition without one completed action is insufficient.

## Historical cutover failure and retry

- Keep every JSON artifact. The command writes no credentials or secret values.
- Fix the reported dependency or stale state and rerun `--mode apply`. Completed
  operations are idempotent and disappear from the next inventory.
- Never mark a legacy Run successful during repair. `done` Tickets remain
  untouched.
- If any old workflow remains open, stop. Do not deploy target registrations or
  work around `--require-ready`.

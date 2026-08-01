# Software factory v0 cutover

> **NOT YET EXECUTED.** The hardened, inert cutover command that emits report
> schema version 2 must be deployed before this window. PR 8 must not be its
> first deployment. Do not run `--mode apply`, activate the target
> registrations, or merge PR 8 until its reviewed cutover window.

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

## Failure and retry

- Keep every JSON artifact. The command writes no credentials or secret values.
- Fix the reported dependency or stale state and rerun `--mode apply`. Completed
  operations are idempotent and disappear from the next inventory.
- Never mark a legacy Run successful during repair. `done` Tickets remain
  untouched.
- If any old workflow remains open, stop. Do not deploy target registrations or
  work around `--require-ready`.

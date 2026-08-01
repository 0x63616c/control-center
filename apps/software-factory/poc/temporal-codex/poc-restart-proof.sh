#!/usr/bin/env bash
set -euo pipefail

readonly kube_context="orbstack"
readonly namespace="codex-agent-poc"
readonly model="${CODEX_MODEL:?CODEX_MODEL must name a subscription-visible Codex model}"
workflow_id="agent-poc-restart-$(date -u +%Y%m%dT%H%M%SZ)"
readonly workflow_id

kubectl --context "${kube_context}" --namespace "${namespace}" exec deployment/agent-poc-worker -- \
  /usr/local/bin/agent-poc-run \
  -temporal-address temporal:7233 \
  -namespace default \
  -workflow-id "${workflow_id}" \
  -model "${model}" \
  -max-turns 3 \
  -tool-delay 10s \
  -wait=false

activity_started=false
for _ in $(seq 1 100); do
  description="$(kubectl --context "${kube_context}" --namespace "${namespace}" exec deployment/temporal -- \
    temporal workflow describe --address temporal:7233 --namespace default --workflow-id "${workflow_id}" --output json)"
  if jq -e '.pendingActivities[]? | select(.activityType.name == "agent-poc.tool" and .state == "PENDING_ACTIVITY_STATE_STARTED")' \
    <<<"${description}" >/dev/null; then
    activity_started=true
    break
  fi
  sleep 0.1
done
if [[ "${activity_started}" != true ]]; then
  echo "the tool activity did not start before the recovery proof deadline" >&2
  exit 1
fi

old_pod="$(kubectl --context "${kube_context}" --namespace "${namespace}" get pod \
  -l app=agent-poc-worker -o jsonpath='{.items[0].metadata.name}')"
readonly old_pod
kubectl --context "${kube_context}" --namespace "${namespace}" delete pod "${old_pod}" \
  --grace-period=0 \
  --force \
  --wait=true
new_pod=""
for _ in $(seq 1 200); do
  pods="$(kubectl --context "${kube_context}" --namespace "${namespace}" get pod \
    -l app=agent-poc-worker -o json)"
  new_pod="$(jq -r --arg old_pod "${old_pod}" \
    '[.items[].metadata.name | select(. != $old_pod)][0] // ""' <<<"${pods}")"
  if [[ -n "${new_pod}" && "${new_pod}" != "${old_pod}" ]]; then
    break
  fi
  sleep 0.1
done
if [[ -z "${new_pod}" || "${new_pod}" == "${old_pod}" ]]; then
  echo "the deployment did not create a replacement worker pod" >&2
  exit 1
fi
kubectl --context "${kube_context}" --namespace "${namespace}" wait \
  --for=condition=Ready \
  "pod/${new_pod}" \
  --timeout=120s

kubectl --context "${kube_context}" --namespace "${namespace}" exec deployment/agent-poc-worker -- \
  /usr/local/bin/agent-poc-run \
  -temporal-address temporal:7233 \
  -namespace default \
  -workflow-id "${workflow_id}" \
  -model "${model}" \
  -attach

kubectl --context "${kube_context}" --namespace "${namespace}" exec deployment/temporal -- \
  temporal workflow show --address temporal:7233 --namespace default --workflow-id "${workflow_id}" --output json \
  | jq '{activity_attempts: [.events[] | select(.eventType == "EVENT_TYPE_ACTIVITY_TASK_STARTED") | .activityTaskStartedEventAttributes | {attempt, identity}], workflow_completed: ([.events[] | select(.eventType == "EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED")] | length)}'

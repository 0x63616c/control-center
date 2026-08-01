#!/usr/bin/env bash
set -euo pipefail

readonly kube_context="orbstack"
readonly namespace="codex-agent-poc"
readonly model="${CODEX_MODEL:?CODEX_MODEL must name a subscription-visible Codex model}"
workflow_id="agent-poc-$(date -u +%Y%m%dT%H%M%SZ)"
readonly workflow_id

kubectl --context "${kube_context}" --namespace "${namespace}" exec deployment/agent-poc-worker -- \
  /usr/local/bin/agent-poc-run \
  -temporal-address temporal:7233 \
  -namespace default \
  -workflow-id "${workflow_id}" \
  -model "${model}" \
  -max-turns 3

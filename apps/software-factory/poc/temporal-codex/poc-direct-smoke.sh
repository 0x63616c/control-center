#!/usr/bin/env bash
set -euo pipefail

readonly kube_context="orbstack"
readonly namespace="codex-agent-poc"
readonly model="${CODEX_MODEL:?CODEX_MODEL must name a subscription-visible Codex model}"

result="$(kubectl --context "${kube_context}" --namespace "${namespace}" exec deployment/agent-poc-worker -- \
  /usr/local/bin/agent-poc-worker -direct-smoke-model "${model}")"
if ! jq -e '.Outcome == "final_text" and (.Text | length > 0)' <<<"${result}" >/dev/null; then
  echo "the direct smoke command did not return final text" >&2
  exit 1
fi
jq . <<<"${result}"

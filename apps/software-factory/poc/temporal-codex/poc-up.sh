#!/usr/bin/env bash
set -euo pipefail

readonly kube_context="orbstack"
readonly namespace="codex-agent-poc"
readonly image="codex-agent-poc:dev"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly here
repo_root="$(cd "${here}/../../../.." && pwd)"
readonly repo_root

if [[ -z "${CODEX_AUTH_FILE:-}" ]]; then
  echo "CODEX_AUTH_FILE must name the user-owned auth.json to mount" >&2
  exit 2
fi
if [[ ! -f "${CODEX_AUTH_FILE}" ]]; then
  echo "CODEX_AUTH_FILE does not name a regular file" >&2
  exit 2
fi
if ! kubectl config get-contexts -o name | grep -Fxq "${kube_context}"; then
  echo "the required local Kubernetes context ${kube_context} is unavailable" >&2
  exit 2
fi

docker build \
  --file "${here}/Dockerfile" \
  --tag "${image}" \
  "${repo_root}"

kubectl --context "${kube_context}" apply -f "${here}/k8s/namespace.yaml"
if ! kubectl --context "${kube_context}" --namespace "${namespace}" get secret codex-auth >/dev/null 2>&1; then
  kubectl --context "${kube_context}" --namespace "${namespace}" create secret generic codex-auth \
    --from-file="auth.json=${CODEX_AUTH_FILE}" >/dev/null
else
  echo "reusing the existing durable codex-auth Secret"
fi
kubectl --context "${kube_context}" apply -f "${here}/k8s/temporal.yaml"
kubectl --context "${kube_context}" --namespace "${namespace}" rollout status deployment/temporal --timeout=120s
kubectl --context "${kube_context}" apply -f "${here}/k8s/worker.yaml"
kubectl --context "${kube_context}" --namespace "${namespace}" rollout restart deployment/agent-poc-worker
kubectl --context "${kube_context}" --namespace "${namespace}" rollout status deployment/agent-poc-worker --timeout=120s
kubectl --context "${kube_context}" --namespace "${namespace}" get pods

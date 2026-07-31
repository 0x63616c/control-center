#!/usr/bin/env bash
# Creates a software-factory Ticket via the API and optionally wires blockers.
#
# Usage:
#   scripts/create-ticket.sh --title "..." --body-file path/to/body.md [--blocker ID]...
#
# Requires: sops, kubectl (talosctl kubeconfig context), python3.
# Reads SOFTWARE_FACTORY_API__WORKER_BEARER_TOKEN from secrets/vault.yaml via sops.
# Never prints the decrypted token.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT_FILE="$REPO_ROOT/secrets/vault.yaml"

TITLE=""
BODY_FILE=""
BLOCKERS=()

while [[ $# -gt 0 ]]; do
	case "$1" in
	--title)
		TITLE="$2"
		shift 2
		;;
	--body-file)
		BODY_FILE="$2"
		shift 2
		;;
	--blocker)
		BLOCKERS+=("$2")
		shift 2
		;;
	*)
		echo "unknown argument: $1" >&2
		exit 1
		;;
	esac
done

if [[ -z "$TITLE" || -z "$BODY_FILE" ]]; then
	echo "usage: $0 --title TITLE --body-file FILE [--blocker ID]..." >&2
	exit 1
fi

if [[ ! -f "$BODY_FILE" ]]; then
	echo "body file not found: $BODY_FILE" >&2
	exit 1
fi

TOKEN="$(sops -d --extract '["SOFTWARE_FACTORY_API__WORKER_BEARER_TOKEN"]' "$VAULT_FILE")"

LOCAL_PORT=18080
kubectl port-forward -n software-factory svc/api "${LOCAL_PORT}:8080" >/tmp/create-ticket-pf.log 2>&1 &
PF_PID=$!
trap 'kill "$PF_PID" 2>/dev/null || true' EXIT
sleep 3

PAYLOAD_FILE="$(mktemp)"
trap 'kill "$PF_PID" 2>/dev/null || true; rm -f "$PAYLOAD_FILE"' EXIT

TITLE="$TITLE" BODY_FILE="$BODY_FILE" python3 - >"$PAYLOAD_FILE" <<'PYEOF'
import json
import os

title = os.environ["TITLE"]
with open(os.environ["BODY_FILE"]) as f:
	body = f.read()

print(json.dumps({"title": title, "body": body}))
PYEOF

RESPONSE_FILE="$(mktemp)"
trap 'kill "$PF_PID" 2>/dev/null || true; rm -f "$PAYLOAD_FILE" "$RESPONSE_FILE"' EXIT

HTTP_CODE=$(curl -s -m 15 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
	-X POST "http://localhost:${LOCAL_PORT}/v1/tickets" \
	--data @"$PAYLOAD_FILE" \
	-o "$RESPONSE_FILE" -w "%{http_code}")

if [[ "$HTTP_CODE" != "200" ]]; then
	echo "ticket creation failed: HTTP $HTTP_CODE" >&2
	cat "$RESPONSE_FILE" >&2
	exit 1
fi

TICKET_ID=$(python3 -c "import json; print(json.load(open('$RESPONSE_FILE'))['id'])")
echo "created T-${TICKET_ID}: ${TITLE}"

for BLOCKER_ID in "${BLOCKERS[@]}"; do
	BLOCKER_HTTP_CODE=$(curl -s -m 15 -H "Authorization: Bearer $TOKEN" \
		-X PUT "http://localhost:${LOCAL_PORT}/v1/tickets/${TICKET_ID}/blockers/${BLOCKER_ID}" \
		-o /dev/null -w "%{http_code}")
	if [[ "$BLOCKER_HTTP_CODE" != "204" ]]; then
		echo "failed to set blocker T-${BLOCKER_ID} on T-${TICKET_ID}: HTTP $BLOCKER_HTTP_CODE" >&2
		exit 1
	fi
	echo "T-${TICKET_ID} now blocked by T-${BLOCKER_ID}"
done

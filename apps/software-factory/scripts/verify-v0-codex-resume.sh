#!/usr/bin/env bash

# Runs the v0 provider-resume gate against the exact sandbox image. It mounts
# the supplied auth document at the same path as the pod spec. Each docker
# invocation has a new /work filesystem, so a resume can succeed only through
# the provider identity captured from the first run.
set -euo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <sandbox-image> <codex-auth-json>" >&2
  exit 2
fi

image=$1
auth_file=$2
if [[ ! -f "$auth_file" ]]; then
  echo "codex auth file does not exist: $auth_file" >&2
  exit 2
fi

evidence_dir=$(mktemp -d)
trap 'rm -rf "$evidence_dir"' EXIT

run_fresh() {
  docker run --rm --platform linux/amd64 -i --entrypoint sh \
    -v "$auth_file:/var/run/secrets/software-factory/codex-auth.json:ro" \
    "$image" -c '
      set -eu
      mkdir -p /work/.codex
      ln -s /var/run/secrets/software-factory/codex-auth.json /work/.codex/auth.json
      export CODEX_HOME=/work/.codex
      exec codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "$@"
    ' -- "$@"
}

kill_before_thread_started() {
  local cid_file=$evidence_dir/killed-before.cid
  local pid
  local process_status=0

  printf 'This prompt must never reach Codex.\n' | docker run --rm --platform linux/amd64 -i \
    --cidfile "$cid_file" --entrypoint sh \
    -v "$auth_file:/var/run/secrets/software-factory/codex-auth.json:ro" \
    "$image" -c '
      set -eu
      mkdir -p /work/.codex
      ln -s /var/run/secrets/software-factory/codex-auth.json /work/.codex/auth.json
      export CODEX_HOME=/work/.codex
      sleep 30
      exec codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -
    ' >"$evidence_dir/killed-before.jsonl" 2>"$evidence_dir/killed-before.stderr" &
  pid=$!

  for _ in {1..100}; do
    if [[ -s "$cid_file" ]]; then
      break
    fi
    sleep 0.1
  done
  if [[ ! -s "$cid_file" ]]; then
    wait "$pid" || true
    return 1
  fi

  docker kill "$(<"$cid_file")" >/dev/null
  wait "$pid" || process_status=$?
  printf '%s\n' "$process_status" >"$evidence_dir/killed-before.exit"

  [[ "$process_status" -eq 137 ]] || return 1
  if jq -e 'select(.type == "thread.started")' "$evidence_dir/killed-before.jsonl" >/dev/null 2>&1; then
    return 1
  fi
}

kill_after_thread_started() {
  local cid_file=$evidence_dir/killed-after.cid
  local pid
  local process_status=0
  local thread_id

  printf 'Count from one to one hundred, one number per line.\n' | docker run --rm --platform linux/amd64 -i \
    --cidfile "$cid_file" --entrypoint sh \
    -v "$auth_file:/var/run/secrets/software-factory/codex-auth.json:ro" \
    "$image" -c '
      set -eu
      mkdir -p /work/.codex
      ln -s /var/run/secrets/software-factory/codex-auth.json /work/.codex/auth.json
      export CODEX_HOME=/work/.codex
      exec codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -
    ' >"$evidence_dir/killed-after.jsonl" 2>"$evidence_dir/killed-after.stderr" &
  pid=$!

  for _ in {1..100}; do
    if [[ -s "$cid_file" ]] && jq -e 'select(.type == "thread.started")' \
      "$evidence_dir/killed-after.jsonl" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done

  if [[ ! -s "$cid_file" ]]; then
    wait "$pid" || true
    return 1
  fi
  thread_id=$(jq -r 'select(.type == "thread.started") | .thread_id' \
    "$evidence_dir/killed-after.jsonl" | head -n 1)
  if [[ -z "$thread_id" || "$thread_id" == "null" ]]; then
    docker kill "$(<"$cid_file")" >/dev/null 2>&1 || true
    wait "$pid" || true
    return 1
  fi

  docker kill "$(<"$cid_file")" >/dev/null
  wait "$pid" || process_status=$?
  printf '%s\n' "$process_status" >"$evidence_dir/killed-after.exit"
  [[ "$process_status" -eq 137 ]] || return 1
  printf '%s\n' "$thread_id"
}

terminal_envelope_is_complete() {
  jq -e -s '
    length > 1 and
    ([.[] | select(.type == "thread.started" and (.thread_id | type == "string") and (.thread_id | length > 0))] | length == 1) and
    (last.type == "turn.completed")
  ' "$1" >/dev/null
}

usage_fields_are_complete() {
  jq -e -s '
    (last | select(.type == "turn.completed") | .usage) as $usage |
    ($usage | type == "object") and
    (["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"] |
      all(. as $field | $usage[$field] | type == "number"))
  ' "$1" >/dev/null
}

outputs_do_not_disclose_auth_strings() {
  local patterns=$evidence_dir/auth-patterns
  local output

  # Values stay in the mode-0700 temporary directory and are never printed.
  # Twelve characters avoids treating short schema labels as credentials.
  jq -r '.. | strings | select(length >= 12)' "$auth_file" >"$patterns"
  if [[ ! -s "$patterns" ]]; then
    return 0
  fi

  for output in \
    "$evidence_dir/first.jsonl" "$evidence_dir/first.stderr" \
    "$evidence_dir/resume.jsonl" "$evidence_dir/resume.stderr" \
    "$evidence_dir/killed-before.jsonl" "$evidence_dir/killed-before.stderr" \
    "$evidence_dir/killed-after.jsonl" "$evidence_dir/killed-after.stderr" \
    "$evidence_dir/resume-after-kill.jsonl" "$evidence_dir/resume-after-kill.stderr"; do
    if [[ -f "$output" ]] && grep -Fq -f "$patterns" "$output"; then
      return 1
    fi
  done
}

set +e
printf 'Describe the word telescope in exactly three words.\n' | run_fresh - \
  >"$evidence_dir/first.jsonl" 2>"$evidence_dir/first.stderr"
first_status=$?
set -e

thread_id=$(jq -r 'select(.type == "thread.started") | .thread_id' \
  "$evidence_dir/first.jsonl" | head -n 1)
resume_status=-1
resume_error="thread identity was not captured"
: >"$evidence_dir/resume.jsonl"
: >"$evidence_dir/resume.stderr"
if [[ -n "$thread_id" && "$thread_id" != "null" ]]; then
  set +e
  printf 'Reply with exactly: resumed\n' | run_fresh resume "$thread_id" - \
    >"$evidence_dir/resume.jsonl" 2>"$evidence_dir/resume.stderr"
  resume_status=$?
  set -e
  resume_error=$(tail -n 1 "$evidence_dir/resume.stderr")
fi

set +e
kill_before_thread_started
killed_before_status=$?
killed_thread_id=$(kill_after_thread_started)
killed_after_status=$?
set -e

killed_before_process_status=-1
if [[ -s "$evidence_dir/killed-before.exit" ]]; then
  killed_before_process_status=$(<"$evidence_dir/killed-before.exit")
fi
killed_after_process_status=-1
if [[ -s "$evidence_dir/killed-after.exit" ]]; then
  killed_after_process_status=$(<"$evidence_dir/killed-after.exit")
fi

resume_after_kill_status=-1
resume_after_kill_error="thread identity was not captured before kill"
: >"$evidence_dir/resume-after-kill.jsonl"
: >"$evidence_dir/resume-after-kill.stderr"
if [[ "$killed_after_status" -eq 0 ]]; then
  set +e
  printf 'Reply with exactly: resumed\n' | run_fresh resume "$killed_thread_id" - \
    >"$evidence_dir/resume-after-kill.jsonl" 2>"$evidence_dir/resume-after-kill.stderr"
  resume_after_kill_status=$?
  set -e
  resume_after_kill_error=$(tail -n 1 "$evidence_dir/resume-after-kill.stderr")
fi

set +e
terminal_envelope_is_complete "$evidence_dir/first.jsonl"
terminal_envelope_status=$?
usage_fields_are_complete "$evidence_dir/first.jsonl"
usage_fields_status=$?
outputs_do_not_disclose_auth_strings
secret_scan_status=$?
set -e

required_probes_status=0
if [[ "$first_status" -ne 0 || -z "$thread_id" || "$thread_id" == "null" || \
  "$terminal_envelope_status" -ne 0 || "$usage_fields_status" -ne 0 || \
  "$killed_before_status" -ne 0 || "$killed_after_status" -ne 0 || "$secret_scan_status" -ne 0 ]]; then
  required_probes_status=1
fi

jq -n \
  --arg image "$image" \
  --arg thread_id "$thread_id" \
  --argjson first_exit "$first_status" \
  --argjson terminal_envelope_verified "$([[ "$terminal_envelope_status" -eq 0 ]] && printf true || printf false)" \
  --argjson usage_fields_verified "$([[ "$usage_fields_status" -eq 0 ]] && printf true || printf false)" \
  --argjson usage "$(jq -sc '[.[] | select(.type == "turn.completed") | .usage] | first // null' "$evidence_dir/first.jsonl")" \
  --argjson resume_exit "$resume_status" \
  --arg resume_error "$resume_error" \
  --argjson killed_before_exit "$killed_before_process_status" \
  --argjson killed_before_verified "$([[ "$killed_before_status" -eq 0 ]] && printf true || printf false)" \
  --arg killed_thread_id "$killed_thread_id" \
  --argjson killed_after_exit "$killed_after_process_status" \
  --argjson killed_after_verified "$([[ "$killed_after_status" -eq 0 ]] && printf true || printf false)" \
  --argjson resume_after_kill_exit "$resume_after_kill_status" \
  --arg resume_after_kill_error "$resume_after_kill_error" \
  --argjson no_secret_disclosure "$([[ "$secret_scan_status" -eq 0 ]] && printf true || printf false)" \
  --argjson required_probes_verified "$([[ "$required_probes_status" -eq 0 ]] && printf true || printf false)" \
  '{
    image: $image,
    thread_id: $thread_id,
    first_exit: $first_exit,
    terminal_envelope_verified: $terminal_envelope_verified,
    usage_fields_verified: $usage_fields_verified,
    terminal_usage: $usage,
    resume_exit: $resume_exit,
    resume_error: $resume_error,
    fresh_filesystem_resume: ($resume_exit == 0),
    killed_before_thread_started: {
      container_exit: $killed_before_exit,
      verified: $killed_before_verified
    },
    killed_after_thread_started: {
      thread_id: $killed_thread_id,
      container_exit: $killed_after_exit,
      verified: $killed_after_verified,
      resume_exit: $resume_after_kill_exit,
      resume_error: $resume_after_kill_error,
      fresh_filesystem_resume: ($resume_after_kill_exit == 0)
    },
    no_secret_disclosure: $no_secret_disclosure,
    required_probes_verified: $required_probes_verified
  }'

if [[ "$required_probes_status" -ne 0 || "$resume_status" -ne 0 || "$resume_after_kill_status" -ne 0 ]]; then
  exit 1
fi

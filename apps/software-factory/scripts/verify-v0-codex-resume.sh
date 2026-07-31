#!/usr/bin/env bash

# Runs the v0 provider-resume gate against the exact sandbox image. It mounts
# the supplied auth document at the same path as the pod spec. Each docker
# invocation has a new /work filesystem, while an independent host-side sink
# receives JSONL events through an HTTP boundary before that filesystem dies.
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

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
evidence_dir=$(mktemp -d)
sink_pid=""

cleanup() {
  if [[ -n "$sink_pid" ]] && kill -0 "$sink_pid" >/dev/null 2>&1; then
    kill "$sink_pid" >/dev/null 2>&1 || true
    wait "$sink_pid" 2>/dev/null || true
  fi
  rm -rf "$evidence_dir"
}
trap cleanup EXIT

sink_binary=$evidence_dir/event-sink
sink_events=$evidence_dir/store-events.jsonl
sink_ready=$evidence_dir/sink-address
(
  cd "$script_dir/.."
  go build -o "$sink_binary" ./internal/runworkercapability/eventsink
)
"$sink_binary" -events "$sink_events" -ready "$sink_ready" \
  >"$evidence_dir/sink.stdout" 2>"$evidence_dir/sink.stderr" &
sink_pid=$!
for _ in {1..100}; do
  if [[ -s "$sink_ready" ]]; then
    break
  fi
  sleep 0.1
done
if [[ ! -s "$sink_ready" ]]; then
  echo "independent event sink did not start" >&2
  exit 1
fi
sink_address=$(<"$sink_ready")

run_fresh() {
  local docker_args=(run --rm --platform linux/amd64 -i --entrypoint sh)
  if [[ -n "${CODEX_CID_FILE:-}" ]]; then
    docker_args+=(--cidfile "$CODEX_CID_FILE")
  fi
  docker_args+=(-v "$auth_file:/var/run/secrets/software-factory/codex-auth.json:ro")
  docker "${docker_args[@]}" "$image" -c '
    set -eu
    mkdir -p /work/.codex
    ln -s /var/run/secrets/software-factory/codex-auth.json /work/.codex/auth.json
    export CODEX_HOME=/work/.codex
    exec codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "$@"
  ' -- "$@"
}

stream_events_to_sink() {
  local event
  while IFS= read -r event; do
    if [[ -z "$event" ]]; then
      continue
    fi
    curl --fail --silent --show-error \
      --header 'Content-Type: application/json' \
      --request POST \
      --data-binary "$event" \
      "http://$sink_address/events" >/dev/null
  done
}

kill_before_thread_started() {
  local probe_dir=$evidence_dir/pre-identity
  local cid_file=$probe_dir/container.cid
  local pid
  local process_status=0
  local executable
  local rollout_count

  mkdir -p "$probe_dir"
  docker run --rm --platform linux/amd64 -i --cidfile "$cid_file" --entrypoint sh \
    -v "$auth_file:/var/run/secrets/software-factory/codex-auth.json:ro" \
    -v "$probe_dir:/probe" \
    "$image" -c '
      set -eu
      mkdir -p /work/.codex
      ln -s /var/run/secrets/software-factory/codex-auth.json /work/.codex/auth.json
      export CODEX_HOME=/work/.codex
      mkfifo /tmp/codex-probe-input
      exec 3<>/tmp/codex-probe-input
      codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check - \
        </tmp/codex-probe-input &
      codex_pid=$!
      while :; do
        executable=$(readlink "/proc/$codex_pid/exe" 2>/dev/null || true)
        case "$executable" in
          ""|*/sh|*/dash) ;;
          *) break ;;
        esac
      done
      rollout_count=$(find /work/.codex -type f -name "rollout-*.jsonl" | wc -l | tr -d " ")
      printf "pid=%s\nexecutable=%s\nrollout_count=%s\n" \
        "$codex_pid" "$executable" "$rollout_count" >/probe/process
      wait "$codex_pid"
    ' >"$evidence_dir/killed-before.jsonl" 2>"$evidence_dir/killed-before.stderr" &
  pid=$!

  for _ in {1..100}; do
    if [[ -s "$cid_file" && -s "$probe_dir/process" ]]; then
      break
    fi
    sleep 0.1
  done
  if [[ ! -s "$cid_file" || ! -s "$probe_dir/process" ]]; then
    if [[ -s "$cid_file" ]]; then
      docker kill "$(<"$cid_file")" >/dev/null 2>&1 || true
    fi
    wait "$pid" || true
    return 1
  fi

  executable=$(awk -F= '$1 == "executable" {sub(/^[^=]*=/, ""); print}' "$probe_dir/process")
  rollout_count=$(awk -F= '$1 == "rollout_count" {print $2}' "$probe_dir/process")
  if [[ -z "$executable" ]] || ! docker top "$(<"$cid_file")" -eo pid,comm,args | grep -q '[c]odex exec'; then
    docker kill "$(<"$cid_file")" >/dev/null 2>&1 || true
    wait "$pid" || true
    return 1
  fi

  docker kill "$(<"$cid_file")" >/dev/null
  wait "$pid" || process_status=$?
  printf '%s\n' "$process_status" >"$evidence_dir/killed-before.exit"
  printf '%s\n' "$executable" >"$evidence_dir/killed-before.executable"
  printf '%s\n' "$rollout_count" >"$evidence_dir/killed-before.rollouts"

  [[ "$process_status" -eq 137 && "$rollout_count" -eq 0 ]] || return 1
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
    "$sink_events" "$evidence_dir/first.stderr" \
    "$evidence_dir/resume.jsonl" "$evidence_dir/resume.stderr" \
    "$evidence_dir/killed-before.jsonl" "$evidence_dir/killed-before.stderr" \
    "$evidence_dir/killed-after.jsonl" "$evidence_dir/killed-after.stderr" \
    "$evidence_dir/resume-after-kill.jsonl" "$evidence_dir/resume-after-kill.stderr" \
    "$evidence_dir/sink.stdout" "$evidence_dir/sink.stderr"; do
    if [[ -f "$output" ]] && grep -Fq -f "$patterns" "$output"; then
      return 1
    fi
  done
}

first_pipe=$evidence_dir/first.pipe
first_cid_file=$evidence_dir/first.cid
mkfifo "$first_pipe"
stream_events_to_sink <"$first_pipe" &
forward_pid=$!
set +e
printf 'Describe the word telescope in exactly three words.\n' | \
  CODEX_CID_FILE="$first_cid_file" run_fresh - \
  >"$first_pipe" 2>"$evidence_dir/first.stderr" &
first_pid=$!
set -e

incremental_stream_status=1
for _ in {1..300}; do
  sink_count=$(curl --fail --silent "http://$sink_address/count" 2>/dev/null || printf 0)
  if [[ -s "$first_cid_file" && "$sink_count" -ge 1 ]] && \
    [[ "$(docker inspect -f '{{.State.Running}}' "$(<"$first_cid_file")" 2>/dev/null)" == "true" ]]; then
    incremental_stream_status=0
    break
  fi
  sleep 0.1
done

set +e
wait "$first_pid"
first_status=$?
wait "$forward_pid"
forward_status=$?
set -e

worker_container_deleted_status=1
for _ in {1..100}; do
  if ! docker inspect "$(<"$first_cid_file")" >/dev/null 2>&1; then
    worker_container_deleted_status=0
    break
  fi
  sleep 0.1
done
sink_survived_worker_status=1
if kill -0 "$sink_pid" >/dev/null 2>&1 && curl --fail --silent "http://$sink_address/count" >/dev/null; then
  sink_survived_worker_status=0
fi
store_event_count=$(curl --fail --silent "http://$sink_address/count")

thread_id=$(jq -r 'select(.type == "thread.started") | .thread_id' "$sink_events" | head -n 1)
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
killed_before_executable=""
killed_before_rollouts=-1
if [[ -s "$evidence_dir/killed-before.exit" ]]; then
  killed_before_process_status=$(<"$evidence_dir/killed-before.exit")
fi
if [[ -s "$evidence_dir/killed-before.executable" ]]; then
  killed_before_executable=$(<"$evidence_dir/killed-before.executable")
fi
if [[ -s "$evidence_dir/killed-before.rollouts" ]]; then
  killed_before_rollouts=$(<"$evidence_dir/killed-before.rollouts")
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
terminal_envelope_is_complete "$sink_events"
terminal_envelope_status=$?
usage_fields_are_complete "$sink_events"
usage_fields_status=$?
outputs_do_not_disclose_auth_strings
secret_scan_status=$?
set -e

required_probes_status=0
if [[ "$first_status" -ne 0 || "$forward_status" -ne 0 || -z "$thread_id" || "$thread_id" == "null" || \
  "$incremental_stream_status" -ne 0 || "$worker_container_deleted_status" -ne 0 || \
  "$sink_survived_worker_status" -ne 0 || "$terminal_envelope_status" -ne 0 || \
  "$usage_fields_status" -ne 0 || "$killed_before_status" -ne 0 || \
  "$killed_after_status" -ne 0 || "$secret_scan_status" -ne 0 ]]; then
  required_probes_status=1
fi

jq -n \
  --arg image "$image" \
  --arg thread_id "$thread_id" \
  --argjson first_exit "$first_status" \
  --argjson incremental_stream_verified "$([[ "$incremental_stream_status" -eq 0 ]] && printf true || printf false)" \
  --argjson store_event_count "$store_event_count" \
  --argjson worker_filesystem_deleted "$([[ "$worker_container_deleted_status" -eq 0 ]] && printf true || printf false)" \
  --argjson sink_survived_worker "$([[ "$sink_survived_worker_status" -eq 0 ]] && printf true || printf false)" \
  --argjson terminal_envelope_verified "$([[ "$terminal_envelope_status" -eq 0 ]] && printf true || printf false)" \
  --argjson usage_fields_verified "$([[ "$usage_fields_status" -eq 0 ]] && printf true || printf false)" \
  --argjson usage "$(jq -sc '[.[] | select(.type == "turn.completed") | .usage] | first // null' "$sink_events")" \
  --argjson resume_exit "$resume_status" \
  --arg resume_error "$resume_error" \
  --arg killed_before_executable "$killed_before_executable" \
  --argjson killed_before_rollouts "$killed_before_rollouts" \
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
    transcript_store: {
      incremental_stream_verified: $incremental_stream_verified,
      event_count: $store_event_count,
      worker_filesystem_deleted: $worker_filesystem_deleted,
      sink_survived_worker: $sink_survived_worker,
      terminal_envelope_verified: $terminal_envelope_verified,
      usage_fields_verified: $usage_fields_verified,
      terminal_usage: $usage
    },
    resume_exit: $resume_exit,
    resume_error: $resume_error,
    fresh_filesystem_resume: ($resume_exit == 0),
    killed_before_thread_started: {
      executable: $killed_before_executable,
      rollout_files: $killed_before_rollouts,
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

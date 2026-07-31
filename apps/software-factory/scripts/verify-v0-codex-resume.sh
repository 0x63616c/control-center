#!/usr/bin/env bash

# Runs the v0 provider-resume gate against the exact sandbox image. It mounts
# the supplied auth document at the same path as the pod spec, but never reads
# or prints it. Each docker invocation has a new /work filesystem, so a resume
# can succeed only through the provider identity captured from the first run.
set -euo pipefail

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

kill_after_thread_started() {
	local cid_file=$evidence_dir/killed.cid
	local pid
	printf 'Count from one to one hundred, one number per line.\n' | docker run --rm --platform linux/amd64 -i --cidfile "$cid_file" --entrypoint sh \
		-v "$auth_file:/var/run/secrets/software-factory/codex-auth.json:ro" \
		"$image" -c '
			set -eu
			mkdir -p /work/.codex
			ln -s /var/run/secrets/software-factory/codex-auth.json /work/.codex/auth.json
			export CODEX_HOME=/work/.codex
			exec codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -
		' >"$evidence_dir/killed.jsonl" 2>"$evidence_dir/killed.stderr" &
	pid=$!

	for _ in {1..100}; do
		if [[ -s "$cid_file" && -s "$evidence_dir/killed.jsonl" ]] && grep -q '"type":"thread.started"' "$evidence_dir/killed.jsonl"; then
			break
		fi
		sleep 0.1
	done

	if [[ ! -s "$cid_file" ]]; then
		wait "$pid"
		return 1
	fi
	local killed_thread_id
	killed_thread_id=$(jq -r 'select(.type == "thread.started") | .thread_id' "$evidence_dir/killed.jsonl" | head -n 1)
	if [[ -z "$killed_thread_id" || "$killed_thread_id" == "null" ]]; then
		docker kill "$(<"$cid_file")" >/dev/null 2>&1 || true
		wait "$pid" || true
		return 1
	fi

	docker kill "$(<"$cid_file")" >/dev/null
	local process_status=0
	wait "$pid" || process_status=$?
	printf '%s\n' "$process_status" >"$evidence_dir/killed.exit"
	printf '%s\n' "$killed_thread_id"
}

set +e
printf 'Describe the word telescope in exactly three words.\n' | run_fresh - >"$evidence_dir/first.jsonl" 2>"$evidence_dir/first.stderr"
first_status=$?
set -e

thread_id=$(jq -r 'select(.type == "thread.started") | .thread_id' "$evidence_dir/first.jsonl" | head -n 1)
if [[ "$first_status" -ne 0 || -z "$thread_id" || "$thread_id" == "null" ]]; then
  jq -n \
    --arg image "$image" \
    --argjson first_exit "$first_status" \
    --arg first_stderr "$(tail -n 1 "$evidence_dir/first.stderr")" \
    '{image: $image, first_exit: $first_exit, first_stderr: $first_stderr, conclusion: "thread identity was not captured"}'
  exit 1
fi

set +e
printf 'Reply with exactly: resumed\n' | run_fresh resume "$thread_id" - >"$evidence_dir/resume.jsonl" 2>"$evidence_dir/resume.stderr"
resume_status=$?
set -e

set +e
killed_thread_id=$(kill_after_thread_started)
killed_thread_status=$?
set -e
resume_after_kill_status=-1
resume_after_kill_error="thread identity was not captured before kill"
killed_process_status=-1
if [[ "$killed_thread_status" -eq 0 ]]; then
	killed_process_status=$(<"$evidence_dir/killed.exit")
	set +e
	printf 'Reply with exactly: resumed\n' | run_fresh resume "$killed_thread_id" - >"$evidence_dir/resume-after-kill.jsonl" 2>"$evidence_dir/resume-after-kill.stderr"
	resume_after_kill_status=$?
	set -e
	resume_after_kill_error=$(tail -n 1 "$evidence_dir/resume-after-kill.stderr")
fi

jq -n \
  --arg image "$image" \
  --arg thread_id "$thread_id" \
  --argjson first_exit "$first_status" \
  --argjson resume_exit "$resume_status" \
  --arg resume_error "$(tail -n 1 "$evidence_dir/resume.stderr")" \
  --arg killed_thread_id "$killed_thread_id" \
  --argjson killed_thread_capture_exit "$killed_thread_status" \
  --argjson killed_process_exit "$killed_process_status" \
  --argjson resume_after_kill_exit "$resume_after_kill_status" \
  --arg resume_after_kill_error "$resume_after_kill_error" \
  --argjson usage "$(jq -sc '[.[] | select(.type == "turn.completed") | .usage] | first // null' "$evidence_dir/first.jsonl")" \
  '{
    image: $image,
    thread_id: $thread_id,
    first_exit: $first_exit,
    terminal_usage: $usage,
    resume_exit: $resume_exit,
    resume_error: $resume_error,
    fresh_filesystem_resume: ($resume_exit == 0),
    killed_after_thread_started: {
      thread_id: $killed_thread_id,
      thread_capture_exit: $killed_thread_capture_exit,
      container_exit: $killed_process_exit,
      resume_exit: $resume_after_kill_exit,
      resume_error: $resume_after_kill_error,
      fresh_filesystem_resume: ($resume_after_kill_exit == 0)
    }
  }'

if [[ "$resume_status" -ne 0 ]]; then
  exit 1
fi

# Live proof evidence

Captured on 2026-08-01 UTC against the local OrbStack Kubernetes cluster with
one `agent-poc-worker` replica and model `gpt-5.6-sol`.

No credential values are recorded here.

## Direct HTTP and SSE call

The direct smoke call completed through the private ChatGPT Codex Responses
backend:

```text
Outcome: final_text
ResponseID: resp_05f130cf44051ace016a6d5d918e108199aaa320bab9061b09
Text: DIRECT_OK
Status: completed
Usage: input 33, output 6, total 39
```

## Temporal tool loop

Workflow `agent-poc-20260801T024447Z`, run
`019fbb35-ba0d-748b-82de-d6f27cf1c8d9`, completed with:

```text
FinalText: Temporal durably resumes work after worker failure.
ModelTurns: 2
ToolCalls: 1
Usage: input 423, output 34, total 457
```

## Sole-worker restart recovery

Workflow `agent-poc-restart-20260801T024524Z`, run
`019fbb36-4804-7c11-a253-6cdd0f29939b`, was started with a delayed tool
activity. The script observed that activity running and force-deleted the sole
worker pod. Temporal then completed the same workflow after the replacement pod
became ready.

```text
activity attempt 1: 1@agent-poc-worker-64fff6f887-rqdx5@
activity attempt 2: 1@agent-poc-worker-64fff6f887-q2d24@
next activity:      1@agent-poc-worker-64fff6f887-q2d24@
workflow_completed: 1

FinalText: Temporal durably resumes work after worker failure.
ModelTurns: 2
ToolCalls: 1
Usage: input 423, output 34, total 457
```

The changed worker identity and second attempt prove that Temporal recovered
the in-flight tool activity after loss of the only worker pod.

## Secret-safety check

The worker logs and this workflow's Temporal history were scanned for common
credential field/header names and with gitleaks in redacted mode. No matches or
leaks were found.

The dedicated service account was also checked with Kubernetes authorization:
it can `get` and `update` only the named `codex-auth` Secret and cannot list
Secrets. The durable Secret held only the expected `auth.json` key; its value
was never read or printed.

# Live proof evidence

Captured on 2026-08-01 UTC against the local OrbStack Kubernetes cluster with
one `agent-poc-worker` replica and model `gpt-5.6-sol`.

No credential values are recorded here.

## Direct HTTP and SSE call

The direct smoke call completed through the private ChatGPT Codex Responses
backend:

```text
Outcome: final_text
ResponseID: resp_005eaa64cfafafb7016a6d5a2375dc8199b5fc9ac92b693c82
Text: DIRECT_OK
Status: completed
Usage: input 33, output 6, total 39
```

## Temporal tool loop

Workflow `agent-poc-20260801T022400Z`, run
`019fbb22-aee7-7b74-957d-19938fe75943`, completed with:

```text
FinalText: Temporal durably resumes work after worker failure.
ModelTurns: 2
ToolCalls: 1
Usage: input 415, output 34, total 449
```

## Sole-worker restart recovery

Workflow `agent-poc-restart-20260801T022956Z`, run
`019fbb28-1e49-78cb-ad18-a2a6e8badc55`, was started with a delayed tool
activity. The script observed that activity running and force-deleted the sole
worker pod. Temporal then completed the same workflow after the replacement pod
became ready.

```text
activity attempt 1: 1@agent-poc-worker-7f446d8c6f-4fw42@
activity attempt 2: 1@agent-poc-worker-7f446d8c6f-gld4d@
next activity:      1@agent-poc-worker-7f446d8c6f-gld4d@
workflow_completed: 1

FinalText: Temporal durably resumes work after worker failure.
ModelTurns: 2
ToolCalls: 1
Usage: input 415, output 34, total 449
```

The changed worker identity and second attempt prove that Temporal recovered
the in-flight tool activity after loss of the only worker pod.

## Secret-safety check

The worker logs and this workflow's Temporal history were scanned for common
credential field/header names and with gitleaks in redacted mode. No matches or
leaks were found.

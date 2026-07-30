# Runbook: software-factory first live run (ADR-0011)

> **NOT YET EXECUTED.** Written ahead of the run so the first attempt is watched
> rather than discovered. Update it in place afterwards with what actually
> happened — reality diverging from this file is the point of writing it down.

The first run opens a **real PR** against this repo. There is no dry-run mode and
none is being built (Calum, 2026-07-28, #345), so the safety comes from a
throwaway ticket, a watched run and a rehearsed abort — not from a flag.

Everything below runs from a worktree of this repo. `kubectl` and `talosctl`
reach prod over the LAN; there is **no SSH to home-server**.

Two kinds of angle bracket. `<n>`, `<ticket>`, `<run-id>`, `<stage>` are values
you have — substitute them. `<name: track/#issue>` is a name that **does not
exist yet**; a step needing one cannot be run until the work
that defines it lands.

## 0. What must be true first (hard gate)

- [ ] Every earlier track merged: B5 (#337), C1 (#338), C2 (#339), D1 (#340),
      E1 (#341), E2 (#342), F1 (#343), F2 (#344). G is last by construction.
- [ ] **Merged ≠ deployed — but by now both are true.** `apps/software-factory/**`
      is its own CI path filter, deliberately absent from `any_app`
      (`.github/workflows/ci.yml`), and `deploy-home-server` fires on
      `any_app || infra || softwarefactory || (workflow_dispatch && force_all)`
      (`ci.yml`) since E2 (#342) wired the `softwarefactory` term in. Do not
      infer "running" from "merged" — look:

      kubectl -n software-factory get deploy,pods

      Today that prints the `software-factory-worker` Deployment `1/1` Ready
      with a `Running` pod (live since #369).

- [ ] Temporal namespace registered (already true):

      kubectl -n temporal get job temporal-namespace-software-factory
      # NAME                                  STATUS     COMPLETIONS
      # temporal-namespace-software-factory   Complete   1/1

- [ ] The worker is polling its task queue — a Deployment that is `Ready` proves
      the process started, not that it registered. Check the queue has a poller
      with `task-queue describe --task-queue software-factory` (§3, CLI pod;
      the value is `work.TaskQueue`, `internal/work/queue.go:39`). Expect a
      poller for each `TaskQueueType` (`activity`, `workflow`), `Identity`
      naming the running pod, `LastAccessTime` seconds ago.
- [ ] The codex credential is seeded (F2) and the GitHub App config Secret is
      wired (F1). Check **presence only**:

      kubectl -n software-factory get secret

      Never `-o yaml`, never `describe`, never decrypt to stdout.

- [ ] Calum is at a keyboard. The run ends with a real PR he closes by hand.

## 1. The throwaway ticket

File it like any other (`/create-ticket`), with `auto` **withheld** until §2:

    gh issue create --title "software-factory smoke: <one tiny change>" \
      --label area/tooling --label type/chore

Pick work that touches **one file**, has an obvious right answer, and would be
harmless if it were merged by accident. It will not be merged — choose as though
it might.

## 2. Start it

    gh issue edit <n> --add-label auto

The dispatcher timer-loops every 30s (ADR-0011), so pickup is within a minute.
There is no way to make it go sooner; `WorkNow` was dropped deliberately.

## 3. Watch it — four windows

**The ticket.** A comment per step, appended as the run goes: pickup, one per
stage (posted running, edited to done/failed), then the outcome with token
totals (#331). This is the fastest read on where the run is.

**Temporal.** `temporal-ui` is ClusterIP with no public hostname:

    kubectl -n temporal port-forward svc/temporal-ui 8080:8080
    # http://localhost:8080 → namespace software-factory → work-ticket-<n>

For the CLI, the server image ships **no** `temporal` binary — `/usr/local/bin`
holds only `temporal-server`. Use a throwaway admin-tools pod:

    kubectl -n temporal run tmp-temporal-cli --rm -i --restart=Never \
      --image=temporalio/admin-tools:1.31.2 \
      --command -- temporal --address temporal-server:7233 \
      --namespace software-factory workflow list

Swap the trailing subcommand for `workflow describe`, `workflow terminate`
(abort lever 3, §5) or `task-queue describe --task-queue software-factory`
(`work.TaskQueue`, §0).

Four `would violate PodSecurity "restricted"` warnings are expected and mean
nothing is wrong: neither `temporal` nor `software-factory` carries PodSecurity
labels (verified 2026-07-28), the cluster default warns on `restricted` without
enforcing it, and the pod is admitted and runs. There is no misconfigured
namespace here to go and fix.

**`workflow list` prints nothing at all and exits 0** until the first run exists,
because `software-factory` has no workflows yet. Empty is the correct output
today, not a broken command — verified 2026-07-28. To prove the harness itself
works before the first run, swap in `operator namespace list`, which returns
`temporal-system`, `control-center`, `software-factory`.

**The output is also sometimes lost outright, and that does not mean the command
did not run.** `kubectl run --rm -i` deletes the pod the moment the container
exits, and attach can lose that race: you get `couldn't attach to pod … falling
back to streaming logs`, then nothing. Measured 2026-07-28 against prod with
`operator namespace list`, which prints 18 lines and is never empty — output
arrived in 4 of 5 runs of the form above, and in 1 of 3 of an earlier set.

**So never read an empty result as "it didn't happen"**, above all for
`workflow terminate`: the next lever up is 4, which stops every other in-flight
ticket to stop one. Confirm rather than escalate —

    … --namespace software-factory workflow describe --workflow-id work-ticket-<n>

— and read the status. A missing confirmation costs one more read; the wrong
inference costs every other run.

When you need the output to be there, sleep **before** the command so `kubectl`
attaches while the container is still idle:

    kubectl -n temporal run tmp-temporal-cli --rm -i --restart=Never \
      --image=temporalio/admin-tools:1.31.2 --command -- sh -c \
      'sleep 2; temporal --address temporal-server:7233 --namespace software-factory workflow list'

Measured 2026-07-28: **10 of 10** runs printed. Sleeping *after* the command
instead is worse than not sleeping at all — **0 of 5** printed, because attach
then connects only once the output has already gone.

**Logs.** Grafana → Explore → Loki, 14-day retention:

    {namespace="software-factory"}
    {namespace="software-factory", level="error"}

Transcripts outlive Loki and are the record of what the model actually did.
The path under the volume is `<ticket>/<run-id>/<stage>.jsonl`
(`work.StageKey.TranscriptPath`), mounted at `/transcripts`
(`TRANSCRIPTS_MOUNT_PATH`, `infra/src/software-factory.ts`) since F1 (#343)
landed. Full path: `/transcripts/<ticket>/<run-id>/<stage>.jsonl`.

**Pods.** The window the other three miss:

    kubectl -n software-factory get pods -w

A sandbox stuck `Pending` or in `ImagePullBackOff`, or evicted, shows up nowhere
else promptly: the ticket comment still says the stage is running, Temporal still
shows an activity in flight, and Loki has nothing because the container never
started. On a first run this is where the boring failures live.

## 4. What wrong looks like

| Symptom | Cause | Do |
|---|---|---|
| `codex exec` exits **1 with empty stdout** | a proactive token refresh failed. The diagnosis is on **stderr only**, and the CLI retries ~104 times in ~35s against `auth.openai.com` first | read the stage's stderr, not its stdout. **The most likely first-run failure** (#340) |
| 403 on pod create / watch / exec | the worker Role is missing a verb — `watch` on `pods`, `get` on `pods/exec` | fix the Role (#343), not the code |
| worker wedges during startup | the transcript volume mounted `hard`; an unreachable NFS server hangs inside `New` | must be `soft` with bounded `timeo`/`retrans` (#343) |
| run keeps burning quota while rate-limited | detection is a heuristic on error text — ADR-0011 admits no structured event exists | expect false negatives; abort by hand (§5) |
| status comment edit 404s | someone deleted the comment | policy is **undecided** (open on #331). Note what happened; do not invent one |
| a plausible but wrong PR | the system working as designed | close it. This is the cost the design accepts |

## 5. Abort — four levers, least blast radius first

1. **Remove `auto`.** `gh issue edit <n> --remove-label auto`. Stops new claims;
   the in-flight run keeps going.
2. **Pause the dispatcher.** `UpdateConfig` signal with the paused field set —
   the control surface is one signal and one query (ADR-0011), sendable from the
   Temporal UI or the CLI pod above. Leaves in-flight tickets running.
3. **Terminate one ticket.** `workflow terminate --workflow-id work-ticket-<n>`
   from the CLI pod. **It often prints nothing even when it worked** (§3) —
   confirm with `workflow describe`, do not assume it failed and reach for 4.
   Its sandbox pod is not reaped by the terminate either — check
   `kubectl -n software-factory get pods` and delete it.
4. **Stop everything.**
   `kubectl -n software-factory scale deploy/<worker-deployment: F1/#343> --replicas=0`.

After 2–4, check whether `implement` had already pushed:

    git ls-remote --heads origin | grep <the run's branch>

Decide by hand. **Never** `git branch -D` or `git worktree remove` here — other
sessions own branches you cannot see (AGENTS.md).

## 6. Aftermath

- [ ] Calum closes the PR by hand.
- [ ] `gh issue edit <n> --remove-label auto`, then close the throwaway ticket.
- [ ] Record the run on #345: which stages ran, tokens spent (they are in the
      outcome comment), what broke, what this file got wrong.
- [ ] Anything unvalidatable-until-prod that the run **did** validate — the
      `pods/exec` WebSocket→SPDY fallback, `CodeExitError` carrying the real exit
      code, rate-limit detection — gets said plainly on its own ticket. Those are
      open specifically because no test can reach them (#343).

## 7. Retire `grind-tickets` (gated on §6)

Only once a run has reached `propose` on its own. Then, one PR, `Refs #345`:

- [ ] delete `.claude/workflows/grind-tickets.js`
- [ ] AGENTS.md — the `auto` label bullet still says `grind-tickets` draws from
      that pool; the worker does now
- [ ] ADR-0011's opening already states the workflow is deleted; make that true
      rather than editing it

Until then it stays. It is the working tool, and the thing replacing it has
never run.

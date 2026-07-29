# Runbook: software-factory first live run (ADR-0011)

> **NOT YET EXECUTED.** Written ahead of the run so the first attempt is watched
> rather than discovered. Update it in place afterwards with what actually
> happened — reality diverging from this file is the point of writing it down.

The first run opens a **real PR** against this repo. There is no dry-run mode and
none is being built (Calum, 2026-07-28, #345), so the safety comes from a
throwaway ticket, a watched run and a rehearsed abort — not from a flag.

Everything below runs from a worktree of this repo. `kubectl` and `talosctl`
reach prod over the LAN; there is **no SSH to home-server**.

## 0. What must be true first (hard gate)

- [ ] Every earlier track merged: B5 (#337), C1 (#338), C2 (#339), D1 (#340),
      E1 (#341), E2 (#342), F1 (#343), F2 (#344). G is last by construction.
- [ ] **Merged ≠ deployed.** `apps/software-factory/**` is its own CI path filter
      and is deliberately absent from `any_app` (`.github/workflows/ci.yml`), and
      `deploy-home-server` fires on `any_app || infra`. Until E2 wires the build
      and deploy path, a software-factory-only merge is green with zero effect on
      prod. Do not infer "running" from "merged" — look:

      kubectl -n software-factory get deploy,pods

      Today that prints `No resources found in software-factory namespace.`

- [ ] Temporal namespace registered (already true):

      kubectl -n temporal get job temporal-namespace-software-factory
      # NAME                                  STATUS     COMPLETIONS
      # temporal-namespace-software-factory   Complete   1/1

- [ ] The worker is polling its task queue — a Deployment that is `Ready` proves
      the process started, not that it registered. Check the queue has a poller
      (§3, CLI pod).
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

## 3. Watch it — three windows

**The ticket.** A comment per step, appended as the run goes: pickup, one per
stage (posted running, edited to done/failed), then the outcome with token
totals (#331). This is the fastest read on where the run is.

**Temporal.** `temporal-ui` is ClusterIP with no public hostname:

    kubectl -n temporal port-forward svc/temporal-ui 8080:8080
    # http://localhost:8080 → namespace software-factory → work-ticket-<n>

For the CLI, the server image ships **no** `temporal` binary — `/usr/local/bin`
holds only `temporal-server`. Use a throwaway admin-tools pod; the `temporal`
namespace enforces PodSecurity `restricted`, so it needs the overrides:

    kubectl -n temporal run tmp-temporal-cli --rm -i --restart=Never \
      --image=temporalio/admin-tools:1.31.2 \
      --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":1000,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"tmp-temporal-cli","image":"temporalio/admin-tools:1.31.2","securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}},"command":["temporal","--address","temporal-server:7233","--namespace","software-factory","workflow","list"]}]}}'

Verified 2026-07-28 against prod with `operator namespace list`, which returned
`temporal-system`, `control-center`, `software-factory`. Swap the trailing
`command` for `task-queue describe`, `workflow describe`, `workflow terminate`.

**Logs.** Grafana → Explore → Loki, 14-day retention:

    {namespace="software-factory"}
    {namespace="software-factory", level="error"}

Transcripts outlive Loki and are the record of what the model actually did:
`/transcripts/<ticket>/<run-id>/<stage>.jsonl` on the worker's volume.

## 4. What wrong looks like

| Symptom | Cause | Do |
|---|---|---|
| `codex exec` exits **1 with empty stdout** | a proactive token refresh failed. The diagnosis is on **stderr only**, and the CLI retries ~104 times in ~35s against `auth.openai.com` first | read the stage's stderr, not its stdout. **The most likely first-run failure** (#340) |
| 403 on pod create / watch / exec | the worker Role is missing a verb — `watch` on `pods`, `get` on `pods/exec` | fix the Role (#343), not the code |
| worker wedges during startup | `/transcripts` mounted `hard`; an unreachable NFS server hangs inside `New` | must be `soft` with bounded `timeo`/`retrans` (#343) |
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
   from the CLI pod. Its sandbox pod is not reaped by that — check
   `kubectl -n software-factory get pods` and delete it.
4. **Stop everything.** `kubectl -n software-factory scale deploy/<worker> --replicas=0`.

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

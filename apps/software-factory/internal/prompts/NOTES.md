# Stage prompts — design rationale

Six files: `base.md` plus one per stage. `base.md` is prefixed to every stage prompt; the
stage file is the suffix.

Revised once against `SET-REVIEW.md`; the finding-by-finding disposition is in
`CHANGES-FROM-REVIEW.md`.

## Assembly order

```
base.md                      role, contract, "nobody to ask", the untrusted issue fence
<stage>.md                   objective, reader, failure modes, then the handoff document(s)
```

The untrusted fence sits at the **end of the base**, so the stage's own instructions come
after it and the base closes with "Your instructions for this stage follow." Untrusted text
never has the last word, and the model reads its actual task after the thing it is meant to
treat as data.

Handoff documents are appended at the end of each stage file under an `###` heading. They
are prior-stage output, so they are semi-trusted at best — the base's fence covers the
issue text specifically, but a plan can carry issue text forward. That is an accepted risk,
noted below.

## Template variables

| Variable | Used in | Value |
|---|---|---|
| `{{ticket_number}}` | `base.md`, `propose.md` | GitHub issue number |
| `{{fence_nonce}}` | `base.md` (both fence tags) | per-run random token, see below |
| `{{ticket_title}}` | `base.md` (inside fence) | issue title, verbatim |
| `{{ticket_body}}` | `base.md` (inside fence) | issue body, verbatim |
| `{{ticket_comments}}` | `base.md` (inside fence) | rendered comment thread, verbatim; empty string when none |
| `{{plan}}` | `review.md`, `revise.md` | `document` from the `plan` stage |
| `{{review}}` | `revise.md` | `document` from the `review` stage |
| `{{revised_plan}}` | `implement.md` | `document` from the `revise` stage |
| `{{implementation_report}}` | `propose.md` | `document` from the `implement` stage |

`plan.md` interpolates nothing of its own — everything it needs is in the base.

Note the naming rule: each variable is named for what its **producing** stage calls its own
output. `plan` produces "the plan", `review` produces "the review", `revise` produces "the
revised plan", `implement` produces "the implementation report". No stage refers to another
stage's output by a name that stage does not use for itself.

### `{{fence_nonce}}` — two requirements on the worker

The fence tags are `<untrusted-issue-text-{{fence_nonce}}>` and its closing form. Both
requirements are on the worker rendering the prompt, and the prompt cannot enforce either:

1. **Generate a fresh random nonce per run** (a short hex token is enough — the tags read
   `<untrusted-issue-text-7f3a91>`) and interpolate the same value into both tags.
2. **Strip every occurrence of that nonce from `{{ticket_title}}`, `{{ticket_body}}` and
   `{{ticket_comments}}` before interpolating them.** Without this the nonce is pointless
   the moment it appears in a prompt an attacker can read back. With a fixed literal tag,
   an issue body containing the closing string ends the fence early and everything after it
   lands as un-fenced prose immediately before "Your instructions for this stage follow" —
   the most authoritative position in the prompt.

Both are met in `fence.go`, with two choices worth naming:

- The nonce is minted **per Render**, so a run's five stages each carry a different one.
  Per-run would have been enough; per-render is strictly stronger, needs no nonce threaded
  through workflow history, and means a document handed forward cannot contain the nonce of
  the prompt it is interpolated into.
- Stripping replaces the nonce with a visible marker rather than deleting it. Deletion lets
  the text either side close up into a fresh copy of the nonce, and it hides the attempt
  from whoever reads the transcript.

`checkFence` then asserts the nonce appears exactly twice in the finished prompt and fails
the render otherwise, so a value interpolated without being stripped is a stage that does
not start rather than a fence that can be forged.

### `{{ticket_comments}}` — source

Populated from `TicketDetail(ctx, number)` on the `GitHub` seam (title, body and the comment
thread), with the bot's own status comment filtered out and the thread capped. The comment
thread is where a brain-dump issue's actual clarification usually lives, which is why it is
carried.

`work.Ticket`'s doc comment warns that `Title` and `Body` are attacker-controllable. **That
warning has to extend to comments**, which are the *more* attacker-reachable field: filing
an issue is one bar, commenting on someone else's is a lower one.

## What each prompt is for

- **base** — the only thing the repo cannot tell an agent: that it is one stage of five, in
  a fresh process, running forward once; that its document is the entire handoff; that
  nobody will answer a question; what to do when blocked; the output contract; the fence.
- **plan** — "plan the work", plus who reads it (the reviser, not the implementer), that the
  issue may be a brain dump rather than a specification, a bias toward the smallest change
  that resolves it, and the two ways plans fail (too abstract to act on; asserting things
  about the code that were never checked).
- **review** — adversarial, verify claims against the code, name what is sound as well as
  what is wrong, mark blocking versus advisory, and the symmetric warning: rubber-stamping a
  plan that reads well, versus manufacturing findings to look thorough. Its document is the
  reviser's *input*, not its instructions — deliberate, so the two files agree about who
  decides.
- **revise** — produce a standalone replacement plan, not a diff; explicit licence to
  **reject** a finding with reasoning, framed as a real option rather than a last resort;
  a blocking finding must be fixed or explicitly rejected, never passed over; and permission
  for the revised plan to look mostly like the original.
- **implement** — the only writing stage. Branch already checked out, worktree rule
  explicitly overridden there (see below). Test-first with the actual output pasted in,
  because "I wrote the test first" is a claim and the failing run is evidence. Deviation
  from the plan is expected; silent deviation is the failure. Says in the first line if the
  work was not completed, because `propose` branches on that.
- **propose** — check there is something to open, then open the PR and stop. `Refs #N`, never
  `Fixes`/`Closes`. Reads the branch so the description matches what shipped. Write for a
  reader who has seen neither issue nor plan. Do not invent rationale the report does not
  support.

## `AGENTS.md` overrides, named where they conflict

The base orders every stage to read and follow `AGENTS.md`, so anything this environment
contradicts has to be named or the agent is left with two opposite instructions. Two are:

- `implement.md` — "never edit the main checkout, always `wtp add` a worktree first". The
  sandbox is a disposable per-ticket checkout and the branch is pre-made. Named there, once,
  and scoped explicitly to that one rule.
- `propose.md` — "opening a PR, and self-merging it once it's green, is pre-approved". Not
  in this pipeline; merging is the human handback point.

The base carries the general form of this in one clause ("where this prompt overrides
something in it, it says so at the point of conflict; nothing else in it is suspended") so
that an override at one site is not read as licence to ignore the rest.

## Deliberately left out

- **Anything `AGENTS.md` already says** — worktrees, commit cadence, style, testing tools,
  issue-label scheme, where things live. Each stage points at `AGENTS.md` once, via the base,
  and stops. Two deliberate duplications survive:
  - `Refs #N` in `propose`: a safety rule whose failure (auto-closing an unvalidated issue)
    is silent and irreversible-ish, so it is worth saying twice.
  - "Use the repository's pull request template" in `propose`: kept only because it is the
    antecedent for the sentence that follows it about the Screenshot section, which is
    genuinely new information (no browser in the sandbox).

  `implement`'s old "Commit as you go" was cut as pure restatement. Its "push the branch
  before you finish" is **not** in `AGENTS.md` and is load-bearing — ADR-0011 makes the
  pushed branch the durable state between `implement` and `propose`, so a lost pod costs a
  re-clone rather than the ticket.
- **Whether a later stage should read the codebase.** Never mentioned in either direction.
  `review`, `revise` and `propose` are told to verify against the repo or the branch, which
  encourages reading without framing it as unusual.
- **Required headings.** Every stage's structure is prose ("useful ground to cover", "cover
  what you changed and why"), and the base states once that headings are advisory. No stage
  presents a bulleted skeleton, because a skeleton is a form and gets filled in.
- **Verdict / severity / status fields.** Nothing branches on stage output — the pipeline is
  linear — so a machine-readable verdict would be decoration. `review` is asked to mark
  blocking versus advisory in prose, for `revise` to weigh, not for the harness to parse.
- **Token or time budgets.** No stage is told to hurry. Rate limits are a dispatcher concern.
- **Any mention of the JSON envelope.** `--output-schema` enforces `{"document": …}`; telling
  the model about the wrapper invites it to hand-write JSON.

## Risks a human should decide on

1. **Prior-stage documents are not fenced.** Only the issue text is. If a planner quotes a
   malicious issue body into its plan, the fence's protection does not travel with it to
   `review`/`revise`/`implement`. Fencing handoffs with the same nonce is one line each and
   would cost some readability — worth doing if `auto` ever becomes filable by anyone but the
   owner, which ADR-0011 already names as the trigger for revisiting the threat model. The
   renderer does strip the nonce from handoff documents as well, so an unfenced quote cannot
   forge the fence; what it cannot do is mark where the quote begins.
2. **`implement` is asked to paste real test output into its document.** On a large test
   suite that could be long, and the document is interpolated into `propose`'s prompt and
   surfaced to reviewers. No truncation guidance is given, deliberately — truncation
   instructions are how "show the failing output" degrades back into "claim you ran it". If
   documents come back enormous in practice, cap it in the prompt with evidence rather than
   pre-emptively.
3. **`revise`'s licence to reject is the most abusable line in the set.** It is the correct
   instruction — a reviewer can be wrong, and a `revise` stage that capitulates to a bad
   finding damages a working plan — but it is also the sentence a lazy stage would use to
   dismiss everything. It is hedged with "check before you accept" and a requirement to say
   what was checked; whether that holds is exactly the thing to audit in the first real
   transcripts.
4. **`propose`'s empty-branch exit is a prompt instruction, not a guard.** It tells the stage
   not to open a PR when nothing shipped, and it tells the harness what that outcome looks
   like in the document — but a stage that ignores it still holds a GitHub credential. If an
   empty PR ever appears, the fix is a check in the worker before the stage runs, not more
   prose.
5. **Two things the prompts assert and cannot enforce**: "you cannot write files" in
   `plan`/`review`/`revise`, and "do not create, rename or switch branches" in `implement`.
   The first is only true if codex actually runs those stages in a read-only sandbox mode —
   worth confirming, because as written it is either a constraint or a false statement about
   the environment, and the set has just been purged of the latter. The second is an
   instruction and nothing more.
6. Minor: the base says nobody will answer, while the document's first line is in fact
   posted to the issue. That is deliberate — the claim is that no *reply* comes, not that
   nothing is read — but an agent could still reason its way into addressing a human in that
   line. Worth watching.

# Disposition of `SET-REVIEW.md`

| # | Finding | Resolution |
|---|---|---|
| 1 | BLOCKER — `base.md` claims files do not survive a stage; they do | **Fixed.** Handoff paragraph is now about knowledge: "the next stage sees your document and nothing else of yours … nothing you write to the filesystem carries forward unless your stage's own instructions say it does". Keeps the write-it-down intent, leaves `propose`'s precondition and `implement`'s pushed branch intact. |
| 2 | MAJOR — `{{ticket_comments}}` has no source | **Fixed, variable kept.** Source is `TicketDetail(ctx, number)` on the `GitHub` seam (in flight on track B1), bot status comment filtered, thread capped. `NOTES.md` records it and records that `work.Ticket`'s attacker-controllable warning must extend to comments — the reviewer is right that comments are the more attacker-reachable field. |
| 3 | MAJOR — `implement.md` silently overrides `AGENTS.md`'s worktree rule | **Fixed.** Named once in `implement.md`, at the conflict, scoped to that one rule. Audited for others: `propose.md` also overrides "self-merging is pre-approved" and now says so. `base.md` gains one clause that overrides are named at the point of conflict and nothing else is suspended. `NOTES.md` has the list. |
| 4 | MAJOR — no defined behaviour when `implement` was blocked | **Fixed.** `propose.md` opens with a precondition check: if the report says the work was not completed, or the branch has no commits ahead of `main`, do not open a PR — say so, say the branch state, stop. `implement.md` now requires "not completed" in its first line so the signal is where `propose` will see it. |
| 5 | MAJOR — the fence can be closed by the issue body | **Fixed.** Tags are `<untrusted-issue-text-{{fence_nonce}}>`; new template variable. `NOTES.md` states the two worker requirements: fresh nonce per run in both tags, and strip every occurrence of the nonce from title/body/comments before interpolating. Prose now reads "between those two markers". |
| 6 | MINOR — `plan.md` misdescribes the pipeline | **Fixed.** "…a third stage folds that critique back in. What the implementer follows is that revision, so write the plan it should be able to keep." |
| 7 | MINOR — `implement.md` says "the plan", input is "the revised plan" | **Fixed.** Both sites. Also "written by someone who had not tried it" → "by people who had not tried it", since the reviser verified parts of it. |
| 8 | MINOR — `review` says its findings are instructions, `revise` says they are not | **Fixed on the review side.** "the stage after you does that, deciding what to act on with your document as its input". |
| 9 | MINOR — `revise` never told the blocking/advisory distinction exists | **Fixed.** One clause in `revise.md`: a blocking finding must be fixed or explicitly rejected, never passed over in silence. |
| 10 | MINOR — `review.md` overclaims exclusivity | **Fixed.** "and only this stage can catch that" cut. |
| 11 | MINOR — `propose` given no licence to look at the branch | **Fixed.** "Read the branch — `git log`, the diff — so that what you describe matches what actually shipped", with the do-not-invent-rationale rule kept as the contrast clause. |
| 12 | MINOR — PR template Screenshot section no stage can satisfy | **Fixed.** `propose.md`: delete the section when nothing user-facing changed; when something did, keep it and say no screenshot was captured. (The template already says to delete it; the new part is declaring the gap on a UI change.) |
| 13 | MINOR — `AGENTS.md` restatement broader than `NOTES.md` claims | **Fixed, partly by cutting, partly by correcting the note.** "Commit as you go" cut from `implement.md`. "Use the repository's pull request template" kept — it is the antecedent for the Screenshot sentence, which is new information — and `NOTES.md` now says there are two deliberate duplications, not one. `Refs #N` kept, for the author's original reason. |
| 14 | MINOR — line-wrap inconsistency | **Fixed.** All six files now ≤96 columns (`base.md` 96, others ≤95). |
| — | "Under-served": `implement` does not know how to push | **Fixed.** `git push -u origin HEAD` given, for the no-upstream case. |
| — | "Under-served": `plan` not told what a good size is | **Fixed.** One clause in `plan.md`: prefer the smallest change that resolves the issue, say what you deferred. |
| — | "Under-served": nothing says the issue may be a brain dump | **Fixed.** One clause in `plan.md`, at the stage that meets it first. |
| — | "Under-served": read-only claims unenforceable unless codex runs read-only | **Not a prompt change — recorded as risk 5 in `NOTES.md`.** Whether the sentence is a constraint or a falsehood is a runtime question, and the set has just been purged of false statements about the environment, so it should be confirmed rather than reworded. |

Nothing was rejected. Every citation the review gave was checked against `base.md`,
`implement.md`, `propose.md`, ADR-0011, `work.go` and `.github/pull_request_template.md`, and
each held.

One nuance worth recording on finding 1: ADR-0011 also says "a pod lost between `implement`
and `propose` costs a re-clone, not a redone ticket", so the filesystem is not guaranteed to
survive either. The reviewer's fix is right for both cases — the durable channel is the
pushed branch, never files left in the working tree.

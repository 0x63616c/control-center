## Stage: propose

The preceding stage was to commit and push its work on the current branch. Open the pull
request for it, then stop.

First check that there is something to open. If the report below says the work was not
completed, or the branch has no commits ahead of `main`, do not open a pull request: say
that plainly, say what state the branch is in and what the report gives as the reason, and
stop. An empty pull request is worse than none.

Use the repository's pull request template. Reference the issue as `Refs #{{ticket_number}}`
— never `Fixes #{{ticket_number}}` or `Closes #{{ticket_number}}`. Those close the issue the
moment the pull request merges, which is before anyone has verified the change against the
real system. The template's Screenshot section cannot be satisfied from here — there is no
browser in this sandbox — so delete it when nothing user-facing changed, and when something
did, keep it and say that no screenshot was captured, so the gap is declared rather than
looking like an oversight.

Write the body for a reviewer who has read neither the issue nor anything upstream of this
pull request: what changed, why, how it was verified, what to look at first, and anything
the report below flags as unresolved. Read the branch — `git log`, the diff — so that what
you describe matches what actually shipped. What you must not do is invent rationale the
report does not support; if it is thin, say what you can support and no more.

Do not wait for CI. Do not merge. Do not close the issue. `AGENTS.md` pre-approves
self-merging a green pull request; that does not apply to this pipeline. Merging is a human
act and it is the point at which this system hands back.

Your document is short: the pull request URL and number, one line on what you opened, and
anything a human should know — including, if you opened nothing or if opening it failed, what
happened and what state the branch is in.

### The implementation report

{{implementation_report}}

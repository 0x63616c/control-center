## Stage: implement

Carry out the revised plan below. This is the only stage that writes code.

The branch already exists and is checked out. Do not create, rename or switch branches. You
are working in a disposable per-ticket checkout, not the operator's working copy, so
`AGENTS.md`'s rule that you must never edit the main checkout and must `wtp add` a worktree
first does not apply here — the branch it would have you create has already been made for
you. That is the only rule in `AGENTS.md` this stage sets aside.

Push the branch before you finish — `git push -u origin HEAD` if it has no upstream yet. The
next stage opens the pull request from what you pushed, so work you did not push did not
happen. Do not open a pull request yourself.

Work test-first: write the failing test, run it, watch it fail for the right reason, then
make it pass. Put the real commands and their real output in your document. A sentence
saying you did this is not the same as evidence that you did, and only the output is
evidence. Run the repository's own checks before you finish and show those too.

The revised plan was written by people who had not tried it. Where it turns out to be wrong,
deviate — that is expected and correct. What is not acceptable is deviating silently: say
what you changed and why.

Your document is **the implementation report**. It is read by the stage that writes the pull
request description, and then by a human reviewer. Cover what you changed and why it matters,
the failing and passing test output, your deviations from the revised plan, and anything left
broken, skipped or uncertain. Flag that last part yourself rather than letting a reviewer
discover it. If you finished without completing the work — blocked, or the revised plan
turned out unimplementable — say so in the first line, because the next stage decides whether
to open a pull request at all on the strength of that.

### The revised plan

{{revised_plan}}

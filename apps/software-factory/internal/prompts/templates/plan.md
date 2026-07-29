## Stage: plan

Plan the work required to resolve this issue.

You are read-only. You may read any file and run commands that inspect the repository, but
you cannot write files and no code is expected from you. Your document is **the plan**.

A reviewer will try to break it before anyone acts on it, and a third stage folds that
critique back in. What the implementer follows is that revision, so write the plan it should
be able to keep. Write for someone competent who has not read what you just read: which
files change, what they do today, what the change is, and how you know.

The issue may be a specification, or it may be a brain dump — a request quoted verbatim,
typos and loose ends included. Read it for what is actually being asked, and prefer the
smallest change that resolves it; a plan the implementer cannot finish is worth less than a
smaller one it can. Say what you deliberately deferred.

Useful ground to cover: what you found and where (paths and symbols, not descriptions of
paths and symbols), the approach you propose and why it rather than the obvious alternative,
roughly what changes where, what tests would prove it works and how they are run, risks and
assumptions, and what you are deliberately leaving out.

Two ways this stage fails. One is a plan too abstract to act on — "update the handler" is
not a plan. The other is a plan that asserts things about the code that are not true; state
what you actually checked, and mark what you did not.

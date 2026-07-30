---
name: work-on-ticket
description: Use when starting work on a GitHub issue/ticket - keeps the sequence straight so nothing gets skipped under time pressure.
---

# work-on-ticket

## Steps

1. **Read the ticket and all comments.** `gh issue view <N> --comments`. Don't
   skip comments — later ones often supersede the original ask.
2. **Quick validity check.** Explore the relevant code. Is the ticket still
   accurate? Feature already shipped, code already moved, assumption already
   false? Note it before planning.
3. **Stop and create a worktree.** MUST run `wtp add -b issue-<N>-<slug>`
   before touching any code — never edit in the main checkout (see AGENTS.md
   "Never edit in the main checkout"). `<N>` is the issue number, `<slug>` a
   few kebab-case words from the title. Then `EnterWorktree({path: <path wtp
   printed>})` to actually move the session into it — `wtp cd` alone does not
   relocate an agent session.
4. **Plan the work.** Sketch the approach before touching code.
5. **Implement the plan.**
6. **Hand off the PR.** Use `.github/pull_request_template.md` for its
   description. Complete every applicable section with real branch evidence,
   reference the ticket as `Refs #<N>` (never `Fixes`/`Closes`), and delete the
   Screenshot section when there is no UI change.

If step 2 finds the ticket is stale/invalid, say so and confirm with the user
before planning — don't silently reinterpret or silently proceed.

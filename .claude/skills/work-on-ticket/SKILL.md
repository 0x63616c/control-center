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
3. **Plan the work.** Sketch the approach before touching code.
4. **Implement the plan.**

If step 2 finds the ticket is stale/invalid, say so and confirm with the user
before planning — don't silently reinterpret or silently proceed.

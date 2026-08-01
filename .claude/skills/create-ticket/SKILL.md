---
name: create-ticket
description: Use when filing a software-factory Ticket in this repo, or when the user says "ticket", "file a ticket", "make an issue", or dumps ideas to track. Applies the verbatim-ask rule and factory Ticket workflow.
---

# create-ticket

"Ticket" here means a software-factory Ticket. It is the sole work tracker and
brain-dump inbox, backed by the factory's own Postgres store and API
(ADR-0012). Create it through `scripts/create-ticket.sh`; never expose or
inspect the bearer token that script decrypts.

## Recipe

1. Keep one Ticket per request, so work can be independently planned, run, and
   completed. Add `--blocker T-<id>` for every known prerequisite.
2. Write a self-contained body. Factory Tickets have no labels: lifecycle and
   execution state belong to the factory.
3. Create it:

```bash
scripts/create-ticket.sh \
  --title "<cleaned-up handle, not the raw ask>" \
  --body-file <body.md> \
  --blocker <id>
```

`<body.md>` must contain:

```md
## Original ask (verbatim)

> <requester's exact wording, character-for-character - typos and all>

## Interpretation

<your read on it, clearly separate from the quote above>
```

Rules:
- The verbatim blockquote is mandatory and must not be paraphrased — that's the one unacceptable edit.
- Do not add labels, milestones, or a parallel tracking record.
- If the ask cites an origin (for example `item #22` from a brain dump), retain it in the body as context.
- The script prints the created `T-<id>` and never prints the bearer token.

## PR handoff

This skill creates Tickets, not pull requests. If the work continues to a PR,
write its description from `.github/pull_request_template.md`: complete every
applicable section with real branch evidence, use `Refs T-<id>` for its Ticket,
and delete the
Screenshot section when there is no UI change.

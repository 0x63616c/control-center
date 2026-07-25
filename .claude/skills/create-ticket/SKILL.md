---
name: create-ticket
description: Use when filing a GitHub issue in this repo, or when the user says "ticket", "file a ticket", "make an issue", or dumps ideas to track. Applies this repo's verbatim-ask rule and exactly-two-labels scheme.
---

# create-ticket

"Ticket" = GitHub issue. This repo has one tracker: `gh issue`.

## Recipe

1. Search first — don't dupe: `gh issue list --search "<keywords>" --state all --json number,title,labels,state`
2. Pick exactly one `area/*` and one `type/*` label (list below). No other labels — no priority, no status, no milestone.
3. Create:

```bash
gh issue create \
  --title "<cleaned-up handle, not the raw ask>" \
  --label "area/<x>" --label "type/<y>" \
  --body '## Original ask (verbatim)

> <requester'"'"'s exact wording, character-for-character - typos and all>

## Interpretation

<your read on it, clearly separate from the quote above>'
```

Rules:
- The verbatim blockquote is mandatory and must not be paraphrased — that's the one unacceptable edit.
- One issue per request, even when several ideas arrive in one message, so each closes independently.
- If the ask cites an origin (e.g. "item #22" from a brain dump), note it in the body — that number is not a GitHub issue number.

## Labels

- `area/`: `infra` `network` `hardware` `panel-ui` `tiles` `integrations` `observability` `docs` `tooling` `security`
- `type/`: `bug` `chore` `feature` `design` `spike` `verify` `question`

If neither list fits, ask the user rather than inventing a new label.

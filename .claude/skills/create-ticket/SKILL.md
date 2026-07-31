---
name: create-ticket
description: Use when filing a GitHub issue in this repo, or when the user says "ticket", "file a ticket", "make an issue", or dumps ideas to track. Applies this repo's verbatim-ask rule and exactly-two-labels scheme.
---

# create-ticket

"Ticket" = GitHub issue. This repo has one tracker: `gh issue`.

## Recipe

1. Search first — don't dupe: `gh issue list --search "<keywords>" --state all --json number,title,labels,state`
2. Pick exactly one `area/*` and one `type/*` label (list below), plus `auto` if an agent could take it end-to-end unattended. No other labels at filing time — no priority, no status, no milestone. `failed` is a lifecycle marker software-factory adds later to a failed ticket and any run-owned PR; do not select it here.
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

Get the current, authoritative set from the repo (don't trust a hardcoded list — it goes stale, and the repo also carries unrelated default labels like `bug`/`enhancement`/`ruby` you must ignore):

```bash
gh label list --limit 100 --json name | jq -r '.[].name' | grep -E '^(area|type)/'
```

As of 2026-07-25 that's:
- `area/`: `infra` `network` `hardware` `panel-ui` `tiles` `integrations` `observability` `docs` `tooling` `security`
- `type/`: `bug` `chore` `design` `feature` `question` `spike` `verify`

If neither list fits, ask the user rather than inventing a new label.

## PR handoff

This skill creates issues, not pull requests. If the work continues to a PR,
write its description from `.github/pull_request_template.md`: complete every
applicable section with real branch evidence, use `Refs #N` (never `Fixes #N`
or another closing keyword) for an issue the PR resolves, close it by hand
after merge, and delete the
Screenshot section when there is no UI change.

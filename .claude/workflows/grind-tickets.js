export const meta = {
  name: 'grind-tickets',
  description: 'Work a caller-specified set of GitHub issues: plan -> adversarial review -> revise -> implement in isolated worktrees, then open one ready-for-review PR per ticket. It never pushes to main, never merges, and never closes a ticket. Anything blocked is posted as a question on its own issue.',
  whenToUse:
    'Batch-clearing backlog tickets unattended. REQUIRES an explicit ticket list: {tickets:[108,99,...]}. It never chooses its own work. Output is open PRs for you to review - merging, and therefore deploying, stays yours. Add {dryRun:true} to plan and implement without pushing.',
  phases: [
    { title: 'Plan', detail: 'explore the codebase, draft a full plan per ticket', model: 'sonnet' },
    { title: 'Review', detail: 'a distinct agent attacks each plan', model: 'sonnet' },
    { title: 'Revise', detail: 'planner answers every finding', model: 'sonnet' },
    { title: 'Implement', detail: 'fresh agent executes in an isolated worktree', model: 'sonnet' },
    { title: 'Blocked', detail: 'post questions and blockers onto their own issues', model: 'sonnet' },
    { title: 'Propose', detail: 'serialized rebase + push branch + open a PR, one at a time', model: 'sonnet' },
  ],
}

// ---------------------------------------------------------------------------
// Inputs
//   args.tickets    number[]  REQUIRED - the exact issue numbers to work. This
//                             workflow never selects its own work: picking what to
//                             spend effort on is the owner's call, not an agent's.
//   args.repoDir    string    override the checkout path
//   args.dryRun     boolean   plan/review/revise/implement but never push or open a PR
//   args.batchSize  number    max tickets in flight at once through the
//                             plan->review->revise->implement pipeline. Batches
//                             run one after another, never concurrently with each
//                             other. Default 5.
// ---------------------------------------------------------------------------

// `args` can arrive as a JSON STRING rather than an object , the Skill wrapper
// passes its arguments through as text, and the value survives stringified even
// when the caller supplies a real object. Normalise both shapes BEFORE reading
// any field: reading `args.tickets` off a string yields undefined, and the
// workflow then rejects a perfectly valid ticket list with "requires an
// explicit ticket list" (cost two failed launches on 2026-07-25).
const ARGS = typeof args === 'string' ? JSON.parse(args) : (args || {})

const REPO = ARGS.repoDir || '/Users/calum/code/github.com/0x63616c/world-wide-webb'
const DRY_RUN = !!ARGS.dryRun

const tickets = Array.isArray(ARGS.tickets)
  ? ARGS.tickets.map(Number).filter((n) => Number.isInteger(n) && n > 0)
  : []

if (tickets.length === 0) {
  throw new Error(
    'grind-tickets requires an explicit ticket list, e.g. args: {tickets: [108, 99, 93]}. ' +
      'It deliberately will not choose its own tickets.',
  )
}
if (tickets.length > 4096) throw new Error('too many tickets')

const BATCH_SIZE = Number.isInteger(ARGS.batchSize) && ARGS.batchSize > 0 ? ARGS.batchSize : 5

const HOUSE_RULES = `
REPO: ${REPO} (branch main). Read AGENTS.md + CODEBASE_OVERVIEW.md before anything.
Hard house rules you MUST obey:
- Read docs/writing-scalable-typescript/README.md before writing or reviewing TS/TSX.
- Features are self-contained Apps under features/<id>/ (ADR-0001). Never hand-edit features/_generated/.
  If manifest/tile data changes, run \`bun run apps:gen\` and commit the regenerated files.
- Shared primitives live in packages/platform. Dependency boundaries are Biome-enforced.
- Use shared UI primitives from apps/web/src/components/ui/. Storybook-first for new UI.
- Panel audio only via playCue() from apps/web/src/lib/sound/. Never construct AudioContext elsewhere.
- No raw process.env in features - use the @www/platform/env registry.
- NEVER read, print, decrypt or echo secret values (secrets/vault.yaml, tokens, keys). Key-NAME
  presence checks only. No \`-o yaml\`/\`describe\`/\`cat\` on anything holding a secret.
- No fake or placeholder data. Backend code uses structured logging.
- Fixed panel size 1366x1024, not responsive.
- NEVER \`git add -A\` or \`git add .\` - concurrent sessions share checkouts and you will
  swallow their uncommitted work. Stage explicit paths only, then verify with \`git show --stat HEAD\`.
- NEVER write "Fixes #N"/"Closes #N" in a commit message. A resolved issue closes when the
  canonical \`Fixes #N\` reference in its PR description merges; use no closing keywords elsewhere.
- Commit messages are written in NORMAL English prose, not compressed/caveman style.
- Do not run background jobs or yield waiting on anything. Everything foreground and bounded.

WHEN YOU ARE STUCK OR NEED A DECISION:
The repo owner is NOT watching this run. Do not guess at a decision that is theirs to make,
and do not quietly narrow a ticket's scope to whatever you could figure out. Instead, state
the blocker plainly in your structured output - be specific about what you tried, what you
found, and the exact question you need answered. A later stage posts it as a comment on that
issue so the owner sees it. Reporting an honest blocker is a SUCCESSFUL outcome; inventing a
change so the run looks productive is a failure.
`

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ticket', 'understanding', 'files', 'steps', 'verification', 'risks'],
  properties: {
    ticket: { type: 'number' },
    understanding: { type: 'string', description: 'What the ticket asks for, grounded in its verbatim block.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths that must change, each with a one-line why.' },
    steps: { type: 'array', items: { type: 'string' }, description: 'Ordered concrete steps naming files and exact changes.' },
    verification: { type: 'array', items: { type: 'string' }, description: 'Exact commands/checks proving the ticket is done.' },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ticket', 'verdict', 'findings'],
  properties: {
    ticket: { type: 'number' },
    verdict: { type: 'string', enum: ['sound', 'needs-revision', 'ticket-not-actionable'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'problem', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ticket: { type: 'number' },
    status: { type: 'string', enum: ['done', 'partial', 'abandoned'] },
    branch: { type: 'string', description: 'Branch holding the commits, or "" if nothing was committed.' },
    commits: { type: 'array', items: { type: 'string' } },
    filesChanged: { type: 'array', items: { type: 'string' } },
    verification: { type: 'string', description: 'Commands run and their REAL outcome. Quote failures verbatim.' },
    summary: { type: 'string', description: 'One or two sentences fit to paste into the closing comment.' },
    notes: { type: 'string', description: 'Deviations from the plan, and anything left undone.' },
    blocker: {
      type: 'string',
      description:
        'Empty if nothing is blocked. Otherwise the specific question or obstacle needing the owner: what you tried, what you found, and the exact decision required. This gets posted to the issue.',
    },
  },
  required: ['ticket', 'status', 'branch', 'commits', 'filesChanged', 'verification', 'summary', 'notes', 'blocker'],
}

const PROPOSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ticket', 'status', 'sha', 'notes'],
  properties: {
    ticket: { type: 'number' },
    status: { type: 'string', enum: ['proposed', 'skipped', 'conflict-abandoned'] },
    pr: { type: 'number', description: 'The PR number opened for this ticket, if any.' },
    sha: { type: 'string', description: 'Final sha on the pushed branch. Never a sha on main.' },
    notes: { type: 'string' },
  },
}

log(
  `Working ${tickets.length} tickets, up to ${BATCH_SIZE} in flight at once` +
    `${DRY_RUN ? ' (DRY RUN - nothing will be pushed)' : ''}`,
)

// Blockers accumulated across every phase. Each entry becomes a comment on its
// own issue, so a question an agent could not answer lands where the owner will
// actually see it rather than dying inside a workflow result.
const blockers = []

// ---------------------------------------------------------------------------
// Phases 1-4 - plan -> review -> revise -> implement, one chain per ticket,
// run through a rolling pool capped at BATCH_SIZE concurrent tickets. A slot
// frees the moment ANY ticket finishes its whole chain, so a slow ticket
// never blocks the others queued behind it - unlike fixed batches, where the
// next group can't start until every ticket in the current group is done.
// ---------------------------------------------------------------------------

phase('Plan')

async function runTicket(n) {
  const plan = await agent(`${HOUSE_RULES}

You are the PLANNER for GitHub issue #${n}. Change NO files - this is read-and-think only.

1. \`cd ${REPO} && gh issue view ${n}\` and read the FULL body including the
   "## Original ask (verbatim)" blockquote. That block is the source of truth. Do not
   substitute your own idea of what would be nicer to build.
2. Explore the real codebase until you know exactly which files must change and why.
   Verify every path you name actually exists - do not plan against remembered structure.
3. Plan to close the ENTIRE ticket. If it has several parts, every part gets steps.
4. Each step must be executable by an engineer who never saw your exploration: name the
   file, the symbol, and the exact change.
5. Verification must genuinely prove it: \`bun run typecheck\`, relevant tests, plus
   \`bun run apps:check\` if features/ is touched, plus a browser screenshot for UI tickets.

Return the structured plan.`, { label: `plan:#${n}`, phase: 'Plan', model: 'sonnet', schema: PLAN_SCHEMA })

  const review = await agent(`${HOUSE_RULES}

You are an adversarial PLAN REVIEWER for GitHub issue #${n}. You did NOT write this plan.
Find what is wrong with it. Do not praise it. Change no files.

PLAN:
${JSON.stringify(plan, null, 2)}

Check against the real repo:
1. \`cd ${REPO} && gh issue view ${n}\`. Does the plan close the WHOLE ticket, or has it
   quietly narrowed scope to the easy part?
2. Does every file path it names exist? Hallucinated paths are blockers.
3. Does it violate any house rule above, or docs/writing-scalable-typescript/? Blocker.
4. Missing steps: codegen regeneration, doc updates, tests, migrations, generated barrels.
5. Steps that would break something else, or collide with concurrent work.
6. Is the plan's factual premise still true TODAY? Plans drift - verify claimed commits/state.

A plan with no findings is suspicious; look harder before returning "sound".
Return "ticket-not-actionable" ONLY if closing it genuinely requires a human decision,
a physical action, or a credential.

Return the structured review.`, { label: `review:#${n}`, phase: 'Review', model: 'sonnet', schema: REVIEW_SCHEMA })

  let rev
  if (review && review.verdict === 'ticket-not-actionable') {
    const reason = review.findings
      .map((f) => `- **${f.severity}:** ${f.problem}\n  - suggested: ${f.fix}`)
      .join('\n')
    log(`#${n} not actionable - will post the blocker to the issue`)
    blockers.push({
      ticket: n,
      stage: 'review',
      body: `A plan review concluded this cannot be closed without a decision from you.\n\n${reason}`,
    })
    rev = { skip: true, ticket: n, reason }
  } else {
    const revised = await agent(`${HOUSE_RULES}

You are the PLANNER for issue #${n}, revising after review. Address EVERY finding.
Where a finding is WRONG, verify against real code and say so explicitly in the plan's
risks - do not silently ignore it, and do not cave to a finding you disproved.

FINDINGS:
${JSON.stringify(review, null, 2)}

Re-verify any path the reviewer questioned by actually opening it. Change no files.
Return the revised structured plan.`, { label: `revise:#${n}`, phase: 'Revise', model: 'sonnet', schema: PLAN_SCHEMA })
    rev = { skip: false, ticket: n, plan: revised }
  }

  if (!rev || rev.skip) {
    return {
      ticket: n, status: 'abandoned', branch: '', commits: [], filesChanged: [],
      verification: 'not attempted', summary: '', blocker: '',
      notes: rev ? `skipped: ${rev.reason}` : 'planning failed',
    }
  }

  return agent(`${HOUSE_RULES}

You are the IMPLEMENTER for GitHub issue #${n}.

Get your own isolated copy of the repo with the project's real worktree tool, not a bare
\`git worktree add\`:
  \`cd ${REPO} && wtp add -b ticket-${n}\`
It prints the new worktree's path - capture it. From then on, address that worktree by its
ABSOLUTE path in every command (\`git -C <worktree-path> ...\`, \`cd <worktree-path> && ...\` as
one command, or \`bun --cwd <worktree-path> ...\`). Do not rely on a plain \`cd\` persisting
across tool calls or on relative paths - cwd is not guaranteed to survive between your
commands, and the main checkout at ${REPO} must never be touched.

Execute this reviewed plan:
${JSON.stringify(rev.plan, null, 2)}

Rules:
- The \`wtp add -b ticket-${n}\` above already created and checked out branch \`ticket-${n}\`.
- Follow the plan. If reality contradicts it, follow reality and record the deviation in notes.
- If the honest outcome is "there was nothing to fix" or "this cannot be fixed", say so with
  evidence and commit nothing. That is a valid result. Never invent a change to look productive.
- Stage explicit paths. Never \`git add -A\`.
- DO NOT PUSH. Leave commits on your local branch; a later stage merges them.
- Before finishing, run \`bun run typecheck\`, tests relevant to your change, and
  \`bun run apps:check\` if you touched features/ - all scoped to the worktree path above.
  Report REAL results; fix and re-run on failure. Never claim a passing check you did not see pass.
- If a check fails and you cannot fix it, set status "partial" and quote the failure verbatim.
- Leave the worktree in place when you finish - do not remove it. It is cleaned up later,
  automatically, once its branch is merged.

Set \`summary\` to one or two sentences suitable for pasting into the ticket's closing comment.
Set \`blocker\` to "" if nothing needs the owner. Otherwise put the specific question there -
it will be posted as a comment on issue #${n}. Use it when you hit a decision only the owner
can make, an external dependency you cannot change, or a scope call you should not make alone.
Return the structured report, with \`branch\` = "ticket-${n}" if you committed, else "".`,
    { label: `impl:#${n}`, phase: 'Implement', model: 'sonnet', schema: IMPL_SCHEMA })
}

// Rolling pool: at most BATCH_SIZE tickets in flight. Each of the BATCH_SIZE
// "lanes" below pulls the next unclaimed ticket off `tickets` as soon as it
// finishes its own chain, instead of waiting for sibling tickets in a fixed
// group - a slow ticket only ever occupies its own lane.
let nextIndex = 0
async function lane() {
  const out = []
  while (nextIndex < tickets.length) {
    const n = tickets[nextIndex++]
    out.push(await runTicket(n))
  }
  return out
}
const laneResults = await Promise.all(
  Array.from({ length: Math.min(BATCH_SIZE, tickets.length) }, () => lane()),
)
const results = laneResults.flat()

const impls = results.filter(Boolean)
const ready = impls.filter((r) => r.branch && r.commits && r.commits.length > 0)
const notLanded = impls.filter((r) => !(r.branch && r.commits && r.commits.length > 0))

log(`Implemented: ${ready.length} branches ready, ${notLanded.length} produced no commit`)
for (const r of notLanded) log(`  no commit: #${r.ticket} (${r.status}) - ${r.notes}`)

// ---------------------------------------------------------------------------
// Blocked - post every question and obstacle onto its own issue.
// Runs BEFORE merge so a blocker is recorded even if a later phase dies.
// ---------------------------------------------------------------------------

for (const r of impls) {
  if (r.blocker && r.blocker.trim()) {
    blockers.push({ ticket: r.ticket, stage: 'implementation', body: r.blocker.trim() })
  } else if (r.status === 'partial') {
    blockers.push({
      ticket: r.ticket,
      stage: 'implementation',
      body: `Implementation stopped part-way.\n\nWhat was done: ${r.summary || '(none reported)'}\n\nNotes: ${r.notes}\n\nVerification output:\n\n\`\`\`\n${r.verification}\n\`\`\``,
    })
  }
}

async function postBlockers(list) {
  if (list.length === 0) return
  phase('Blocked')
  log(`Posting ${list.length} blocker(s) to their issues`)
  await parallel(
    list.map((b) => () =>
      agent(`${HOUSE_RULES}

Post a blocker comment on GitHub issue #${b.ticket}. Work in ${REPO}.

An agent working this ticket during the ${b.stage} stage could not proceed without a decision
from the repo owner. Raw report:

---
${b.body}
---

Write that up as a clear comment addressed to the owner and post it with:
  gh issue comment ${b.ticket} --body "..."
(the flag is --body, NOT --comment)

Requirements for the comment:
- Open with a bold one-line statement of what is needed, so it is obvious at a glance.
- Then what was tried and what was found, concretely - file paths, commands, error text.
- Then the decision or answer required, as a short numbered list of options where options exist.
- If the raw report contains anything resembling a secret value, token or key, DO NOT include
  it; refer to the key by NAME only.
- No hedging filler, no apologies. The owner is reading this cold, possibly weeks later, so it
  must stand alone without the run's context.

Do NOT close the issue. Do NOT change any labels. Do NOT edit code.
Return one line: the issue number and that you commented.`,
        { label: `blocked:#${b.ticket}`, phase: 'Blocked', model: 'sonnet' }),
    ),
  )
  list.length = 0
}

await postBlockers(blockers)

if (DRY_RUN) {
  log('DRY RUN - stopping before pushing any branch.')
  return { dryRun: true, implemented: impls }
}
if (ready.length === 0) {
  return { implemented: impls, proposed: [], summary: 'nothing to propose' }
}
// ---------------------------------------------------------------------------
// Phase 5 - PROPOSE. One PR per ticket, open (not draft) - ready for review.
//
// This used to cherry-pick onto main and push. It no longer does: main is now
// branch-and-PR by default (#120), so an unattended workflow must not be the one
// exception that still writes to main. Nothing here merges, so there is also
// nothing to rebuild or deploy-verify - those phases went with the push. A human
// merging the PR triggers the deploy and GitHub auto-closes an issue whose
// canonical PR-description field says `Fixes #N` (AGENTS.md).
//
// Serialized rather than parallel: these branches share one checkout and the
// worktrees they came from, and concurrent pushes race.
// ---------------------------------------------------------------------------

phase('Propose')

const proposed = []
for (const r of ready) {
  const p = await agent(`${HOUSE_RULES}

You are the PROPOSE agent for issue #${r.ticket}. NEVER push to main and never merge anything.

Commits sit on local branch \`${r.branch}\` (SHAs: ${r.commits.join(', ')}), possibly in a
worktree - \`git -C ${REPO} worktree list\` and \`git -C ${REPO} branch --list ${r.branch}\` locate them.

1. \`git -C ${REPO} fetch origin\`. Rebase \`${r.branch}\` onto latest origin/main so the PR is
   mergeable. On a conflict you cannot resolve mechanically, abort cleanly, leave the branch
   as it was, and report status "conflict-abandoned".
2. Run \`bun run typecheck\` and the tests relevant to the change. If it fails because of THIS
   branch, fix forward and commit. If it fails for unrelated pre-existing reasons, say so in
   notes and continue. Never claim a passing check you did not see pass.
3. Push the BRANCH, never main: \`git -C ${REPO} push -u origin ${r.branch}\`.
   If the pre-push hook fails because the worktree has no node_modules, run \`bun install\`
   there - do NOT reach for --no-verify.
4. Open the pull request OPEN, not draft:
   \`gh pr create --base main --head ${r.branch} --title "<conventional commit title>" --body-file <file>\`
   Build \`<file>\` from \`.github/pull_request_template.md\`. Complete every applicable
   section with the branch's current facts: describe the behavior and relevant changed areas,
   explain why, and list exact verification commands with their real outcomes. Reference the
   resolved issue as \`Fixes #${r.ticket}\` in the template's canonical linked-issue section.
   Never use closing keywords in commit messages or incidental PR prose. Keep the Screenshot
   section for UI work with real visual evidence; delete it when there is no UI change. Never
   manufacture command output or visual evidence.
5. Watch CI on the PR to a real conclusion: \`gh pr checks <pr-number> --watch\`. Record the
   final status in notes ("CI green" / "CI failed: <check name>" / etc) - do not guess, wait for
   the real result. Do not attempt to fix unrelated pre-existing CI failures; only fix ones your
   own commits caused, then push and re-watch.
6. Report the PR number and the final sha on the branch.

Return the structured report.`, { label: `propose:#${r.ticket}`, phase: 'Propose', model: 'sonnet', schema: PROPOSE_SCHEMA })
  if (p) proposed.push(p)
  log(`propose #${r.ticket}: ${p ? `${p.status} ${p.pr ? `PR #${p.pr}` : p.sha}` : 'agent failed'}`)
}

for (const p of proposed) {
  if (p.status !== 'proposed') {
    blockers.push({
      ticket: p.ticket,
      stage: `propose (${p.status})`,
      body: `The work for this ticket was implemented but no PR could be opened.\n\n${p.notes}\n\nThe commits still exist on branch \`ticket-${p.ticket}\` locally. Nothing was pushed to main.`,
    })
  }
}
await postBlockers(blockers)

const opened = proposed.filter((p) => p.status === 'proposed')
log(`${opened.length} PR(s) opened - none merged. Review and merge them yourself.`)

return {
  implemented: impls.map((r) => ({ ticket: r.ticket, status: r.status, files: r.filesChanged, notes: r.notes })),
  notLanded: notLanded.map((r) => ({ ticket: r.ticket, why: r.notes })),
  proposed,
  summary: `${opened.length} PR(s) opened for review. Nothing merged or deployed; linked issues auto-close when their PRs merge.`,
}

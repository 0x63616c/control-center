export const meta = {
  name: 'grind-tickets',
  description: 'Close N low-hanging GitHub issues: plan -> adversarial review -> revise -> implement in isolated worktrees, serialized merge to main, forced full rebuild, live deploy verification, then close only what actually shipped',
  whenToUse:
    'Batch-clearing backlog tickets unattended. Pass {tickets:[108,99,...]} to pick explicitly, or {count:8} to let a triage agent choose safe ones. Only give it self-contained work — it deliberately refuses hardware, secrets and design-decision tickets.',
  phases: [
    { title: 'Triage', detail: 'pick safe tickets when none were named', model: 'sonnet' },
    { title: 'Plan', detail: 'explore the codebase, draft a full plan per ticket', model: 'sonnet' },
    { title: 'Review', detail: 'a distinct agent attacks each plan', model: 'sonnet' },
    { title: 'Revise', detail: 'planner answers every finding', model: 'sonnet' },
    { title: 'Implement', detail: 'fresh agent executes in an isolated worktree', model: 'sonnet' },
    { title: 'Merge', detail: 'serialized rebase + push to main, one at a time', model: 'sonnet' },
    { title: 'Rebuild', detail: 'force_all dispatch so no image digest is stranded', model: 'sonnet' },
    { title: 'Verify', detail: 'bounded CI polling + live pod check', model: 'sonnet' },
    { title: 'Close', detail: 'close only tickets whose code is provably deployed', model: 'sonnet' },
  ],
}

// ---------------------------------------------------------------------------
// Inputs
//   args.tickets  number[]  explicit issue numbers (skips triage)
//   args.count    number    how many to auto-pick when tickets is absent (default 8)
//   args.repoDir  string    override the checkout path
//   args.dryRun   boolean   plan/review/revise/implement but never merge or push
// ---------------------------------------------------------------------------

const REPO = (args && args.repoDir) || '/Users/calum/code/github.com/0x63616c/world-wide-webb'
const WANT = (args && args.count) || 8
const DRY_RUN = !!(args && args.dryRun)
const EXPLICIT = args && Array.isArray(args.tickets) ? args.tickets : null

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
- NEVER write "Fixes #N"/"Closes #N" in a commit message. Closing happens only after live verification.
- Commit messages are written in NORMAL English prose, not compressed/caveman style.
- Do not run background jobs or yield waiting on anything. Everything foreground and bounded.
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
  required: ['ticket', 'status', 'branch', 'commits', 'filesChanged', 'verification', 'summary', 'notes'],
  properties: {
    ticket: { type: 'number' },
    status: { type: 'string', enum: ['done', 'partial', 'abandoned'] },
    branch: { type: 'string', description: 'Branch holding the commits, or "" if nothing was committed.' },
    commits: { type: 'array', items: { type: 'string' } },
    filesChanged: { type: 'array', items: { type: 'string' } },
    verification: { type: 'string', description: 'Commands run and their REAL outcome. Quote failures verbatim.' },
    summary: { type: 'string', description: 'One or two sentences fit to paste into the closing comment.' },
    notes: { type: 'string', description: 'Deviations from the plan, and anything left undone.' },
  },
}

const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ticket', 'status', 'sha', 'notes'],
  properties: {
    ticket: { type: 'number' },
    status: { type: 'string', enum: ['pushed', 'skipped', 'conflict-abandoned'] },
    sha: { type: 'string' },
    notes: { type: 'string' },
  },
}

const CI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'state', 'conclusion', 'buildsRan', 'detail'],
  properties: {
    runId: { type: 'string' },
    state: { type: 'string', enum: ['running', 'finished', 'not-found'] },
    conclusion: { type: 'string', enum: ['success', 'failure', 'cancelled', 'unknown'] },
    buildsRan: { type: 'boolean', description: 'True only if build-* and merge-* jobs actually RAN (not skipped).' },
    detail: { type: 'string', description: 'Job conclusions; verbatim failure output if red.' },
  },
}

// ---------------------------------------------------------------------------
// Phase 0 - triage
// ---------------------------------------------------------------------------

let tickets = EXPLICIT

if (!tickets) {
  phase('Triage')
  const TRIAGE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['picked', 'rejected'],
    properties: {
      picked: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['number', 'title', 'why'],
          properties: { number: { type: 'number' }, title: { type: 'string' }, why: { type: 'string' } },
        },
      },
      rejected: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['number', 'why'],
          properties: { number: { type: 'number' }, why: { type: 'string' } },
        },
      },
    },
  }

  const triage = await agent(`${HOUSE_RULES}

You are the TRIAGE agent. Pick up to ${WANT} open GitHub issues an autonomous agent can fully
close WITHOUT asking the repo owner a single question.

Run \`cd ${REPO} && gh issue list --state open --limit 100 --json number,title,labels,body\`.

PICK a ticket only if all hold:
- The work is self-contained in this repo: code, config, tests or docs.
- Success is objectively checkable (typecheck, a test, a screenshot, a command's output).
- It needs no physical action, no purchase, no vendor console, no credential, no secret value.
- It needs no taste/product decision that only the owner can make.

REJECT (do not pick):
- area/hardware, or anything requiring touching a machine.
- Anything about secrets, vaults, credentials or key rotation.
- type/design, type/question, type/spike - these want a human's judgement, not an implementation.
- Anything whose fix depends on an upstream release or an external service's state.
- Sweeping "clean up everything" tickets whose scope you cannot bound from the text.

Prefer tickets that touch disjoint files, so parallel implementers do not collide.
Order \`picked\` with wide-sweeping/whole-tree tickets LAST - they merge last and rebase over everything.

Return picked and rejected, each with a one-line reason.`,
    { label: 'triage', phase: 'Triage', model: 'sonnet', schema: TRIAGE_SCHEMA })

  if (!triage || !triage.picked || triage.picked.length === 0) {
    log('Triage picked nothing - stopping.')
    return { picked: [], reason: 'triage returned no actionable tickets', rejected: triage ? triage.rejected : null }
  }
  tickets = triage.picked.map((p) => p.number)
  log(`Triage picked ${tickets.length}: ${tickets.map((n) => '#' + n).join(', ')}`)
  for (const r of (triage.rejected || []).slice(0, 12)) log(`  rejected #${r.number}: ${r.why}`)
}

if (tickets.length > 4096) throw new Error('too many tickets')
log(`Working ${tickets.length} tickets${DRY_RUN ? ' (DRY RUN - nothing will be pushed)' : ''}`)

// ---------------------------------------------------------------------------
// Phases 1-4 - plan -> review -> revise -> implement, pipelined per ticket
// ---------------------------------------------------------------------------

phase('Plan')

const results = await pipeline(
  tickets,

  (n) => agent(`${HOUSE_RULES}

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

Return the structured plan.`, { label: `plan:#${n}`, phase: 'Plan', model: 'sonnet', schema: PLAN_SCHEMA }),

  (plan, n) => agent(`${HOUSE_RULES}

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

Return the structured review.`, { label: `review:#${n}`, phase: 'Review', model: 'sonnet', schema: REVIEW_SCHEMA }),

  async (review, n) => {
    if (review && review.verdict === 'ticket-not-actionable') {
      log(`#${n} not actionable: ${review.findings.map((f) => f.problem).join('; ')}`)
      return { skip: true, ticket: n, reason: review.findings.map((f) => f.problem).join('; ') }
    }
    const revised = await agent(`${HOUSE_RULES}

You are the PLANNER for issue #${n}, revising after review. Address EVERY finding.
Where a finding is WRONG, verify against real code and say so explicitly in the plan's
risks - do not silently ignore it, and do not cave to a finding you disproved.

FINDINGS:
${JSON.stringify(review, null, 2)}

Re-verify any path the reviewer questioned by actually opening it. Change no files.
Return the revised structured plan.`, { label: `revise:#${n}`, phase: 'Revise', model: 'sonnet', schema: PLAN_SCHEMA })
    return { skip: false, ticket: n, plan: revised }
  },

  (rev, n) => {
    if (!rev || rev.skip) {
      return {
        ticket: n, status: 'abandoned', branch: '', commits: [], filesChanged: [],
        verification: 'not attempted', summary: '',
        notes: rev ? `skipped: ${rev.reason}` : 'planning failed',
      }
    }
    return agent(`${HOUSE_RULES}

You are the IMPLEMENTER for GitHub issue #${n}.

You run in an ISOLATED GIT WORKTREE - your own copy of the repo. \`pwd\` to find it and work
there, never in the user's main checkout.

Execute this reviewed plan:
${JSON.stringify(rev.plan, null, 2)}

Rules:
- \`git checkout -b ticket-${n}\` before committing.
- Follow the plan. If reality contradicts it, follow reality and record the deviation in notes.
- If the honest outcome is "there was nothing to fix" or "this cannot be fixed", say so with
  evidence and commit nothing. That is a valid result. Never invent a change to look productive.
- Stage explicit paths. Never \`git add -A\`.
- DO NOT PUSH. Leave commits on your local branch; a later stage merges them.
- Before finishing, run \`bun run typecheck\`, tests relevant to your change, and
  \`bun run apps:check\` if you touched features/. Report REAL results; fix and re-run on failure.
  Never claim a passing check you did not see pass.
- If a check fails and you cannot fix it, set status "partial" and quote the failure verbatim.

Set \`summary\` to one or two sentences suitable for pasting into the ticket's closing comment.
Return the structured report, with \`branch\` = "ticket-${n}" if you committed, else "".`,
      { label: `impl:#${n}`, phase: 'Implement', model: 'sonnet', schema: IMPL_SCHEMA, isolation: 'worktree' })
  },
)

const impls = results.filter(Boolean)
const ready = impls.filter((r) => r.branch && r.commits && r.commits.length > 0)
const notLanded = impls.filter((r) => !(r.branch && r.commits && r.commits.length > 0))

log(`Implemented: ${ready.length} branches ready, ${notLanded.length} produced no commit`)
for (const r of notLanded) log(`  no commit: #${r.ticket} (${r.status}) - ${r.notes}`)

if (DRY_RUN) {
  log('DRY RUN - stopping before merge.')
  return { dryRun: true, implemented: impls }
}
if (ready.length === 0) {
  return { implemented: impls, merged: [], ci: null, closed: [], summary: 'nothing to merge' }
}

// ---------------------------------------------------------------------------
// Phase 5 - SERIALIZED merge. Never parallel: concurrent pushes to main evict
// each other's queued CI runs and race on the shared checkout.
// ---------------------------------------------------------------------------

phase('Merge')

const merged = []
for (const r of ready) {
  const m = await agent(`${HOUSE_RULES}

You are the MERGE agent for issue #${r.ticket}. Work in the MAIN checkout: ${REPO}.
Other Claude sessions share this checkout and push to main concurrently. Use
\`git -C ${REPO} ...\` for every git command so you can never act on the wrong tree.

Commits sit on local branch \`${r.branch}\` (SHAs: ${r.commits.join(', ')}), possibly in a
worktree - \`git -C ${REPO} worktree list\` and \`git -C ${REPO} branch --list ${r.branch}\` locate them.

1. \`git -C ${REPO} fetch origin\` then \`git -C ${REPO} status\`. If the checkout holds
   UNCOMMITTED changes from another session, leave them completely alone - never stash,
   never discard, never stage them. If they block you, report status "skipped".
2. Bring the ticket commits onto main rebased on latest origin/main. Cherry-picking the
   named SHAs is usually cleanest.
3. On conflict, resolve only if mechanical and both intents survive. Otherwise abort cleanly
   (\`git cherry-pick --abort\`), leave main untouched, report "conflict-abandoned".
4. Run \`bun run typecheck\` from ${REPO}. If it fails because of YOUR merge, fix forward and
   commit. If it fails for unrelated pre-existing reasons, note that and continue.
5. \`git -C ${REPO} push origin main\`. If rejected because a peer pushed first: fetch, rebase,
   re-run typecheck, push again. Up to 3 attempts.
6. Report the final sha on origin/main.

Do NOT watch CI. Push and return. Foreground only, no background jobs.
Return the structured merge report.`, { label: `merge:#${r.ticket}`, phase: 'Merge', model: 'sonnet', schema: MERGE_SCHEMA })
  if (m) merged.push(m)
  log(`merge #${r.ticket}: ${m ? m.status + ' ' + m.sha : 'agent failed'}`)
}

const pushed = merged.filter((m) => m.status === 'pushed')
if (pushed.length === 0) {
  return { implemented: impls, merged, ci: null, closed: [], summary: 'nothing reached main' }
}

// ---------------------------------------------------------------------------
// Phase 6 - forced rebuild.
// A batch of rapid pushes leaves the last run's path filter looking at only the
// LAST push's diff, so build-*/merge-* get skipped and deploy ships stale digests
// while reporting green. Earlier runs were evicted from the queue before starting
// (GitHub keeps one pending run per concurrency group; cancel-in-progress:false
// does not help). So never trust the push-triggered run - force a full rebuild.
// ---------------------------------------------------------------------------

phase('Rebuild')

const dispatch = await agent(`${HOUSE_RULES}

You are the REBUILD dispatcher. ${pushed.length} commits just landed on main:
${pushed.map((p) => `  #${p.ticket} -> ${p.sha}`).join('\n')}

Rapid pushes mean the push-triggered CI runs cannot be trusted: each run's path filter sees
only its own push's diff, so image builds get skipped and deploy reuses stale digests while
still reporting success.

Do exactly this:
1. \`cd ${REPO} && gh workflow run ci.yml --ref main -f force_all=true\`
2. Wait ~15s, then \`gh run list --workflow=ci.yml --branch main --event workflow_dispatch --limit 3\`
3. Return ONLY the numeric run id of the dispatch you just created. Nothing else.

Do not watch it. Do not wait for it. Return the id immediately.`,
  { label: 'dispatch-rebuild', phase: 'Rebuild', model: 'sonnet' })

const runIdMatch = String(dispatch || '').match(/\b(\d{8,})\b/)
const runId = runIdMatch ? runIdMatch[1] : null
log(`force_all run: ${runId || 'UNKNOWN - verifier will locate it'}`)

// ---------------------------------------------------------------------------
// Phase 7 - bounded CI polling.
// Each agent call watches for a BOUNDED time and returns. The loop lives in the
// script, so no agent can answer "I'll report back when it finishes" and exit -
// which is exactly how the first version of this workflow silently failed.
// ---------------------------------------------------------------------------

phase('Verify')

let ci = null
for (let attempt = 1; attempt <= 10; attempt++) {
  const s = await agent(`${HOUSE_RULES}

You are the CI VERIFIER (poll ${attempt} of 10). Work in ${REPO}.
${runId ? `Target run: ${runId}.` : 'Find the newest workflow_dispatch CI run on main.'}

Run EXACTLY this, which is bounded and WILL return:
  cd ${REPO} && timeout 240 gh run watch ${runId || '<run-id>'} --exit-status --interval 20; echo "RC=$?"

Then \`gh run view <id> --json status,conclusion,headSha,jobs\`.

Rules that matter:
- NEVER answer that you are waiting and will report later. You must return a verdict from the
  data you have RIGHT NOW. If the run is still going after the timeout, return state "running".
- Set buildsRan TRUE only if the build-*/merge-* jobs actually ran. If they are "skipped",
  set it FALSE even when the run is green - a green run that built nothing did not deploy.
- If the run is red, include the failing job's verbatim output in \`detail\`, and say whether
  the failure comes from these commits or is pre-existing/another session's.

Return the structured status.`, { label: `ci-poll-${attempt}`, phase: 'Verify', model: 'sonnet', schema: CI_SCHEMA })

  if (s && s.state === 'finished') { ci = s; break }
  if (s && s.state === 'not-found' && attempt >= 3) { ci = s; break }
  log(`poll ${attempt}: ${s ? s.state : 'agent failed'}`)
}

if (!ci || ci.conclusion !== 'success' || !ci.buildsRan) {
  log(`NOT closing any ticket: ${!ci ? 'no CI verdict' : `conclusion=${ci.conclusion} buildsRan=${ci.buildsRan}`}`)
  return {
    implemented: impls.map((r) => ({ ticket: r.ticket, status: r.status, notes: r.notes })),
    notLanded: notLanded.map((r) => ({ ticket: r.ticket, why: r.notes })),
    merged, ci, closed: [],
    summary: 'code is on main but NOT verified deployed - tickets left open deliberately',
  }
}

// ---------------------------------------------------------------------------
// Phase 8 - close, but only what is provably live.
// ---------------------------------------------------------------------------

phase('Close')

const closeReport = await agent(`${HOUSE_RULES}

You are the CLOSER. CI run ${ci.runId} finished: conclusion=${ci.conclusion}, builds actually ran.

First PROVE the code is live, do not assume:
  kubectl get pods -n control-center
Pod age must postdate the deploy. If pods did not roll, STOP and close nothing.

Then, for each ticket below, decide honestly whether it is FULLY resolved. A ticket whose
implementer reported "partial", or deliberately left part of the scope undone, must be
COMMENTED and left OPEN - not closed. Closing a partially-done ticket is worse than leaving it.

${pushed.map((p) => {
  const impl = impls.find((i) => i.ticket === p.ticket) || {}
  return `#${p.ticket} sha=${p.sha} status=${impl.status}\n  summary: ${impl.summary}\n  notes: ${impl.notes}`
}).join('\n\n')}

For fully-resolved tickets:
  gh issue close <N> --comment "Shipped in <sha>. <summary>

CI run ${ci.runId} green with a full force_all rebuild - all build/merge/deploy jobs ran.
Verified live: control-center pods rolled to the new images."

For partially-resolved ones, use \`gh issue comment <N> --body "..."\` stating exactly what
shipped and what is deliberately left, so it is obvious later. Note: the flag is --body,
not --comment, for \`gh issue comment\`.

Return plain text: which tickets you closed, which you left open and why, and the pod evidence.`,
  { label: 'close-tickets', phase: 'Close', model: 'sonnet' })

return {
  implemented: impls.map((r) => ({ ticket: r.ticket, status: r.status, files: r.filesChanged, notes: r.notes })),
  notLanded: notLanded.map((r) => ({ ticket: r.ticket, why: r.notes })),
  merged,
  ci,
  closeReport,
}

import { getLogger } from "@www/logger";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";

import { config } from "./config";
import { db } from "./db";
import {
  GITHUB_POLL_STATUS_SINGLETON_ID,
  githubPollStatus,
  githubRun,
  githubRunLogTail,
} from "./schema";

// GitHub Actions deploy poller (spec 2026-07-18-github-deploy-tile-design).
// The worker calls runGithubPollCycle on a 10s tick; the cycle self-gates to
// 60s while no run is in flight so the idle request rate stays at ~60/hr.
// "Currently deployed" is the newest run whose DEPLOY JOB concluded success,
// not the newest green run: ci.yml's path filters can skip deploy inside a
// successful run. The api reads only Postgres (api.ts); this module is the
// single place that talks to GitHub.

const GITHUB_BASE_URL = "https://api.github.com";
/** Name of the deploy job in ci.yml; its conclusion defines "deployed". */
export const DEPLOY_JOB_NAME = "deploy-home-server";
/** Poll gap while no run is in flight (hot runs poll every worker tick). */
export const IDLE_POLL_MS = 60_000;
/** Stored failure-log tail size. */
export const LOG_TAIL_BYTES = 4096;
/** Job logs 404 briefly after a failure; wait this long before the first try. */
const LOG_TAIL_MIN_AGE_MS = 5_000;
/** Give up on a run's log tail after this many failed fetches. */
const LOG_TAIL_MAX_ATTEMPTS = 5;

// ─── zod edge schemas (same rationale as asc-version-service: a changed or
// malformed payload fails loudly at the boundary, never writes garbage) ───────

const runSchema = z.object({
  id: z.number().int(),
  run_number: z.number().int(),
  name: z.string(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string(),
  created_at: z.string(),
  // Null while a run is still queued; created_at stands in until it starts.
  run_started_at: z.string().nullish(),
  updated_at: z.string(),
  head_commit: z
    .object({
      message: z.string(),
      author: z.object({ name: z.string() }).nullish(),
    })
    .nullish(),
});

const runsResponseSchema = z.object({ workflow_runs: z.array(runSchema) });

const jobSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  steps: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
        conclusion: z.string().nullable(),
      }),
    )
    .default([]),
});

const jobsResponseSchema = z.object({ jobs: z.array(jobSchema) });

const commitResponseSchema = z.object({
  sha: z.string(),
  stats: z.object({ additions: z.number().int(), deletions: z.number().int() }),
  files: z.array(z.object({ filename: z.string() })).default([]),
});

const compareResponseSchema = z.object({ ahead_by: z.number().int() });

// ─── parsed shapes ────────────────────────────────────────────────────────────

export interface GithubRunListItem {
  id: number;
  runNumber: number;
  workflowName: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  startedAtUtc: Date;
  completedAtUtc: Date | null;
  htmlUrl: string;
}

export interface GithubJobsSummary {
  /** Conclusion of the `deploy` job; null while it has not finished (or does not exist). */
  deployJobConclusion: string | null;
  failed: { jobId: number; jobName: string; stepName: string } | null;
  current: { jobName: string; stepName: string } | null;
}

export interface GithubCommitDetail {
  sha: string;
  additions: number;
  deletions: number;
  changedFileCount: number;
}

function isGithubConfigured(): boolean {
  return Boolean(config.GITHUB_ACTIONS_TOKEN);
}

/** Parse + validate a runs-list response into row-shaped items (newest first). */
export function parseRunsResponse(json: unknown): GithubRunListItem[] {
  const parsed = runsResponseSchema.parse(json);
  return parsed.workflow_runs.map((r) => ({
    id: r.id,
    runNumber: r.run_number,
    workflowName: r.name,
    headSha: r.head_sha,
    status: r.status,
    conclusion: r.conclusion,
    commitMessage: r.head_commit?.message ?? null,
    commitAuthor: r.head_commit?.author?.name ?? null,
    startedAtUtc: new Date(r.run_started_at ?? r.created_at),
    // The runs list carries no completed_at; updated_at is when the run last
    // transitioned, which for a completed run IS its completion time.
    completedAtUtc: r.status === "completed" ? new Date(r.updated_at) : null,
    htmlUrl: r.html_url,
  }));
}

/**
 * Reduce a run's job list to what the tile needs: the deploy-job conclusion,
 * the first failed job+step, and the currently executing job+step.
 */
export function parseJobsResponse(json: unknown): GithubJobsSummary {
  const parsed = jobsResponseSchema.parse(json);
  const deploy = parsed.jobs.find((j) => j.name === DEPLOY_JOB_NAME);
  const failedJob = parsed.jobs.find((j) => j.conclusion === "failure");
  const failedStep = failedJob?.steps.find((s) => s.conclusion === "failure");
  const currentJob = parsed.jobs.find((j) => j.status === "in_progress");
  const currentStep = currentJob?.steps.find((s) => s.status === "in_progress");
  return {
    deployJobConclusion: deploy?.status === "completed" ? deploy.conclusion : null,
    failed: failedJob
      ? {
          jobId: failedJob.id,
          jobName: failedJob.name,
          stepName: failedStep?.name ?? "unknown step",
        }
      : null,
    current: currentJob
      ? { jobName: currentJob.name, stepName: currentStep?.name ?? currentJob.name }
      : null,
  };
}

export function parseCommitResponse(json: unknown): GithubCommitDetail {
  const parsed = commitResponseSchema.parse(json);
  return {
    sha: parsed.sha,
    additions: parsed.stats.additions,
    deletions: parsed.stats.deletions,
    changedFileCount: parsed.files.length,
  };
}

export function parseCompareResponse(json: unknown): number {
  return compareResponseSchema.parse(json).ahead_by;
}

/** Last LOG_TAIL_BYTES of a job log; whole log when already smaller. */
export function logTailOf(text: string): string {
  return text.length <= LOG_TAIL_BYTES ? text : text.slice(-LOG_TAIL_BYTES);
}

/**
 * Cadence gate: hot (a run in flight) polls every worker tick; idle waits
 * IDLE_POLL_MS between polls. The 1s epsilon absorbs tick-timing jitter so an
 * idle poll lands every 60s, not every 70s.
 */
export function shouldPollNow(lastAttemptAtMs: number, hot: boolean, nowMs: number): boolean {
  if (hot) return true;
  return nowMs - lastAttemptAtMs >= IDLE_POLL_MS - 1_000;
}

// ─── GitHub fetch ─────────────────────────────────────────────────────────────

async function ghFetch(path: string, accept = "application/vnd.github+json"): Promise<Response> {
  const res = await fetch(`${GITHUB_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${config.GITHUB_ACTIONS_TOKEN}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub ${path.split("?")[0]} HTTP ${res.status}`);
  return res;
}

// ─── cycle ────────────────────────────────────────────────────────────────────

// Module-level cadence state. The worker is a single sequential poller, so a
// plain variable is race-free; a restart just means one immediate poll.
let lastAttemptAtMs = 0;

async function hasRunInFlight(): Promise<boolean> {
  const rows = await db
    .select({ id: githubRun.id })
    .from(githubRun)
    .where(inArray(githubRun.status, ["queued", "in_progress"]))
    .limit(1);
  return rows.length > 0;
}

async function upsertRuns(runs: GithubRunListItem[]): Promise<void> {
  for (const r of runs) {
    await db
      .insert(githubRun)
      .values({ ...r })
      .onConflictDoUpdate({
        target: githubRun.id,
        set: {
          status: r.status,
          conclusion: r.conclusion,
          startedAtUtc: r.startedAtUtc,
          completedAtUtc: r.completedAtUtc,
          // The runs list omits head_commit on rare payloads; never null-out a
          // message we already stored.
          ...(r.commitMessage == null ? {} : { commitMessage: r.commitMessage }),
          ...(r.commitAuthor == null ? {} : { commitAuthor: r.commitAuthor }),
        },
      });
  }
}

/** Runs whose job detail is missing or possibly moving: in flight, or completed
 *  without a deploy-job verdict, or failed without a named failing job. */
async function runsNeedingJobs(runIds: number[]): Promise<{ id: number; status: string }[]> {
  if (runIds.length === 0) return [];
  return db
    .select({ id: githubRun.id, status: githubRun.status })
    .from(githubRun)
    .where(
      and(
        inArray(githubRun.id, runIds),
        or(
          inArray(githubRun.status, ["queued", "in_progress"]),
          isNull(githubRun.deployJobConclusion),
          and(eq(githubRun.conclusion, "failure"), isNull(githubRun.failedJobName)),
        ),
      ),
    );
}

async function refreshJobs(runId: number): Promise<void> {
  const res = await ghFetch(`/repos/${config.GITHUB_REPO}/actions/runs/${runId}/jobs?per_page=100`);
  const summary = parseJobsResponse(await res.json());
  await db
    .update(githubRun)
    .set({
      deployJobConclusion: summary.deployJobConclusion,
      failedJobId: summary.failed?.jobId ?? null,
      failedJobName: summary.failed?.jobName ?? null,
      failedStepName: summary.failed?.stepName ?? null,
      currentJobName: summary.current?.jobName ?? null,
      currentStepName: summary.current?.stepName ?? null,
    })
    .where(eq(githubRun.id, runId));
  if (summary.failed) {
    // Mark the failure now; the log tail is fetched on a LATER tick because job
    // logs 404 for several seconds after a job flips to failure.
    await db
      .insert(githubRunLogTail)
      .values({ runId, jobId: summary.failed.jobId })
      .onConflictDoNothing();
  }
}

async function backfillCommitDetails(): Promise<void> {
  const missing = await db
    .select({ id: githubRun.id, headSha: githubRun.headSha })
    .from(githubRun)
    .where(isNull(githubRun.additions))
    .orderBy(desc(githubRun.startedAtUtc))
    .limit(5);
  for (const row of missing) {
    const res = await ghFetch(`/repos/${config.GITHUB_REPO}/commits/${row.headSha}`);
    const detail = parseCommitResponse(await res.json());
    await db
      .update(githubRun)
      .set({
        additions: detail.additions,
        deletions: detail.deletions,
        changedFileCount: detail.changedFileCount,
      })
      .where(eq(githubRun.id, row.id));
  }
}

async function fetchPendingLogTails(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - LOG_TAIL_MIN_AGE_MS);
  const pending = await db
    .select({
      runId: githubRunLogTail.runId,
      jobId: githubRunLogTail.jobId,
      attempts: githubRunLogTail.attempts,
      completedAtUtc: githubRun.completedAtUtc,
    })
    .from(githubRunLogTail)
    .innerJoin(githubRun, eq(githubRun.id, githubRunLogTail.runId))
    .where(
      and(isNull(githubRunLogTail.logTail), lt(githubRunLogTail.attempts, LOG_TAIL_MAX_ATTEMPTS)),
    )
    .limit(3);
  for (const p of pending) {
    // Linear backoff: attempt N waits N extra poll-ages before retrying, so a
    // slow log flush never burns all attempts inside one hot window.
    const readyAt = p.completedAtUtc
      ? new Date(p.completedAtUtc.getTime() + LOG_TAIL_MIN_AGE_MS * (p.attempts + 1))
      : cutoff;
    if (now.getTime() < readyAt.getTime()) continue;
    try {
      const res = await ghFetch(`/repos/${config.GITHUB_REPO}/actions/jobs/${p.jobId}/logs`, "*/*");
      const tail = logTailOf(await res.text());
      await db
        .update(githubRunLogTail)
        .set({ logTail: tail, fetchedAtUtc: now, attempts: p.attempts + 1 })
        .where(eq(githubRunLogTail.runId, p.runId));
    } catch (err) {
      getLogger().warn({ err, runId: p.runId }, "github-actions: log tail fetch failed");
      await db
        .update(githubRunLogTail)
        .set({ attempts: p.attempts + 1 })
        .where(eq(githubRunLogTail.runId, p.runId));
    }
  }
}

async function refreshDeployedPointer(runs: GithubRunListItem[]): Promise<void> {
  const deployedRows = await db
    .select({
      id: githubRun.id,
      headSha: githubRun.headSha,
      completedAtUtc: githubRun.completedAtUtc,
      startedAtUtc: githubRun.startedAtUtc,
    })
    .from(githubRun)
    .where(eq(githubRun.deployJobConclusion, "success"))
    .orderBy(desc(githubRun.startedAtUtc))
    .limit(1);
  const deployed = deployedRows[0];
  const mainHeadSha = runs[0]?.headSha ?? null;

  let commitsBehind = 0;
  if (deployed && mainHeadSha && deployed.headSha !== mainHeadSha) {
    // Exact count from the compare endpoint (feed rows are runs = pushes, so
    // counting them would undercount multi-commit pushes). A compare failure
    // (e.g. force-push made the base unreachable) keeps the previous value.
    const res = await ghFetch(
      `/repos/${config.GITHUB_REPO}/compare/${deployed.headSha}...${mainHeadSha}`,
    );
    commitsBehind = parseCompareResponse(await res.json());
  }

  await db
    .insert(githubPollStatus)
    .values({
      id: GITHUB_POLL_STATUS_SINGLETON_ID,
      deployedSha: deployed?.headSha ?? null,
      deployedRunId: deployed?.id ?? null,
      deployedAtUtc: deployed?.completedAtUtc ?? deployed?.startedAtUtc ?? null,
      mainHeadSha,
      commitsBehind,
      updatedAtUtc: new Date(),
    })
    .onConflictDoUpdate({
      target: githubPollStatus.id,
      set: {
        deployedSha: deployed?.headSha ?? null,
        deployedRunId: deployed?.id ?? null,
        deployedAtUtc: deployed?.completedAtUtc ?? deployed?.startedAtUtc ?? null,
        mainHeadSha,
        commitsBehind,
        updatedAtUtc: new Date(),
      },
    });
}

async function markHeartbeat(error: string | null): Promise<void> {
  const now = new Date();
  // Same consecutive-failure streak semantics as weather-ingest: reset on
  // success, increment on error. Single sequential poller, so race-free.
  const rows = await db
    .select({ n: githubPollStatus.consecutiveFailures })
    .from(githubPollStatus)
    .where(eq(githubPollStatus.id, GITHUB_POLL_STATUS_SINGLETON_ID))
    .limit(1);
  const consecutiveFailures = error ? (rows[0]?.n ?? 0) + 1 : 0;
  await db
    .insert(githubPollStatus)
    .values({
      id: GITHUB_POLL_STATUS_SINGLETON_ID,
      lastPolledAtUtc: now,
      lastError: error,
      consecutiveFailures,
    })
    .onConflictDoUpdate({
      target: githubPollStatus.id,
      set: { lastPolledAtUtc: now, lastError: error, consecutiveFailures, updatedAtUtc: now },
    });
}

/**
 * One poll cycle. Never throws: any failure lands in the heartbeat's
 * lastError/consecutiveFailures (the tile's "stale" state) and last-known rows
 * survive. A no-op when the token is unset or the idle gate has not elapsed.
 */
export async function runGithubPollCycle(nowMs = Date.now()): Promise<void> {
  if (!isGithubConfigured()) return;
  try {
    const hot = await hasRunInFlight();
    if (!shouldPollNow(lastAttemptAtMs, hot, nowMs)) return;
    lastAttemptAtMs = nowMs;

    const res = await ghFetch(`/repos/${config.GITHUB_REPO}/actions/runs?branch=main&per_page=20`);
    const runs = parseRunsResponse(await res.json());
    await upsertRuns(runs);

    for (const r of await runsNeedingJobs(runs.map((run) => run.id))) {
      await refreshJobs(r.id);
    }

    await backfillCommitDetails();
    await refreshDeployedPointer(runs);
    await fetchPendingLogTails(new Date(nowMs));
    await markHeartbeat(null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err }, "github-actions: poll cycle failed");
    await markHeartbeat(msg).catch(() => {});
  }
}

// ─── read side (deploys tRPC router) ─────────────────────────────────────────

export const CommitDeployState = {
  Deployed: "deployed",
  Building: "building",
  Failed: "failed",
  Skipped: "skipped",
} as const;
export type CommitDeployState = (typeof CommitDeployState)[keyof typeof CommitDeployState];

interface GithubRunRow {
  status: string;
  conclusion: string | null;
  deployJobConclusion: string | null;
}

/** Map a run row to the per-commit deploy state the tile feed renders. */
export function commitStateForRun(run: GithubRunRow): CommitDeployState {
  if (run.status !== "completed") return CommitDeployState.Building;
  if (run.deployJobConclusion === "success") return CommitDeployState.Deployed;
  if (run.conclusion === "failure") return CommitDeployState.Failed;
  // Green run, deploy skipped by path filters , or jobs not yet resolved.
  return CommitDeployState.Skipped;
}

export interface GithubDeployStatus {
  configured: boolean;
  lastPolledAtUtc: string | null;
  consecutiveFailures: number;
  deployedSha: string | null;
  deployedAtUtc: string | null;
  mainHeadSha: string | null;
  commitsBehind: number;
  run: { jobName: string; stepName: string; startedAtUtc: string; htmlUrl: string } | null;
  failure: { jobName: string; stepName: string; logTail: string | null; htmlUrl: string } | null;
  commits: {
    sha: string;
    message: string;
    committedAtUtc: string;
    htmlUrl: string;
    state: CommitDeployState;
    changedFileCount: number | null;
    additions: number | null;
    deletions: number | null;
  }[];
}

/**
 * One-read status for the Deploys tile. The in-flight/failed verdict comes from
 * the NEWEST run only: an older failure that a newer green run superseded is
 * history (visible in the feed), not the pipeline's current state.
 */
export async function getGithubDeployStatus(): Promise<GithubDeployStatus> {
  const statusRows = await db
    .select()
    .from(githubPollStatus)
    .where(eq(githubPollStatus.id, GITHUB_POLL_STATUS_SINGLETON_ID))
    .limit(1);
  const envelope = statusRows[0] ?? null;

  const runs = await db.select().from(githubRun).orderBy(desc(githubRun.startedAtUtc)).limit(20);
  const latest = runs[0] ?? null;

  let run: GithubDeployStatus["run"] = null;
  let failure: GithubDeployStatus["failure"] = null;
  if (latest && latest.status !== "completed") {
    run = {
      jobName: latest.currentJobName ?? latest.workflowName,
      stepName: latest.currentStepName ?? "",
      startedAtUtc: latest.startedAtUtc.toISOString(),
      htmlUrl: latest.htmlUrl,
    };
  } else if (latest && latest.conclusion === "failure") {
    const tailRows = await db
      .select({ logTail: githubRunLogTail.logTail })
      .from(githubRunLogTail)
      .where(eq(githubRunLogTail.runId, latest.id))
      .limit(1);
    failure = {
      jobName: latest.failedJobName ?? "unknown job",
      stepName: latest.failedStepName ?? "unknown step",
      logTail: tailRows[0]?.logTail ?? null,
      htmlUrl: latest.htmlUrl,
    };
  }

  return {
    configured: isGithubConfigured(),
    lastPolledAtUtc: envelope?.lastPolledAtUtc?.toISOString() ?? null,
    consecutiveFailures: envelope?.consecutiveFailures ?? 0,
    deployedSha: envelope?.deployedSha ?? null,
    deployedAtUtc: envelope?.deployedAtUtc?.toISOString() ?? null,
    mainHeadSha: envelope?.mainHeadSha ?? null,
    commitsBehind: envelope?.commitsBehind ?? 0,
    run,
    failure,
    commits: runs.map((r) => ({
      sha: r.headSha,
      message: r.commitMessage ?? "(no commit message)",
      committedAtUtc: r.startedAtUtc.toISOString(),
      htmlUrl: r.htmlUrl,
      state: commitStateForRun(r),
      changedFileCount: r.changedFileCount,
      additions: r.additions,
      deletions: r.deletions,
    })),
  };
}

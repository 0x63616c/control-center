/**
 * Measures CI pipeline latency two ways, because they answer different questions:
 *
 *  - PIPELINE DURATION: run start -> deploy job finished. What we control by
 *    making jobs faster.
 *  - LEAD TIME: a push landing -> the first successful deploy at or after it.
 *    What actually matters to a human waiting for their commit to reach prod.
 *    Diverges wildly from pipeline duration when runs get cancelled, because a
 *    superseded push has to wait for someone else's later run to carry it.
 *
 * Usage: bun run measure:ci [days]   (default 7)
 */
const DAYS = Number(process.argv[2] ?? 7);
const REPO = "0x63616c/world-wide-webb";
const WORKFLOW = "ci.yml";

type Run = {
  id: number;
  created_at: string;
  conclusion: string | null;
  event: string;
  head_sha: string;
  display_title: string;
};
type Job = {
  name: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
};

async function gh<T>(path: string): Promise<T> {
  const proc = Bun.spawn(["gh", "api", path], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`gh api ${path} failed: ${await new Response(proc.stderr).text()}`);
  }
  return JSON.parse(out) as T;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const k = (sorted.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

function report(label: string, values: number[]): void {
  const s = [...values].sort((a, b) => a - b);
  console.info(`\n${label}  (n=${s.length})`);
  if (s.length === 0) {
    console.info("  no data");
    return;
  }
  for (const p of [0.5, 0.75, 0.9, 0.95]) {
    const v = pct(s, p);
    console.info(
      `  p${String(p * 100).padStart(2)}  ${v.toFixed(0).padStart(6)}s  ${(v / 60).toFixed(1)}m`,
    );
  }
  console.info(
    `  max  ${s[s.length - 1].toFixed(0).padStart(6)}s  ${(s[s.length - 1] / 60).toFixed(1)}m`,
  );
}

const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);

// Two pages of 100 covers a week comfortably at this repo's push rate. If the
// API's total_count says otherwise, warn rather than silently truncating the
// window - a truncated baseline would corrupt every before/after comparison
// that leans on this script.
const runs: Run[] = [];
let totalCount = 0;
for (const page of [1, 2]) {
  const res = await gh<{ total_count: number; workflow_runs: Run[] }>(
    `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?created=%3E%3D${since}&branch=main&per_page=100&page=${page}`,
  );
  totalCount = res.total_count;
  runs.push(...res.workflow_runs);
}
if (totalCount > runs.length) {
  console.info(
    `WARNING: window truncated - ${totalCount} runs exist in this window but only ${runs.length} were analysed`,
  );
}

const byConclusion = new Map<string, number>();
for (const r of runs) {
  const k = r.conclusion ?? "in_progress";
  byConclusion.set(k, (byConclusion.get(k) ?? 0) + 1);
}
console.info(`window: last ${DAYS}d (since ${since})   runs: ${runs.length}`);
console.info(`conclusions: ${[...byConclusion].map(([k, v]) => `${k}=${v}`).join(" ")}`);

// Successful deploys: (run start, deploy finished).
const deploys: { start: number; done: number }[] = [];
const pipeline: number[] = [];
for (const r of runs.filter((x) => x.conclusion === "success")) {
  const { jobs } = await gh<{ jobs: Job[] }>(
    `repos/${REPO}/actions/runs/${r.id}/jobs?per_page=100`,
  );
  const dep = jobs.find(
    (j) => j.name === "deploy-home-server" && j.conclusion === "success" && j.completed_at,
  );
  if (!dep?.completed_at) continue;
  const start = Date.parse(r.created_at);
  const done = Date.parse(dep.completed_at);
  deploys.push({ start, done });
  pipeline.push((done - start) / 1000);
}

// Lead time: for every push, when did the first deploy at-or-after it finish?
const leads: number[] = [];
for (const r of runs.filter((x) => x.event === "push")) {
  const pushedAt = Date.parse(r.created_at);
  const carrier = deploys
    .filter((d) => d.start >= pushedAt && d.done >= pushedAt)
    .sort((a, b) => a.done - b.done)[0];
  if (carrier) leads.push((carrier.done - pushedAt) / 1000);
}

report("PIPELINE DURATION (push -> deploy done, green runs only)", pipeline);
report("LEAD TIME (push -> commit live in prod, every push)", leads);

// Utilisation: the number that decides whether queueing dominates.
const hours = new Set(runs.filter((r) => r.event === "push").map((r) => r.created_at.slice(0, 13)));
const pushes = runs.filter((r) => r.event === "push").length;
const medianPipeline = pct(
  [...pipeline].sort((a, b) => a - b),
  0.5,
);
if (hours.size > 0 && Number.isFinite(medianPipeline)) {
  const arrivalsPerHour = pushes / hours.size;
  const capacityPerHour = 3600 / medianPipeline;
  const rho = arrivalsPerHour / capacityPerHour;
  console.info(
    `\nUTILISATION  arrivals ${arrivalsPerHour.toFixed(2)}/active-hour  capacity ${capacityPerHour.toFixed(2)}/hour  rho ${rho.toFixed(2)}`,
  );
  console.info(rho >= 1 ? "  SATURATED - backlog grows without bound" : "  stable");
  console.info(
    "  (rho excludes time cancelled runs held their concurrency slot; true utilisation is >= this figure)",
  );
}

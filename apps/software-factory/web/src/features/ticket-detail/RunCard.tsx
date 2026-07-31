import type { RunOutput } from "@/api/generated";
import { formatDuration } from "@/features/ticket-detail/duration";
import { StepList } from "@/features/ticket-detail/StepList";
import { formatUsage } from "@/features/ticket-detail/usage";
import { temporalRunUrl } from "@/lib/temporal";

// runStatus renders outcome/failureKind as one short phrase. Both are empty
// strings until the Run ends — a Run in flight has neither, and that is a
// distinct, renderable state, not an omission to guess at.
function runStatus(run: RunOutput): string {
  if (run.endedAt === null) return "running";
  if (run.outcome === "failed" && run.failureKind !== "") return `failed (${run.failureKind})`;
  return run.outcome || "ended";
}

function runPillClass(run: RunOutput): string {
  if (run.endedAt === null) return "pill pill-working";
  if (run.outcome === "failed" || run.outcome === "exhausted") return "pill pill-failed";
  if (run.outcome === "proposed") return "pill pill-done";
  return "pill pill-blocked";
}

export function RunCard({ run }: { run: RunOutput }) {
  return (
    <article className="run-card">
      <header>
        <strong>Run {run.id}</strong>
        <span className={runPillClass(run)}>{runStatus(run)}</span>
        {run.endedAt !== null && (
          <span className="row-meta">{formatDuration(run.startedAt, run.endedAt)}</span>
        )}
        <span className="spacer" />
        <a
          className="temporal-link"
          href={temporalRunUrl(run.ticketId, run.id)}
          target="_blank"
          rel="noreferrer"
        >
          Temporal history ↗
        </a>
      </header>
      <p className="usage">Usage: {formatUsage(run.usage)}</p>
      <StepList steps={run.steps ?? []} runId={run.id} ticketId={run.ticketId} />
    </article>
  );
}

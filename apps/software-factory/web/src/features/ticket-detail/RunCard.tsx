import type { RunOutput } from "@/api/generated";
import { formatDuration } from "@/features/ticket-detail/duration";
import { StepList } from "@/features/ticket-detail/StepList";
import { formatUsage } from "@/features/ticket-detail/usage";

// runStatus renders outcome/failureKind as one short phrase. Both are empty
// strings until the Run ends — a Run in flight has neither, and that is a
// distinct, renderable state, not an omission to guess at.
function runStatus(run: RunOutput): string {
  if (run.endedAt === null) return "running";
  if (run.outcome === "failed" && run.failureKind !== "") return `failed (${run.failureKind})`;
  return run.outcome || "ended";
}

export function RunCard({ run }: { run: RunOutput }) {
  return (
    <article>
      <header>
        <strong>Run {run.id}</strong> — {runStatus(run)} ·{" "}
        {formatDuration(run.startedAt, run.endedAt)}
      </header>
      <p>Usage: {formatUsage(run.usage)}</p>
      <StepList steps={run.steps ?? []} runId={run.id} ticketId={run.ticketId} />
    </article>
  );
}

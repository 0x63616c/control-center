import type { StepOutput } from "@/api/generated";
import { AttemptRow } from "@/features/ticket-detail/AttemptRow";
import { formatDuration } from "@/features/ticket-detail/duration";
import { formatUsage } from "@/features/ticket-detail/usage";

// StepRow renders ADR-0012's fixed line shape: the turn is the headline, and
// "· N attempts" appears only when there was more than one — a healthy run
// (every Step's only Attempt succeeded) reads quietly, and a Step the machine
// had to retry is the one that gets loud.
export function StepRow({
  step,
  runId,
  ticketId,
}: {
  step: StepOutput;
  runId: string;
  ticketId: number;
}) {
  const attempts = step.attempts ?? [];
  return (
    <div data-testid="step-row">
      <p>
        <strong>{step.stage}</strong> · turn {step.turn} ·{" "}
        {formatDuration(step.startedAt, step.endedAt)}
        {attempts.length > 1 && ` · ${attempts.length} attempts`}
      </p>
      <p>Usage: {formatUsage(step.usage)}</p>
      <ul>
        {attempts.map((attempt) => (
          <li key={attempt.attemptNo}>
            <AttemptRow
              attempt={attempt}
              runId={runId}
              ticketId={ticketId}
              stage={step.stage}
              turn={step.turn}
              showAttemptNumber={attempts.length > 1}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

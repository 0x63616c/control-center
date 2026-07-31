import type { AttemptOutput, StepOutputStage } from "@/api/generated";
import { formatDuration } from "@/features/ticket-detail/duration";
import { TranscriptViewer } from "@/features/ticket-detail/TranscriptViewer";
import { transcriptDownloadUrl } from "@/features/ticket-detail/transcriptUrl";
import { formatAttemptUsage } from "@/features/ticket-detail/usage";

function resultLabel(result: string): string {
  return result === "" ? "in progress" : result;
}

function resultPillClass(result: string): string {
  if (result === "succeeded") return "pill pill-done";
  if (result === "failed") return "pill pill-failed";
  return "pill pill-working";
}

export function AttemptRow({
  attempt,
  runId,
  ticketId,
  stage,
  turn,
  showAttemptNumber,
}: {
  attempt: AttemptOutput;
  runId: string;
  ticketId: number;
  stage: StepOutputStage;
  turn: number;
  showAttemptNumber: boolean;
}) {
  return (
    <div className="attempt-row" data-testid="attempt-row">
      <div className="row-line">
        {showAttemptNumber && <span>Attempt {attempt.attemptNo}</span>}
        <span className={resultPillClass(attempt.result)}>{resultLabel(attempt.result)}</span>
        <span className="row-meta">
          {formatDuration(attempt.startedAt, attempt.endedAt)} · {attempt.model} ({attempt.effort})
        </span>
      </div>
      <p className="usage">Usage: {formatAttemptUsage(attempt)}</p>
      {attempt.hasTranscript ? (
        <p>
          <a
            href={transcriptDownloadUrl(ticketId, runId, stage, turn, attempt.attemptNo)}
            download={`ticket-${ticketId}-${stage}-turn${turn}-attempt${attempt.attemptNo}.jsonl`}
          >
            Download transcript
          </a>{" "}
          <TranscriptViewer
            ticketId={ticketId}
            runId={runId}
            stage={stage}
            turn={turn}
            attemptNo={attempt.attemptNo}
          />
        </p>
      ) : (
        <p className="row-meta">No transcript stored for this attempt.</p>
      )}
    </div>
  );
}

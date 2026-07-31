import type { AttemptOutput, StepOutputStage } from "@/api/generated";
import { formatDuration } from "@/features/ticket-detail/duration";
import { TranscriptViewer } from "@/features/ticket-detail/TranscriptViewer";
import { transcriptDownloadUrl } from "@/features/ticket-detail/transcriptUrl";
import { formatAttemptUsage } from "@/features/ticket-detail/usage";

function resultLabel(result: string): string {
  return result === "" ? "in progress" : result;
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
    <div data-testid="attempt-row">
      <p>
        {showAttemptNumber && <>Attempt {attempt.attemptNo} · </>}
        {formatDuration(attempt.startedAt, attempt.endedAt)} · {resultLabel(attempt.result)} ·{" "}
        {attempt.model} ({attempt.effort})
      </p>
      <p>Usage: {formatAttemptUsage(attempt)}</p>
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
        <p>No transcript stored for this attempt.</p>
      )}
    </div>
  );
}

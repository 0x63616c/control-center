import axios from "axios";
import type { StepOutputStage } from "@/api/generated";

// transcriptDownloadUrl builds the same-origin path main.tsx's
// axios.defaults.baseURL ("/api") already routes through nginx to the API
// (ADR-0012 "Exposure and authentication"). A plain <a href download> is
// enough — the browser carries the Cloudflare Access session cookie on a
// same-origin navigation, so no fetch/blob plumbing is needed here.
export function transcriptDownloadUrl(
  ticketId: number,
  runId: string,
  stage: StepOutputStage,
  turn: number,
  attemptNo: number,
): string {
  const base = axios.defaults.baseURL ?? "";
  return `${base}/v1/tickets/${ticketId}/runs/${runId}/stages/${stage}/turns/${turn}/attempts/${attemptNo}/transcript`;
}

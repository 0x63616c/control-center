/**
 * GitHub webhook verification + persistence (#126).
 *
 * SECURITY BOUNDARY. `hooks.worldwidewebb.co` is deliberately NOT behind
 * Cloudflare Access — GitHub has to be able to POST to it from the public
 * internet — so the HMAC below is the ONLY thing standing between us and an
 * open write endpoint. Treat any change here as a security change.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** GitHub's own cap is 25 MB; we have no use for payloads near that. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export type WebhookRejection = "missing-signature" | "bad-signature" | "body-too-large";

/**
 * Constant-time comparison of `X-Hub-Signature-256` against the HMAC of the RAW
 * body. The raw bytes matter: re-serialising the parsed JSON changes key order
 * and whitespace, and the signature would never match.
 */
export function verifySignature(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  secret: string,
): WebhookRejection | null {
  if (rawBody.byteLength > MAX_BODY_BYTES) return "body-too-large";
  if (!signatureHeader) return "missing-signature";

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const provided = Buffer.from(signatureHeader);
  const computed = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch, which would itself leak length
  // through the error path, so the length check short-circuits first.
  if (provided.length !== computed.length) return "bad-signature";
  return timingSafeEqual(provided, computed) ? null : "bad-signature";
}

export type DeliveryHeaders = Readonly<{
  deliveryId: string | null;
  event: string | null;
  hookId: string | null;
}>;

export type DeliveryRow = Readonly<{
  deliveryId: string;
  source: "github";
  event: string;
  action: string | null;
  repo: string | null;
  senderLogin: string | null;
  subjectType: string | null;
  subjectNumber: number | null;
  installationId: string | null;
  hookId: string | null;
  signatureValid: true;
  payload: unknown;
}>;

/**
 * Flattens the handful of fields worth querying out of an arbitrary GitHub
 * payload. Everything is optional by design: this runs over EVERY event type we
 * subscribe to, and a shape assumption here would turn an unfamiliar event into
 * a 500 (which GitHub responds to by eventually disabling the hook).
 */
export function toDeliveryRow(
  headers: DeliveryHeaders,
  payload: Record<string, unknown>,
): DeliveryRow | null {
  if (!headers.deliveryId || !headers.event) return null;

  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const obj = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

  const issue = obj(payload.issue);
  const pull = obj(payload.pull_request);
  const subject = pull ?? issue;
  const subjectNumber = subject && typeof subject.number === "number" ? subject.number : null;

  const installation = obj(payload.installation);

  return {
    deliveryId: headers.deliveryId,
    source: "github",
    event: headers.event,
    action: str(payload.action),
    repo: str(obj(payload.repository)?.full_name),
    senderLogin: str(obj(payload.sender)?.login),
    subjectType: pull ? "pull_request" : issue ? "issue" : null,
    subjectNumber,
    installationId: installation?.id == null ? null : String(installation.id),
    hookId: headers.hookId,
    signatureValid: true,
    payload,
  };
}

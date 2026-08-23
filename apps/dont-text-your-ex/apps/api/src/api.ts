import { createLogger } from "@www/logger";
import { Hono } from "hono";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  AppleAuthRequestSchema,
  AuthDevRequestSchema,
  CloseJarRequestSchema,
  CreateAbuseReportRequestSchema,
  CreateJarRequestSchema,
  CreateReportRequestSchema,
  DisablePushDeviceRequestSchema,
  JarIdSchema,
  JoinJarRequestSchema,
  LeaveJarRequestSchema,
  LogSlipRequestSchema,
  NotificationIdSchema,
  NotificationPreferencesSchema,
  NotificationTargetSchema,
  PreviewJarRequestSchema,
  PushRegistrationResponseSchema,
  RegisterPushDeviceRequestSchema,
  ReportIdSchema,
  RescueCommandRequestSchema,
  RescueInterventionIdSchema,
  RescueInterventionSchema,
  ResolveReportRequestSchema,
  RotateInviteRequestSchema,
  type SessionToken,
  ShareStreakRequestSchema,
  UpdateMeRequestSchema,
  UpdateNotificationPreferencesRequestSchema,
  UpdateTimeZoneRequestSchema,
  type UserId,
  UserIdSchema,
} from "../../../contracts";
import { completeAppleAccountSignIn, verifyAppleIdentityToken } from "./apple-auth";
import { requireUser } from "./auth";
import { errorDetails, parseRequestJson, parseRequestValue } from "./boundary";
import { type ContentSafetyReason, evaluateTextContent } from "./content-safety";
import { appleBundleId, isProduction } from "./env";
import { type SanitizedEvidenceImage, sanitizeEvidenceImage } from "./evidence-image";
import { id } from "./ids";
import { ModerationAuthorizationError, moderationStore } from "./moderation";
import { notificationStore } from "./notifications";
import { rescueStore } from "./rescue";
import { resetAndSeed } from "./seed";
import * as store from "./store";

export type Env = { Variables: { userId: UserId | null; token: SessionToken | null } };

export const api = new Hono<Env>();

const log = createLogger({ service: "dont-text-your-ex-api" });

const unauth = { error: "not_authenticated" } as const;
const jarClosed = { error: "jar_closed" } as const;
const notFound = { error: "not_found" } as const;

function assertNever(value: never): never {
  throw new Error(`Unhandled state: ${JSON.stringify(value)}`);
}

function rejectedContentReason(
  values: readonly (string | null | undefined)[],
): ContentSafetyReason | null {
  for (const value of values) {
    // Some legacy optional fields deliberately use an empty string as "not
    // configured". Whitespace/control-only submissions are still evaluated
    // and rejected.
    if (value == null || value === "") continue;
    const result = evaluateTextContent(value);
    if (!result.allowed) return result.reason;
  }
  return null;
}

// ─────────────────────────── health ───────────────────────────
api.get("/health", (c) => c.json({ ok: true }));

// ─────────────────────────── auth ───────────────────────────
// Non-production dev/test login seam (404 in production). The native "Sign in
// with Apple" sheet can't run in a browser, so local dev and the e2e suite mint
// a session here instead. { as: "new" } creates a fresh empty-profile user (the
// first-run setup flow); otherwise it logs in as the seeded primary user.
api.post("/auth/dev", async (c) => {
  if (isProduction()) return c.json({ error: "not_found" }, 404);
  const parsed = await parseRequestJson(c, AuthDevRequestSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (body.as === "new") {
    const fresh = await store.createUser({
      name: "",
      appleId: id("dev", 32),
      authProvider: "apple",
    });
    const token = await store.createSession(fresh.id);
    return c.json({ status: "needs_profile" as const, token, user: await store.getMe(fresh.id) });
  }
  const user = await store.findUserByPhone("+15550000001");
  if (!user) return c.json({ error: "seeded_user_not_found" }, 404);
  const token = await store.createSession(user.id);
  return c.json({ status: "authenticated" as const, token, user: await store.getMe(user.id) });
});

// Non-production test seam: truncate + reseed for per-test isolation (404 in prod).
api.post("/test/reset", async (c) => {
  if (isProduction()) return c.json({ error: "not_found" }, 404);
  await resetAndSeed();
  return c.json({ ok: true });
});

// Real Sign In with Apple: verifies the JWT from the native
// ASAuthorizationAppleIDProvider flow, then finds or creates the user.
api.post("/auth/apple", async (c) => {
  const parsed = await parseRequestJson(c, AppleAuthRequestSchema);
  if (!parsed.ok) return parsed.response;
  const { identityToken, nonce, fullName } = parsed.value;
  const rejectedReason = rejectedContentReason([fullName]);
  if (rejectedReason) {
    return c.json({ error: "content_not_allowed" as const, reason: rejectedReason }, 400);
  }

  // Decode diagnostic metadata before verification, but never log the stable
  // Apple subject or token. The most common failure is an `aud` mismatch.
  try {
    const header = decodeProtectedHeader(identityToken);
    const payload = decodeJwt(identityToken);
    log.info(
      {
        alg: header.alg,
        kid: header.kid,
        aud: payload.aud,
        iss: payload.iss,
        exp: payload.exp,
        expectedAud: appleBundleId(),
        tokenLen: identityToken.length,
      },
      "auth/apple: token received",
    );
  } catch (e) {
    log.warn({ err: errorDetails(e).message }, "auth/apple: token could not be decoded");
  }

  let sub: string;
  try {
    ({ sub } = await verifyAppleIdentityToken(identityToken, nonce));
  } catch (e) {
    const { name, message } = errorDetails(e);
    log.warn(
      { err: name, msg: message, expectedAud: appleBundleId() },
      "auth/apple: verification failed",
    );
    return c.json(
      {
        error: "invalid_apple_token",
        ...(isProduction() ? {} : { message, expectedAud: appleBundleId() }),
      },
      401,
    );
  }
  const result = await completeAppleAccountSignIn(sub, fullName, {
    findUserByAppleId: store.findUserByAppleId,
    createUser: store.createUser,
    createSession: store.createSession,
    getMe: store.getMe,
  });
  log.info(
    { created: result.created, status: result.response.status, userId: result.response.user.id },
    "auth/apple: signed in",
  );
  return c.json(result.response);
});

api.post("/auth/logout", async (c) => {
  const token = c.get("token");
  if (token) await store.deleteSession(token);
  return c.json({ ok: true });
});

// ─────────────────────────── me ───────────────────────────
api.get("/me", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  return c.json(await store.getMe(uid));
});

api.patch("/me", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsed = await parseRequestJson(c, UpdateMeRequestSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const rejectedReason = rejectedContentReason([body.name, ...(body.exes ?? [])]);
  if (rejectedReason) {
    return c.json({ error: "content_not_allowed" as const, reason: rejectedReason }, 400);
  }
  if (
    body.name !== undefined ||
    body.color !== undefined ||
    body.emoji !== undefined ||
    body.photo !== undefined
  ) {
    await store.updateUser(uid, {
      name: body.name,
      color: body.color,
      emoji: body.emoji,
      photo: body.photo,
    });
  }
  if (body.exes !== undefined) await store.setExes(uid, body.exes);
  return c.json(await store.getMe(uid));
});

api.patch("/me/timezone", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsed = await parseRequestJson(c, UpdateTimeZoneRequestSchema);
  if (!parsed.ok) return parsed.response;
  await store.updateUserTimeZone(uid, parsed.value.timezone);
  return c.json({ ok: true });
});

api.get("/me/blocks", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  return c.json(await store.listBlockedUsers(uid));
});

api.put("/me/blocks/:userId", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsed = parseRequestValue(c, UserIdSchema, c.req.param("userId"));
  if (!parsed.ok) return parsed.response;
  await store.blockUser(uid, parsed.value);
  return c.json({ ok: true } as const);
});

api.delete("/me/blocks/:userId", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsed = parseRequestValue(c, UserIdSchema, c.req.param("userId"));
  if (!parsed.ok) return parsed.response;
  await store.unblockUser(uid, parsed.value);
  return c.json({ ok: true } as const);
});

api.get("/me/notification-preferences", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  return c.json(NotificationPreferencesSchema.parse(await notificationStore().getPreferences(uid)));
});

api.patch("/me/notification-preferences", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsed = await parseRequestJson(c, UpdateNotificationPreferencesRequestSchema);
  if (!parsed.ok) return parsed.response;
  return c.json(
    NotificationPreferencesSchema.parse(
      await notificationStore().updatePreferences(uid, parsed.value),
    ),
  );
});

// Push tokens are accepted only for the current authenticated account. There
// is deliberately no route that lets a client create or raise a notification.
api.post("/push/devices", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsed = await parseRequestJson(c, RegisterPushDeviceRequestSchema);
  if (!parsed.ok) return parsed.response;
  await notificationStore().registerDevice(uid, parsed.value);
  return c.json(PushRegistrationResponseSchema.parse({ status: "registered" }));
});

api.post("/push/devices/disable", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsed = await parseRequestJson(c, DisablePushDeviceRequestSchema);
  if (!parsed.ok) return parsed.response;
  await notificationStore().disableDevice(uid, parsed.value.installationId);
  return c.json({ ok: true });
});

api.get("/notifications/:id/target", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsed = parseRequestValue(c, NotificationIdSchema, c.req.param("id"));
  if (!parsed.ok) return parsed.response;
  return c.json(
    NotificationTargetSchema.parse(await notificationStore().resolveTarget(uid, parsed.value)),
  );
});

// ─────────────────────────── private urge rescue ───────────────────────────
api.get("/rescue", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const intervention = await rescueStore.current(uid);
  return c.json(intervention === null ? null : RescueInterventionSchema.parse(intervention));
});

api.post("/rescue", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  return c.json(RescueInterventionSchema.parse(await rescueStore.start(uid)));
});

api.post("/rescue/:id/command", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsedId = parseRequestValue(c, RescueInterventionIdSchema, c.req.param("id"));
  if (!parsedId.ok) return parsedId.response;
  const parsed = await parseRequestJson(c, RescueCommandRequestSchema);
  if (!parsed.ok) return parsed.response;
  const outcome = await rescueStore.command({
    userId: uid,
    interventionId: parsedId.value,
    action: parsed.value.action,
  });
  switch (outcome.outcome) {
    case "applied":
    case "terminal":
      return c.json(RescueInterventionSchema.parse(outcome.intervention));
    case "ineligible":
      return c.json({ error: "rescue_command_ineligible" }, 409);
    case "not_found":
      return c.json(notFound, 404);
    default:
      return assertNever(outcome);
  }
});

// ─────────────────────────── jars ───────────────────────────
api.get("/jars", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  return c.json(await store.listJarsForUser(uid));
});

api.post("/jars", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsed = await parseRequestJson(c, CreateJarRequestSchema);
  if (!parsed.ok) return parsed.response;
  const rejectedReason = rejectedContentReason([parsed.value.name, parsed.value.rule]);
  if (rejectedReason) {
    return c.json({ error: "content_not_allowed" as const, reason: rejectedReason }, 400);
  }
  return c.json(await store.createJar({ userId: uid, ...parsed.value }));
});

api.post("/jars/preview", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsed = await parseRequestJson(c, PreviewJarRequestSchema);
  if (!parsed.ok) return parsed.response;
  const preview = await store.getJarPreviewByCode(parsed.value.code, uid);
  if (!preview) return c.json({ error: "not_found" }, 404);
  return c.json(preview);
});

api.post("/jars/join", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsed = await parseRequestJson(c, JoinJarRequestSchema);
  if (!parsed.ok) return parsed.response;
  const res = await store.joinJarByCode(uid, parsed.value.code);
  if (!res) return c.json({ error: "not_found" }, 404);
  return c.json(res);
});

api.get("/jars/:id", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsed = parseRequestValue(c, JarIdSchema, c.req.param("id"));
  if (!parsed.ok) return parsed.response;
  const jarId = parsed.value;
  if (!(await store.isMember(jarId, uid))) return c.json(notFound, 404);
  const detail = await store.getJarDetail(jarId, uid);
  if (!detail) return c.json({ error: "not_found" }, 404);
  return c.json(detail);
});

api.post("/jars/:id/close", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsedId = parseRequestValue(c, JarIdSchema, c.req.param("id"));
  if (!parsedId.ok) return parsedId.response;
  const parsed = await parseRequestJson(c, CloseJarRequestSchema);
  if (!parsed.ok) return parsed.response;
  const result = await store.closeJar(parsedId.value, uid);
  const closeStatus = result.status;
  switch (closeStatus) {
    case "not_found":
    case "not_member":
      return c.json(notFound, 404);
    case "forbidden":
      return c.json({ error: "owner_required" }, 403);
    case "closed":
      break;
    default:
      assertNever(closeStatus);
  }
  const detail = await store.getJarDetail(parsedId.value, uid);
  if (!detail) return c.json({ error: "not_found" }, 404);
  return c.json(detail);
});

api.post("/jars/:id/invite/rotate", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsedId = parseRequestValue(c, JarIdSchema, c.req.param("id"));
  if (!parsedId.ok) return parsedId.response;
  const parsed = await parseRequestJson(c, RotateInviteRequestSchema);
  if (!parsed.ok) return parsed.response;
  let result: Awaited<ReturnType<typeof store.rotateInvite>>;
  try {
    result = await store.rotateInvite(parsedId.value, uid);
  } catch (error) {
    if (error instanceof store.BlockedInteractionError) return c.json(notFound, 404);
    throw error;
  }
  const rotateStatus = result.status;
  switch (rotateStatus) {
    case "not_found":
    case "not_member":
      return c.json(notFound, 404);
    case "forbidden":
      return c.json({ error: "owner_required" }, 403);
    case "jar_closed":
      return c.json(jarClosed, 409);
    case "rotated":
      break;
    default:
      assertNever(rotateStatus);
  }
  const detail = await store.getJarDetail(parsedId.value, uid);
  if (!detail) return c.json(notFound, 404);
  return c.json(detail);
});

api.post("/jars/:id/leave", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsedId = parseRequestValue(c, JarIdSchema, c.req.param("id"));
  if (!parsedId.ok) return parsedId.response;
  const parsed = await parseRequestJson(c, LeaveJarRequestSchema);
  if (!parsed.ok) return parsed.response;
  const result = await store.leaveJar(parsedId.value, uid);
  const leaveStatus = result.status;
  switch (leaveStatus) {
    case "left":
      return c.json({ ok: true } as const);
    case "owner_must_close":
      return c.json({ error: "owner_must_close" }, 409);
    case "jar_closed":
      return c.json(jarClosed, 409);
    case "not_found":
    case "not_member":
      return c.json(notFound, 404);
    default:
      return assertNever(leaveStatus);
  }
});

api.post("/jars/:id/share-streak", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsedId = parseRequestValue(c, JarIdSchema, c.req.param("id"));
  if (!parsedId.ok) return parsedId.response;
  const jarId = parsedId.value;
  if (!(await store.isMember(jarId, uid))) return c.json(notFound, 404);
  const parsed = await parseRequestJson(c, ShareStreakRequestSchema);
  if (!parsed.ok) return parsed.response;
  try {
    await store.setShareStreak(jarId, uid, parsed.value.value);
  } catch (error) {
    if (error instanceof store.JarClosedError) return c.json(jarClosed, 409);
    if (error instanceof store.BlockedInteractionError) return c.json(notFound, 404);
    throw error;
  }
  return c.json({ ok: true });
});

// ─────────────────────────── slips ───────────────────────────
api.post("/jars/:id/slips", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsedId = parseRequestValue(c, JarIdSchema, c.req.param("id"));
  if (!parsedId.ok) return parsedId.response;
  const jarId = parsedId.value;
  if (!(await store.isMember(jarId, uid))) return c.json(notFound, 404);
  const parsed = await parseRequestJson(c, LogSlipRequestSchema);
  if (!parsed.ok) return parsed.response;
  const rejectedReason = rejectedContentReason([parsed.value.note, parsed.value.exLabel]);
  if (rejectedReason) {
    return c.json({ error: "content_not_allowed" as const, reason: rejectedReason }, 400);
  }
  try {
    await store.logSlip({ jarId, userId: uid, ...parsed.value, source: "self" });
  } catch (error) {
    if (error instanceof store.JarClosedError) return c.json(jarClosed, 409);
    if (error instanceof store.BlockedInteractionError) return c.json(notFound, 404);
    throw error;
  }
  return c.json(await store.getJarDetail(jarId, uid));
});

// ─────────────────────────── reports ───────────────────────────
api.post("/jars/:id/reports", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsedId = parseRequestValue(c, JarIdSchema, c.req.param("id"));
  if (!parsedId.ok) return parsedId.response;
  const jarId = parsedId.value;
  if (!(await store.isMember(jarId, uid))) return c.json(notFound, 404);
  const parsed = await parseRequestJson(c, CreateReportRequestSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const rejectedReason = rejectedContentReason([body.note]);
  if (rejectedReason) {
    return c.json({ error: "content_not_allowed" as const, reason: rejectedReason }, 400);
  }
  if (body.accusedId === uid) return c.json({ error: "cannot_report_self" as const }, 400);
  if (!(await store.isMember(jarId, body.accusedId))) return c.json({ error: "bad_target" }, 400);
  const detail = await store.getJarDetail(jarId, uid);
  if (!detail) return c.json({ error: "jar_not_found" }, 404);
  const amount = body.amountCents ?? detail.defaultCents;
  let evidence: SanitizedEvidenceImage[];
  try {
    evidence = (body.evidence ?? []).map(sanitizeEvidenceImage);
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  let report: Awaited<ReturnType<typeof store.createReport>>;
  try {
    report = await store.createReport({
      jarId,
      accuserId: uid,
      accusedId: body.accusedId,
      note: body.note ?? null,
      anonymous: !!body.anonymous,
      amountCents: amount,
      evidence,
    });
  } catch (error) {
    if (error instanceof store.JarClosedError) return c.json(jarClosed, 409);
    if (error instanceof store.BlockedInteractionError) return c.json(notFound, 404);
    throw error;
  }
  return c.json(report);
});

// Abuse reports are a private moderation aggregate, distinct from gameplay
// accountability reports. Only submission has a public route.
api.post("/moderation/reports", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsed = await parseRequestJson(c, CreateAbuseReportRequestSchema);
  if (!parsed.ok) return parsed.response;
  const rejectedReason = rejectedContentReason([parsed.value.narrative]);
  if (rejectedReason) {
    return c.json({ error: "content_not_allowed" as const, reason: rejectedReason }, 400);
  }
  if (parsed.value.targetUserId === uid) return c.json({ error: "cannot_report_self" }, 400);
  try {
    return c.json(await moderationStore().submit(uid, parsed.value), 202);
  } catch (error) {
    if (error instanceof ModerationAuthorizationError) {
      return c.json({ error: "not_found_or_forbidden" }, 404);
    }
    throw error;
  }
});

api.get("/reports/pending", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  return c.json(await store.pendingReportsForUser(uid));
});

api.get("/reports/history", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  return c.json(await store.reportHistoryForUser(uid));
});

api.get("/reports/:id", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsedId = parseRequestValue(c, ReportIdSchema, c.req.param("id"));
  if (!parsedId.ok) return parsedId.response;
  const report = await store.reportForUser(parsedId.value, uid);
  if (!report) return c.json({ error: "not_found_or_forbidden" }, 404);
  return c.json(report);
});

api.post("/reports/:id/resolve", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  const parsedId = parseRequestValue(c, ReportIdSchema, c.req.param("id"));
  if (!parsedId.ok) return parsedId.response;
  const parsed = await parseRequestJson(c, ResolveReportRequestSchema);
  if (!parsed.ok) return parsed.response;
  let res: Awaited<ReturnType<typeof store.resolveReport>>;
  try {
    res = await store.resolveReport(parsedId.value, uid, parsed.value.action);
  } catch (error) {
    if (error instanceof store.JarClosedError) return c.json(jarClosed, 409);
    throw error;
  }
  if (!res) return c.json({ error: "not_found_or_forbidden" }, 404);
  return c.json(res);
});

// ─────────────────────────── activity ───────────────────────────
api.get("/activity", async (c) => {
  const uid = requireUser(c);
  if (!uid) return c.json(unauth, 401);
  return c.json(await store.activityForUser(uid));
});

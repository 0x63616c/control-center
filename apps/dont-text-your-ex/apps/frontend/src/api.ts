import type { z } from "zod";
import {
  ActivitySchema,
  ApiErrorBodySchema,
  type AppleAuthRequest,
  AuthResponseSchema,
  type CreateJarRequest,
  type CreateReportRequest,
  JarDetailSchema,
  type JarId,
  JarPreviewSchema,
  JarSummarySchema,
  JoinJarResponseSchema,
  type LogSlipRequest,
  MeSchema,
  OkResponseSchema,
  type ReportId,
  ReportSchema,
  type SessionToken,
  SessionTokenSchema,
  type UpdateMeRequest,
} from "../../../contracts";

const TOKEN_KEY = "tye_token";

// Web builds use the relative "/api" path (same-origin server). Native shells
// (Capacitor iOS) have no same-origin backend, so they must point at a hosted
// API via VITE_API_BASE at build time. Production iOS builds use the same public
// origin as the web app: "https://dont-text-your-ex.worldwidewebb.co".
const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

export function getToken(): SessionToken | null {
  const parsed = SessionTokenSchema.safeParse(localStorage.getItem(TOKEN_KEY));
  return parsed.success ? parsed.data : null;
}

export function setToken(token: SessionToken | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function responseJson(response: Response, description: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`invalid response for ${description}`);
  }
}

async function req<T>(
  schema: z.ZodType<T>,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const description = `${method} ${path}`;
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = undefined;
    }
    const parsed = ApiErrorBodySchema.safeParse(detail);
    const apiDetail = parsed.success ? parsed.data : undefined;
    const message = apiDetail
      ? [apiDetail.error, apiDetail.message].filter(Boolean).join(": ")
      : res.statusText;
    throw new ApiError(res.status, message || `HTTP ${res.status}`, apiDetail);
  }
  const raw = await responseJson(res, description);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid response for ${description}`);
  return parsed.data;
}

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail?: z.infer<typeof ApiErrorBodySchema>,
  ) {
    super(message);
  }
}

export function isApiErrorStatus(error: unknown, status: number): boolean {
  return error instanceof ApiError && error.status === status;
}

export const api = {
  // auth
  signInWithApple: (input: AppleAuthRequest) =>
    req(AuthResponseSchema, "POST", "/auth/apple", input),
  logout: () => req(OkResponseSchema, "POST", "/auth/logout"),

  // me
  me: () => req(MeSchema, "GET", "/me"),
  updateMe: (patch: UpdateMeRequest) => req(MeSchema, "PATCH", "/me", patch),

  // jars
  jars: () => req(JarSummarySchema.array(), "GET", "/jars"),
  jar: (id: JarId) => req(JarDetailSchema, "GET", `/jars/${id}`),
  createJar: (input: CreateJarRequest) => req(JarSummarySchema, "POST", "/jars", input),
  closeJar: (id: JarId) => req(JarDetailSchema, "POST", `/jars/${id}/close`, { confirmed: true }),
  rotateInvite: (id: JarId) =>
    req(JarDetailSchema, "POST", `/jars/${id}/invite/rotate`, { confirmed: true }),
  leaveJar: (id: JarId) => req(OkResponseSchema, "POST", `/jars/${id}/leave`, { confirmed: true }),
  jarByCode: (code: string) =>
    req(JarPreviewSchema, "GET", `/jars/code/${encodeURIComponent(code)}`),
  joinJar: (code: string) => req(JoinJarResponseSchema, "POST", "/jars/join", { code }),
  setShareStreak: (jarId: JarId, value: boolean) =>
    req(OkResponseSchema, "POST", `/jars/${jarId}/share-streak`, { value }),

  // slips
  logSlip: (jarId: JarId, input: LogSlipRequest) =>
    req(JarDetailSchema, "POST", `/jars/${jarId}/slips`, input),

  // reports
  createReport: (jarId: JarId, input: CreateReportRequest) =>
    req(ReportSchema, "POST", `/jars/${jarId}/reports`, input),
  pendingReports: () => req(ReportSchema.array(), "GET", "/reports/pending"),
  reportHistory: () => req(ReportSchema.array(), "GET", "/reports/history"),
  report: (id: ReportId) => req(ReportSchema, "GET", `/reports/${id}`),
  resolveReport: (id: ReportId, action: "own" | "deny") =>
    req(ReportSchema, "POST", `/reports/${id}/resolve`, { action }),

  // activity
  activity: () => req(ActivitySchema.array(), "GET", "/activity"),
};

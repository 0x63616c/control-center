import type {
  ActivityDTO,
  EvidenceThread,
  JarDetailDTO,
  JarPreviewDTO,
  JarSummaryDTO,
  MeDTO,
  ReportDTO,
} from "./types";

const TOKEN_KEY = "tye_token";

// Web builds use the relative "/api" path (same-origin server). Native shells
// (Capacitor iOS) have no same-origin backend, so they must point at a hosted
// API via VITE_API_BASE at build time, e.g. "https://api.textyourex.app".
const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      /* ignore */
    }
    const apiDetail = detail as { error?: string; message?: string };
    const message = [apiDetail?.error, apiDetail?.message].filter(Boolean).join(": ");
    throw new ApiError(res.status, message || res.statusText, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}

export const api = {
  // auth
  signInWithApple: (input: { identityToken: string; fullName?: string }) =>
    req<{ token: string; user: MeDTO; isNew: boolean }>("POST", "/auth/apple", input),
  logout: () => req<{ ok: boolean }>("POST", "/auth/logout"),

  // me
  me: () => req<MeDTO>("GET", "/me"),
  updateMe: (patch: {
    color?: string;
    emoji?: string | null;
    photo?: string | null;
    exes?: string[];
  }) => req<MeDTO>("PATCH", "/me", patch),

  // jars
  jars: () => req<JarSummaryDTO[]>("GET", "/jars"),
  jar: (id: string) => req<JarDetailDTO>("GET", `/jars/${id}`),
  createJar: (input: { name: string; rule?: string; defaultCents?: number }) =>
    req<JarSummaryDTO>("POST", "/jars", input),
  jarByCode: (code: string) => req<JarPreviewDTO>("GET", `/jars/code/${encodeURIComponent(code)}`),
  joinJar: (code: string) => req<{ jarId: string }>("POST", "/jars/join", { code }),
  setShareStreak: (jarId: string, value: boolean) =>
    req<{ ok: boolean }>("POST", `/jars/${jarId}/share-streak`, { value }),

  // slips
  logSlip: (jarId: string, input: { amountCents: number; note?: string; exLabel?: string }) =>
    req<JarDetailDTO>("POST", `/jars/${jarId}/slips`, input),

  // reports
  createReport: (
    jarId: string,
    input: {
      accusedId: string;
      note?: string;
      anonymous: boolean;
      amountCents?: number;
      evidence?: EvidenceThread[];
    },
  ) => req<ReportDTO>("POST", `/jars/${jarId}/reports`, input),
  pendingReports: () => req<ReportDTO[]>("GET", "/reports/pending"),
  resolveReport: (id: string, action: "own" | "deny") =>
    req<ReportDTO>("POST", `/reports/${id}/resolve`, { action }),

  // activity
  activity: () => req<ActivityDTO[]>("GET", "/activity"),
};

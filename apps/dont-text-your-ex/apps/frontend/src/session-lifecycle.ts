import { api, getToken, isApiErrorStatus, setToken } from "./api";
import type { MeDTO } from "./types";

export type SessionRestoreResult =
  | { readonly status: "signed_out" }
  | { readonly status: "authenticated"; readonly user: MeDTO }
  | { readonly status: "expired" }
  | { readonly status: "retry" };

export async function restoreSession(): Promise<SessionRestoreResult> {
  if (!getToken()) return { status: "signed_out" };
  try {
    return { status: "authenticated", user: await api.me() };
  } catch (error) {
    if (isApiErrorStatus(error, 401)) {
      setToken(null);
      return { status: "expired" };
    }
    return { status: "retry" };
  }
}

export async function revokeCurrentSession(revoke = api.logout): Promise<void> {
  await revoke();
  setToken(null);
}

const PRODUCTION_ORIGIN = "https://dont-text-your-ex.worldwidewebb.co";
const INVITE_CODE = /^[A-Z0-9]{6}$/;

function normalizeInviteCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return INVITE_CODE.test(code) ? code : null;
}

export function canonicalInviteUrl(code: string): string {
  const normalized = normalizeInviteCode(code);
  if (!normalized) throw new Error("invalid invite code");
  return `${PRODUCTION_ORIGIN}/j/${normalized}`;
}

export function inviteCodeFromPath(pathname: string): string | null {
  const match = /^\/j\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return normalizeInviteCode(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

export function inviteCodeFromUniversalLink(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== PRODUCTION_ORIGIN) return null;
    return inviteCodeFromPath(url.pathname);
  } catch {
    return null;
  }
}

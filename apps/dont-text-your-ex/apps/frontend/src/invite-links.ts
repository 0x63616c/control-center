import { type InviteCode, InviteCodeSchema } from "../../../contracts";

const PRODUCTION_ORIGIN = "https://dont-text-your-ex.worldwidewebb.co";

function normalizeInviteCode(value: string): InviteCode | null {
  const parsed = InviteCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function canonicalInviteUrl(code: string): string {
  const normalized = normalizeInviteCode(code);
  if (!normalized) throw new Error("invalid invite code");
  return `${PRODUCTION_ORIGIN}/j/${normalized}`;
}

export function inviteCodeFromPath(pathname: string): InviteCode | null {
  const match = /^\/j\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return normalizeInviteCode(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

export function inviteCodeFromUniversalLink(rawUrl: string): InviteCode | null {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== PRODUCTION_ORIGIN) return null;
    return inviteCodeFromPath(url.pathname);
  } catch {
    return null;
  }
}

type NativeAppLinkSource = {
  getLaunchUrl(): Promise<{ url: string } | undefined>;
  addListener(
    eventName: "appUrlOpen",
    listener: (event: { url: string }) => void,
  ): Promise<{ remove(): Promise<void> }>;
};

export function installNativeInviteLinkListeners(
  nativeApp: NativeAppLinkSource,
  onInvite: (code: InviteCode) => void,
): () => void {
  let disposed = false;
  let handle: { remove(): Promise<void> } | undefined;

  void nativeApp
    .getLaunchUrl()
    .then((launch) => {
      if (disposed || !launch?.url) return;
      const code = inviteCodeFromUniversalLink(launch.url);
      if (code) onInvite(code);
    })
    .catch(() => undefined);

  void nativeApp
    .addListener("appUrlOpen", ({ url }) => {
      if (disposed) return;
      const code = inviteCodeFromUniversalLink(url);
      if (code) onInvite(code);
    })
    .then((listenerHandle) => {
      if (disposed) {
        void listenerHandle.remove();
        return;
      }
      handle = listenerHandle;
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    if (handle) void handle.remove();
  };
}

import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { Icon } from "../icons";
import { canonicalInviteUrl } from "../invite-links";
import { T } from "../theme";
import type { JarDetailDTO } from "../types";
import { Btn, Screen, TopBar } from "../ui";
import { ErrorState, type FetchedState, LoadingState, MutationError } from "./fetched-state";

export type InviteServices = Pick<typeof api, "jar" | "rotateInvite">;

export function Invite({
  ctx,
  services = api,
}: {
  ctx: AppCtx<RouteFor<"invite">>;
  services?: InviteServices;
}) {
  const { fresh = false, jarId } = ctx.route;
  const [state, setState] = useState<FetchedState<JarDetailDTO>>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replaceError, setReplaceError] = useState(false);

  useEffect(() => {
    void retry;
    let alive = true;
    setState({ status: "loading" });
    services
      .jar(jarId)
      .then((d) => {
        if (alive) setState({ status: "loaded", value: d });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [jarId, retry, services]);

  if (state.status === "loading") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="Invite to jar" />
        <LoadingState>Loading invite…</LoadingState>
      </Screen>
    );
  }
  if (state.status === "error") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="Invite unavailable" />
        <ErrorState
          label="This invite couldn’t be loaded."
          onRetry={() => setRetry((value) => value + 1)}
        />
      </Screen>
    );
  }
  if (state.status === "empty") return null;

  const jar = state.value;

  const code = jar.inviteCode;
  const expiresAt = jar.inviteExpiresAt;
  const ready = code != null && (expiresAt == null || expiresAt > Date.now());
  const owner = jar.members.some(
    (member) => member.user.id === ctx.me?.id && member.role === "owner",
  );
  const link = ready ? canonicalInviteUrl(code) : null;
  const shareText = `Join my "${jar.name}" jar on Don’t Text Your Ex. Code: ${code} -> ${link}`;
  const expiryLabel =
    expiresAt == null
      ? "Expiry unavailable"
      : `${expiresAt <= Date.now() ? "Expired" : "Expires"} ${new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(expiresAt)}`;

  const copy = () => {
    if (code == null) return;
    if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const share = async () => {
    // Native share sheet on iOS WKWebView + web; falls back to copy where unsupported.
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: "Don’t Text Your Ex",
          text: shareText,
          url: link ?? undefined,
        });
        return;
      } catch {
        // user dismissed or unsupported, fall through to copy
      }
    }
    copy();
  };

  const replaceInvite = async () => {
    if (replacing) return;
    setReplacing(true);
    setReplaceError(false);
    try {
      const replacement = await services.rotateInvite(jarId);
      setState({ status: "loaded", value: replacement });
      setConfirmingReplace(false);
    } catch {
      setReplaceError(true);
    } finally {
      setReplacing(false);
    }
  };

  if (jar.closedAt != null || code == null) {
    return (
      <Screen style={{ display: "flex", flexDirection: "column", paddingBottom: 44 }}>
        <TopBar onBack={() => ctx.back()} title="Invite unavailable" />
        <div
          role="status"
          style={{ textAlign: "center", color: T.sec, lineHeight: 1.5, padding: "80px 24px" }}
        >
          This jar is closed. Its old invite code has been revoked.
        </div>
        <Btn kind="gold" onClick={() => ctx.nav({ name: "jar", jarId }, true)}>
          View jar history
        </Btn>
      </Screen>
    );
  }

  return (
    <Screen style={{ display: "flex", flexDirection: "column", paddingBottom: 44 }}>
      <TopBar onBack={() => ctx.back()} title="Invite to jar" />
      {fresh && (
        <div
          style={{
            background: "rgba(48,209,88,0.12)",
            border: `1px solid rgba(48,209,88,0.35)`,
            borderRadius: 16,
            padding: "12px 16px",
            marginBottom: 18,
            fontSize: 14,
            color: T.green,
            fontWeight: 600,
          }}
        >
          ✓ Jar created. Now drag your friends down with you.
        </div>
      )}

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: 18,
        }}
      >
        <div
          style={{
            fontSize: 13,
            color: T.sec,
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          Your jar code
        </div>
        <button
          type="button"
          disabled={!ready}
          onClick={copy}
          style={{
            width: "100%",
            background: T.surface,
            border: `1px solid ${T.hair}`,
            borderRadius: 22,
            padding: "28px 16px",
            cursor: ready ? "pointer" : "not-allowed",
            opacity: ready ? 1 : 0.72,
            color: T.text,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
          }}
        >
          <span
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 56,
              color: T.gold,
              letterSpacing: "0.1em",
            }}
          >
            {code}
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              color: copied ? T.green : T.sec,
              fontFamily: T.ui,
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            {copied ? (
              <>
                <Icon.check style={{ width: 16, height: 16 }} /> Copied to clipboard
              </>
            ) : (
              <>
                <Icon.copy /> Tap to copy code
              </>
            )}
          </span>
        </button>
        <p
          style={{
            textAlign: "center",
            fontSize: 13.5,
            color: T.sec,
            lineHeight: 1.45,
            margin: 0,
            maxWidth: 260,
          }}
        >
          {ready
            ? 'Send the code to your friends. They enter it on "Join a jar" to drag themselves down with you.'
            : "This invite has expired. Replace it to share a new link."}
        </p>
        <div role="status" style={{ color: ready ? T.sec : T.red, fontSize: 13, fontWeight: 700 }}>
          {expiryLabel}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
        {owner &&
          (confirmingReplace ? (
            <div role="alert" style={{ background: T.surface, borderRadius: 18, padding: 18 }}>
              <div style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 18 }}>
                Replace this invite?
              </div>
              <p style={{ color: T.sec, lineHeight: 1.45, fontSize: 14 }}>
                The current code and link will stop working immediately. The replacement expires in
                seven days.
              </p>
              {replaceError && (
                <MutationError>
                  The invite wasn’t replaced. The current code still works.
                </MutationError>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <Btn kind="dark" disabled={replacing} onClick={() => setConfirmingReplace(false)}>
                  Cancel
                </Btn>
                <Btn kind="red" disabled={replacing} onClick={replaceInvite}>
                  {replacing
                    ? "Replacing…"
                    : replaceError
                      ? "Retry replacing invite"
                      : "Replace invite now"}
                </Btn>
              </div>
            </div>
          ) : (
            <Btn
              kind="dark"
              onClick={() => {
                setReplaceError(false);
                setConfirmingReplace(true);
              }}
            >
              Replace invite
            </Btn>
          ))}
        <Btn kind="dark" disabled={!ready} onClick={share}>
          Share invite
        </Btn>
        <Btn kind="gold" disabled={!ready} onClick={() => ctx.nav({ name: "jar", jarId }, true)}>
          {fresh ? "Take me to my jar" : "Done"}
        </Btn>
      </div>
    </Screen>
  );
}

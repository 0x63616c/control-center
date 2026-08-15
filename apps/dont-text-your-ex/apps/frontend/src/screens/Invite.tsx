import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { Icon } from "../icons";
import { canonicalInviteUrl } from "../invite-links";
import { T } from "../theme";
import type { JarDetailDTO } from "../types";
import { Btn, Screen, TopBar } from "../ui";
import { ErrorState, type FetchedState, LoadingState } from "./fetched-state";

export type InviteServices = Pick<typeof api, "jar">;

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
  const ready = code != null;
  const link = ready ? canonicalInviteUrl(code) : null;
  const shareText = `Join my "${jar.name}" jar on Don’t Text Your Ex. Code: ${code} -> ${link}`;

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
          onClick={copy}
          style={{
            width: "100%",
            background: T.surface,
            border: `1px solid ${T.hair}`,
            borderRadius: 22,
            padding: "28px 16px",
            cursor: "pointer",
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
          Send the code to your friends. They enter it on "Join a jar" to drag themselves down with
          you.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
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

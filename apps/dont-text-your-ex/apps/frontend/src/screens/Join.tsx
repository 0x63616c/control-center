import { useCallback, useEffect, useState } from "react";
import { api, isApiErrorStatus } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { money, T } from "../theme";
import type { JarPreviewDTO } from "../types";
import { AvatarStack, Btn, Screen, TopBar } from "../ui";
import { inputStyle } from "./common";

export type JoinServices = Pick<typeof api, "jarByCode" | "joinJar">;

function describeJoinError(error: unknown): string {
  if (isApiErrorStatus(error, 403)) return "You don’t have permission to join this jar.";
  if (isApiErrorStatus(error, 409)) return "This jar can’t be joined anymore.";
  if (isApiErrorStatus(error, 404)) return "This invite is no longer valid.";
  return "The jar couldn’t be joined. Check your connection and retry.";
}

function describePreviewError(error: unknown): string {
  if (isApiErrorStatus(error, 404)) return "No active jar has that code. Check it and retry.";
  if (isApiErrorStatus(error, 403)) return "You don’t have permission to view this invite.";
  if (isApiErrorStatus(error, 409)) return "This invite is no longer active.";
  return "The invite couldn’t be loaded. Check your connection and retry.";
}

export function Join({
  ctx,
  services = api,
}: {
  ctx: AppCtx<RouteFor<"join">>;
  services?: JoinServices;
}) {
  const [code, setCode] = useState(ctx.route.code ?? "");
  const [preview, setPreview] = useState<JarPreviewDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadPreview = useCallback(
    async (candidate: string) => {
      setBusy(true);
      setErr(null);
      try {
        const p = await services.jarByCode(candidate);
        setPreview(p);
      } catch (error) {
        setErr(describePreviewError(error));
      } finally {
        setBusy(false);
      }
    },
    [services],
  );

  useEffect(() => {
    if (ctx.route.code) void loadPreview(ctx.route.code);
  }, [ctx.route.code, loadPreview]);

  const doPreview = async () => {
    if (busy) return;
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      setErr("Enter the full six-letter invite code.");
      return;
    }
    await loadPreview(code);
  };

  const join = async () => {
    if (!preview || busy) return;
    setBusy(true);
    try {
      setErr(null);
      const { jarId } = await services.joinJar(code);
      if (window.location.pathname.startsWith("/j/")) {
        window.history.replaceState({}, "", "/");
      }
      ctx.nav({ name: "jar", jarId }, true);
    } catch (error) {
      setErr(describeJoinError(error));
      setBusy(false);
    }
  };

  if (preview) {
    return (
      <Screen>
        <TopBar onBack={() => setPreview(null)} title="Join jar" />
        <div
          style={{
            background: T.surface,
            border: `1px solid ${T.hair}`,
            borderRadius: 26,
            padding: "26px 22px",
            textAlign: "center",
            margin: "8px 0 24px",
          }}
        >
          <div
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 30,
              letterSpacing: "-0.03em",
              marginBottom: 14,
            }}
          >
            {preview.name}
          </div>
          {preview.members.length > 0 && (
            <div
              role="img"
              aria-label={`Members: ${preview.members.map((member) => member.name).join(", ")}`}
              style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}
            >
              <AvatarStack users={preview.members} size={40} />
            </div>
          )}
          <div style={{ fontSize: 14, color: T.sec, lineHeight: 1.4, marginBottom: 18 }}>
            “{preview.rule}”
          </div>
          <div style={{ display: "inline-flex", gap: 18 }}>
            <div>
              <div style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 22 }}>
                {preview.memberCount}
              </div>
              <div style={{ fontSize: 12, color: T.sec }}>members</div>
            </div>
            <div>
              <div style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 22, color: T.gold }}>
                {money(preview.defaultCents)}
              </div>
              <div style={{ fontSize: 12, color: T.sec }}>per slip</div>
            </div>
          </div>
        </div>
        <Btn kind="gold" disabled={busy} onClick={join}>
          {busy ? "Joining…" : err ? "Retry joining jar" : "Join the shame"}
        </Btn>
        {err && (
          <div
            role="alert"
            style={{ color: T.red, fontSize: 14, textAlign: "center", marginTop: 12 }}
          >
            {err}
          </div>
        )}
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="Join a jar" />
      <p style={{ color: T.sec, fontSize: 15, lineHeight: 1.4, margin: "2px 0 18px" }}>
        Got an invite code? Enter it here. <span style={{ color: T.ter }}>(try XEX24K)</span>
      </p>
      <input
        value={code}
        onChange={(e) => {
          setCode(e.target.value.toUpperCase().slice(0, 6));
          setErr(null);
        }}
        placeholder="Invite code"
        style={{ ...inputStyle, textAlign: "center", marginBottom: 14, letterSpacing: "0.1em" }}
      />
      {err && (
        <div
          role="alert"
          style={{
            color: T.red,
            fontFamily: T.ui,
            fontSize: 14,
            textAlign: "center",
            marginBottom: 12,
          }}
        >
          {err}
        </div>
      )}
      <Btn kind="gold" disabled={code.length === 0 || busy} onClick={doPreview}>
        {busy ? "Loading invite…" : err ? "Retry invite" : "Preview jar"}
      </Btn>
    </Screen>
  );
}

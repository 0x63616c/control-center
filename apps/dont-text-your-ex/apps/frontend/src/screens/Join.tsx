import { useCallback, useEffect, useState } from "react";
import { api, isApiErrorStatus } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { money, T } from "../theme";
import type { JarPreviewDTO } from "../types";
import { AvatarStack, Btn, Screen, TopBar } from "../ui";
import { inputStyle } from "./common";

export type JoinServices = Pick<typeof api, "jarByCode" | "joinJar">;

type JoinMutationState =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "failed"; readonly message: string };

type PreviewState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "loaded";
      readonly preview: JarPreviewDTO;
      readonly join: JoinMutationState;
    };

function assertNever(value: never): never {
  throw new Error(`Unexpected join state: ${JSON.stringify(value)}`);
}

function joinButtonLabel(state: JoinMutationState): string {
  switch (state.status) {
    case "idle":
      return "Join the shame";
    case "submitting":
      return "Joining…";
    case "failed":
      return "Retry joining jar";
    default:
      return assertNever(state);
  }
}

function previewButtonLabel(state: PreviewState): string {
  switch (state.status) {
    case "idle":
      return "Preview jar";
    case "loading":
      return "Loading invite…";
    case "failed":
      return "Retry invite";
    case "loaded":
      return "Preview loaded";
    default:
      return assertNever(state);
  }
}

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
  const [state, setState] = useState<PreviewState>({ status: "idle" });

  const loadPreview = useCallback(
    async (candidate: string) => {
      setState({ status: "loading" });
      try {
        const preview = await services.jarByCode(candidate);
        setState({ status: "loaded", preview, join: { status: "idle" } });
      } catch (error) {
        setState({ status: "failed", message: describePreviewError(error) });
      }
    },
    [services],
  );

  useEffect(() => {
    if (ctx.route.code) void loadPreview(ctx.route.code);
  }, [ctx.route.code, loadPreview]);

  const doPreview = async () => {
    if (state.status === "loading") return;
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      setState({ status: "failed", message: "Enter the full six-letter invite code." });
      return;
    }
    await loadPreview(code);
  };

  const join = async () => {
    if (state.status !== "loaded" || state.join.status === "submitting") return;
    const preview = state.preview;
    setState({ status: "loaded", preview, join: { status: "submitting" } });
    try {
      const { jarId } = await services.joinJar(code);
      if (window.location.pathname.startsWith("/j/")) {
        window.history.replaceState({}, "", "/");
      }
      ctx.nav({ name: "jar", jarId }, true);
    } catch (error) {
      setState({
        status: "loaded",
        preview,
        join: { status: "failed", message: describeJoinError(error) },
      });
    }
  };

  if (state.status === "loaded") {
    const { preview, join: joinState } = state;
    return (
      <Screen>
        <TopBar onBack={() => setState({ status: "idle" })} title="Join jar" />
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
        <Btn kind="gold" disabled={joinState.status === "submitting"} onClick={join}>
          {joinButtonLabel(joinState)}
        </Btn>
        {joinState.status === "failed" && (
          <div
            role="alert"
            style={{ color: T.red, fontSize: 14, textAlign: "center", marginTop: 12 }}
          >
            {joinState.message}
          </div>
        )}
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="Join a jar" />
      <p style={{ color: T.sec, fontSize: 15, lineHeight: 1.4, margin: "2px 0 18px" }}>
        Got an invite code? Enter it here.{" "}
        {import.meta.env.DEV && <span style={{ color: T.ter }}>(try XEX24K)</span>}
      </p>
      <input
        value={code}
        onChange={(e) => {
          setCode(e.target.value.toUpperCase().slice(0, 6));
          setState({ status: "idle" });
        }}
        placeholder="Invite code"
        style={{ ...inputStyle, textAlign: "center", marginBottom: 14, letterSpacing: "0.1em" }}
      />
      {state.status === "failed" && (
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
          {state.message}
        </div>
      )}
      <Btn
        kind="gold"
        disabled={code.length === 0 || state.status === "loading"}
        onClick={doPreview}
      >
        {previewButtonLabel(state)}
      </Btn>
    </Screen>
  );
}

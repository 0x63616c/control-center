import { Capacitor } from "@capacitor/core";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { Icon } from "../icons";
import {
  authorizeAppleSignIn,
  createAppleSignInAttempt,
  validateAppleSignInResponse,
} from "../native/appleSignIn";
import { T } from "../theme";
import { DevBadge, PAGE_TOP_PADDING } from "../ui";

const SIGNUP_EYEBROWS = [
  "DO NOT TEXT THEM",
  "EST. AFTER THE BREAKUP",
  "BLOCKED BUT CURIOUS",
  "YOUR FRIENDS WARNED YOU",
  "ONE TEXT FROM A RESET",
] as const;

function describeError(error: unknown): {
  message: string;
} {
  if (error instanceof Error) return { message: error.message };
  if (typeof error === "string" && error.trim() !== "") return { message: error };
  return { message: "unknown error" };
}

function isAppleCancellation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "apple_sign_in_cancelled"
  );
}

export type OnboardingServices = {
  readonly isNativePlatform: typeof Capacitor.isNativePlatform;
  readonly createAppleSignInAttempt: typeof createAppleSignInAttempt;
  readonly authorizeAppleSignIn: typeof authorizeAppleSignIn;
  readonly signInWithApple: typeof api.signInWithApple;
};

const DEFAULT_SERVICES: OnboardingServices = {
  isNativePlatform: Capacitor.isNativePlatform,
  createAppleSignInAttempt,
  authorizeAppleSignIn,
  signInWithApple: api.signInWithApple,
};

type SignInState =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "failed"; readonly message: string };

function assertNever(value: never): never {
  throw new Error(`Unexpected sign-in state: ${JSON.stringify(value)}`);
}

function signInButtonLabel(state: SignInState, sessionExpired: boolean): string {
  switch (state.status) {
    case "idle":
      return sessionExpired ? "Continue with Apple" : "Sign in with Apple";
    case "submitting":
      return "Signing in…";
    case "failed":
      return "Try Sign in with Apple again";
    default:
      return assertNever(state);
  }
}

export function Onboarding({
  ctx,
  services = DEFAULT_SERVICES,
}: {
  ctx: AppCtx<RouteFor<"onboarding">>;
  services?: OnboardingServices;
}) {
  const [signInState, setSignInState] = useState<SignInState>({ status: "idle" });
  const [eyebrowIndex, setEyebrowIndex] = useState(0);
  const titleLines = ctx.sessionExpired
    ? ["Still", "Texting", "Them?"]
    : ["Don't", "Text", "Your Ex."];

  useEffect(() => {
    const id = window.setInterval(() => {
      setEyebrowIndex((current) => (current + 1) % SIGNUP_EYEBROWS.length);
    }, 7500);
    return () => window.clearInterval(id);
  }, []);

  const signInApple = async () => {
    if (signInState.status === "submitting") return;
    setSignInState({ status: "submitting" });
    try {
      // Real "Sign in with Apple" only works inside the native iOS app (the Apple
      // sheet can't run in a browser). On web the button is inert; local dev and
      // e2e mint a session through the non-production /auth/dev seam instead.
      if (!services.isNativePlatform()) {
        setSignInState({ status: "idle" });
        return;
      }
      let identityToken: string;
      let authorizationCode: string;
      let nonce: string;
      let fullName: string | undefined;
      try {
        const attempt = await services.createAppleSignInAttempt();
        const response = validateAppleSignInResponse(
          attempt.request,
          await services.authorizeAppleSignIn(attempt.request),
        );
        identityToken = response.identityToken;
        authorizationCode = response.authorizationCode;
        nonce = attempt.rawNonce;
        fullName = response.fullName;
      } catch (e) {
        console.error("[tye] signInApple native error", e);
        setSignInState(
          isAppleCancellation(e)
            ? { status: "idle" }
            : {
                status: "failed",
                message: "Apple sign-in didn’t finish. Check your connection and try again.",
              },
        );
        return;
      }
      try {
        const { token, user, status } = await services.signInWithApple({
          identityToken,
          authorizationCode,
          nonce,
          fullName,
        });
        ctx.signIn(token, user);
        if (status === "needs_profile") ctx.nav({ name: "setup" });
      } catch (e) {
        console.error("[tye] signInApple API error", e);
        setSignInState({
          status: "failed",
          message: "Apple sign-in could not be verified. Please try again.",
        });
      }
    } catch (e) {
      const { message } = describeError(e);
      console.error("[tye] signInApple unexpected error", e);
      setSignInState({ status: "failed", message });
    }
  };

  return (
    <div
      style={{
        flex: 1,
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        background: T.bg,
        color: T.text,
        fontFamily: T.ui,
        display: "flex",
        flexDirection: "column",
        padding: `0 28px ${PAGE_TOP_PADDING}px`,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          paddingTop: PAGE_TOP_PADDING,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 13,
              background: T.gold,
              color: "#000",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 26,
              transform: "rotate(-6deg)",
              flexShrink: 0,
            }}
          >
            ♡
          </div>
          <span
            style={{
              position: "relative",
              display: "grid",
              width: "100%",
              minHeight: 18,
              overflow: "hidden",
              flexShrink: 1,
              minWidth: 0,
            }}
          >
            {SIGNUP_EYEBROWS.map((label) => (
              <span
                key={label}
                aria-hidden
                style={{
                  gridArea: "1 / 1",
                  visibility: "hidden",
                  whiteSpace: "nowrap",
                  fontFamily: T.ui,
                  fontWeight: 700,
                  fontSize: 15,
                  letterSpacing: "0.04em",
                }}
              >
                {label}
              </span>
            ))}
            <span
              key={SIGNUP_EYEBROWS[eyebrowIndex]}
              style={{
                gridArea: "1 / 1",
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                animation: "tye-eyebrow-in 520ms cubic-bezier(.2,.8,.2,1) both",
                whiteSpace: "nowrap",
                fontFamily: T.ui,
                fontWeight: 700,
                fontSize: 15,
                color: T.sec,
                letterSpacing: "0.04em",
              }}
            >
              {SIGNUP_EYEBROWS[eyebrowIndex]}
            </span>
          </span>
        </div>
        <DevBadge />
      </div>
      {signInState.status === "failed" && (
        <div
          style={{
            marginTop: 14,
            border: "1px solid rgba(255,69,58,0.35)",
            background: "rgba(255,69,58,0.12)",
            borderRadius: 16,
            padding: 12,
            flexShrink: 0,
          }}
        >
          <p
            style={{
              fontSize: 13,
              color: T.red,
              margin: 0,
              lineHeight: 1.35,
              wordBreak: "break-word",
              fontWeight: 700,
            }}
          >
            {signInState.message}
          </p>
        </div>
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        <h1
          style={{
            fontFamily: T.disp,
            fontWeight: 800,
            fontSize: 58,
            lineHeight: 0.92,
            letterSpacing: "-0.045em",
            margin: 0,
            width: "100%",
          }}
        >
          {titleLines.map((line, index) => (
            <span key={line}>
              {line === "Your Ex." ? (
                <>
                  Your <span style={{ color: T.gold }}>Ex.</span>
                </>
              ) : line === "Them?" ? (
                <span style={{ color: T.gold }}>Them?</span>
              ) : (
                line
              )}
              {index < titleLines.length - 1 && <br />}
            </span>
          ))}
        </h1>
        <p
          style={{
            fontFamily: T.disp,
            fontWeight: 700,
            fontSize: 23,
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
            margin: "26px 0 10px",
            width: "100%",
          }}
        >
          {ctx.sessionExpired ? (
            <>
              Your local session expired.
              <br />
              Continue with Apple to get back in.
            </>
          ) : (
            <>
              Stop texting your ex.
              <br />
              If you do, <span style={{ color: T.gold }}>log it and start again.</span>
            </>
          )}
        </p>
        <p style={{ width: "100%", fontSize: 16, color: T.sec, lineHeight: 1.45, margin: 0 }}>
          {ctx.sessionExpired
            ? "We cleared the stale device token because the server no longer recognized it."
            : "An invite-only accountability jar for you and friends who want to help."}
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
        <p style={{ color: T.sec, fontSize: 14, lineHeight: 1.45, margin: 0, textAlign: "center" }}>
          Don’t Text Your Ex does not read your messages. Jar activity is shared only with invited
          jar members.
        </p>
        <button
          type="button"
          onClick={signInApple}
          disabled={signInState.status === "submitting"}
          style={{
            width: "100%",
            height: 56,
            borderRadius: 16,
            background: "#fff",
            color: "#000",
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
            fontFamily: T.ui,
            fontWeight: 700,
            fontSize: 18,
            opacity: signInState.status === "submitting" ? 0.6 : 1,
          }}
        >
          <Icon.apple style={{ marginTop: -2 }} />{" "}
          {signInButtonLabel(signInState, ctx.sessionExpired)}
        </button>
      </div>
    </div>
  );
}

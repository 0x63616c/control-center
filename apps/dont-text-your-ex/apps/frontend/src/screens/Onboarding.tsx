import { Capacitor } from "@capacitor/core";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx } from "../appctx";
import { Icon } from "../icons";
import { authorizeAppleSignIn, createAppleSignInRequest } from "../native/appleSignIn";
import { T } from "../theme";
import { DevBadge, PAGE_TOP_PADDING } from "../ui";

const SIGNUP_EYEBROWS = [
  "DO NOT TEXT THEM",
  "EST. AFTER THE BREAKUP",
  "BLOCKED BUT CURIOUS",
  "YOUR FRIENDS WARNED YOU",
  "ONE TEXT FROM A FINE",
] as const;

function describeError(error: unknown): {
  message: string;
} {
  const message = (error as { message?: string })?.message ?? "unknown error";
  return { message };
}

export function Onboarding({ ctx }: { ctx: AppCtx }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
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
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      // Real "Sign in with Apple" only works inside the native iOS app (the Apple
      // sheet can't run in a browser). On web the button is inert; local dev and
      // e2e mint a session through the non-production /auth/dev seam instead.
      if (!Capacitor.isNativePlatform()) {
        setBusy(false);
        return;
      }
      let identityToken: string;
      let fullName: string | undefined;
      try {
        const request = createAppleSignInRequest();
        const response = await authorizeAppleSignIn(request);
        identityToken = response.identityToken;
        fullName = response.fullName;
      } catch (e) {
        console.error("[tye] signInApple native error", e);
        setBusy(false);
        return;
      }
      try {
        const { token, user, isNew } = await api.signInWithApple({ identityToken, fullName });
        ctx.signIn(token, user);
        if (isNew) ctx.nav("setup", {});
      } catch (e) {
        console.error("[tye] signInApple API error", e);
        setErr("Apple sign-in could not be verified. Please try again.");
        setBusy(false);
      }
    } catch (e) {
      const { message } = describeError(e);
      console.error("[tye] signInApple unexpected error", e);
      setErr(message);
      setBusy(false);
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
            $
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
      {err && (
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
            {err}
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
              Or don't, but <span style={{ color: T.gold }}>pay up.</span>
            </>
          )}
        </p>
        <p style={{ width: "100%", fontSize: 16, color: T.sec, lineHeight: 1.45, margin: 0 }}>
          {ctx.sessionExpired
            ? "We cleared the stale device token because the server no longer recognized it."
            : "A shared guilt jar for you and the friends who already know who you shouldn't be texting."}
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, flexShrink: 0 }}>
        <button
          type="button"
          onClick={signInApple}
          disabled={busy}
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
            opacity: busy ? 0.6 : 1,
          }}
        >
          <Icon.apple style={{ marginTop: -2 }} />{" "}
          {ctx.sessionExpired ? "Continue with Apple" : "Sign in with Apple"}
        </button>
      </div>
    </div>
  );
}

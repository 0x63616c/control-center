import { Capacitor } from "@capacitor/core";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { Toggle } from "../bits";
import { Icon } from "../icons";
import { getNativeAppInfo } from "../native/appInfo";
import {
  authorizeAppleSignIn,
  createAppleSignInAttempt,
  validateAppleSignInResponse,
} from "../native/appleSignIn";
import { formatPoints, NO_MONEY_DISCLOSURE, T } from "../theme";
import type { JarSummaryDTO } from "../types";
import { Avatar, DevBadge, Screen, TopBar } from "../ui";

export type ProfileServices = Pick<typeof api, "jars" | "setShareStreak"> & {
  readonly getNativeAppInfo: typeof getNativeAppInfo;
  readonly isNativePlatform: typeof Capacitor.isNativePlatform;
  readonly createAppleSignInAttempt: typeof createAppleSignInAttempt;
  readonly authorizeAppleSignIn: typeof authorizeAppleSignIn;
};

const DEFAULT_SERVICES: ProfileServices = {
  jars: api.jars,
  setShareStreak: api.setShareStreak,
  getNativeAppInfo,
  isNativePlatform: Capacitor.isNativePlatform,
  createAppleSignInAttempt,
  authorizeAppleSignIn,
};

type SignOutState =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "failed" };

type DeleteState =
  | { readonly status: "idle" }
  | { readonly status: "confirming"; readonly confirmed: boolean }
  | { readonly status: "submitting" }
  | { readonly status: "failed"; readonly confirmed: boolean; readonly message: string };

function assertNever(value: never): never {
  throw new Error(`Unexpected sign-out state: ${JSON.stringify(value)}`);
}

function signOutButtonLabel(state: SignOutState): string {
  switch (state.status) {
    case "idle":
      return "Sign out";
    case "submitting":
      return "Signing out…";
    case "failed":
      return "Try signing out again";
    default:
      return assertNever(state);
  }
}

export function Profile({
  ctx,
  services = DEFAULT_SERVICES,
}: {
  ctx: AppCtx<RouteFor<"profile">>;
  services?: ProfileServices;
}) {
  const me = ctx.me;
  const [jars, setJars] = useState<JarSummaryDTO[]>([]);
  const [shares, setShares] = useState<Record<string, boolean>>({});
  const [appVersion, setAppVersion] = useState("v1.0");
  const [signOutState, setSignOutState] = useState<SignOutState>({ status: "idle" });
  const [deleteState, setDeleteState] = useState<DeleteState>({ status: "idle" });

  const meId = me?.id;
  useEffect(() => {
    if (!meId) return;
    let alive = true;
    services
      .jars()
      .then((js) => {
        if (!alive) return;
        setJars(js);
        const map: Record<string, boolean> = {};
        for (const j of js) map[j.id] = j.myShareStreak;
        setShares(map);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [meId, services]);

  useEffect(() => {
    let alive = true;
    services
      .getNativeAppInfo()
      .then((info) => {
        if (!alive || !info) return;
        const build = info.build ? ` (${info.build})` : "";
        setAppVersion(`v${info.version}${build}`);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [services]);

  const totalTally = jars.reduce((s, j) => s + j.myTallyCents, 0);
  const bestStreak = jars.reduce((m, j) => Math.max(m, j.myDaysClean), 0);

  const toggleShare = async (jarId: JarSummaryDTO["id"], v: boolean) => {
    setShares((s) => ({ ...s, [jarId]: v }));
    try {
      await services.setShareStreak(jarId, v);
    } catch {
      setShares((s) => ({ ...s, [jarId]: !v }));
    }
  };

  const signOut = async () => {
    if (signOutState.status === "submitting") return;
    setSignOutState({ status: "submitting" });
    try {
      await ctx.signOut();
    } catch {
      setSignOutState({ status: "failed" });
    }
  };

  const deleteAccount = async () => {
    if (
      (deleteState.status !== "confirming" && deleteState.status !== "failed") ||
      !deleteState.confirmed
    )
      return;
    setDeleteState({ status: "submitting" });
    try {
      let reauthentication:
        | { authorizationCode: string; identityToken: string; nonce: string }
        | undefined;
      if (services.isNativePlatform()) {
        const attempt = await services.createAppleSignInAttempt();
        const response = validateAppleSignInResponse(
          attempt.request,
          await services.authorizeAppleSignIn(attempt.request),
        );
        reauthentication = {
          authorizationCode: response.authorizationCode,
          identityToken: response.identityToken,
          nonce: attempt.rawNonce,
        };
      }
      await ctx.deleteAccount(reauthentication);
    } catch (error) {
      setDeleteState({
        status: "failed",
        confirmed: true,
        message: error instanceof Error ? error.message : "Account deletion could not be started",
      });
    }
  };

  if (!me) return null;

  return (
    <Screen>
      <TopBar title="Profile" trailing={<DevBadge />} />

      <button
        type="button"
        onClick={() => ctx.nav({ name: "editProfile" })}
        style={{
          width: "100%",
          textAlign: "left",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: T.text,
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 26,
          padding: 0,
        }}
      >
        <Avatar user={me} size={68} />
        <div style={{ flex: 1 }}>
          <div
            style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 26, letterSpacing: "-0.02em" }}
          >
            {me.name || "You"}
          </div>
          <div style={{ fontSize: 13.5, color: T.sec, marginTop: 2 }}>
            {bestStreak} days no-contact · {formatPoints(totalTally)} virtual tally
          </div>
        </div>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            color: T.gold,
            fontFamily: T.ui,
            fontWeight: 700,
            fontSize: 14,
          }}
        >
          Edit <Icon.chev style={{ width: 7, height: 12 }} />
        </span>
      </button>

      <div
        style={{
          fontSize: 12,
          color: T.sec,
          fontWeight: 600,
          margin: "0 4px 10px",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        Share my no-contact streak
      </div>
      <div
        style={{
          background: T.surface,
          border: `1px solid ${T.hair}`,
          borderRadius: 18,
          overflow: "hidden",
          marginBottom: 26,
        }}
      >
        {jars.map((j, i) => (
          <div
            key={j.id}
            data-testid="share-row"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "14px 16px",
              borderTop: i ? `1px solid ${T.hair2}` : "none",
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15.5, fontWeight: 600 }}>{j.name}</div>
              <div style={{ fontSize: 12.5, color: T.sec, marginTop: 1 }}>
                {shares[j.id] ? "Jar members see your streak" : "Hidden — members see “—”"}
              </div>
            </div>
            <Toggle
              label={`Share streak for ${j.name}`}
              on={!!shares[j.id]}
              onChange={(v) => toggleShare(j.id, v)}
            />
          </div>
        ))}
        {jars.length === 0 && (
          <div style={{ padding: "14px 16px", color: T.ter, fontSize: 14 }}>Join a jar first.</div>
        )}
      </div>
      <p style={{ textAlign: "center", fontSize: 14, color: T.sec, lineHeight: 1.45 }}>
        Virtual tallies only. {NO_MONEY_DISCLOSURE}
      </p>

      <button
        type="button"
        onClick={() => ctx.nav({ name: "notificationSettings" })}
        style={{
          width: "100%",
          minHeight: 54,
          marginBottom: 26,
          padding: "0 16px",
          borderRadius: 16,
          background: T.surface,
          border: `1px solid ${T.hair}`,
          color: T.text,
          display: "flex",
          alignItems: "center",
          textAlign: "left",
        }}
      >
        <Icon.bell style={{ width: 20, height: 20, color: T.gold, marginRight: 12 }} />
        <span style={{ flex: 1, fontSize: 16, fontWeight: 650 }}>Notifications</span>
        <Icon.chev style={{ width: 7, height: 12, color: T.ter }} />
      </button>

      <button
        type="button"
        onClick={signOut}
        disabled={signOutState.status === "submitting"}
        style={{
          width: "100%",
          height: 54,
          borderRadius: 16,
          background: T.surface2,
          border: `1px solid ${T.hair}`,
          color: T.red,
          fontFamily: T.disp,
          fontWeight: 700,
          fontSize: 17,
          cursor: signOutState.status === "submitting" ? "wait" : "pointer",
          opacity: signOutState.status === "submitting" ? 0.7 : 1,
        }}
      >
        {signOutButtonLabel(signOutState)}
      </button>
      {signOutState.status === "failed" && (
        <p
          role="alert"
          style={{ textAlign: "center", fontSize: 13, color: T.red, margin: "10px 0 0" }}
        >
          Couldn’t sign out. You’re still signed in. Check your connection and try again.
        </p>
      )}

      {deleteState.status === "idle" ? (
        <button
          type="button"
          onClick={() => setDeleteState({ status: "confirming", confirmed: false })}
          style={{
            width: "100%",
            marginTop: 16,
            padding: 12,
            border: "none",
            background: "transparent",
            color: T.red,
            fontSize: 14,
            fontWeight: 650,
            cursor: "pointer",
          }}
        >
          Delete account
        </button>
      ) : (
        <section
          aria-label="Delete account permanently"
          style={{
            marginTop: 16,
            padding: 16,
            border: `1px solid ${T.red}66`,
            borderRadius: 16,
            background: T.surface,
          }}
        >
          <h2 style={{ margin: 0, color: T.red, fontFamily: T.disp, fontSize: 19 }}>
            Delete account permanently?
          </h2>
          <p style={{ color: T.sec, fontSize: 13.5, lineHeight: 1.5 }}>
            This permanently deletes your profile, memberships, private labels, slips, reports,
            evidence, activity, notifications, and sessions. A shared jar stays with its earliest
            active member and is renamed; a jar with no other active member is deleted. This can’t
            be undone.
          </p>
          <p style={{ color: T.sec, fontSize: 13.5, lineHeight: 1.5 }}>
            Deletion starts immediately even if Apple is unavailable. We’ll ask you to confirm with
            Apple so we can revoke access. If automatic revocation isn’t possible, remove Don’t Text
            Your Ex under your Apple Account’s “Sign in with Apple” settings.
          </p>
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              color: T.text,
              fontSize: 14,
              lineHeight: 1.4,
            }}
          >
            <input
              type="checkbox"
              checked={deleteState.status !== "submitting" && deleteState.confirmed}
              disabled={deleteState.status === "submitting"}
              onChange={(event) =>
                setDeleteState({ status: "confirming", confirmed: event.currentTarget.checked })
              }
            />
            I understand this account and its private data cannot be recovered.
          </label>
          <button
            type="button"
            onClick={deleteAccount}
            disabled={
              deleteState.status === "submitting" ||
              (deleteState.status !== "confirming" && deleteState.status !== "failed") ||
              !deleteState.confirmed
            }
            style={{
              width: "100%",
              minHeight: 48,
              marginTop: 14,
              borderRadius: 14,
              border: "none",
              background: T.red,
              color: "white",
              fontWeight: 750,
              opacity:
                deleteState.status === "submitting" ||
                (deleteState.status !== "confirming" && deleteState.status !== "failed") ||
                !deleteState.confirmed
                  ? 0.55
                  : 1,
            }}
          >
            {deleteState.status === "submitting"
              ? "Deleting account…"
              : "Delete my account permanently"}
          </button>
          {deleteState.status === "failed" && (
            <p role="alert" style={{ color: T.red, fontSize: 13, lineHeight: 1.4 }}>
              Couldn’t start deletion. Your account is still active. {deleteState.message}
            </p>
          )}
          <button
            type="button"
            disabled={deleteState.status === "submitting"}
            onClick={() => {
              setDeleteState({ status: "idle" });
            }}
            style={{
              width: "100%",
              marginTop: 8,
              padding: 10,
              border: "none",
              background: "transparent",
              color: T.sec,
            }}
          >
            Keep my account
          </button>
        </section>
      )}
      <p
        style={{ textAlign: "center", fontSize: 13, color: T.sec, lineHeight: 1.4, marginTop: 16 }}
      >
        Don’t Text Your Ex · {appVersion} · supportive accountability with friends
      </p>
    </Screen>
  );
}

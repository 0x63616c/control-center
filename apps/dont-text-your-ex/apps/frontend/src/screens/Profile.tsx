import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { Toggle } from "../bits";
import { Icon } from "../icons";
import { getNativeAppInfo } from "../native/appInfo";
import { money, T } from "../theme";
import type { JarSummaryDTO } from "../types";
import { Avatar, DevBadge, Screen, TopBar } from "../ui";

export type ProfileServices = Pick<typeof api, "jars" | "setShareStreak"> & {
  readonly getNativeAppInfo: typeof getNativeAppInfo;
};

const DEFAULT_SERVICES: ProfileServices = {
  jars: api.jars,
  setShareStreak: api.setShareStreak,
  getNativeAppInfo,
};

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
  const [signingOut, setSigningOut] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

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

  const totalDamage = jars.reduce((s, j) => s + j.myTallyCents, 0);
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
    setSigningOut(true);
    setSignOutFailed(false);
    try {
      await ctx.signOut();
    } catch {
      setSignOutFailed(true);
      setSigningOut(false);
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
            {bestStreak} days clean · {money(totalDamage)} in the hole
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
        Share my clean streak
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
                {shares[j.id] ? "Friends see your streak" : "Hidden - others see “-”"}
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

      <button
        type="button"
        onClick={signOut}
        disabled={signingOut}
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
          cursor: signingOut ? "wait" : "pointer",
          opacity: signingOut ? 0.7 : 1,
        }}
      >
        {signingOut ? "Signing out…" : signOutFailed ? "Try signing out again" : "Sign out"}
      </button>
      {signOutFailed && (
        <p
          role="alert"
          style={{ textAlign: "center", fontSize: 13, color: T.red, margin: "10px 0 0" }}
        >
          Couldn’t sign out. You’re still signed in. Check your connection and try again.
        </p>
      )}
      <p style={{ textAlign: "center", fontSize: 12, color: T.ter, marginTop: 16 }}>
        Don’t Text Your Ex · {appVersion} · made for people with poor impulse control
      </p>
    </Screen>
  );
}

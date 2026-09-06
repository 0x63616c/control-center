import { App as NativeApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useState } from "react";
import {
  type DeleteAccountRequest,
  JarIdSchema,
  ReportIdSchema,
  type SessionToken,
} from "../../../contracts";
import { api, setToken } from "./api";
import type { AppCtx, Route, TabName } from "./appctx";
import { SupportBurst } from "./bits";
import { resolveDevice } from "./device";
import { Icon } from "./icons";
import { installNativeInviteLinkListeners, inviteCodeFromPath } from "./invite-links";
import { IOSDevice } from "./iosframe";
import { getNativeAppInfo } from "./native/appInfo";
import {
  disableCurrentPush,
  installNotificationActionListener,
  refreshEnabledPush,
} from "./native/push";
import * as S from "./screens";
import { restoreSession, revokeCurrentSession } from "./session-lifecycle";
import { T } from "./theme";
import { refreshStoredTimeZone } from "./timezone";
import type { MeDTO } from "./types";

const DEVICE = resolveDevice();
// On a real device (Capacitor) the OS already provides the bezel, status bar and
// home indicator, so we render full-bleed and skip the simulated iPhone frame
// that's used for the web preview - otherwise it's a phone-inside-a-phone.
const NATIVE = Capacitor.isNativePlatform();

const TABS: { id: TabName; label: string; icon: (typeof Icon)[keyof typeof Icon] }[] = [
  { id: "home", label: "Jars", icon: Icon.jars },
  { id: "activity", label: "Activity", icon: Icon.bell },
  { id: "profile", label: "You", icon: Icon.user },
];

function TabBar({
  active,
  onTab,
  badge,
}: {
  active: TabName;
  onTab: (t: TabName) => void;
  badge: boolean;
}) {
  return (
    <div
      style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 40,
        paddingBottom: 26,
        paddingTop: 10,
        display: "flex",
        justifyContent: "space-around",
        background: "linear-gradient(to top, #000 62%, rgba(0,0,0,0))",
      }}
    >
      {TABS.map((t) => {
        const on = active === t.id;
        const I = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            data-testid={`tab-${t.id}`}
            onClick={() => onTab(t.id)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              position: "relative",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              color: on ? T.gold : T.ter,
              padding: "4px 18px",
            }}
          >
            <I style={{ width: 25, height: 25 }} />
            <span style={{ fontFamily: T.ui, fontSize: 10.5, fontWeight: 700 }}>{t.label}</span>
            {t.id === "activity" && badge && (
              <span
                style={{
                  position: "absolute",
                  top: 0,
                  right: 12,
                  width: 9,
                  height: 9,
                  borderRadius: "50%",
                  background: T.red,
                  boxShadow: "0 0 0 2px #000",
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

type ScrollMode = "auto" | "hidden";

type RestoreState =
  | { readonly status: "loading" }
  | { readonly status: "ready" }
  | { readonly status: "failed" };

function assertNever(value: never): never {
  throw new Error(`Unhandled state: ${JSON.stringify(value)}`);
}

function routeForTab(tab: TabName): Route {
  return { name: tab };
}

function renderRoute(ctx: AppCtx): React.ReactNode {
  switch (ctx.route.name) {
    case "onboarding":
      return <S.Onboarding ctx={{ ...ctx, route: ctx.route }} />;
    case "home":
      return <S.Home ctx={{ ...ctx, route: ctx.route }} />;
    case "rescue":
      return <S.Rescue ctx={{ ...ctx, route: ctx.route }} />;
    case "jar":
      return <S.JarDetail ctx={{ ...ctx, route: ctx.route }} />;
    case "logSlip":
      return <S.LogSlip ctx={{ ...ctx, route: ctx.route }} />;
    case "report":
      return <S.ReportMember ctx={{ ...ctx, route: ctx.route }} />;
    case "confirmDeny":
      return <S.ConfirmDeny ctx={{ ...ctx, route: ctx.route }} />;
    case "reportHistory":
      return <S.ReportHistory ctx={{ ...ctx, route: ctx.route }} />;
    case "reportDetail":
      return <S.ReportDetail ctx={{ ...ctx, route: ctx.route }} />;
    case "aboutTally":
      return <S.AboutTally ctx={{ ...ctx, route: ctx.route }} />;
    case "create":
      return <S.Create ctx={{ ...ctx, route: ctx.route }} />;
    case "join":
      return <S.Join ctx={{ ...ctx, route: ctx.route }} />;
    case "invite":
      return <S.Invite ctx={{ ...ctx, route: ctx.route }} />;
    case "activity":
      return <S.ActivityTab ctx={{ ...ctx, route: ctx.route }} />;
    case "profile":
      return <S.Profile ctx={{ ...ctx, route: ctx.route }} />;
    case "notificationSettings":
      return <S.NotificationSettings ctx={{ ...ctx, route: ctx.route }} />;
    case "setup":
      return <S.SetupProfile ctx={{ ...ctx, route: ctx.route }} />;
    case "editProfile":
      return <S.EditProfile ctx={{ ...ctx, route: ctx.route }} />;
    default:
      return assertNever(ctx.route);
  }
}

function useFit() {
  const [scale, setScale] = useState(1);
  const [compactWeb, setCompactWeb] = useState(false);
  useEffect(() => {
    const updateScale = () => {
      const { w: W, h: H } = DEVICE;
      setScale(Math.min(window.innerWidth / (W + 24), window.innerHeight / (H + 24), 1));
      setCompactWeb(window.innerWidth < W + 24);
    };
    updateScale();
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, []);
  return { compactWeb, scale };
}

export default function App() {
  const [restoreState, setRestoreState] = useState<RestoreState>({ status: "loading" });
  const [me, setMeState] = useState<MeDTO | null>(null);
  const [tab, setTabState] = useState<TabName>("onboarding");
  const [stack, setStack] = useState<Route[]>([]);
  const [burst, setBurst] = useState(false);
  const [hasPendingReport, setHasPendingReport] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [pendingInviteCode, setPendingInviteCode] = useState<string | null>(() =>
    inviteCodeFromPath(window.location.pathname),
  );
  const { compactWeb, scale } = useFit();

  useEffect(() => {
    const readWebPath = () => {
      const code = inviteCodeFromPath(window.location.pathname);
      if (!code) return;
      setPendingInviteCode(code);
      window.history.replaceState({}, "", "/");
    };
    window.addEventListener("popstate", readWebPath);
    readWebPath();

    let removeNativeListeners: (() => void) | undefined;
    if (NATIVE) {
      removeNativeListeners = installNativeInviteLinkListeners(NativeApp, setPendingInviteCode);
    }

    return () => {
      window.removeEventListener("popstate", readWebPath);
      removeNativeListeners?.();
    };
  }, []);

  const refreshPending = useCallback(() => {
    api
      .pendingReports()
      .then((r) => setHasPendingReport(r.length > 0))
      .catch(() => {});
  }, []);

  const restoreAuth = useCallback(async () => {
    setRestoreState({ status: "loading" });
    const result = await restoreSession();
    switch (result.status) {
      case "signed_out":
        setRestoreState({ status: "ready" });
        break;
      case "authenticated":
        setMeState(result.user);
        setTabState("home");
        // A user with no name yet (Apple declined to share / first run) must
        // complete profile setup before using the app.
        if (!result.user.name.trim()) setStack([{ name: "setup" }]);
        refreshPending();
        setRestoreState({ status: "ready" });
        break;
      case "expired":
        setSessionExpired(true);
        setRestoreState({ status: "ready" });
        break;
      case "retry":
        setRestoreState({ status: "failed" });
        break;
      default:
        assertNever(result);
    }
  }, [refreshPending]);

  // boot: restore session if a token exists
  useEffect(() => {
    void restoreAuth();
  }, [restoreAuth]);

  useEffect(() => {
    if (restoreState.status !== "ready" || !me?.name?.trim() || !pendingInviteCode) return;
    setTabState("home");
    setStack([{ name: "join", code: pendingInviteCode }]);
    setPendingInviteCode(null);
  }, [restoreState.status, me, pendingInviteCode]);

  const nav = useCallback((route: Route, replaceRoot = false) => {
    setStack((stack) => (replaceRoot ? [route] : [...stack, route]));
  }, []);
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const goTab = useCallback((t: TabName) => {
    setTabState(t);
    setStack([]);
  }, []);

  useEffect(() => {
    if (!NATIVE || !me) return;
    const appInfo = async () => {
      const info = await getNativeAppInfo();
      if (!info) throw new Error("native app info unavailable");
      return info;
    };
    void refreshEnabledPush(api.registerPushDevice, appInfo);
    let disposed = false;
    let removeActionListener: (() => Promise<void>) | undefined;
    void installNotificationActionListener((notificationId) => {
      void api.notificationTarget(notificationId).then(
        (target) => {
          switch (target.type) {
            case "activity":
              goTab("activity");
              break;
            case "profile":
              goTab("profile");
              break;
            case "jar":
              nav({ name: "jar", jarId: JarIdSchema.parse(target.jarId) }, true);
              break;
            case "report":
              nav({ name: "reportDetail", reportId: ReportIdSchema.parse(target.reportId) }, true);
              break;
            case "unavailable":
              goTab("activity");
              break;
          }
        },
        () => goTab("activity"),
      );
    }).then((remove) => {
      if (disposed) {
        void remove();
      } else {
        removeActionListener = remove;
      }
    });
    return () => {
      disposed = true;
      void removeActionListener?.();
    };
  }, [goTab, me, nav]);

  useEffect(() => {
    if (!me) return;
    const refresh = () => {
      if (document.visibilityState === "visible") {
        void refreshStoredTimeZone(api.updateTimeZone).catch(() => undefined);
      }
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [me]);

  const signIn = useCallback((token: SessionToken, user: MeDTO) => {
    setToken(token);
    setMeState(user);
    setSessionExpired(false);
    setStack([]);
    setTabState("home");
    api
      .pendingReports()
      .then((r) => setHasPendingReport(r.length > 0))
      .catch(() => {});
  }, []);

  const signOut = useCallback(async () => {
    await disableCurrentPush(api.disablePushDevice, false).catch(() => undefined);
    await revokeCurrentSession();
    setMeState(null);
    setStack([]);
    setTabState("onboarding");
    setSessionExpired(false);
    setHasPendingReport(false);
  }, []);

  const deleteAccount = useCallback(
    async (reauthentication?: Omit<DeleteAccountRequest, "confirmed">) => {
      await disableCurrentPush(api.disablePushDevice, false).catch(() => undefined);
      await api.deleteAccount({ confirmed: true, ...reauthentication });
      setToken(null);
      setMeState(null);
      setStack([]);
      setTabState("onboarding");
      setSessionExpired(false);
      setHasPendingReport(false);
    },
    [],
  );

  const fireBurst = useCallback(() => {
    setBurst(true);
    setTimeout(() => setBurst(false), 2200);
  }, []);

  const route: Route = stack.at(-1) ?? routeForTab(tab);
  const routeKey = JSON.stringify(route);
  const scrollMode: ScrollMode = route.name === "onboarding" ? "hidden" : "auto";

  const ctx: AppCtx = {
    me,
    setMe: setMeState,
    route,
    nav,
    back,
    tab: goTab,
    signIn,
    signOut,
    deleteAccount,
    sessionExpired,
    fireBurst,
    hasPendingReport,
    refreshPending,
  };

  const showTabs =
    restoreState.status === "ready" && me != null && stack.length === 0 && tab !== "onboarding";

  const inner = (
    <>
      {restoreState.status === "loading" ? (
        <div
          style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: T.ter,
            fontFamily: T.disp,
            fontSize: 18,
          }}
        >
          …
        </div>
      ) : restoreState.status === "failed" ? (
        <div
          role="alert"
          style={{
            minHeight: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            padding: 32,
            textAlign: "center",
            color: T.text,
          }}
        >
          <h1 style={{ margin: 0, fontFamily: T.disp, fontSize: 24 }}>Couldn’t restore session</h1>
          <p style={{ margin: 0, color: T.sec, lineHeight: 1.5 }}>
            You’re still signed in. Check your connection and try again.
          </p>
          <button
            type="button"
            onClick={restoreAuth}
            style={{
              minHeight: 48,
              padding: "0 24px",
              border: 0,
              borderRadius: 14,
              background: T.gold,
              color: "#000",
              fontFamily: T.disp,
              fontWeight: 800,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      ) : (
        <div
          key={routeKey}
          className="screen-anim"
          style={{ minHeight: "100%", flex: 1, display: "flex", flexDirection: "column" }}
        >
          {renderRoute(ctx)}
        </div>
      )}
      <SupportBurst show={burst} />
      {showTabs && <TabBar active={tab} onTab={goTab} badge={hasPendingReport} />}
    </>
  );

  // Native and narrow web viewports render full-bleed. Scaling the simulated
  // phone below its design width would make otherwise-correct 44px controls
  // physically too small to tap and leave its 402px layout overflowing at 320px.
  if (NATIVE || compactWeb) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          overflow: "hidden",
          background: "#000",
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          fontFamily: "-apple-system, system-ui, sans-serif",
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
          <div
            key={routeKey}
            style={{ flex: 1, overflow: scrollMode, display: "flex", flexDirection: "column" }}
          >
            {inner}
          </div>
        </div>
      </div>
    );
  }

  // Web preview: render inside the simulated iPhone, scaled to fit the viewport.
  return (
    <div
      style={{
        minHeight: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#000",
      }}
    >
      <div style={{ transform: `scale(${scale})`, transformOrigin: "center center" }}>
        <IOSDevice
          width={DEVICE.w}
          height={DEVICE.h}
          scrollMode={scrollMode}
          scrollResetKey={routeKey}
        >
          {inner}
        </IOSDevice>
      </div>
    </div>
  );
}

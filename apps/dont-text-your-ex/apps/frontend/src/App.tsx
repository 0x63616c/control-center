import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken } from "./api";
import type { AppCtx, Route, ScreenName, TabName } from "./appctx";
import { MoneyBurst } from "./bits";
import { resolveDevice } from "./device";
import { Icon } from "./icons";
import { IOSDevice } from "./iosframe";
import * as S from "./screens";
import { T } from "./theme";
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

const SCREENS: Record<ScreenName, (p: { ctx: AppCtx }) => React.ReactNode> = {
  onboarding: S.Onboarding,
  home: S.Home,
  jar: S.JarDetail,
  logSlip: S.LogSlip,
  report: S.ReportMember,
  confirmDeny: S.ConfirmDeny,
  settle: S.Settle,
  create: S.Create,
  join: S.Join,
  invite: S.Invite,
  activity: S.ActivityTab,
  profile: S.Profile,
  setup: S.SetupProfile,
  editProfile: S.EditProfile,
};

type ScrollMode = "auto" | "hidden";

const ROUTE_SCROLL_MODE: Partial<Record<ScreenName, ScrollMode>> = {
  onboarding: "hidden",
};

function useFit() {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const updateScale = () => {
      const { w: W, h: H } = DEVICE;
      setScale(Math.min(window.innerWidth / (W + 24), window.innerHeight / (H + 24), 1));
    };
    updateScale();
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, []);
  return scale;
}

export default function App() {
  const [booted, setBooted] = useState(false);
  const [me, setMeState] = useState<MeDTO | null>(null);
  const [tab, setTabState] = useState<TabName>("onboarding");
  const [stack, setStack] = useState<Route[]>([]);
  const [burst, setBurst] = useState(false);
  const [hasPendingReport, setHasPendingReport] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const scale = useFit();

  const refreshPending = useCallback(() => {
    api
      .pendingReports()
      .then((r) => setHasPendingReport(r.length > 0))
      .catch(() => {});
  }, []);

  // boot: restore session if a token exists
  useEffect(() => {
    const token = getToken();
    if (!token) {
      setBooted(true);
      return;
    }
    api
      .me()
      .then((u) => {
        setMeState(u);
        setTabState("home");
        // A user with no name yet (Apple declined to share / first run) must
        // complete profile setup before using the app.
        if (!u.name?.trim()) setStack([{ name: "setup", params: {} }]);
        refreshPending();
      })
      .catch(() => {
        setToken(null);
        setSessionExpired(true);
      })
      .finally(() => setBooted(true));
  }, [refreshPending]);

  const nav = useCallback(
    (name: ScreenName, params: Record<string, unknown> = {}, replaceRoot = false) => {
      setStack((s) => (replaceRoot ? [{ name, params }] : [...s, { name, params }]));
    },
    [],
  );
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const goTab = useCallback((t: TabName) => {
    setTabState(t);
    setStack([]);
  }, []);

  const signIn = useCallback((token: string, user: MeDTO) => {
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

  const signOut = useCallback(() => {
    api.logout().catch(() => {});
    setToken(null);
    setMeState(null);
    setStack([]);
    setTabState("onboarding");
    setSessionExpired(false);
    setHasPendingReport(false);
  }, []);

  const fireBurst = useCallback(() => {
    setBurst(true);
    setTimeout(() => setBurst(false), 2200);
  }, []);

  const route: Route = stack.length
    ? stack[stack.length - 1]
    : { name: tab as ScreenName, params: {} };
  const routeKey = route.name + JSON.stringify(route.params);
  const scrollMode = ROUTE_SCROLL_MODE[route.name] ?? "auto";

  const ctx: AppCtx = {
    me,
    setMe: setMeState,
    route,
    nav,
    back,
    tab: goTab,
    signIn,
    signOut,
    sessionExpired,
    fireBurst,
    hasPendingReport,
    refreshPending,
  };

  const Cmp = SCREENS[route.name] ?? S.Home;
  const showTabs = booted && me != null && stack.length === 0 && tab !== "onboarding";

  const inner = (
    <>
      {!booted ? (
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
      ) : (
        <div
          key={routeKey}
          className="screen-anim"
          style={{ minHeight: "100%", flex: 1, display: "flex", flexDirection: "column" }}
        >
          <Cmp ctx={ctx} />
        </div>
      )}
      <MoneyBurst show={burst} />
      {showTabs && <TabBar active={tab} onTab={goTab} badge={hasPendingReport} />}
    </>
  );

  // Native (Capacitor): full-bleed into the real device, honoring safe areas.
  // No simulated frame - the OS draws the real island/status bar/home indicator.
  if (NATIVE) {
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

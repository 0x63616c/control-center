import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { Icon } from "../icons";
import { money, streakLabel, T } from "../theme";
import type { JarDetailDTO } from "../types";
import { Avatar, Btn, IconBtn, Screen, TopBar } from "../ui";
import { ActivityRow, useCountUp } from "./common";
import { ErrorState, type FetchedState, LoadingState, MutationError } from "./fetched-state";

export type JarDetailServices = Pick<typeof api, "jar" | "closeJar" | "leaveJar">;

type LifecycleAction = "close" | "leave";
type LifecycleMutationState =
  | { readonly status: "idle" }
  | { readonly status: "confirming"; readonly action: LifecycleAction }
  | { readonly status: "submitting"; readonly action: LifecycleAction }
  | { readonly status: "failed"; readonly action: LifecycleAction };

function assertNever(value: never): never {
  throw new Error(`Unexpected jar lifecycle state: ${JSON.stringify(value)}`);
}

function lifecycleActionLabel(action: LifecycleAction, inProgress: boolean): string {
  switch (action) {
    case "close":
      return inProgress ? "Closing…" : "Close jar permanently";
    case "leave":
      return inProgress ? "Leaving…" : "Leave jar permanently";
    default:
      return assertNever(action);
  }
}

function lifecycleButtonLabel(state: LifecycleMutationState, action: LifecycleAction): string {
  switch (state.status) {
    case "idle":
    case "confirming":
    case "failed":
      return lifecycleActionLabel(action, false);
    case "submitting":
      return lifecycleActionLabel(state.action, true);
    default:
      return assertNever(state);
  }
}

export function JarDetail({
  ctx,
  services = api,
}: {
  ctx: AppCtx<RouteFor<"jar">>;
  services?: JarDetailServices;
}) {
  const { jarId } = ctx.route;
  const [state, setState] = useState<FetchedState<JarDetailDTO>>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [lifecycleMutation, setLifecycleMutation] = useState<LifecycleMutationState>({
    status: "idle",
  });

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

  const total = state.status === "loaded" ? state.value.jarTotalCents : 0;
  const animated = useCountUp(total);

  if (state.status === "loading") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="" />
        <LoadingState>Loading jar…</LoadingState>
      </Screen>
    );
  }
  if (state.status === "error") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="Jar unavailable" />
        <ErrorState
          label="This jar couldn’t be loaded."
          onRetry={() => setRetry((value) => value + 1)}
        />
      </Screen>
    );
  }
  if (state.status === "empty") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="Jar unavailable" />
        <div role="status" style={{ textAlign: "center", color: T.sec, padding: "60px 0" }}>
          This jar is no longer available.
        </div>
      </Screen>
    );
  }

  const jar = state.value;

  const meId = ctx.me?.id;
  const feed = jar.activity.slice(0, 4);
  const closed = jar.closedAt != null;
  const owner = jar.members.some((member) => member.user.id === meId && member.role === "owner");
  const activeMember = jar.members.some((member) => member.user.id === meId);

  const closeJar = async () => {
    if (lifecycleMutation.status === "submitting" || closed || !owner) return;
    setLifecycleMutation({ status: "submitting", action: "close" });
    try {
      const updated = await services.closeJar(jar.id);
      setState({ status: "loaded", value: updated });
      setLifecycleMutation({ status: "idle" });
    } catch {
      setLifecycleMutation({ status: "failed", action: "close" });
    }
  };

  const leaveJar = async () => {
    if (lifecycleMutation.status === "submitting" || closed || owner || !activeMember) return;
    setLifecycleMutation({ status: "submitting", action: "leave" });
    try {
      await services.leaveJar(jar.id);
      ctx.nav({ name: "home" }, true);
    } catch {
      setLifecycleMutation({ status: "failed", action: "leave" });
    }
  };

  return (
    <Screen>
      <TopBar
        onBack={() => ctx.back()}
        title={jar.name}
        trailing={
          closed ? undefined : (
            <IconBtn
              aria-label="Invite people"
              onClick={() => ctx.nav({ name: "invite", jarId: jar.id })}
            >
              <Icon.share style={{ width: 17, height: 17 }} />
            </IconBtn>
          )
        }
      />

      {closed && (
        <div
          role="status"
          style={{
            border: `1px solid ${T.hair}`,
            borderRadius: 16,
            background: T.surface2,
            color: T.sec,
            padding: "13px 15px",
            marginBottom: 18,
            lineHeight: 1.45,
          }}
        >
          This jar was closed{jar.closedBy ? ` by ${jar.closedBy.name}` : ""}. Its history is
          read-only.
        </div>
      )}

      {/* HERO pot */}
      <div style={{ textAlign: "center", padding: "14px 0 6px" }}>
        <div
          style={{
            fontSize: 13.5,
            color: T.sec,
            fontWeight: 600,
            letterSpacing: "0.02em",
            marginBottom: 6,
          }}
        >
          IN THE JAR
        </div>
        <div
          data-testid="jar-pot"
          style={{
            fontFamily: T.disp,
            fontWeight: 800,
            fontSize: 92,
            color: T.gold,
            letterSpacing: "-0.05em",
            lineHeight: 0.9,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {money(animated)}
        </div>
        <div
          style={{
            fontSize: 14,
            color: T.sec,
            margin: "12px auto 0",
            maxWidth: 280,
            lineHeight: 1.4,
          }}
        >
          “{jar.rule}”
        </div>
      </div>

      {/* primary action */}
      {!closed && (
        <>
          <div style={{ margin: "24px 0 10px" }}>
            <Btn
              kind="red"
              icon={<span style={{ fontSize: 20 }}>💔</span>}
              onClick={() => ctx.nav({ name: "logSlip", jarId: jar.id })}
            >
              I texted my ex
            </Btn>
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 26 }}>
            <Btn
              kind="dark"
              style={{ height: 50, fontSize: 16 }}
              icon={<Icon.flag style={{ width: 17, height: 17 }} />}
              onClick={() => ctx.nav({ name: "report", jarId: jar.id })}
            >
              Report
            </Btn>
            <Btn
              kind="dark"
              style={{ height: 50, fontSize: 16 }}
              onClick={() => ctx.nav({ name: "settle", jarId: jar.id })}
            >
              Settle up
            </Btn>
          </div>
        </>
      )}

      {/* WALL OF SHAME */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <h2
          style={{
            fontFamily: T.disp,
            fontWeight: 800,
            fontSize: 18,
            letterSpacing: "0.02em",
            margin: 0,
          }}
        >
          WALL OF SHAME 🏆
        </h2>
        <span style={{ fontSize: 12.5, color: T.ter }}>most slips up top</span>
      </div>
      <div
        style={{
          background: T.surface,
          border: `1px solid ${T.hair}`,
          borderRadius: 22,
          overflow: "hidden",
          marginBottom: 26,
        }}
      >
        {jar.members.map((m, i) => {
          const streak = streakLabel(m);
          const me = m.user.id === meId;
          return (
            <div
              key={m.user.id}
              data-testid="shame-row"
              data-member={m.user.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 13,
                padding: "13px 16px",
                borderTop: i ? `1px solid ${T.hair2}` : "none",
                background: me ? "rgba(255,210,63,0.06)" : "transparent",
              }}
            >
              <div
                style={{
                  width: 18,
                  fontFamily: T.disp,
                  fontWeight: 800,
                  fontSize: 16,
                  color: i === 0 ? T.gold : T.ter,
                  textAlign: "center",
                }}
              >
                {i + 1}
              </div>
              <Avatar user={m.user} size={40} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.disp, fontWeight: 700, fontSize: 16 }}>
                  {m.user.name}
                  {me && <span style={{ color: T.sec, fontWeight: 600 }}> · you</span>}
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    marginTop: 1,
                    color:
                      streak === "just caved"
                        ? T.red
                        : streak === "forever clean"
                          ? T.green
                          : T.sec,
                  }}
                >
                  {streak || "- streak hidden"}
                </div>
              </div>
              <div
                style={{
                  fontFamily: T.disp,
                  fontWeight: 800,
                  fontSize: 20,
                  color: m.tallyCents ? T.text : T.ter,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {money(m.tallyCents)}
              </div>
            </div>
          );
        })}
      </div>

      {/* recent activity */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 2,
        }}
      >
        <h2 style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 18, margin: 0 }}>Recent</h2>
        <button
          type="button"
          onClick={() => ctx.tab("activity")}
          style={{
            background: "none",
            border: "none",
            color: T.gold,
            fontFamily: T.ui,
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          All
        </button>
      </div>
      <div>
        {feed.map((a) => (
          <ActivityRow key={a.id} a={a} />
        ))}
        {feed.length === 0 && (
          <div style={{ color: T.ter, fontSize: 13.5, padding: "10px 0" }}>
            Nothing yet. Suspicious.
          </div>
        )}
      </div>

      {!closed && owner && (
        <div style={{ borderTop: `1px solid ${T.hair}`, marginTop: 30, paddingTop: 22 }}>
          {lifecycleMutation.status !== "idle" && lifecycleMutation.action === "close" ? (
            <div role="alert" style={{ background: T.surface, borderRadius: 18, padding: 18 }}>
              <div style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 18 }}>
                Close this jar permanently?
              </div>
              <p style={{ color: T.sec, lineHeight: 1.45, fontSize: 14 }}>
                Everyone can still read its history, but invites and every jar action will stop.
              </p>
              {lifecycleMutation.status === "failed" && (
                <MutationError>The jar couldn’t be closed. Try again.</MutationError>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <Btn
                  kind="dark"
                  disabled={lifecycleMutation.status === "submitting"}
                  onClick={() => setLifecycleMutation({ status: "idle" })}
                >
                  Cancel
                </Btn>
                <Btn
                  kind="red"
                  disabled={lifecycleMutation.status === "submitting"}
                  onClick={closeJar}
                >
                  {lifecycleButtonLabel(lifecycleMutation, "close")}
                </Btn>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setLifecycleMutation({ status: "confirming", action: "close" })}
              style={{
                width: "100%",
                border: "none",
                background: "transparent",
                color: T.red,
                fontFamily: T.ui,
                fontWeight: 700,
                fontSize: 14,
                cursor: "pointer",
                padding: 12,
              }}
            >
              Close jar
            </button>
          )}
        </div>
      )}
      {!closed && activeMember && !owner && (
        <div style={{ borderTop: `1px solid ${T.hair}`, marginTop: 30, paddingTop: 22 }}>
          {lifecycleMutation.status !== "idle" && lifecycleMutation.action === "leave" ? (
            <div role="alert" style={{ background: T.surface, borderRadius: 18, padding: 18 }}>
              <div style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 18 }}>
                Leave this jar?
              </div>
              <p style={{ color: T.sec, lineHeight: 1.45, fontSize: 14 }}>
                You’ll lose access. Your existing tally and activity stay in the jar’s history.
              </p>
              {lifecycleMutation.status === "failed" && (
                <MutationError>The jar couldn’t be left. Try again.</MutationError>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <Btn
                  kind="dark"
                  disabled={lifecycleMutation.status === "submitting"}
                  onClick={() => setLifecycleMutation({ status: "idle" })}
                >
                  Cancel
                </Btn>
                <Btn
                  kind="red"
                  disabled={lifecycleMutation.status === "submitting"}
                  onClick={leaveJar}
                >
                  {lifecycleButtonLabel(lifecycleMutation, "leave")}
                </Btn>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setLifecycleMutation({ status: "confirming", action: "leave" })}
              style={{
                width: "100%",
                border: "none",
                background: "transparent",
                color: T.red,
                fontFamily: T.ui,
                fontWeight: 700,
                fontSize: 14,
                cursor: "pointer",
                padding: 12,
              }}
            >
              Leave jar
            </button>
          )}
        </div>
      )}
    </Screen>
  );
}

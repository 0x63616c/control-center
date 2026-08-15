import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { Icon } from "../icons";
import { money, T } from "../theme";
import type { JarSummaryDTO, UserDTO } from "../types";
import { AvatarStack, IconBtn, Screen, TopBar } from "../ui";
import { ErrorState, type FetchedState, LoadingState } from "./fetched-state";

export type HomeServices = Pick<typeof api, "jars" | "jar">;
type HomeData = {
  readonly jars: readonly JarSummaryDTO[];
  readonly members: Readonly<Record<string, UserDTO>>;
  readonly avatarsUnavailable: boolean;
};

export function Home({
  ctx,
  services = api,
}: {
  ctx: AppCtx<RouteFor<"home">>;
  services?: HomeServices;
}) {
  const [state, setState] = useState<FetchedState<HomeData>>({ status: "loading" });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    void retry;
    let alive = true;
    setState({ status: "loading" });
    services
      .jars()
      .then(async (js) => {
        if (!alive) return;
        if (js.length === 0) {
          setState({ status: "empty" });
          return;
        }
        const map: Record<string, UserDTO> = {};
        let avatarsUnavailable = false;
        await Promise.all(
          js.map(async (j) => {
            try {
              const d = await services.jar(j.id);
              for (const m of d.members) map[m.user.id] = m.user;
            } catch {
              avatarsUnavailable = true;
            }
          }),
        );
        if (alive)
          setState({ status: "loaded", value: { jars: js, members: map, avatarsUnavailable } });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [retry, services]);

  const topBar = (
    <TopBar
      title="Your jars"
      trailing={
        <IconBtn
          aria-label="Create jar"
          data-testid="create-jar"
          onClick={() => ctx.nav({ name: "create" })}
        >
          <Icon.plus />
        </IconBtn>
      }
    />
  );

  if (state.status === "loading") {
    return (
      <Screen>
        {topBar}
        <LoadingState>Loading your jars…</LoadingState>
      </Screen>
    );
  }
  if (state.status === "error") {
    return (
      <Screen>
        {topBar}
        <ErrorState
          label="Your jars couldn’t be loaded."
          onRetry={() => setRetry((value) => value + 1)}
        />
      </Screen>
    );
  }
  if (state.status === "empty") {
    return (
      <Screen>
        {topBar}
        <div style={{ textAlign: "center", color: T.sec, fontSize: 15, padding: "20px 0" }}>
          No jars yet. Start one and drag your friends down with you.
        </div>
        <button
          type="button"
          onClick={() => ctx.nav({ name: "join" })}
          style={{
            width: "100%",
            background: "transparent",
            border: `1.5px dashed ${T.hair}`,
            borderRadius: 24,
            padding: 18,
            color: T.sec,
            fontFamily: T.ui,
            fontWeight: 600,
            fontSize: 15,
            cursor: "pointer",
          }}
        >
          <Icon.plus style={{ width: 16, height: 16 }} /> Join a jar with a code
        </button>
      </Screen>
    );
  }

  const { avatarsUnavailable, jars, members } = state.value;

  const myTotal = jars.reduce((s, j) => s + j.myTallyCents, 0);
  const bestStreak = jars.reduce((max, j) => Math.max(max, j.myDaysClean), 0);

  return (
    <Screen>
      {topBar}

      {avatarsUnavailable && (
        <div role="status" style={{ color: T.ter, fontSize: 12.5, marginBottom: 12 }}>
          Some member photos couldn’t be loaded.
        </div>
      )}

      <div
        style={{
          background: "linear-gradient(135deg, #1c1606, #100c02)",
          border: `1px solid ${T.hair}`,
          borderRadius: 24,
          padding: "20px 22px",
          marginBottom: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ fontSize: 13.5, color: T.sec, fontWeight: 600, marginBottom: 4 }}>
            Your total damage
          </div>
          <div
            data-testid="total-damage"
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 44,
              color: T.gold,
              letterSpacing: "-0.03em",
              lineHeight: 1,
            }}
          >
            {money(myTotal)}
          </div>
        </div>
        <div
          style={{
            alignSelf: "stretch",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            justifyContent: "space-between",
            textAlign: "right",
          }}
        >
          <div
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 44,
              color: T.green,
              lineHeight: 1,
              letterSpacing: "-0.03em",
            }}
          >
            {bestStreak}
          </div>
          <div style={{ fontSize: 12, color: T.sec, fontWeight: 600 }}>days clean</div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {jars.map((j) => {
          const memberUsers = j.memberIds.map((id) => members[id]).filter(Boolean);
          return (
            <button
              key={j.id}
              type="button"
              data-testid="jar-card"
              data-jar-name={j.name}
              onClick={() => ctx.nav({ name: "jar", jarId: j.id })}
              style={{
                textAlign: "left",
                background: T.surface,
                border: `1px solid ${T.hair}`,
                borderRadius: 24,
                padding: 20,
                cursor: "pointer",
                color: T.text,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <div
                  style={{
                    fontFamily: T.disp,
                    fontWeight: 700,
                    fontSize: 22,
                    letterSpacing: "-0.02em",
                  }}
                >
                  {j.name}
                </div>
                <Icon.chev style={{ color: T.ter, marginTop: 6 }} />
              </div>
              <div
                style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0 18px" }}
              >
                {memberUsers.length > 0 ? (
                  <AvatarStack users={memberUsers} size={30} />
                ) : (
                  <div style={{ height: 30 }} />
                )}
                <span style={{ fontSize: 13.5, color: T.sec, fontWeight: 600 }}>
                  {j.memberCount} in
                </span>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <div
                  style={{
                    flex: 1,
                    background: T.surface2,
                    borderRadius: 14,
                    padding: "11px 14px",
                  }}
                >
                  <div style={{ fontSize: 11.5, color: T.sec, fontWeight: 600, marginBottom: 2 }}>
                    You owe
                  </div>
                  <div
                    style={{
                      fontFamily: T.disp,
                      fontWeight: 700,
                      fontSize: 22,
                      color: j.myTallyCents ? T.gold : T.sec,
                    }}
                  >
                    {money(j.myTallyCents)}
                  </div>
                </div>
                <div
                  style={{
                    flex: 1,
                    background: T.surface2,
                    borderRadius: 14,
                    padding: "11px 14px",
                  }}
                >
                  <div style={{ fontSize: 11.5, color: T.sec, fontWeight: 600, marginBottom: 2 }}>
                    Jar total
                  </div>
                  <div style={{ fontFamily: T.disp, fontWeight: 700, fontSize: 22 }}>
                    {money(j.jarTotalCents)}
                  </div>
                </div>
              </div>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => ctx.nav({ name: "join" })}
          style={{
            background: "transparent",
            border: `1.5px dashed ${T.hair}`,
            borderRadius: 24,
            padding: 18,
            cursor: "pointer",
            color: T.sec,
            fontFamily: T.ui,
            fontWeight: 600,
            fontSize: 15,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          <Icon.plus style={{ width: 16, height: 16 }} /> Join a jar with a code
        </button>
      </div>
    </Screen>
  );
}

import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { formatPoints, NO_MONEY_DISCLOSURE, T } from "../theme";
import type { JarDetailDTO } from "../types";
import { Screen, TopBar } from "../ui";
import { ErrorState, type FetchedState, LoadingState } from "./fetched-state";

export type AboutTallyServices = Pick<typeof api, "jar">;

export function AboutTally({
  ctx,
  services = api,
}: {
  ctx: AppCtx<RouteFor<"aboutTally">>;
  services?: AboutTallyServices;
}) {
  const { jarId } = ctx.route;
  const [state, setState] = useState<FetchedState<JarDetailDTO>>({ status: "loading" });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    void retry;
    let alive = true;
    setState({ status: "loading" });
    services
      .jar(jarId)
      .then((d) => {
        if (!alive) return;
        setState(
          d.members.some((member) => member.user.id === ctx.me?.id)
            ? { status: "loaded", value: d }
            : { status: "empty" },
        );
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [ctx.me?.id, jarId, retry, services]);

  if (state.status === "loading") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="About my tally" />
        <LoadingState>Loading your tally…</LoadingState>
      </Screen>
    );
  }
  if (state.status === "error") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="About my tally" />
        <ErrorState
          label="Your tally couldn’t be loaded."
          onRetry={() => setRetry((value) => value + 1)}
        />
      </Screen>
    );
  }
  if (state.status === "empty") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="About my tally" />
        <div role="status" style={{ textAlign: "center", color: T.sec, padding: "60px 0" }}>
          You aren’t a member of this jar.
        </div>
      </Screen>
    );
  }

  const jar = state.value;
  const membership = jar.members.find((member) => member.user.id === ctx.me?.id);
  if (!membership) return null;

  const tally = membership.tallyCents;

  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="About my tally" />
      <div style={{ textAlign: "center", padding: "30px 0 10px" }}>
        <div style={{ fontSize: 13.5, color: T.sec, fontWeight: 600, marginBottom: 8 }}>
          YOUR VIRTUAL TALLY
        </div>
        <div
          style={{
            fontFamily: T.disp,
            fontWeight: 800,
            fontSize: 80,
            color: T.gold,
            letterSpacing: "-0.04em",
            lineHeight: 0.9,
          }}
        >
          {formatPoints(tally)}
        </div>
      </div>

      <div
        style={{
          background: T.surface,
          border: `1px solid ${T.hair}`,
          borderRadius: 20,
          padding: "18px 20px",
          margin: "28px 0 22px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 15,
            padding: "6px 0",
          }}
        >
          <span style={{ color: T.sec }}>Your slips in {jar.name}</span>
          <span style={{ fontWeight: 700, fontFamily: T.disp }}>{formatPoints(tally)}</span>
        </div>
      </div>

      <p
        style={{
          textAlign: "center",
          fontSize: 14,
          color: T.sec,
          marginTop: 16,
          lineHeight: 1.55,
        }}
      >
        This is a shared accountability scoreboard value only. {NO_MONEY_DISCLOSURE}
      </p>
    </Screen>
  );
}

import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { money, T } from "../theme";
import type { JarDetailDTO } from "../types";
import { Btn, Screen, TopBar } from "../ui";
import { ErrorState, type FetchedState, LoadingState } from "./fetched-state";

export type SettleServices = Pick<typeof api, "jar">;

export function Settle({
  ctx,
  services = api,
}: {
  ctx: AppCtx<RouteFor<"settle">>;
  services?: SettleServices;
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
        <TopBar onBack={() => ctx.back()} title="Settle up" />
        <LoadingState>Loading your balance…</LoadingState>
      </Screen>
    );
  }
  if (state.status === "error") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="Settle up" />
        <ErrorState
          label="Your balance couldn’t be loaded."
          onRetry={() => setRetry((value) => value + 1)}
        />
      </Screen>
    );
  }
  if (state.status === "empty") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="Settle up" />
        <div role="status" style={{ textAlign: "center", color: T.sec, padding: "60px 0" }}>
          You aren’t a member of this jar.
        </div>
      </Screen>
    );
  }

  const jar = state.value;
  const membership = jar.members.find((member) => member.user.id === ctx.me?.id);
  if (!membership) return null;

  const owe = membership.tallyCents;

  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="Settle up" />
      <div style={{ textAlign: "center", padding: "30px 0 10px" }}>
        <div style={{ fontSize: 13.5, color: T.sec, fontWeight: 600, marginBottom: 8 }}>
          YOU OWE THE JAR
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
          {money(owe)}
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
          <span style={{ fontWeight: 700, fontFamily: T.disp }}>{money(owe)}</span>
        </div>
      </div>

      <div style={{ position: "relative" }}>
        <Btn kind="gold" disabled>
          Pay {money(owe)}
        </Btn>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              background: "#000",
              color: T.gold,
              fontFamily: T.disp,
              fontWeight: 700,
              fontSize: 14,
              padding: "5px 12px",
              borderRadius: 999,
              border: `1px solid ${T.gold}`,
            }}
          >
            Payments coming soon
          </span>
        </div>
      </div>
      <p
        style={{ textAlign: "center", fontSize: 13, color: T.ter, marginTop: 16, lineHeight: 1.45 }}
      >
        Right now this is purely a guilt scoreboard. Payments are coming soon. The shame, however,
        is live.
      </p>
    </Screen>
  );
}

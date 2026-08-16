import { useEffect, useState } from "react";
import { api, isApiErrorStatus } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { formatPoints, T } from "../theme";
import type { JarRecapDTO } from "../types";
import { Screen, TopBar } from "../ui";
import { ErrorState, type FetchedState, LoadingState } from "./fetched-state";

export type RecapServices = Pick<typeof api, "recaps" | "recap">;

function monthLabel(recap: JarRecapDTO): string {
  const [year, month] = recap.calendarMonth.split("-").map(Number);
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, 1)));
}

function RecapCard({ recap }: { recap: JarRecapDTO }) {
  return (
    <article
      style={{
        background: T.surface,
        border: `1px solid ${T.hair}`,
        borderRadius: 22,
        padding: 18,
        marginBottom: 14,
      }}
    >
      <div style={{ color: T.gold, fontSize: 13, fontWeight: 750 }}>{monthLabel(recap)}</div>
      <h2 style={{ fontFamily: T.disp, fontSize: 23, margin: "5px 0 16px" }}>{recap.jarName}</h2>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Metric label="Slips" value={String(recap.slipCount)} />
        <Metric label="Virtual tally added" value={formatPoints(recap.tallyChangeCents)} />
      </div>
      {recap.sharedStreakHighlights.length > 0 && (
        <p style={{ color: T.sec, fontSize: 14, lineHeight: 1.45, margin: "16px 0 0" }}>
          Shared streak highlights:{" "}
          {recap.sharedStreakHighlights
            .map((item) => `${item.count} × ${item.days} days`)
            .join(", ")}
          .
        </p>
      )}
      {recap.crossedMilestonesCents.length > 0 && (
        <p style={{ color: T.sec, fontSize: 14, lineHeight: 1.45, margin: "8px 0 0" }}>
          Jar milestones crossed: {recap.crossedMilestonesCents.map(formatPoints).join(", ")}.
        </p>
      )}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: T.surface2, borderRadius: 14, padding: 13 }}>
      <div style={{ color: T.ter, fontSize: 12 }}>{label}</div>
      <div style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 21, marginTop: 3 }}>{value}</div>
    </div>
  );
}

export function Recaps({
  ctx,
  services = api,
}: {
  ctx: AppCtx<RouteFor<"recaps">>;
  services?: RecapServices;
}) {
  const [state, setState] = useState<FetchedState<readonly JarRecapDTO[]>>({ status: "loading" });
  const [unavailable, setUnavailable] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    void retry;
    let alive = true;
    setUnavailable(false);
    setState({ status: "loading" });
    const request = ctx.route.recapId
      ? services.recap(ctx.route.recapId).then((recap) => [recap])
      : services.recaps();
    request
      .then((recaps) => {
        if (!alive) return;
        setState(recaps.length > 0 ? { status: "loaded", value: recaps } : { status: "empty" });
      })
      .catch((error: unknown) => {
        if (!alive) return;
        if (isApiErrorStatus(error, 404)) {
          setUnavailable(true);
          setState({ status: "empty" });
        } else {
          setState({ status: "error" });
        }
      });
    return () => {
      alive = false;
    };
  }, [ctx.route.recapId, retry, services]);

  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="Monthly recaps" />
      {state.status === "loading" && <LoadingState>Loading recaps…</LoadingState>}
      {state.status === "error" && (
        <ErrorState
          label="Your recaps couldn’t be loaded. Check your connection."
          onRetry={() => setRetry((value) => value + 1)}
        />
      )}
      {state.status === "empty" && (
        <div
          role="status"
          style={{ color: T.sec, textAlign: "center", padding: "54px 18px", lineHeight: 1.5 }}
        >
          {unavailable
            ? "That recap is no longer available to this account."
            : "No recaps yet. A jar gets one after a completed month with activity."}
        </div>
      )}
      {state.status === "loaded" &&
        state.value.map((recap) => <RecapCard key={recap.id} recap={recap} />)}
    </Screen>
  );
}

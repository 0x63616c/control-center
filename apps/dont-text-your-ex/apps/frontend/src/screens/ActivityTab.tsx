import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { Icon } from "../icons";
import { T } from "../theme";
import type { ActivityDTO, ReportDTO } from "../types";
import { Screen, TopBar } from "../ui";
import { ActivityRow } from "./common";
import { ErrorState, type FetchedState, LoadingState } from "./fetched-state";

export type ActivityServices = Pick<typeof api, "activity" | "pendingReports">;
type ActivityData = {
  readonly feed: readonly ActivityDTO[];
  readonly pending: readonly ReportDTO[];
};

export function ActivityTab({
  ctx,
  services = api,
}: {
  ctx: AppCtx<RouteFor<"activity">>;
  services?: ActivityServices;
}) {
  const [state, setState] = useState<FetchedState<ActivityData>>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const historyButton = (
    <button
      type="button"
      onClick={() => ctx.nav({ name: "reportHistory" })}
      style={{
        width: "100%",
        minHeight: 48,
        borderRadius: 16,
        border: `1px solid ${T.hair}`,
        background: T.surface2,
        color: T.text,
        fontFamily: T.disp,
        fontWeight: 700,
        cursor: "pointer",
        marginBottom: 18,
      }}
    >
      View check history
    </button>
  );

  useEffect(() => {
    void retry;
    let alive = true;
    setState({ status: "loading" });
    Promise.all([services.activity(), services.pendingReports()])
      .then(([feed, pending]) => {
        if (!alive) return;
        setState(
          feed.length === 0 && pending.length === 0
            ? { status: "empty" }
            : { status: "loaded", value: { feed, pending } },
        );
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [retry, services]);

  if (state.status === "loading") {
    return (
      <Screen>
        <TopBar title="Activity" />
        <LoadingState>Loading activity…</LoadingState>
      </Screen>
    );
  }
  if (state.status === "error") {
    return (
      <Screen>
        <TopBar title="Activity" />
        <ErrorState
          label="Activity couldn’t be loaded."
          onRetry={() => setRetry((value) => value + 1)}
        />
      </Screen>
    );
  }
  if (state.status === "empty") {
    return (
      <Screen>
        <TopBar title="Activity" />
        {historyButton}
        <div style={{ textAlign: "center", color: T.ter, fontSize: 14, padding: "60px 0" }}>
          No activity yet. Keep supporting each other.
        </div>
      </Screen>
    );
  }

  const { feed, pending } = state.value;

  const topReport = pending[0];

  return (
    <Screen>
      <TopBar title="Activity" />
      {historyButton}

      {topReport && (
        <button
          type="button"
          onClick={() => ctx.nav({ name: "confirmDeny", reportId: topReport.id })}
          style={{
            width: "100%",
            textAlign: "left",
            cursor: "pointer",
            background: "linear-gradient(135deg, #2a0d0b, #170807)",
            border: `1px solid rgba(255,69,58,0.4)`,
            borderRadius: 22,
            padding: "16px 18px",
            marginBottom: 22,
            color: T.text,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: "rgba(255,69,58,0.18)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: T.red,
              }}
            >
              <Icon.flag style={{ width: 16, height: 16 }} />
            </div>
            <span style={{ fontFamily: T.disp, fontWeight: 700, fontSize: 16, color: T.red }}>
              You have an accountability check
            </span>
          </div>
          <div style={{ fontSize: 14, color: "#E8C9C6", lineHeight: 1.35 }}>
            {topReport.anonymous ? "Someone in the jar" : (topReport.accuser?.name ?? "Someone")}{" "}
            sent you a check. Review and respond →
          </div>
        </button>
      )}

      <div>
        {feed.map((a) => {
          const reportId = a.reportId;
          return reportId ? (
            <button
              key={a.id}
              type="button"
              aria-label={`View accountability check in ${a.jarName}`}
              onClick={() => ctx.nav({ name: "reportDetail", reportId })}
              style={{
                width: "100%",
                minHeight: 44,
                border: 0,
                padding: 0,
                background: "transparent",
                color: T.text,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <ActivityRow a={a} showJar />
            </button>
          ) : (
            <ActivityRow key={a.id} a={a} showJar />
          );
        })}
      </div>
      {feed.length > 0 && (
        <div style={{ textAlign: "center", color: T.ter, fontSize: 13, padding: "24px 0 0" }}>
          You’re all caught up.
        </div>
      )}
    </Screen>
  );
}

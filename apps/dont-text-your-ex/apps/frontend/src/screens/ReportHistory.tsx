import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { EvidenceShot, EvidenceViewer } from "../bits";
import { money, T } from "../theme";
import type { ReportDTO } from "../types";
import { Btn, Screen, TopBar } from "../ui";
import { ErrorState, type FetchedState, LoadingState } from "./fetched-state";

export type ReportHistoryServices = Pick<typeof api, "reportHistory">;
export type ReportDetailServices = Pick<typeof api, "report">;

function outcome(report: ReportDTO): { label: string; color: string } {
  switch (report.status) {
    case "owned":
      return { label: "Owned", color: T.gold };
    case "denied":
      return { label: "Denied", color: T.sec };
    case "pending":
      return { label: "Awaiting response", color: T.red };
    case "expired":
      return { label: "Expired", color: T.ter };
  }
}

function OutcomePill({ report }: { report: ReportDTO }) {
  const value = outcome(report);
  return (
    <span
      style={{
        border: `1px solid ${value.color}`,
        borderRadius: 999,
        color: value.color,
        fontSize: 11.5,
        fontWeight: 800,
        padding: "4px 8px",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
      }}
    >
      {value.label}
    </span>
  );
}

export function ReportHistory({
  ctx,
  services = api,
}: {
  ctx: AppCtx<RouteFor<"reportHistory">>;
  services?: ReportHistoryServices;
}) {
  const [state, setState] = useState<FetchedState<readonly ReportDTO[]>>({ status: "loading" });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    void retry;
    let alive = true;
    setState({ status: "loading" });
    services
      .reportHistory()
      .then((reports) => {
        if (alive)
          setState(reports.length ? { status: "loaded", value: reports } : { status: "empty" });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [retry, services]);

  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="Report history" />
      {state.status === "loading" && <LoadingState>Loading report history…</LoadingState>}
      {state.status === "error" && (
        <ErrorState
          label="Report history couldn’t be loaded."
          onRetry={() => setRetry((value) => value + 1)}
        />
      )}
      {state.status === "empty" && (
        <div style={{ textAlign: "center", color: T.ter, fontSize: 14, padding: "60px 0" }}>
          No resolved reports yet.
        </div>
      )}
      {state.status === "loaded" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {state.value.map((report) => (
            <button
              key={report.id}
              type="button"
              onClick={() => ctx.nav({ name: "reportDetail", reportId: report.id })}
              style={{
                width: "100%",
                minHeight: 76,
                padding: "14px 16px",
                borderRadius: 18,
                border: `1px solid ${T.hair}`,
                background: T.surface,
                color: T.text,
                cursor: "pointer",
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.disp, fontWeight: 750, fontSize: 16 }}>
                  {report.accused.name} · {report.jarName}
                </div>
                <div
                  style={{
                    color: T.sec,
                    fontSize: 13,
                    marginTop: 4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {report.note ?? `${report.evidence.length} screenshot attachment(s)`}
                </div>
              </div>
              <OutcomePill report={report} />
            </button>
          ))}
        </div>
      )}
    </Screen>
  );
}

export function ReportDetail({
  ctx,
  services = api,
}: {
  ctx: AppCtx<RouteFor<"reportDetail">>;
  services?: ReportDetailServices;
}) {
  const [state, setState] = useState<FetchedState<ReportDTO>>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [viewer, setViewer] = useState<number | null>(null);

  useEffect(() => {
    void retry;
    let alive = true;
    setState({ status: "loading" });
    services
      .report(ctx.route.reportId)
      .then((report) => {
        if (alive) setState({ status: "loaded", value: report });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [ctx.route.reportId, retry, services]);

  if (state.status === "loading") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="Report detail" />
        <LoadingState>Loading report…</LoadingState>
      </Screen>
    );
  }
  if (state.status === "error" || state.status === "empty") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="Report detail" />
        <ErrorState
          label="This report couldn’t be loaded."
          onRetry={() => setRetry((value) => value + 1)}
        />
      </Screen>
    );
  }

  const report = state.value;
  const reporter = report.anonymous ? "Someone in the jar" : (report.accuser?.name ?? "Someone");

  return (
    <Screen>
      <TopBar
        onBack={() => ctx.back()}
        title="Report detail"
        trailing={<OutcomePill report={report} />}
      />
      <div
        style={{
          background: T.surface,
          border: `1px solid ${T.hair}`,
          borderRadius: 20,
          padding: 18,
          marginBottom: 18,
        }}
      >
        <div style={{ color: T.sec, fontSize: 12.5, marginBottom: 8 }}>
          {report.jarName} · {report.ago} ago
        </div>
        <div style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 20, lineHeight: 1.25 }}>
          {reporter} reported {report.accused.name}
        </div>
        <div style={{ color: T.gold, fontWeight: 750, marginTop: 8 }}>
          {money(report.amountCents)} consequence
        </div>
      </div>

      {report.note && (
        <div
          style={{
            borderLeft: `3px solid ${T.red}`,
            color: T.text,
            fontSize: 15.5,
            lineHeight: 1.5,
            padding: "4px 0 4px 14px",
            marginBottom: 20,
          }}
        >
          “{report.note}”
        </div>
      )}

      {report.evidence.length > 0 && (
        <>
          <div style={{ color: T.sec, fontSize: 12, fontWeight: 700, marginBottom: 10 }}>
            THE RECEIPTS ({report.evidence.length})
          </div>
          <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 18 }}>
            {report.evidence.map((image, index) => (
              <EvidenceShot key={image.id} image={image} w={128} onOpen={() => setViewer(index)} />
            ))}
          </div>
        </>
      )}

      {report.status === "pending" && ctx.me?.id === report.accused.id && (
        <Btn onClick={() => ctx.nav({ name: "confirmDeny", reportId: report.id })}>
          Respond to report
        </Btn>
      )}

      <EvidenceViewer
        images={report.evidence}
        index={viewer}
        onClose={() => setViewer(null)}
        onIndex={setViewer}
      />
    </Screen>
  );
}

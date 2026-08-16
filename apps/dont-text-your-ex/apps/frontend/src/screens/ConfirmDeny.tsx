import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { EvidenceShot, EvidenceViewer } from "../bits";
import { formatPoints, T } from "../theme";
import type { ReportDTO } from "../types";
import { Btn, Screen, TopBar } from "../ui";
import { ErrorState, type FetchedState, LoadingState, MutationError } from "./fetched-state";

export type ConfirmDenyServices = Pick<typeof api, "pendingReports" | "resolveReport">;

type ResolutionState =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "failed" }
  | { readonly status: "resolved"; readonly outcome: "owned" | "denied" };

export function ConfirmDeny({
  ctx,
  services = api,
}: {
  ctx: AppCtx<RouteFor<"confirmDeny">>;
  services?: ConfirmDenyServices;
}) {
  const { reportId } = ctx.route;
  const [state, setState] = useState<FetchedState<ReportDTO>>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [viewer, setViewer] = useState<number | null>(null);
  const [resolution, setResolution] = useState<ResolutionState>({ status: "idle" });

  useEffect(() => {
    void retry;
    let alive = true;
    setState({ status: "loading" });
    services
      .pendingReports()
      .then((rs) => {
        if (!alive) return;
        const report = rs.find((item) => item.id === reportId);
        setState(report ? { status: "loaded", value: report } : { status: "empty" });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
  }, [reportId, retry, services]);

  const report = state.status === "loaded" ? state.value : null;

  const resolve = async (action: "own" | "deny") => {
    if (!report || resolution.status === "submitting") return;
    setResolution({ status: "submitting" });
    try {
      await services.resolveReport(report.id, action);
      ctx.refreshPending();
      setResolution({ status: "resolved", outcome: action === "own" ? "owned" : "denied" });
    } catch {
      setResolution({ status: "failed" });
    }
  };

  if (state.status === "loading") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="Accountability check" />
        <LoadingState>Loading check…</LoadingState>
      </Screen>
    );
  }
  if (state.status === "error") {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="Accountability check" />
        <ErrorState
          label="This check couldn’t be loaded."
          onRetry={() => setRetry((value) => value + 1)}
        />
      </Screen>
    );
  }
  if (state.status === "empty" || report == null) {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="Accountability check" />
        <div style={{ textAlign: "center", color: T.ter, paddingTop: 80, fontFamily: T.disp }}>
          No checks are waiting for your response.
        </div>
      </Screen>
    );
  }

  if (resolution.status === "resolved") {
    const owned = resolution.outcome === "owned";
    return (
      <Screen>
        <div
          style={{
            minHeight: 620,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            gap: 18,
          }}
        >
          <div style={{ fontSize: 56 }}>{owned ? "🫡" : "🙅"}</div>
          <h2
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 30,
              letterSpacing: "-0.02em",
              margin: 0,
            }}
          >
            {owned ? "Respect." : "Response saved."}
          </h2>
          <p style={{ color: T.sec, fontSize: 16, lineHeight: 1.45, maxWidth: 290, margin: 0 }}>
            {owned ? (
              <>
                You accepted it. <b style={{ color: T.gold }}>{formatPoints(report.amountCents)}</b>{" "}
                was added to your virtual tally, and your no-contact streak reset. Jar members can
                see the update.
              </>
            ) : (
              <>The check is closed, and your tally did not change.</>
            )}
          </p>
          <div style={{ width: "100%", marginTop: 10 }}>
            <Btn kind="gold" onClick={() => ctx.tab("home")}>
              Done
            </Btn>
          </div>
        </div>
      </Screen>
    );
  }

  const accuser = report.anonymous ? "Someone in the jar" : (report.accuser?.name ?? "Someone");

  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="Accountability check" />
      <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
        <div style={{ fontSize: 46, marginBottom: 10 }}>👀</div>
        <h2
          style={{
            fontFamily: T.disp,
            fontWeight: 800,
            fontSize: 27,
            letterSpacing: "-0.02em",
            lineHeight: 1.1,
            margin: "0 auto",
            maxWidth: 300,
          }}
        >
          <span style={{ color: T.red }}>{accuser}</span> sent you an accountability check.
        </h2>
        <div style={{ fontSize: 13.5, color: T.ter, marginTop: 10 }}>
          in {report.jarName} · {report.ago} ago
        </div>
      </div>

      {report.note && (
        <div
          style={{
            background: T.surface,
            border: `1px solid ${T.hair}`,
            borderRadius: 18,
            padding: "16px 18px",
            margin: "22px 0 16px",
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: T.sec,
              fontWeight: 600,
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            What they shared
          </div>
          <div style={{ fontSize: 16, lineHeight: 1.45 }}>“{report.note}”</div>
        </div>
      )}

      {report.evidence.length > 0 && (
        <>
          <div
            style={{
              fontSize: 12,
              color: T.sec,
              fontWeight: 600,
              marginBottom: 10,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Supporting screenshots ({report.evidence.length})
          </div>
          <div
            style={{
              display: "flex",
              gap: 10,
              marginBottom: 30,
              overflowX: "auto",
              paddingBottom: 4,
            }}
          >
            {report.evidence.map((e, i) => (
              <EvidenceShot key={e.id} image={e} w={128} onOpen={() => setViewer(i)} />
            ))}
          </div>
        </>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Btn
          kind="gold"
          disabled={resolution.status === "submitting"}
          onClick={() => resolve("own")}
        >
          Accept and add {formatPoints(report.amountCents)}
        </Btn>
        <Btn
          kind="dark"
          disabled={resolution.status === "submitting"}
          onClick={() => resolve("deny")}
        >
          Deny this check
        </Btn>
      </div>
      {resolution.status === "failed" && (
        <MutationError>
          The check couldn’t be updated. Check your connection and try again.
        </MutationError>
      )}
      <p
        style={{
          textAlign: "center",
          fontSize: 12.5,
          color: T.ter,
          marginTop: 16,
          lineHeight: 1.4,
        }}
      >
        Denying closes this check without changing your tally.
      </p>

      <EvidenceViewer
        images={report.evidence}
        index={viewer}
        onClose={() => setViewer(null)}
        onIndex={setViewer}
      />
    </Screen>
  );
}

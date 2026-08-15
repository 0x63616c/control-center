import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx } from "../appctx";
import { EvidenceShot, EvidenceViewer } from "../bits";
import { money, T } from "../theme";
import type { ReportDTO } from "../types";
import { Btn, Screen, TopBar } from "../ui";

export function ConfirmDeny({ ctx }: { ctx: AppCtx }) {
  const reportId = ctx.route.params.reportId as string;
  const [report, setReport] = useState<ReportDTO | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [done, setDone] = useState<"owned" | "denied" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .pendingReports()
      .then((rs) => {
        if (!alive) return;
        setReport(rs.find((r) => r.id === reportId) ?? rs[0] ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [reportId]);

  const resolve = async (action: "own" | "deny") => {
    if (!report || busy) return;
    setBusy(true);
    try {
      await api.resolveReport(report.id, action);
      ctx.refreshPending();
      setDone(action === "own" ? "owned" : "denied");
    } catch {
      setBusy(false);
    }
  };

  if (!report) {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="You've been reported" />
        <div style={{ textAlign: "center", color: T.ter, paddingTop: 80, fontFamily: T.disp }}>
          Nothing pending. You're (currently) clean.
        </div>
      </Screen>
    );
  }

  if (done) {
    const owned = done === "owned";
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
            {owned ? "Respect." : "Bold move."}
          </h2>
          <p style={{ color: T.sec, fontSize: 16, lineHeight: 1.45, maxWidth: 290, margin: 0 }}>
            {owned ? (
              <>
                You owned it. <b style={{ color: T.gold }}>{money(report.amountCents)}</b> added to
                your tally and your streak's back to zero. The jar saw.
              </>
            ) : (
              <>
                Report dropped. We'll take your word for it… <i>this time.</i>
              </>
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
      <TopBar onBack={() => ctx.back()} title="You've been reported" />
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
          <span style={{ color: T.red }}>{accuser}</span> says you texted your ex.
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
            The accusation
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
            The receipts ({report.evidence.length})
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
              <EvidenceShot key={e.id} shot={e.thread} w={128} onOpen={() => setViewer(i)} />
            ))}
          </div>
        </>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Btn kind="gold" disabled={busy} onClick={() => resolve("own")}>
          Own it - add {money(report.amountCents)} 🫡
        </Btn>
        <Btn kind="dark" disabled={busy} onClick={() => resolve("deny")}>
          Deny it - wasn't me
        </Btn>
      </div>
      <p
        style={{
          textAlign: "center",
          fontSize: 12.5,
          color: T.ter,
          marginTop: 16,
          lineHeight: 1.4,
        }}
      >
        Denying drops the report. For now. A denied report can go to a jar vote later.
      </p>

      <EvidenceViewer
        shots={report.evidence.map((e) => e.thread)}
        index={viewer}
        onClose={() => setViewer(null)}
        onIndex={setViewer}
      />
    </Screen>
  );
}

import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx } from "../appctx";
import { Icon } from "../icons";
import { T } from "../theme";
import type { ActivityDTO, ReportDTO } from "../types";
import { Screen, TopBar } from "../ui";
import { ActivityRow } from "./common";

export function ActivityTab({ ctx }: { ctx: AppCtx }) {
  const [feed, setFeed] = useState<ActivityDTO[] | null>(null);
  const [pending, setPending] = useState<ReportDTO[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .activity()
      .then((a) => {
        if (alive) setFeed(a);
      })
      .catch(() => setFeed([]));
    api
      .pendingReports()
      .then((p) => {
        if (alive) setPending(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const topReport = pending[0];

  return (
    <Screen>
      <TopBar title="Activity" />

      {topReport && (
        <button
          type="button"
          onClick={() => ctx.nav("confirmDeny", { reportId: topReport.id })}
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
              You've been reported
            </span>
          </div>
          <div style={{ fontSize: 14, color: "#E8C9C6", lineHeight: 1.35 }}>
            {topReport.anonymous ? "Someone in the jar" : (topReport.accuser?.name ?? "Someone")}{" "}
            says you texted your ex. Fess up or fight it →
          </div>
        </button>
      )}

      <div>
        {(feed ?? []).map((a) => (
          <ActivityRow key={a.id} a={a} showJar />
        ))}
      </div>
      {feed && feed.length === 0 && !topReport && (
        <div style={{ textAlign: "center", color: T.ter, fontSize: 14, padding: "60px 0" }}>
          No carnage yet. Give it time.
        </div>
      )}
      {feed && feed.length > 0 && (
        <div style={{ textAlign: "center", color: T.ter, fontSize: 13, padding: "24px 0 0" }}>
          That's all the carnage for now.
        </div>
      )}
    </Screen>
  );
}

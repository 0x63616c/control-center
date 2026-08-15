import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx } from "../appctx";
import { Icon } from "../icons";
import { money, streakLabel, T } from "../theme";
import type { JarDetailDTO } from "../types";
import { Avatar, Btn, IconBtn, Screen, TopBar } from "../ui";
import { ActivityRow, useCountUp } from "./common";

export function JarDetail({ ctx }: { ctx: AppCtx }) {
  const jarId = ctx.route.params.jarId as string;
  const [jar, setJar] = useState<JarDetailDTO | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .jar(jarId)
      .then((d) => {
        if (alive) setJar(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [jarId]);

  const total = jar?.jarTotalCents ?? 0;
  const animated = useCountUp(total);

  if (!jar) {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="" />
        <div style={{ textAlign: "center", color: T.ter, paddingTop: 80, fontFamily: T.disp }}>
          …
        </div>
      </Screen>
    );
  }

  const meId = ctx.me?.id;
  const feed = jar.activity.slice(0, 4);

  return (
    <Screen>
      <TopBar
        onBack={() => ctx.back()}
        title={jar.name}
        trailing={
          <IconBtn onClick={() => ctx.nav("invite", { jarId: jar.id })}>
            <Icon.share style={{ width: 17, height: 17 }} />
          </IconBtn>
        }
      />

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
      <div style={{ margin: "24px 0 10px" }}>
        <Btn
          kind="red"
          icon={<span style={{ fontSize: 20 }}>💔</span>}
          onClick={() => ctx.nav("logSlip", { jarId: jar.id })}
        >
          I texted my ex
        </Btn>
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 26 }}>
        <Btn
          kind="dark"
          style={{ height: 50, fontSize: 16 }}
          icon={<Icon.flag style={{ width: 17, height: 17 }} />}
          onClick={() => ctx.nav("report", { jarId: jar.id })}
        >
          Report
        </Btn>
        <Btn
          kind="dark"
          style={{ height: 50, fontSize: 16 }}
          onClick={() => ctx.nav("settle", { jarId: jar.id })}
        >
          Settle up
        </Btn>
      </div>

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
    </Screen>
  );
}

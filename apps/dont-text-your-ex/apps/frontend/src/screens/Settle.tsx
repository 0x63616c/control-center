import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx } from "../appctx";
import { money, T } from "../theme";
import type { JarDetailDTO } from "../types";
import { Btn, Screen, TopBar } from "../ui";

export function Settle({ ctx }: { ctx: AppCtx }) {
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

  const owe = jar?.members.find((m) => m.user.id === ctx.me?.id)?.tallyCents ?? 0;

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
          <span style={{ color: T.sec }}>Your slips in {jar?.name ?? "this jar"}</span>
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

import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx } from "../appctx";
import { Stepper } from "../bits";
import { money, T } from "../theme";
import type { JarDetailDTO } from "../types";
import { Btn, Screen, TopBar } from "../ui";
import { inputStyle, labelStyle } from "./common";

export function LogSlip({ ctx }: { ctx: AppCtx }) {
  const jarId = ctx.route.params.jarId as string;
  const [jar, setJar] = useState<JarDetailDTO | null>(null);
  const [cents, setCents] = useState(500);
  const [note, setNote] = useState("");
  const [ex, setEx] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const myExes = ctx.me?.exes ?? [];
  const myStreak = jar?.members.find((m) => m.user.id === ctx.me?.id)?.daysClean ?? 0;

  useEffect(() => {
    let alive = true;
    api
      .jar(jarId)
      .then((d) => {
        if (!alive) return;
        setJar(d);
        setCents(d.defaultCents);
        setEx(myExes[0] ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jarId, myExes[0]]);

  const doLog = async () => {
    if (busy || !jar) return;
    setBusy(true);
    try {
      await api.logSlip(jar.id, {
        amountCents: cents,
        note: note || undefined,
        exLabel: ex || undefined,
      });
      ctx.fireBurst();
      ctx.refreshPending();
      ctx.nav("jar", { jarId: jar.id }, true);
    } catch {
      setBusy(false);
    }
  };

  if (!jar) {
    return (
      <Screen>
        <TopBar onBack={() => ctx.back()} title="Fess up" />
        <div style={{ color: T.ter, textAlign: "center", paddingTop: 60, fontFamily: T.disp }}>
          …
        </div>
      </Screen>
    );
  }

  return (
    <Screen style={{ display: "flex", flexDirection: "column" }}>
      <TopBar onBack={() => ctx.back()} title="Fess up" />
      <div style={{ width: "100%" }}>
        <p
          style={{
            width: "100%",
            fontFamily: T.disp,
            fontWeight: 700,
            fontSize: 26,
            letterSpacing: "-0.02em",
            lineHeight: 1.1,
            margin: "6px 0 26px",
          }}
        >
          So you <span style={{ color: T.red }}>caved.</span> How much is that gonna cost you?
        </p>

        <div style={{ width: "100%", marginBottom: 30 }}>
          <Stepper cents={cents} onChange={setCents} step={jar.defaultCents} />
          <div style={{ textAlign: "center", fontSize: 12.5, color: T.ter, marginTop: 12 }}>
            jar default is {money(jar.defaultCents)} a slip
          </div>
        </div>

        {myExes.length > 0 && (
          <div style={{ width: "100%", marginBottom: 22 }}>
            <span style={labelStyle}>
              Which one? <span style={{ color: T.ter }}>(private - only you see this)</span>
            </span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {myExes.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEx(e === ex ? null : e)}
                  style={{
                    padding: "9px 16px",
                    borderRadius: 999,
                    cursor: "pointer",
                    fontFamily: T.ui,
                    fontWeight: 600,
                    fontSize: 14.5,
                    background: e === ex ? T.gold : T.surface2,
                    color: e === ex ? "#000" : T.text,
                    border: `1px solid ${e === ex ? T.gold : T.hair}`,
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ width: "100%", marginBottom: 28 }}>
          <span style={labelStyle}>
            Wanna explain yourself? <span style={{ color: T.ter }}>(optional)</span>
          </span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="“it was a moment of weakness…”"
            style={inputStyle}
          />
        </div>

        <Btn kind="red" onClick={() => setConfirming(true)}>
          Add {money(cents)} to my shame
        </Btn>
      </div>

      {confirming && (
        // biome-ignore lint/a11y/noStaticElementInteractions: dismiss backdrop, not a semantic action
        <div
          role="presentation"
          onClick={() => setConfirming(false)}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 180,
            background: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "flex-end",
            animation: "tye-fade .2s ease",
            cursor: "default",
          }}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: presentation container prevents event bubbling to backdrop */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: propagation stopper only, no semantic action */}
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              background: T.surface,
              borderRadius: "28px 28px 0 0",
              border: `1px solid ${T.hair}`,
              borderBottom: "none",
              padding: "26px 22px 40px",
              animation: "tye-up .25s cubic-bezier(.2,.8,.2,1)",
            }}
          >
            <div style={{ fontSize: 40, textAlign: "center", marginBottom: 8 }}>🫣</div>
            <h3
              style={{
                fontFamily: T.disp,
                fontWeight: 800,
                fontSize: 24,
                textAlign: "center",
                letterSpacing: "-0.02em",
                margin: "0 0 6px",
              }}
            >
              You sure-sure?
            </h3>
            <p
              style={{
                textAlign: "center",
                color: T.sec,
                fontSize: 15,
                lineHeight: 1.4,
                margin: "0 0 22px",
              }}
            >
              This resets your <b style={{ color: T.green }}>{myStreak}-day clean streak</b> to zero
              and tells the whole jar. No takebacks.
            </p>
            <Btn kind="red" disabled={busy} onClick={doLog}>
              Yeah. I did it. 💸
            </Btn>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              style={{
                width: "100%",
                height: 50,
                marginTop: 8,
                background: "none",
                border: "none",
                color: T.sec,
                fontFamily: T.ui,
                fontWeight: 600,
                fontSize: 15,
                cursor: "pointer",
              }}
            >
              Actually I'm strong, never mind
            </button>
          </div>
        </div>
      )}
    </Screen>
  );
}

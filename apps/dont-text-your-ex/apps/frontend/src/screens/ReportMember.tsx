import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { Toggle } from "../bits";
import { T } from "../theme";
import type { JarDetailDTO, MemberDTO } from "../types";
import { Avatar, Btn, Screen, TopBar } from "../ui";
import { inputStyle, labelStyle } from "./common";

export function ReportMember({ ctx }: { ctx: AppCtx<RouteFor<"report">> }) {
  const { jarId } = ctx.route;
  const [jar, setJar] = useState<JarDetailDTO | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [anon, setAnon] = useState(false);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .jar(jarId)
      .then((d) => {
        if (!alive) return;
        setJar(d);
        const others = d.members.filter((m) => m.user.id !== ctx.me?.id);
        setTarget(others[0]?.user.id ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [jarId, ctx.me?.id]);

  const others: MemberDTO[] = (jar?.members ?? []).filter((m) => m.user.id !== ctx.me?.id);
  const canSend = !!target && note.trim().length > 0;

  const send = async () => {
    if (!canSend || !jar || !target || busy) return;
    setBusy(true);
    try {
      await api.createReport(jar.id, {
        accusedId: target,
        note: note || undefined,
        anonymous: anon,
        amountCents: jar.defaultCents,
      });
      setSent(true);
    } catch {
      setBusy(false);
    }
  };

  if (sent && jar && target) {
    const p = jar.members.find((m) => m.user.id === target)?.user;
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
          <div style={{ fontSize: 56 }}>📨</div>
          <h2
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 30,
              letterSpacing: "-0.02em",
              margin: 0,
            }}
          >
            Snitched.
          </h2>
          <p style={{ color: T.sec, fontSize: 16, lineHeight: 1.45, maxWidth: 280, margin: 0 }}>
            {anon ? (
              <>
                <b style={{ color: T.text }}>{p?.name}</b> is getting pinged - and they won't know
                it was you. 🤫
              </>
            ) : (
              <>
                <b style={{ color: T.text }}>{p?.name}</b> is getting pinged right now. They can own
                it or deny it.
              </>
            )}
          </p>
          <div style={{ width: "100%", marginTop: 10 }}>
            <Btn kind="gold" onClick={() => ctx.back()}>
              Back to the jar
            </Btn>
          </div>
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="Report a slip" />
      <p style={{ color: T.sec, fontSize: 15, lineHeight: 1.4, margin: "2px 0 22px" }}>
        Caught someone red-handed? Drop the evidence.
      </p>

      <span style={labelStyle}>Who slipped?</span>
      <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
        {others.map((m) => {
          const on = m.user.id === target;
          return (
            <button
              key={m.user.id}
              type="button"
              onClick={() => setTarget(m.user.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "8px 14px 8px 8px",
                borderRadius: 999,
                cursor: "pointer",
                background: on ? "rgba(255,210,63,0.12)" : T.surface2,
                border: `1.5px solid ${on ? T.gold : T.hair}`,
              }}
            >
              <Avatar user={m.user} size={28} />
              <span style={{ fontFamily: T.disp, fontWeight: 700, fontSize: 15, color: T.text }}>
                {m.user.name}
              </span>
            </button>
          );
        })}
        {others.length === 0 && (
          <div style={{ color: T.ter, fontSize: 14 }}>
            You're the only one here. Invite someone to snitch on.
          </div>
        )}
      </div>

      <span style={labelStyle}>
        The receipts <span style={{ color: T.ter }}>(screenshots)</span>
      </span>
      <div style={{ marginBottom: 24 }}>
        <button
          type="button"
          aria-label="Screenshot attachments unavailable"
          disabled
          style={{
            width: "100%",
            minHeight: 58,
            borderRadius: 16,
            border: `1.5px dashed ${T.hair}`,
            background: T.surface2,
            color: T.ter,
            cursor: "not-allowed",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: T.ui,
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          Screenshot attachments aren’t available yet
        </button>
      </div>

      <span style={labelStyle}>Add what happened</span>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder="“replied to her story in 4 seconds flat…”"
        style={{ ...inputStyle, marginBottom: 20 }}
      />

      <div
        data-testid="anon-row"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          background: T.surface,
          border: `1px solid ${T.hair}`,
          borderRadius: 16,
          padding: "14px 16px",
          marginBottom: 14,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: T.disp, fontWeight: 700, fontSize: 15.5 }}>
            Send anonymously 🥷
          </div>
          <div style={{ fontSize: 12.5, color: T.sec, marginTop: 2 }}>
            They'll just see “someone in the jar.”
          </div>
        </div>
        <Toggle on={anon} onChange={setAnon} />
      </div>

      {!canSend && (
        <div style={{ fontSize: 12.5, color: T.ter, textAlign: "center", marginBottom: 12 }}>
          Add a note to send.
        </div>
      )}
      <Btn kind="red" disabled={!canSend || busy} onClick={send}>
        {anon ? "Send it anonymously" : "Send the report"}
      </Btn>
    </Screen>
  );
}

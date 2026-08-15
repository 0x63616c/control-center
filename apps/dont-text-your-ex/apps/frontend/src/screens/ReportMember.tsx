import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppCtx } from "../appctx";
import { EvidenceShot, EvidenceViewer, Toggle } from "../bits";
import { Icon } from "../icons";
import { T } from "../theme";
import type { EvidenceThread, JarDetailDTO, MemberDTO } from "../types";
import { Avatar, Btn, Screen, TopBar } from "../ui";
import { inputStyle, labelStyle } from "./common";

// camera-roll mock shots a user can attach as evidence
const ROLL: EvidenceThread[] = [
  {
    to: "Christie",
    time: "2:14 AM",
    bubbles: [
      { me: true, text: "u up?" },
      { me: false, text: "calum it is 2am" },
      { me: true, text: "i know. i just miss the way you-" },
    ],
  },
  {
    to: "Christie",
    time: "2:21 AM",
    bubbles: [
      { me: false, text: "we broke up for a reason" },
      { me: true, text: "name one" },
      { me: true, text: "exactly" },
    ],
  },
  {
    to: "Eddie",
    time: "11:47 PM",
    bubbles: [
      { me: true, text: "happy birthday 🥹" },
      { me: true, text: "thinking about u" },
      { me: false, text: "who is this" },
    ],
  },
];

const keyOf = (s: EvidenceThread) => `${s.to}-${s.time}`;

export function ReportMember({ ctx }: { ctx: AppCtx }) {
  const jarId = ctx.route.params.jarId as string;
  const [jar, setJar] = useState<JarDetailDTO | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [shots, setShots] = useState<EvidenceThread[]>([]);
  const [anon, setAnon] = useState(false);
  const [picking, setPicking] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
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
  const canSend = !!target && (note.trim().length > 0 || shots.length > 0);
  const toggleShot = (s: EvidenceThread) =>
    setShots((p) =>
      p.find((x) => keyOf(x) === keyOf(s)) ? p.filter((x) => keyOf(x) !== keyOf(s)) : [...p, s],
    );

  const send = async () => {
    if (!canSend || !jar || !target || busy) return;
    setBusy(true);
    try {
      await api.createReport(jar.id, {
        accusedId: target,
        note: note || undefined,
        anonymous: anon,
        amountCents: jar.defaultCents,
        evidence: shots,
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
      <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
        {shots.map((s, i) => (
          <div key={keyOf(s)} style={{ position: "relative" }}>
            <EvidenceShot shot={s} w={104} onOpen={() => setViewer(i)} />
            <button
              type="button"
              onClick={() => toggleShot(s)}
              style={{
                position: "absolute",
                top: -7,
                right: -7,
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: T.red,
                border: "2px solid #000",
                color: "#fff",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
              }}
            >
              <Icon.x style={{ width: 12, height: 12 }} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setPicking(true)}
          style={{
            width: 104,
            height: 156,
            borderRadius: 16,
            border: `1.5px dashed ${T.hair}`,
            background: T.surface2,
            color: T.sec,
            cursor: "pointer",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            fontFamily: T.ui,
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          <Icon.plus /> Add
        </button>
      </div>

      <span style={labelStyle}>
        Add context <span style={{ color: T.ter }}>(optional if you've got receipts)</span>
      </span>
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
          Add a screenshot or a note to send.
        </div>
      )}
      <Btn kind="red" disabled={!canSend || busy} onClick={send}>
        {anon ? "Send it anonymously" : "Send the report"}
      </Btn>

      {picking && (
        // biome-ignore lint/a11y/noStaticElementInteractions: dismiss backdrop, not a semantic action
        <div
          role="presentation"
          onClick={() => setPicking(false)}
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
              padding: "20px 20px 40px",
              animation: "tye-up .25s cubic-bezier(.2,.8,.2,1)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <h3 style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 20, margin: 0 }}>
                Camera roll
              </h3>
              <button
                type="button"
                onClick={() => setPicking(false)}
                style={{
                  background: "none",
                  border: "none",
                  color: T.gold,
                  fontFamily: T.ui,
                  fontWeight: 700,
                  fontSize: 16,
                  cursor: "pointer",
                }}
              >
                Done
              </button>
            </div>
            <div style={{ display: "flex", gap: 10, overflowX: "auto" }}>
              {ROLL.map((s) => {
                const on = shots.find((x) => keyOf(x) === keyOf(s));
                return (
                  <button
                    key={keyOf(s)}
                    type="button"
                    data-testid="roll-shot"
                    onClick={() => toggleShot(s)}
                    style={{
                      position: "relative",
                      border: "none",
                      background: "none",
                      padding: 0,
                      cursor: "pointer",
                      flexShrink: 0,
                    }}
                  >
                    <div
                      style={{
                        borderRadius: 16,
                        outline: on ? `3px solid ${T.gold}` : "none",
                        outlineOffset: 2,
                      }}
                    >
                      <EvidenceShot shot={s} w={110} interactive={false} />
                    </div>
                    {on && (
                      <div
                        style={{
                          position: "absolute",
                          top: 6,
                          left: 6,
                          width: 24,
                          height: 24,
                          borderRadius: "50%",
                          background: T.gold,
                          color: "#000",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          pointerEvents: "none",
                        }}
                      >
                        <Icon.check style={{ width: 14, height: 14 }} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <EvidenceViewer
        shots={shots}
        index={viewer}
        onClose={() => setViewer(null)}
        onIndex={setViewer}
      />
    </Screen>
  );
}

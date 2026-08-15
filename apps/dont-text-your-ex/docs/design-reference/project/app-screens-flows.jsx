// app-screens-flows.jsx - LogSlip, ReportMember, ConfirmDeny, Settle

// shared input styles
const inputStyle = {
  width: "100%",
  background: T.surface2,
  border: `1px solid ${T.hair}`,
  borderRadius: 16,
  padding: "14px 16px",
  color: T.text,
  fontFamily: T.ui,
  fontSize: 16,
  boxSizing: "border-box",
  outline: "none",
  resize: "none",
};
const labelStyle = {
  fontSize: 13,
  color: T.sec,
  fontWeight: 600,
  marginBottom: 8,
  display: "block",
};

// camera-roll mock shots a user can attach as evidence
const ROLL = [
  {
    id: "r1",
    to: "Christie",
    time: "2:14 AM",
    bubbles: [
      { me: true, text: "u up?" },
      { me: false, text: "calum it is 2am" },
      { me: true, text: "i know. i just miss the way you-" },
    ],
  },
  {
    id: "r2",
    to: "Christie",
    time: "2:21 AM",
    bubbles: [
      { me: false, text: "we broke up for a reason" },
      { me: true, text: "name one" },
      { me: true, text: "exactly" },
    ],
  },
  {
    id: "r3",
    to: "Eddie",
    time: "11:47 PM",
    bubbles: [
      { me: true, text: "happy birthday 🥹" },
      { me: true, text: "thinking about u" },
      { me: false, text: "who is this" },
    ],
  },
];

// ───────────────────────── Log a Slip ─────────────────────────
function LogSlip({ ctx }) {
  const j = ctx.jars.find((x) => x.id === ctx.route.params.jarId);
  const myExes = person(ME).exes;
  const [cents, setCents] = React.useState(j.defaultCents);
  const [note, setNote] = React.useState("");
  const [ex, setEx] = React.useState(myExes[0] || null);
  const [confirming, setConfirming] = React.useState(false);

  const doLog = () => {
    ctx.logSlip(j.id, cents);
    ctx.fireBurst();
    ctx.nav("jar", { jarId: j.id }, true);
  };

  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="Fess up" />
      <p
        style={{
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

      <div style={{ marginBottom: 30 }}>
        <Stepper cents={cents} onChange={setCents} step={j.defaultCents} />
        <div style={{ textAlign: "center", fontSize: 12.5, color: T.ter, marginTop: 12 }}>
          jar default is {money(j.defaultCents)} a slip
        </div>
      </div>

      {myExes.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <span style={labelStyle}>
            Which one? <span style={{ color: T.ter }}>(private - only you see this)</span>
          </span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {myExes.map((e) => (
              <button
                key={e}
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

      <div style={{ marginBottom: 28 }}>
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

      {/* friction confirm sheet */}
      {confirming && (
        <div
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
          }}
        >
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
              This resets your <b style={{ color: T.green }}>4-day clean streak</b> to zero and
              tells the whole jar. No takebacks.
            </p>
            <Btn kind="red" onClick={doLog}>
              Yeah. I did it. 💸
            </Btn>
            <button
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

// ───────────────────────── Report a Member ─────────────────────────
function ReportMember({ ctx }) {
  const j = ctx.jars.find((x) => x.id === ctx.route.params.jarId);
  const others = j.members.filter((m) => m.user !== ME);
  const [target, setTarget] = React.useState(others[0]?.user || null);
  const [note, setNote] = React.useState("");
  const [shots, setShots] = React.useState([]);
  const [anon, setAnon] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [viewer, setViewer] = React.useState(null);
  const [sent, setSent] = React.useState(false);

  const canSend = target && (note.trim() || shots.length > 0);
  const toggleShot = (s) =>
    setShots((p) => (p.find((x) => x.id === s.id) ? p.filter((x) => x.id !== s.id) : [...p, s]));

  if (sent) {
    const p = person(target);
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
                <b style={{ color: T.text }}>{p.name}</b> is getting pinged - and they won't know it
                was you. 🤫
              </>
            ) : (
              <>
                <b style={{ color: T.text }}>{p.name}</b> is getting pinged right now. They can own
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
          const p = person(m.user);
          const on = m.user === target;
          return (
            <button
              key={m.user}
              onClick={() => setTarget(m.user)}
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
              <Avatar id={m.user} size={28} />
              <span style={{ fontFamily: T.disp, fontWeight: 700, fontSize: 15, color: T.text }}>
                {p.name}
              </span>
            </button>
          );
        })}
      </div>

      <span style={labelStyle}>
        The receipts <span style={{ color: T.ter }}>(screenshots)</span>
      </span>
      <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
        {shots.map((s, i) => (
          <div key={s.id} style={{ position: "relative" }}>
            <EvidenceShot shot={s} w={104} onOpen={() => setViewer(i)} />
            <button
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
      <Btn kind="red" disabled={!canSend} onClick={() => setSent(true)}>
        {anon ? "Send it anonymously" : "Send the report"}
      </Btn>

      {/* camera roll picker */}
      {picking && (
        <div
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
          }}
        >
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
                const on = shots.find((x) => x.id === s.id);
                return (
                  <button
                    key={s.id}
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
                      <EvidenceShot shot={s} w={110} onOpen={() => toggleShot(s)} />
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

// ───────────────────────── Confirm / Deny (accused) ─────────────────────────
function ConfirmDeny({ ctx }) {
  const r = PENDING_REPORT;
  const j = JARS.find((x) => x.id === r.jar);
  const accuser = r.anonymous ? "Someone in the jar" : person(r.accuser).name;
  const [viewer, setViewer] = React.useState(null);
  const [done, setDone] = React.useState(null); // 'owned' | 'denied'

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
                You owned it. <b style={{ color: T.gold }}>{money(r.amountCents)}</b> added to your
                tally and your streak's back to zero. The jar saw.
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
          in {j.name} · {r.ago} ago
        </div>
      </div>

      {/* note */}
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
        <div style={{ fontSize: 16, lineHeight: 1.45 }}>“{r.note}”</div>
      </div>

      {/* evidence */}
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
        The receipts ({r.evidence.length})
      </div>
      <div
        style={{ display: "flex", gap: 10, marginBottom: 30, overflowX: "auto", paddingBottom: 4 }}
      >
        {r.evidence.map((s, i) => (
          <EvidenceShot key={s.id} shot={s} w={128} onOpen={() => setViewer(i)} />
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Btn
          kind="gold"
          onClick={() => {
            ctx.ownReport();
            setDone("owned");
          }}
        >
          Own it - add {money(r.amountCents)} 🫡
        </Btn>
        <Btn
          kind="dark"
          onClick={() => {
            ctx.denyReport();
            setDone("denied");
          }}
        >
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
        shots={r.evidence}
        index={viewer}
        onClose={() => setViewer(null)}
        onIndex={setViewer}
      />
    </Screen>
  );
}

// ───────────────────────── Settle up (inert) ─────────────────────────
function Settle({ ctx }) {
  const j = ctx.jars.find((x) => x.id === ctx.route.params.jarId);
  const owe = myMembership(j).tallyCents;
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
          <span style={{ color: T.sec }}>Your slips in {j.name}</span>
          <span style={{ fontWeight: 700, fontFamily: T.disp }}>{money(owe)}</span>
        </div>
        <div style={{ height: 1, background: T.hair2, margin: "8px 0" }} />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 15,
            padding: "6px 0",
          }}
        >
          <span style={{ color: T.sec }}>Processing fee</span>
          <span style={{ fontWeight: 700, fontFamily: T.disp, color: T.green }}>$0.00</span>
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
        Right now this is purely a guilt scoreboard - no card gets charged. Apple Pay drops in
        later. The shame, however, is live.
      </p>
    </Screen>
  );
}

Object.assign(window, { LogSlip, ReportMember, ConfirmDeny, Settle, inputStyle, labelStyle });

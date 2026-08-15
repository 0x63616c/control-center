// app-screens-admin.jsx - Create, Join, Invite, Profile

function Create({ ctx }) {
  const [name, setName] = React.useState("");
  const [rule, setRule] = React.useState("");
  const [cents, setCents] = React.useState(500);
  const newId = React.useRef("jar_new");
  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="New jar" />
      <p style={{ color: T.sec, fontSize: 15, lineHeight: 1.4, margin: "2px 0 24px" }}>
        Round up the friends who'll keep you honest.
      </p>

      <span style={labelStyle}>Jar name</span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="“The Group Chat”"
        style={{ ...inputStyle, marginBottom: 22 }}
      />

      <span style={labelStyle}>
        The rule <span style={{ color: T.ter }}>(set the tone)</span>
      </span>
      <textarea
        value={rule}
        onChange={(e) => setRule(e.target.value)}
        rows={2}
        placeholder="“Don't text your ex. We mean it.”"
        style={{ ...inputStyle, marginBottom: 22 }}
      />

      <span style={labelStyle}>Cost per slip</span>
      <div
        style={{
          background: T.surface,
          border: `1px solid ${T.hair}`,
          borderRadius: 20,
          padding: "22px 0",
          marginBottom: 30,
        }}
      >
        <Stepper cents={cents} onChange={setCents} step={100} />
      </div>

      <Btn
        kind="gold"
        disabled={!name.trim()}
        onClick={() => ctx.nav("invite", { jarId: "jar_8af2e52a", fresh: true })}
      >
        Create jar & invite friends
      </Btn>
    </Screen>
  );
}

function Join({ ctx }) {
  const [code, setCode] = React.useState("");
  const [preview, setPreview] = React.useState(false);
  const j = JARS[0];
  if (preview) {
    const ids = j.members.map((m) => m.user);
    return (
      <Screen>
        <TopBar onBack={() => setPreview(false)} title="Join jar" />
        <div
          style={{
            background: T.surface,
            border: `1px solid ${T.hair}`,
            borderRadius: 26,
            padding: "26px 22px",
            textAlign: "center",
            margin: "8px 0 24px",
          }}
        >
          <div
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 30,
              letterSpacing: "-0.03em",
              marginBottom: 14,
            }}
          >
            {j.name}
          </div>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
            <AvatarStack ids={ids} size={40} />
          </div>
          <div style={{ fontSize: 14, color: T.sec, lineHeight: 1.4, marginBottom: 18 }}>
            “{j.rule}”
          </div>
          <div style={{ display: "inline-flex", gap: 18 }}>
            <div>
              <div style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 22 }}>{ids.length}</div>
              <div style={{ fontSize: 12, color: T.sec }}>members</div>
            </div>
            <div>
              <div style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 22, color: T.gold }}>
                {money(j.defaultCents)}
              </div>
              <div style={{ fontSize: 12, color: T.sec }}>per slip</div>
            </div>
          </div>
        </div>
        <Btn kind="gold" onClick={() => ctx.nav("jar", { jarId: j.id }, true)}>
          Join the shame
        </Btn>
      </Screen>
    );
  }
  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="Join a jar" />
      <p style={{ color: T.sec, fontSize: 15, lineHeight: 1.4, margin: "2px 0 26px" }}>
        Got an invite code? Punch it in.
      </p>
      <div style={{ display: "flex", gap: 10, justifyContent: "center", marginBottom: 26 }}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            style={{
              width: 46,
              height: 58,
              borderRadius: 13,
              background: T.surface2,
              border: `1.5px solid ${code.length === i ? T.gold : T.hair}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 26,
            }}
          >
            {code[i] || ""}
          </div>
        ))}
      </div>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
        placeholder="Type or paste code"
        style={{ ...inputStyle, textAlign: "center", marginBottom: 14, letterSpacing: "0.1em" }}
      />
      <Btn kind="gold" disabled={code.length < 4} onClick={() => setPreview(true)}>
        Preview jar
      </Btn>
      <button
        onClick={() => setPreview(true)}
        style={{
          width: "100%",
          height: 50,
          marginTop: 10,
          background: "none",
          border: "none",
          color: T.sec,
          fontFamily: T.ui,
          fontWeight: 600,
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        or open an invite link →
      </button>
    </Screen>
  );
}

function Invite({ ctx }) {
  const fresh = ctx.route.params.fresh;
  const j = ctx.jars.find((x) => x.id === ctx.route.params.jarId) || JARS[0];
  const code = "XEX" + "24K";
  const link = "textyourex.app/j/" + code;
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const shareApps = [
    { name: "Messages", bg: "#34C759", glyph: "💬" },
    { name: "WhatsApp", bg: "#25D366", glyph: "🟢" },
    {
      name: "Instagram",
      bg: "linear-gradient(45deg,#FEDA75,#FA7E1E,#D62976,#962FBF)",
      glyph: "📸",
    },
    { name: "Copy link", bg: T.surface2, glyph: "🔗" },
  ];

  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="Invite to jar" />
      {fresh && (
        <div
          style={{
            background: "rgba(48,209,88,0.12)",
            border: `1px solid rgba(48,209,88,0.35)`,
            borderRadius: 16,
            padding: "12px 16px",
            marginBottom: 18,
            fontSize: 14,
            color: T.green,
            fontWeight: 600,
          }}
        >
          ✓ Jar created. Now drag your friends down with you.
        </div>
      )}
      <div style={{ textAlign: "center", padding: "6px 0 4px" }}>
        <div style={{ fontSize: 13.5, color: T.sec, fontWeight: 600, marginBottom: 8 }}>
          SHARE THIS CODE
        </div>
        <div
          style={{
            fontFamily: T.disp,
            fontWeight: 800,
            fontSize: 52,
            color: T.gold,
            letterSpacing: "0.08em",
          }}
        >
          {code}
        </div>
      </div>

      <button
        onClick={copy}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 12,
          background: T.surface,
          border: `1px solid ${T.hair}`,
          borderRadius: 16,
          padding: "14px 16px",
          margin: "20px 0 26px",
          cursor: "pointer",
          color: T.text,
        }}
      >
        <span style={{ flex: 1, textAlign: "left", fontFamily: T.ui, fontSize: 15, color: T.sec }}>
          {link}
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: copied ? T.green : T.gold,
            fontFamily: T.ui,
            fontWeight: 700,
            fontSize: 14,
          }}
        >
          {copied ? (
            <>
              <Icon.check style={{ width: 16, height: 16 }} /> Copied
            </>
          ) : (
            <>
              <Icon.copy /> Copy
            </>
          )}
        </span>
      </button>

      <div
        style={{
          fontSize: 12,
          color: T.sec,
          fontWeight: 600,
          marginBottom: 14,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        Send it via
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 30 }}>
        {shareApps.map((a) => (
          <button
            key={a.name}
            onClick={a.name === "Copy link" ? copy : undefined}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              width: 72,
            }}
          >
            <div
              style={{
                width: 60,
                height: 60,
                borderRadius: 16,
                background: a.bg,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 26,
                border: a.name === "Copy link" ? `1px solid ${T.hair}` : "none",
              }}
            >
              {a.glyph}
            </div>
            <span style={{ fontFamily: T.ui, fontSize: 11.5, color: T.sec, fontWeight: 600 }}>
              {a.name}
            </span>
          </button>
        ))}
      </div>

      <Btn kind="gold" onClick={() => ctx.nav("jar", { jarId: j.id }, true)}>
        {fresh ? "Take me to my jar" : "Done"}
      </Btn>
    </Screen>
  );
}

function Profile({ ctx }) {
  const me = person(ME);
  const [notif, setNotif] = React.useState({
    slips: true,
    reports: true,
    joins: false,
    milestones: true,
  });
  const row = (label, sub, key) => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "14px 16px",
        borderTop: `1px solid ${T.hair2}`,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15.5, fontWeight: 600 }}>{label}</div>
        {sub && <div style={{ fontSize: 12.5, color: T.sec, marginTop: 1 }}>{sub}</div>}
      </div>
      <Toggle on={notif[key]} onChange={(v) => setNotif((p) => ({ ...p, [key]: v }))} />
    </div>
  );

  return (
    <Screen>
      <TopBar title="Profile" />
      {/* identity */}
      <button
        onClick={() => ctx.nav("editProfile")}
        style={{
          width: "100%",
          textAlign: "left",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: T.text,
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 26,
          padding: 0,
        }}
      >
        <Avatar id={ME} size={68} />
        <div style={{ flex: 1 }}>
          <div
            style={{ fontFamily: T.disp, fontWeight: 800, fontSize: 26, letterSpacing: "-0.02em" }}
          >
            {me.name}
          </div>
          <div style={{ fontSize: 13.5, color: T.sec, marginTop: 2 }}>
            4 days clean · {money(7000)} in the hole
          </div>
        </div>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            color: T.gold,
            fontFamily: T.ui,
            fontWeight: 700,
            fontSize: 14,
          }}
        >
          Edit <Icon.chev style={{ width: 7, height: 12 }} />
        </span>
      </button>

      <div
        style={{
          fontSize: 12,
          color: T.sec,
          fontWeight: 600,
          margin: "0 4px 10px",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        Share my clean streak
      </div>
      <div
        style={{
          background: T.surface,
          border: `1px solid ${T.hair}`,
          borderRadius: 18,
          overflow: "hidden",
          marginBottom: 26,
        }}
      >
        {ctx.jars.map((j, i) => {
          const m = myMembership(j);
          return (
            <div
              key={j.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "14px 16px",
                borderTop: i ? `1px solid ${T.hair2}` : "none",
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15.5, fontWeight: 600 }}>{j.name}</div>
                <div style={{ fontSize: 12.5, color: T.sec, marginTop: 1 }}>
                  {m.shareStreak ? "Friends see your streak" : "Hidden - others see “-”"}
                </div>
              </div>
              <Toggle on={m.shareStreak} onChange={(v) => ctx.setShare(j.id, v)} />
            </div>
          );
        })}
      </div>

      <div
        style={{
          fontSize: 12,
          color: T.sec,
          fontWeight: 600,
          margin: "0 4px 10px",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        Notify me when…
      </div>
      <div
        style={{
          background: T.surface,
          border: `1px solid ${T.hair}`,
          borderRadius: 18,
          overflow: "hidden",
          marginBottom: 26,
        }}
      >
        <div style={{ borderTop: "none" }}>
          {row("Someone caves", "A slip gets logged in your jar", "slips")}
        </div>
        {row("You're reported", "Time to fess up or fight it", "reports")}
        {row("Someone joins", "Fresh meat enters a jar", "joins")}
        {row("Jar milestones", "The pot crosses $50, $100…", "milestones")}
      </div>

      <button
        onClick={() => ctx.tab("onboarding")}
        style={{
          width: "100%",
          height: 54,
          borderRadius: 16,
          background: T.surface2,
          border: `1px solid ${T.hair}`,
          color: T.red,
          fontFamily: T.disp,
          fontWeight: 700,
          fontSize: 17,
          cursor: "pointer",
        }}
      >
        Sign out
      </button>
      <p style={{ textAlign: "center", fontSize: 12, color: T.ter, marginTop: 16 }}>
        Text Your Ex · v1.0 · made with poor impulse control
      </p>
    </Screen>
  );
}

Object.assign(window, { Create, Join, Invite, Profile });

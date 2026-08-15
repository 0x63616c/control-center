// app-screens-auth.jsx - PhoneEntry, CodeEntry, SetupProfile, EditProfile + AvatarEditor, NumberPad

const AV_COLORS = [
  "#FF375F",
  "#5E5CE6",
  "#30D158",
  "#FF9F0A",
  "#0A84FF",
  "#BF5AF2",
  "#FF6482",
  "#64D2FF",
];
const AV_EMOJI = ["-", "🫠", "💔", "🥲", "😈", "🦝", "🍷", "👀"];

// custom dark number pad
function NumberPad({ onPress }) {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3,1fr)",
        gap: 12,
        maxWidth: 320,
        margin: "0 auto",
      }}
    >
      {keys.map((k, i) =>
        k === "" ? (
          <div key={i} />
        ) : (
          <button
            key={i}
            onClick={() => onPress(k)}
            style={{
              height: 60,
              borderRadius: 16,
              cursor: "pointer",
              background: k === "del" ? "transparent" : T.surface2,
              border: k === "del" ? "none" : `1px solid ${T.hair}`,
              color: T.text,
              fontFamily: T.disp,
              fontWeight: 700,
              fontSize: 26,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {k === "del" ? "⌫" : k}
          </button>
        ),
      )}
    </div>
  );
}

// Phone number entry
function PhoneEntry({ ctx }) {
  const [num, setNum] = React.useState("");
  const fmt = (d) => {
    if (d.length <= 3) return d;
    if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
  };
  const press = (k) => setNum((n) => (k === "del" ? n.slice(0, -1) : n.length < 10 ? n + k : n));
  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="" />
      <div style={{ display: "flex", flexDirection: "column", minHeight: 660 }}>
        <div style={{ paddingTop: 6 }}>
          <h1
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 32,
              letterSpacing: "-0.03em",
              margin: "0 0 8px",
            }}
          >
            What's your number?
          </h1>
          <p style={{ color: T.sec, fontSize: 15.5, lineHeight: 1.4, margin: 0 }}>
            We'll text you a code. The irony isn't lost on us.
          </p>
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: T.surface2,
                border: `1px solid ${T.hair}`,
                borderRadius: 12,
                padding: "10px 14px",
                fontFamily: T.disp,
                fontWeight: 700,
                fontSize: 22,
              }}
            >
              🇺🇸 +1
            </div>
            <div
              style={{
                fontFamily: T.disp,
                fontWeight: 800,
                fontSize: 30,
                letterSpacing: "0.01em",
                minWidth: 200,
                color: num ? T.text : T.ter,
              }}
            >
              {num ? fmt(num) : "(555) 000-0000"}
            </div>
          </div>
        </div>
        <div style={{ paddingBottom: 8 }}>
          <div style={{ marginBottom: 18 }}>
            <NumberPad onPress={press} />
          </div>
          <Btn kind="gold" disabled={num.length < 10} onClick={() => ctx.nav("code", { num })}>
            Send me the code
          </Btn>
        </div>
      </div>
    </Screen>
  );
}

// OTP code entry
function CodeEntry({ ctx }) {
  const [code, setCode] = React.useState("");
  const press = (k) =>
    setCode((c) => {
      if (k === "del") return c.slice(0, -1);
      const n = c.length < 6 ? c + k : c;
      if (n.length === 6) setTimeout(() => ctx.nav("setup", {}), 280);
      return n;
    });
  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="" />
      <div style={{ display: "flex", flexDirection: "column", minHeight: 660 }}>
        <div style={{ paddingTop: 6 }}>
          <h1
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 32,
              letterSpacing: "-0.03em",
              margin: "0 0 8px",
            }}
          >
            Check your texts
          </h1>
          <p style={{ color: T.sec, fontSize: 15.5, lineHeight: 1.4, margin: 0 }}>
            Sent a 6-digit code to{" "}
            {ctx.route.params.num
              ? `(${ctx.route.params.num.slice(0, 3)}) •••-${ctx.route.params.num.slice(6)}`
              : "your phone"}
            .
          </p>
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 22,
          }}
        >
          <div style={{ display: "flex", gap: 9 }}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                style={{
                  width: 44,
                  height: 56,
                  borderRadius: 13,
                  background: T.surface2,
                  border: `1.5px solid ${code.length === i ? T.gold : T.hair}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: T.disp,
                  fontWeight: 800,
                  fontSize: 26,
                  color: T.text,
                }}
              >
                {code[i] || ""}
              </div>
            ))}
          </div>
          <button
            style={{
              background: "none",
              border: "none",
              color: T.gold,
              fontFamily: T.ui,
              fontWeight: 600,
              fontSize: 14.5,
              cursor: "pointer",
            }}
          >
            Resend code
          </button>
        </div>
        <div style={{ paddingBottom: 8 }}>
          <NumberPad onPress={press} />
        </div>
      </div>
    </Screen>
  );
}

// Reusable avatar editor (color / emoji / photo upload)
function AvatarEditor({ draft, setDraft }) {
  const fileRef = React.useRef(null);
  const onFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setDraft((d) => ({ ...d, photo: r.result }));
    r.readAsDataURL(f);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ position: "relative", marginBottom: 18 }}>
        <Avatar id={ME} size={104} override={draft} />
        <button
          onClick={() => fileRef.current.click()}
          style={{
            position: "absolute",
            bottom: -2,
            right: -2,
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: T.gold,
            border: "3px solid #000",
            color: "#000",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
          }}
        >
          📷
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={onFile}
          style={{ display: "none" }}
        />
      </div>
      {draft.photo && (
        <button
          onClick={() => setDraft((d) => ({ ...d, photo: null }))}
          style={{
            background: "none",
            border: "none",
            color: T.sec,
            fontFamily: T.ui,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            marginBottom: 14,
          }}
        >
          Remove photo
        </button>
      )}
      {!draft.photo && (
        <>
          <div
            style={{
              display: "flex",
              gap: 9,
              marginBottom: 14,
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            {AV_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setDraft((d) => ({ ...d, color: c }))}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  background: c,
                  cursor: "pointer",
                  border: draft.color === c ? "3px solid #fff" : "3px solid transparent",
                }}
              />
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            {AV_EMOJI.map((e) => (
              <button
                key={e}
                onClick={() => setDraft((d) => ({ ...d, emoji: e === "-" ? null : e }))}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  cursor: "pointer",
                  fontSize: e === "-" ? 13 : 18,
                  background:
                    draft.emoji === e || (e === "-" && !draft.emoji) ? T.surface2 : "transparent",
                  border: `1px solid ${draft.emoji === e || (e === "-" && !draft.emoji) ? T.gold : T.hair}`,
                  color: T.sec,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {e === "-" ? "Aa" : e}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// New-user profile setup
function SetupProfile({ ctx }) {
  const [draft, setDraft] = React.useState({
    name: "",
    color: ctx.me.color,
    emoji: null,
    photo: null,
  });
  return (
    <Screen>
      <TopBar onBack={() => ctx.back()} title="" />
      <div style={{ textAlign: "center", marginBottom: 6 }}>
        <h1
          style={{
            fontFamily: T.disp,
            fontWeight: 800,
            fontSize: 32,
            letterSpacing: "-0.03em",
            margin: "0 0 6px",
          }}
        >
          Make it official
        </h1>
        <p style={{ color: T.sec, fontSize: 15.5, lineHeight: 1.4, margin: 0 }}>
          Your friends need to know whose shame is whose.
        </p>
      </div>
      <div style={{ margin: "28px 0 26px" }}>
        <AvatarEditor draft={draft} setDraft={setDraft} />
      </div>
      <span style={labelStyle}>Display name</span>
      <input
        value={draft.name}
        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        placeholder="Calum"
        style={{
          ...inputStyle,
          fontSize: 18,
          fontFamily: T.disp,
          fontWeight: 700,
          marginBottom: 26,
        }}
      />
      <Btn
        kind="gold"
        disabled={!draft.name.trim()}
        onClick={() => {
          ctx.setMe({ ...draft, name: draft.name.trim() });
          ctx.tab("home");
        }}
      >
        Start the shame →
      </Btn>
    </Screen>
  );
}

// Edit existing profile (from settings)
function EditProfile({ ctx }) {
  const cur = PEOPLE[ME];
  const [draft, setDraft] = React.useState({
    name: cur.name,
    color: cur.color,
    emoji: cur.emoji || null,
    photo: cur.photo || null,
  });
  return (
    <Screen>
      <TopBar
        onBack={() => ctx.back()}
        title="Edit profile"
        trailing={
          <button
            onClick={() => {
              ctx.setMe({ ...draft, name: draft.name.trim() || cur.name });
              ctx.back();
            }}
            style={{
              background: "none",
              border: "none",
              color: T.gold,
              fontFamily: T.disp,
              fontWeight: 700,
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            Save
          </button>
        }
      />
      <div style={{ margin: "20px 0 26px" }}>
        <AvatarEditor draft={draft} setDraft={setDraft} />
      </div>
      <span style={labelStyle}>Display name</span>
      <input
        value={draft.name}
        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        placeholder="Your name"
        style={{
          ...inputStyle,
          fontSize: 18,
          fontFamily: T.disp,
          fontWeight: 700,
          marginBottom: 26,
        }}
      />
      <Btn
        kind="gold"
        onClick={() => {
          ctx.setMe({ ...draft, name: draft.name.trim() || cur.name });
          ctx.back();
        }}
      >
        Save changes
      </Btn>
    </Screen>
  );
}

Object.assign(window, {
  PhoneEntry,
  CodeEntry,
  SetupProfile,
  EditProfile,
  AvatarEditor,
  NumberPad,
});

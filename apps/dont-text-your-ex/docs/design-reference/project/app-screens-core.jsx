// app-screens-core.jsx - Onboarding, Home, JarDetail, Activity, Profile

// count-up hook for animated tallies
function useCountUp(target, dur = 700) {
  const [v, setV] = React.useState(target);
  const prev = React.useRef(target);
  React.useEffect(() => {
    const from = prev.current,
      to = target;
    prev.current = target;
    if (from === to) return;
    let raf, t0;
    const tick = (t) => {
      if (!t0) t0 = t;
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - (1 - p) ** 3;
      setV(Math.round(from + (to - from) * e));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

// ───────────────────────── Onboarding ─────────────────────────
function Onboarding({ ctx }) {
  return (
    <div
      style={{
        minHeight: "100%",
        background: T.bg,
        color: T.text,
        fontFamily: T.ui,
        display: "flex",
        flexDirection: "column",
        padding: "0 28px 44px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          paddingTop: 60,
        }}
      >
        {/* wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 13,
              background: T.gold,
              color: "#000",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 26,
              transform: "rotate(-6deg)",
            }}
          >
            $
          </div>
          <span
            style={{
              fontFamily: T.ui,
              fontWeight: 700,
              fontSize: 15,
              color: T.sec,
              letterSpacing: "0.04em",
            }}
          >
            EST. AFTER THE BREAKUP
          </span>
        </div>
        <h1
          style={{
            fontFamily: T.disp,
            fontWeight: 800,
            fontSize: 58,
            lineHeight: 0.92,
            letterSpacing: "-0.045em",
            margin: 0,
          }}
        >
          Text
          <br />
          Your
          <br />
          <span style={{ color: T.gold }}>Ex.</span>
        </h1>
        <p
          style={{
            fontFamily: T.disp,
            fontWeight: 700,
            fontSize: 23,
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
            margin: "26px 0 10px",
          }}
        >
          Stop texting your ex.
          <br />
          Or don't - but <span style={{ color: T.gold }}>pay up.</span>
        </p>
        <p style={{ fontSize: 16, color: T.sec, lineHeight: 1.45, margin: 0, maxWidth: 300 }}>
          A shared guilt jar for you and the friends who already know who you shouldn't be texting.
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <button
          onClick={() => ctx.tab("home")}
          style={{
            width: "100%",
            height: 56,
            borderRadius: 16,
            background: "#fff",
            color: "#000",
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
            fontFamily: T.ui,
            fontWeight: 700,
            fontSize: 18,
          }}
        >
          <Icon.apple style={{ marginTop: -2 }} /> Sign in with Apple
        </button>
        <button
          onClick={() => ctx.nav("phone")}
          style={{
            width: "100%",
            height: 56,
            borderRadius: 16,
            background: T.surface2,
            color: T.text,
            border: `1px solid ${T.hair}`,
            cursor: "pointer",
            fontFamily: T.ui,
            fontWeight: 700,
            fontSize: 17,
          }}
        >
          Continue with phone
        </button>
        <div style={{ textAlign: "center", fontSize: 13.5, color: T.sec, marginTop: 2 }}>
          Already in a jar?{" "}
          <button
            onClick={() => ctx.tab("home")}
            style={{
              background: "none",
              border: "none",
              color: T.gold,
              fontFamily: T.ui,
              fontWeight: 700,
              fontSize: 13.5,
              cursor: "pointer",
              padding: 0,
            }}
          >
            Log in
          </button>
        </div>
        <p
          style={{
            textAlign: "center",
            fontSize: 12,
            color: T.ter,
            margin: "4px 0 0",
            lineHeight: 1.4,
          }}
        >
          No money actually moves. Yet. The shame is real though.
        </p>
      </div>
    </div>
  );
}

// ───────────────────────── Home / My Jars ─────────────────────────
function Home({ ctx }) {
  const myTotal = ctx.jars.reduce((s, j) => s + myMembership(j).tallyCents, 0);
  return (
    <Screen>
      <TopBar
        title="Your jars"
        trailing={
          <IconBtn onClick={() => ctx.nav("create")}>
            <Icon.plus />
          </IconBtn>
        }
      />
      {/* damage summary */}
      <div
        style={{
          background: "linear-gradient(135deg, #1c1606, #100c02)",
          border: `1px solid ${T.hair}`,
          borderRadius: 24,
          padding: "20px 22px",
          marginBottom: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ fontSize: 13.5, color: T.sec, fontWeight: 600, marginBottom: 4 }}>
            Your total damage
          </div>
          <div
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 44,
              color: T.gold,
              letterSpacing: "-0.03em",
              lineHeight: 1,
            }}
          >
            {money(myTotal)}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div
            style={{
              fontFamily: T.disp,
              fontWeight: 800,
              fontSize: 30,
              color: T.green,
              lineHeight: 1,
            }}
          >
            4
          </div>
          <div style={{ fontSize: 12, color: T.sec, fontWeight: 600, marginTop: 2 }}>
            days clean
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {ctx.jars.map((j) => {
          const mine = myMembership(j);
          const ids = j.members.map((m) => m.user);
          return (
            <button
              key={j.id}
              onClick={() => ctx.nav("jar", { jarId: j.id })}
              style={{
                textAlign: "left",
                background: T.surface,
                border: `1px solid ${T.hair}`,
                borderRadius: 24,
                padding: 20,
                cursor: "pointer",
                color: T.text,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <div
                  style={{
                    fontFamily: T.disp,
                    fontWeight: 700,
                    fontSize: 22,
                    letterSpacing: "-0.02em",
                  }}
                >
                  {j.name}
                </div>
                <Icon.chev style={{ color: T.ter, marginTop: 6 }} />
              </div>
              <div
                style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0 18px" }}
              >
                <AvatarStack ids={ids} size={30} />
                <span style={{ fontSize: 13.5, color: T.sec, fontWeight: 600 }}>
                  {ids.length} in
                </span>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <div
                  style={{
                    flex: 1,
                    background: T.surface2,
                    borderRadius: 14,
                    padding: "11px 14px",
                  }}
                >
                  <div style={{ fontSize: 11.5, color: T.sec, fontWeight: 600, marginBottom: 2 }}>
                    You owe
                  </div>
                  <div
                    style={{
                      fontFamily: T.disp,
                      fontWeight: 700,
                      fontSize: 22,
                      color: mine.tallyCents ? T.gold : T.sec,
                    }}
                  >
                    {money(mine.tallyCents)}
                  </div>
                </div>
                <div
                  style={{
                    flex: 1,
                    background: T.surface2,
                    borderRadius: 14,
                    padding: "11px 14px",
                  }}
                >
                  <div style={{ fontSize: 11.5, color: T.sec, fontWeight: 600, marginBottom: 2 }}>
                    Jar total
                  </div>
                  <div style={{ fontFamily: T.disp, fontWeight: 700, fontSize: 22 }}>
                    {money(jarTotal(j))}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
        {/* join row */}
        <button
          onClick={() => ctx.nav("join")}
          style={{
            background: "transparent",
            border: `1.5px dashed ${T.hair}`,
            borderRadius: 24,
            padding: 18,
            cursor: "pointer",
            color: T.sec,
            fontFamily: T.ui,
            fontWeight: 600,
            fontSize: 15,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          <Icon.plus style={{ width: 16, height: 16 }} /> Join a jar with a code
        </button>
      </div>
    </Screen>
  );
}

// shared activity row
function ActivityRow({ a, showJar }) {
  const jarName = JARS.find((j) => j.id === a.jar)?.name;
  let icon, title, sub;
  if (a.type === "slip") {
    const p = person(a.user);
    icon = <Avatar id={a.user} size={42} />;
    title = (
      <>
        <b>{p.name}</b> caved{" "}
        <span style={{ color: T.red, fontWeight: 700 }}>{money(a.amountCents)}</span>
      </>
    );
    sub = a.note ? `“${a.note}”` : `texted ${a.ex}`;
  } else if (a.type === "report") {
    const p = person(a.user),
      by = person(a.by);
    icon = (
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: "50%",
          background: "rgba(255,69,58,0.14)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: T.red,
        }}
      >
        <Icon.flag />
      </div>
    );
    title = (
      <>
        <b>{p.name}</b> got reported
      </>
    );
    sub = `by ${a.anon ? "someone" : by.name}${a.note ? ` · “${a.note}”` : ""}`;
  } else if (a.type === "join") {
    const p = person(a.user);
    icon = <Avatar id={a.user} size={42} />;
    title = (
      <>
        <b>{p.name}</b> joined the jar
      </>
    );
    sub = "fresh meat";
  } else if (a.type === "milestone") {
    icon = (
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: "50%",
          background: "rgba(255,210,63,0.16)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: T.gold,
        }}
      >
        <Icon.party />
      </div>
    );
    title = <b>{a.text}</b>;
    sub = null;
  }
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "11px 0" }}>
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: T.ui, fontSize: 15, lineHeight: 1.25 }}>{title}</div>
        {sub && (
          <div
            style={{
              fontSize: 13,
              color: T.sec,
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {sub}
          </div>
        )}
        {showJar && <div style={{ fontSize: 11.5, color: T.ter, marginTop: 3 }}>{jarName}</div>}
      </div>
      <div style={{ fontSize: 12.5, color: T.ter, flexShrink: 0 }}>{a.ago}</div>
    </div>
  );
}

// ───────────────────────── Jar Detail (hero) ─────────────────────────
function JarDetail({ ctx }) {
  const j = ctx.jars.find((x) => x.id === ctx.route.params.jarId);
  const total = jarTotal(j);
  const animated = useCountUp(total);
  const board = [...j.members].sort((a, b) => b.tallyCents - a.tallyCents);
  const feed = ACTIVITY.filter((a) => a.jar === j.id).slice(0, 4);

  return (
    <Screen>
      <TopBar
        onBack={() => ctx.back()}
        title={j.name}
        trailing={
          <IconBtn onClick={() => ctx.nav("invite", { jarId: j.id })}>
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
          “{j.rule}”
        </div>
      </div>

      {/* primary action */}
      <div style={{ margin: "24px 0 10px" }}>
        <Btn
          kind="red"
          icon={<span style={{ fontSize: 20 }}>💔</span>}
          onClick={() => ctx.nav("logSlip", { jarId: j.id })}
        >
          I texted my ex
        </Btn>
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 26 }}>
        <Btn
          kind="dark"
          style={{ height: 50, fontSize: 16 }}
          icon={<Icon.flag style={{ width: 17, height: 17 }} />}
          onClick={() => ctx.nav("report", { jarId: j.id })}
        >
          Report
        </Btn>
        <Btn
          kind="dark"
          style={{ height: 50, fontSize: 16 }}
          onClick={() => ctx.nav("settle", { jarId: j.id })}
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
        {board.map((m, i) => {
          const p = person(m.user);
          const streak = streakLabel(m);
          const me = m.user === ME;
          return (
            <div
              key={m.user}
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
              <Avatar id={m.user} size={40} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.disp, fontWeight: 700, fontSize: 16 }}>
                  {p.name}
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
      </div>
    </Screen>
  );
}

// ───────────────────────── Activity tab ─────────────────────────
function ActivityTab({ ctx }) {
  return (
    <Screen>
      <TopBar title="Activity" />
      {/* pending report banner */}
      {!ctx.reportResolved && (
        <button
          onClick={() => ctx.nav("confirmDeny", { reportId: PENDING_REPORT.id })}
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
            Someone in the jar says you texted your ex. Fess up or fight it →
          </div>
        </button>
      )}
      <div>
        {ACTIVITY.map((a) => (
          <ActivityRow key={a.id} a={a} showJar />
        ))}
      </div>
      <div style={{ textAlign: "center", color: T.ter, fontSize: 13, padding: "24px 0 0" }}>
        That's all the carnage for now.
      </div>
    </Screen>
  );
}

Object.assign(window, { Onboarding, Home, JarDetail, ActivityTab, ActivityRow, useCountUp });

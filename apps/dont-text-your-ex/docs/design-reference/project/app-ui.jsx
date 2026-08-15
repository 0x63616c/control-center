// app-ui.jsx - design tokens, icons, and shared primitives for Text Your Ex

const T = {
  bg: "#000000",
  surface: "#121212",
  surface2: "#1A1A1A",
  hair: "rgba(255,255,255,0.09)",
  hair2: "rgba(255,255,255,0.06)",
  text: "#FFFFFF",
  sec: "#8A8A8E",
  ter: "#5A5A5E",
  gold: "#FFD23F",
  goldDim: "#E6B800",
  red: "#FF453A",
  green: "#30D158",
  disp: "'Bricolage Grotesque', system-ui, sans-serif",
  ui: "'Hanken Grotesk', system-ui, sans-serif",
};

// ─── Icons (stroke, currentColor) ───
const Icon = {
  back: (p) => (
    <svg width="11" height="18" viewBox="0 0 11 18" fill="none" {...p}>
      <path
        d="M9 1L2 9l7 8"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  plus: (p) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" {...p}>
      <path d="M10 3v14M3 10h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  ),
  chev: (p) => (
    <svg width="8" height="14" viewBox="0 0 8 14" fill="none" {...p}>
      <path
        d="M1 1l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  jars: (p) => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" {...p}>
      <path
        d="M7 2h10M6 6h12l-1 13a3 3 0 01-3 3H10a3 3 0 01-3-3L6 6z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M6.5 13h11" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  ),
  bell: (p) => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" {...p}>
      <path
        d="M12 3a6 6 0 016 6c0 6 2 7 2 7H4s2-1 2-7a6 6 0 016-6zM10 20a2 2 0 004 0"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  user: (p) => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" {...p}>
      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
  flag: (p) => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" {...p}>
      <path
        d="M5 21V4m0 1h12l-2 4 2 4H5"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  share: (p) => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" {...p}>
      <path
        d="M12 15V3m0 0L8 7m4-4l4 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  copy: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <rect x="8" y="8" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.9" />
      <path
        d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"
        stroke="currentColor"
        strokeWidth="1.9"
      />
    </svg>
  ),
  check: (p) => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" {...p}>
      <path
        d="M4 12l5 6L20 5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  x: (p) => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" {...p}>
      <path
        d="M5 5l14 14M19 5L5 19"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  ),
  apple: (p) => (
    <svg width="18" height="22" viewBox="0 0 18 22" fill="currentColor" {...p}>
      <path d="M14.6 11.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.7-3-2-3.7-2-1.6-.2-3 .9-3.8.9-.8 0-2-.9-3.2-.9C4.4 5.7 2.8 6.7 2 8.3c-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.7 2.5 3 2.4 1.2 0 1.6-.8 3.1-.8 1.4 0 1.8.8 3.1.8 1.3 0 2.1-1.2 2.9-2.4.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.5-1-2.5-3.6zM12.1 4c.7-.8 1.1-2 1-3.2-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.3z" />
    </svg>
  ),
  party: (p) => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" {...p}>
      <path
        d="M3 21l5-13 8 8-13 5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M14 3v2M19 6l-1.4 1.4M21 11h-2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
};

// ─── Avatar ───
function Avatar({ id, size = 40, ring, override }) {
  const p = override || PEOPLE[id] || { name: "?", color: "#444" };
  const common = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    boxShadow: ring ? `0 0 0 2px ${T.bg}, 0 0 0 4px ${ring}` : "none",
  };
  if (p.photo) {
    return <img src={p.photo} alt={p.name} style={{ ...common, objectFit: "cover" }} />;
  }
  return (
    <div
      style={{
        ...common,
        background: p.color,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: T.disp,
        fontWeight: 700,
        fontSize: p.emoji ? size * 0.5 : size * 0.4,
        letterSpacing: "-0.02em",
        overflow: "hidden",
      }}
    >
      {p.emoji || p.name.slice(0, 2)}
    </div>
  );
}

function AvatarStack({ ids, size = 28 }) {
  return (
    <div style={{ display: "flex" }}>
      {ids.map((id, i) => (
        <div key={id} style={{ marginLeft: i === 0 ? 0 : -size * 0.32, zIndex: ids.length - i }}>
          <div style={{ borderRadius: "50%", boxShadow: `0 0 0 2px ${T.bg}` }}>
            <Avatar id={id} size={size} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Buttons ───
function Btn({ children, onClick, kind = "gold", icon, style = {}, disabled }) {
  const base = {
    gold: { background: T.gold, color: "#000", border: "none" },
    red: { background: T.red, color: "#fff", border: "none" },
    dark: { background: T.surface2, color: T.text, border: `1px solid ${T.hair}` },
    ghost: { background: "transparent", color: T.sec, border: "none" },
  }[kind];
  const [press, setPress] = React.useState(false);
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onPointerDown={() => setPress(true)}
      onPointerUp={() => setPress(false)}
      onPointerLeave={() => setPress(false)}
      style={{
        width: "100%",
        height: 58,
        borderRadius: 18,
        cursor: disabled ? "default" : "pointer",
        fontFamily: T.disp,
        fontWeight: 700,
        fontSize: 19,
        letterSpacing: "-0.01em",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 9,
        transition: "transform .12s, opacity .12s",
        opacity: disabled ? 0.4 : 1,
        transform: press && !disabled ? "scale(0.97)" : "scale(1)",
        ...base,
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

// Round icon button (nav)
function IconBtn({ children, onClick, style = {} }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 38,
        height: 38,
        borderRadius: "50%",
        flexShrink: 0,
        background: T.surface2,
        border: `1px solid ${T.hair}`,
        color: T.text,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// Screen scaffold: full-black scroll area, top padding clears the island.
function Screen({ children, pad = true, style = {} }) {
  return (
    <div
      style={{
        minHeight: "100%",
        background: T.bg,
        color: T.text,
        fontFamily: T.ui,
        padding: pad ? "0 20px" : 0,
        boxSizing: "border-box",
        paddingBottom: 120,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// A simple top bar with optional back + title + trailing
function TopBar({ onBack, title, trailing }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        paddingTop: 64,
        paddingBottom: 12,
        minHeight: 38,
      }}
    >
      {onBack && (
        <IconBtn onClick={onBack}>
          <Icon.back />
        </IconBtn>
      )}
      <div
        style={{
          flex: 1,
          fontFamily: T.disp,
          fontWeight: 700,
          fontSize: 20,
          letterSpacing: "-0.02em",
        }}
      >
        {title}
      </div>
      {trailing}
    </div>
  );
}

// Pill tag
function Tag({ children, color = T.sec, bg }) {
  return (
    <span
      style={{
        fontFamily: T.ui,
        fontWeight: 600,
        fontSize: 12.5,
        color,
        background: bg || "rgba(255,255,255,0.06)",
        padding: "4px 10px",
        borderRadius: 999,
        letterSpacing: "0.01em",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

Object.assign(window, { T, Icon, Avatar, AvatarStack, Btn, IconBtn, Screen, TopBar, Tag });

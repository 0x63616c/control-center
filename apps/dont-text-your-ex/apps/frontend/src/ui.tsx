import { type CSSProperties, type ReactNode, useState } from "react";
import { Icon } from "./icons";
import { T } from "./theme";

export const PAGE_TOP_PADDING = 22;

export type AvatarUser = {
  name: string;
  color: string;
  emoji?: string | null;
  photo?: string | null;
};

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2)
    return words
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
  return (words[0]?.[0] ?? "?").toUpperCase();
}

export function Avatar({
  user,
  size = 40,
  ring,
}: {
  user: AvatarUser;
  size?: number;
  ring?: string;
}) {
  const common: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    boxShadow: ring ? `0 0 0 2px ${T.bg}, 0 0 0 4px ${ring}` : "none",
  };
  // Avatars are decorative; aria-hidden keeps their initials out of the
  // accessible name of any button/row that contains them.
  if (user.photo) {
    return <img src={user.photo} alt="" aria-hidden style={{ ...common, objectFit: "cover" }} />;
  }
  return (
    <div
      aria-hidden
      style={{
        ...common,
        background: user.color,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: T.disp,
        fontWeight: 700,
        fontSize: user.emoji ? size * 0.5 : size * 0.4,
        letterSpacing: "-0.02em",
        overflow: "hidden",
      }}
    >
      {user.emoji || initials(user.name)}
    </div>
  );
}

export function AvatarStack({ users, size = 28 }: { users: AvatarUser[]; size?: number }) {
  return (
    <div style={{ display: "flex" }}>
      {users.map((u, i) => (
        <div
          key={u.name}
          style={{ marginLeft: i === 0 ? 0 : -size * 0.32, zIndex: users.length - i }}
        >
          <div style={{ borderRadius: "50%", boxShadow: `0 0 0 2px ${T.bg}` }}>
            <Avatar user={u} size={size} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DevBadge() {
  if (!import.meta.env.DEV) return null;
  return (
    <span
      style={{
        border: `1px solid ${T.hair}`,
        borderRadius: 999,
        color: T.gold,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
        fontWeight: 700,
        padding: "5px 8px",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
      }}
    >
      LOCAL DEV
    </span>
  );
}

type BtnKind = "gold" | "red" | "dark" | "ghost";
export function Btn({
  children,
  onClick,
  kind = "gold",
  icon,
  style = {},
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: BtnKind;
  icon?: ReactNode;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  const base: Record<BtnKind, CSSProperties> = {
    gold: { background: T.gold, color: "#000", border: "none" },
    red: { background: T.red, color: "#fff", border: "none" },
    dark: { background: T.surface2, color: T.text, border: `1px solid ${T.hair}` },
    ghost: { background: "transparent", color: T.sec, border: "none" },
  };
  const [press, setPress] = useState(false);
  return (
    <button
      type="button"
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
        ...base[kind],
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconBtn({
  children,
  onClick,
  style = {},
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  style?: CSSProperties;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...rest}
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

export function Screen({
  children,
  pad = true,
  style = {},
}: {
  children: ReactNode;
  pad?: boolean;
  style?: CSSProperties;
}) {
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

export function TopBar({
  onBack,
  title,
  trailing,
}: {
  onBack?: () => void;
  title?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        paddingTop: PAGE_TOP_PADDING,
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

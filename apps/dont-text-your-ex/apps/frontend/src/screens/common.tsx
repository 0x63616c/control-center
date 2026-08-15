import {
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "../icons";
import { money, T } from "../theme";
import type { ActivityDTO } from "../types";
import { Avatar } from "../ui";

export const inputStyle: CSSProperties = {
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
export const labelStyle: CSSProperties = {
  fontSize: 13,
  color: T.sec,
  fontWeight: 600,
  marginBottom: 8,
  display: "block",
};

// animated count-up for tallies / pot totals
export function useCountUp(target: number, dur = 700): number {
  const [v, setV] = useState(target);
  const prev = useRef(target);
  useEffect(() => {
    const from = prev.current,
      to = target;
    prev.current = target;
    if (from === to) return;
    let raf = 0,
      t0 = 0;
    const tick = (t: number) => {
      if (!t0) t0 = t;
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - (1 - p) ** 3;
      setV(Math.round(from + (to - from) * e));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, dur]);
  return v;
}

// One row in an activity feed.
export function ActivityRow({ a, showJar }: { a: ActivityDTO; showJar?: boolean }) {
  let icon: React.ReactNode = null;
  let title: React.ReactNode = null;
  let sub: string | null = null;

  if (a.type === "slip" && a.user) {
    icon = <Avatar user={a.user} size={42} />;
    title = (
      <>
        <b>{a.user.name}</b> caved{" "}
        <span style={{ color: T.red, fontWeight: 700 }}>{money(a.amountCents ?? 0)}</span>
      </>
    );
    sub = a.note ? `“${a.note}”` : a.exLabel ? `texted ${a.exLabel}` : "texted their ex";
  } else if (a.type === "report" && a.user) {
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
        <b>{a.user.name}</b> got reported
      </>
    );
    sub = `by ${a.anonymous || !a.by ? "someone" : a.by.name}${a.note ? ` · “${a.note}”` : ""}`;
  } else if (a.type === "join" && a.user) {
    icon = <Avatar user={a.user} size={42} />;
    title = (
      <>
        <b>{a.user.name}</b> joined the jar
      </>
    );
    sub = "fresh meat";
  } else if (a.type === "deny" && a.user) {
    icon = (
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: "50%",
          background: "rgba(138,138,142,0.16)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: T.sec,
        }}
      >
        <Icon.x />
      </div>
    );
    title = (
      <>
        <b>{a.user.name}</b> denied a report
      </>
    );
    sub = "innocent until proven otherwise";
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
        {showJar && <div style={{ fontSize: 11.5, color: T.ter, marginTop: 3 }}>{a.jarName}</div>}
      </div>
      <div style={{ fontSize: 12.5, color: T.ter, flexShrink: 0 }}>{a.ago}</div>
    </div>
  );
}

export interface AvatarDraft {
  name: string;
  color: string;
  emoji: string | null;
  photo: string | null;
}
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

export function AvatarEditor({
  draft,
  setDraft,
}: {
  draft: AvatarDraft;
  setDraft: Dispatch<SetStateAction<AvatarDraft>>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setDraft((d) => ({ ...d, photo: r.result as string }));
    r.readAsDataURL(f);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ position: "relative", marginBottom: 18 }}>
        <Avatar user={draft} size={104} />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
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
          type="button"
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
                type="button"
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
            {AV_EMOJI.map((e) => {
              const active = draft.emoji === e || (e === "-" && !draft.emoji);
              return (
                <button
                  key={e}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, emoji: e === "-" ? null : e }))}
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 10,
                    cursor: "pointer",
                    fontSize: e === "-" ? 13 : 18,
                    background: active ? T.surface2 : "transparent",
                    border: `1px solid ${active ? T.gold : T.hair}`,
                    color: T.sec,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {e === "-" ? "Aa" : e}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

import type { CSSProperties } from "react";
import { Icon } from "./icons";
import { money, T } from "./theme";
import type { EvidenceThread } from "./types";

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      style={{
        width: 51,
        height: 31,
        borderRadius: 999,
        border: "none",
        cursor: "pointer",
        background: on ? T.green : "rgba(255,255,255,0.16)",
        position: "relative",
        transition: "background .2s",
        flexShrink: 0,
        padding: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: on ? 22 : 2,
          width: 27,
          height: 27,
          borderRadius: "50%",
          background: "#fff",
          transition: "left .2s",
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
        }}
      />
    </button>
  );
}

export function Stepper({
  cents,
  onChange,
  step = 100,
}: {
  cents: number;
  onChange: (c: number) => void;
  step?: number;
}) {
  const round = (c: number) => Math.max(step, Math.round(c / step) * step);
  const Round = ({ dir }: { dir: number }) => (
    <button
      type="button"
      onClick={() => onChange(round(cents + dir * step))}
      style={{
        width: 56,
        height: 56,
        borderRadius: "50%",
        flexShrink: 0,
        background: T.surface2,
        border: `1px solid ${T.hair}`,
        color: T.text,
        fontFamily: T.disp,
        fontSize: 28,
        fontWeight: 700,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
      }}
    >
      {dir > 0 ? "+" : "−"}
    </button>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 22 }}>
      <Round dir={-1} />
      <div
        style={{
          fontFamily: T.disp,
          fontWeight: 800,
          fontSize: 76,
          color: T.gold,
          letterSpacing: "-0.04em",
          minWidth: 150,
          textAlign: "center",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1,
        }}
      >
        {money(cents)}
      </div>
      <Round dir={1} />
    </div>
  );
}

// Fake iMessage-style screenshot used as report "evidence".
// `interactive=false` renders just the thumbnail (no <button>), so callers can
// place it inside their own button without nesting (invalid HTML).
export function EvidenceShot({
  shot,
  w = 132,
  onOpen,
  full = false,
  interactive = true,
}: {
  shot: EvidenceThread;
  w?: number;
  onOpen?: () => void;
  full?: boolean;
  interactive?: boolean;
}) {
  const scale = full ? 1 : w / 320;
  const inner = (
    <div
      style={{
        width: 320,
        transformOrigin: "top left",
        transform: full ? "none" : `scale(${scale})`,
        background: "#000",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          padding: "16px 0 14px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: "50%",
            background: "#3A3A3C",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: T.disp,
            fontWeight: 700,
            fontSize: 18,
            color: "#fff",
          }}
        >
          {shot.to.slice(0, 2)}
        </div>
        <div style={{ fontFamily: T.ui, fontSize: 14, color: "#fff", fontWeight: 600 }}>
          {shot.to} <span style={{ color: "#8A8A8E" }}>›</span>
        </div>
        <div style={{ fontFamily: T.ui, fontSize: 11, color: "#8A8A8E" }}>{shot.time}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "16px 14px 22px" }}>
        {shot.bubbles.map((b) => (
          <div
            key={b.text}
            style={{ display: "flex", justifyContent: b.me ? "flex-end" : "flex-start" }}
          >
            <div
              style={{
                maxWidth: "74%",
                padding: "9px 14px",
                borderRadius: 20,
                fontFamily: T.ui,
                fontSize: 15,
                lineHeight: 1.3,
                color: "#fff",
                background: b.me ? "#0A84FF" : "#26252A",
                borderBottomRightRadius: b.me ? 5 : 20,
                borderBottomLeftRadius: b.me ? 20 : 5,
              }}
            >
              {b.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
  if (full) return inner;

  // Non-interactive thumbnail: same visual, plain div (no button, no "tap" badge).
  if (!interactive) {
    return (
      <div
        style={{
          width: w,
          height: w * 1.5,
          borderRadius: 16,
          overflow: "hidden",
          flexShrink: 0,
          border: `1px solid ${T.hair}`,
          background: "#000",
          position: "relative",
        }}
      >
        {inner}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        width: w,
        height: w * 1.5,
        borderRadius: 16,
        overflow: "hidden",
        flexShrink: 0,
        border: `1px solid ${T.hair}`,
        background: "#000",
        cursor: "pointer",
        padding: 0,
        position: "relative",
      }}
    >
      {inner}
      <span
        style={{
          position: "absolute",
          bottom: 8,
          right: 8,
          background: "rgba(0,0,0,0.6)",
          color: "#fff",
          fontFamily: T.ui,
          fontSize: 10,
          fontWeight: 600,
          padding: "3px 7px",
          borderRadius: 999,
          backdropFilter: "blur(4px)",
        }}
      >
        tap
      </span>
    </button>
  );
}

export function EvidenceViewer({
  shots,
  index,
  onClose,
  onIndex,
}: {
  shots: EvidenceThread[];
  index: number | null;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  if (index == null) return null;
  const shot = shots[index];
  return (
    <button
      type="button"
      onClick={onClose}
      style={{
        all: "unset",
        position: "absolute",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.96)",
        backdropFilter: "blur(8px)",
        display: "flex",
        flexDirection: "column",
        animation: "tye-fade .2s ease",
        cursor: "default",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "60px 20px 8px",
        }}
      >
        <span style={{ fontFamily: T.ui, color: T.sec, fontSize: 14 }}>
          {index + 1} / {shots.length}
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#fff",
            cursor: "pointer",
            padding: 6,
          }}
        >
          <Icon.x />
        </button>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: presentation container prevents event bubbling to backdrop */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: propagation stopper only, no semantic action */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 20px",
        }}
      >
        <div
          style={{
            width: 320,
            background: "#000",
            borderRadius: 22,
            border: `1px solid ${T.hair}`,
            overflow: "hidden",
          }}
        >
          <EvidenceShot shot={shot} full />
        </div>
      </div>
      {shots.length > 1 && (
        // biome-ignore lint/a11y/noStaticElementInteractions: propagation stopper only
        // biome-ignore lint/a11y/useKeyWithClickEvents: propagation stopper only
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ display: "flex", justifyContent: "center", gap: 8, padding: "12px 0 40px" }}
        >
          {shots.map((s, i) => (
            <button
              key={`${s.to}-${s.time}`}
              type="button"
              onClick={() => onIndex(i)}
              style={{
                width: i === index ? 22 : 8,
                height: 8,
                borderRadius: 999,
                border: "none",
                background: i === index ? T.gold : "rgba(255,255,255,0.3)",
                cursor: "pointer",
                transition: "all .2s",
              }}
            />
          ))}
        </div>
      )}
    </button>
  );
}

const BURST_IDS = Array.from({ length: 14 }, (_, i) => `bill-${i}`);

export function MoneyBurst({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 150,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {BURST_IDS.map((id) => {
        const left = 8 + Math.random() * 84;
        const delay = Math.random() * 0.25;
        const dur = 1.1 + Math.random() * 0.7;
        const size = 20 + Math.random() * 26;
        const rot = (Math.random() * 2 - 1) * 60;
        return (
          <span
            key={id}
            style={
              {
                position: "absolute",
                left: `${left}%`,
                top: "-12%",
                fontSize: size,
                animation: `tye-fall ${dur}s cubic-bezier(.4,0,.7,1) ${delay}s forwards`,
                ["--rot" as keyof CSSProperties]: `${rot}deg`,
              } as CSSProperties
            }
          >
            💸
          </span>
        );
      })}
    </div>
  );
}

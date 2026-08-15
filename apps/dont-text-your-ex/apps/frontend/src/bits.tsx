import type { CSSProperties } from "react";
import { Icon } from "./icons";
import { money, T } from "./theme";
import type { EvidenceImageInput } from "./types";

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

export function EvidenceShot({
  image,
  w = 132,
  onOpen,
  full = false,
}: {
  image: EvidenceImageInput;
  w?: number;
  onOpen?: () => void;
  full?: boolean;
}) {
  const picture = (
    <img
      src={image.dataUrl}
      alt="Report attachment"
      style={{
        display: "block",
        width: full ? "100%" : w,
        height: full ? "auto" : w * 1.5,
        maxHeight: full ? "70vh" : undefined,
        objectFit: "contain",
        background: "#000",
      }}
    />
  );
  if (full) return picture;

  return (
    <button
      type="button"
      aria-label="View report attachment"
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
      {picture}
    </button>
  );
}

export function EvidenceViewer({
  images,
  index,
  onClose,
  onIndex,
}: {
  images: EvidenceImageInput[];
  index: number | null;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  if (index == null) return null;
  const image = images[index];
  if (!image) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismisses the image viewer
    <div
      role="presentation"
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
          {index + 1} / {images.length}
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
            maxWidth: 360,
            maxHeight: "70vh",
            background: "#000",
            borderRadius: 22,
            border: `1px solid ${T.hair}`,
            overflow: "hidden",
          }}
        >
          <EvidenceShot image={image} full />
        </div>
      </div>
      {images.length > 1 && (
        // biome-ignore lint/a11y/noStaticElementInteractions: propagation stopper only
        // biome-ignore lint/a11y/useKeyWithClickEvents: propagation stopper only
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ display: "flex", justifyContent: "center", gap: 8, padding: "12px 0 40px" }}
        >
          {images.map((image, i) => (
            <button
              key={image.dataUrl}
              aria-label={`View attachment ${i + 1}`}
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
    </div>
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

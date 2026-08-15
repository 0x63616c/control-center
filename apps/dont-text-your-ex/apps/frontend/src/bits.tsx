import { type CSSProperties, useEffect, useRef } from "react";
import { Icon } from "./icons";
import { money, T } from "./theme";
import type { EvidenceImageInput } from "./types";

export function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      onClick={() => onChange(!on)}
      style={{
        width: 51,
        height: 44,
        border: "none",
        cursor: "pointer",
        background: "transparent",
        position: "relative",
        flexShrink: 0,
        padding: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          inset: "6.5px 0",
          borderRadius: 999,
          background: on ? T.green : "rgba(255,255,255,0.16)",
          transition: "background .2s",
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
      </span>
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const image = index == null ? undefined : images[index];
  const isOpen = image != null;

  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, [isOpen]);

  if (!image) return null;
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Report attachment viewer"
      style={{
        all: "unset",
        position: "fixed",
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
          {(index ?? 0) + 1} / {images.length}
        </span>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close attachment viewer"
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#fff",
            cursor: "pointer",
            width: 44,
            height: 44,
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon.x />
        </button>
      </div>
      <div
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
        <div style={{ display: "flex", justifyContent: "center", gap: 8, padding: "12px 0 40px" }}>
          {images.map((image, i) => (
            <button
              key={image.dataUrl}
              aria-label={`View attachment ${i + 1}`}
              type="button"
              onClick={() => onIndex(i)}
              style={{
                width: 44,
                height: 44,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: i === index ? 22 : 8,
                  height: 8,
                  borderRadius: 999,
                  background: i === index ? T.gold : "rgba(255,255,255,0.3)",
                  transition: "all .2s",
                }}
              />
            </button>
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

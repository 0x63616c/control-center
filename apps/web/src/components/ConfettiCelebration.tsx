import type { CSSProperties } from "react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { usePrefersReducedMotion } from "../lib/usePrefersReducedMotion";
import { Z_LAYER } from "../lib/z-layers";

export const CONFETTI_DURATION_MS = 3000;
const COLORS = ["#67e8f9", "#a78bfa", "#fbbf24", "#fb7185", "#6ee7b7"] as const;
const PIECES = Array.from({ length: 42 }, (_, index) => ({
  id: String(index),
  color: COLORS[index % COLORS.length],
  delayMs: (index * 47) % 620,
  driftPx: ((index * 73) % 240) - 120,
  durationMs: 1900 + ((index * 83) % 650),
  leftPercent: 2 + ((index * 37) % 96),
  rotationDeg: 420 + ((index * 59) % 540),
}));

type ConfettiStyle = CSSProperties & {
  "--confetti-delay": string;
  "--confetti-drift": string;
  "--confetti-duration": string;
  "--confetti-rotation": string;
};

export function ConfettiCelebrationView() {
  return (
    <div
      aria-hidden="true"
      className="confetti-celebration"
      data-testid="confetti-celebration"
      style={{ zIndex: Z_LAYER.celebrationOverlay }}
    >
      {PIECES.map((piece) => {
        const style: ConfettiStyle = {
          "--confetti-delay": `${piece.delayMs}ms`,
          "--confetti-drift": `${piece.driftPx}px`,
          "--confetti-duration": `${piece.durationMs}ms`,
          "--confetti-rotation": `${piece.rotationDeg}deg`,
          backgroundColor: piece.color,
          left: `${piece.leftPercent}%`,
        };
        return <i className="confetti-piece" key={piece.id} style={style} />;
      })}
    </div>
  );
}

export function ConfettiCelebration({ onFinished }: { onFinished: () => void }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  useEffect(() => {
    if (prefersReducedMotion) {
      onFinished();
      return;
    }
    const timer = window.setTimeout(onFinished, CONFETTI_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [onFinished, prefersReducedMotion]);

  if (prefersReducedMotion) return null;
  return createPortal(<ConfettiCelebrationView />, document.body);
}

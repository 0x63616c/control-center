import { useEffect } from "react";

export type PrototypeVariant = "A" | "B" | "C";

const VARIANTS = ["A", "B", "C"] as const;

const VARIANT_NAMES: Record<PrototypeVariant, string> = {
  A: "Split workspace",
  B: "Focused dialog",
  C: "Quick composer",
};

export function PrototypeSwitcher({
  current,
  onChange,
}: {
  readonly current: PrototypeVariant;
  readonly onChange: (variant: PrototypeVariant) => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const currentIndex = VARIANTS.indexOf(current);
      const offset = event.key === "ArrowLeft" ? -1 : 1;
      const nextIndex = (currentIndex + offset + VARIANTS.length) % VARIANTS.length;
      const next = VARIANTS[nextIndex];
      if (next) onChange(next);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current, onChange]);

  function cycle(offset: -1 | 1) {
    const currentIndex = VARIANTS.indexOf(current);
    const nextIndex = (currentIndex + offset + VARIANTS.length) % VARIANTS.length;
    const next = VARIANTS[nextIndex];
    if (next) onChange(next);
  }

  return (
    <nav className="prototype-switcher" aria-label="Prototype variants">
      <button type="button" aria-label="Previous variant" onClick={() => cycle(-1)}>
        ←
      </button>
      <span>
        <strong>{current}</strong> — {VARIANT_NAMES[current]}
      </span>
      <button type="button" aria-label="Next variant" onClick={() => cycle(1)}>
        →
      </button>
    </nav>
  );
}

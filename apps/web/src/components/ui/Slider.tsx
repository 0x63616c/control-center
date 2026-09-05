/**
 * Slider , standalone dumb presentational range control with a label + value
 * readout. Zero trpc/data/hook dependencies; all state driven by props.
 *
 * Wraps the shared `.range` class (see styles/tokens.css) , the same dark-track +
 * accent-fill rail every slider in the app uses (lamp brightness, climate,
 * party speed, mixer, media scrub, sound faders). The fill is driven by the
 * `--p` custom property.
 *
 * Variants:
 * - `size`: "md" (default 8px rail), "lg" (prominent 16px rail, lamp
 *   brightness), "scrub" (thin 6px rail + small thumb, media progress).
 * - `orientation="vertical"`: same control rotated -90°, for faders. Set
 *   `length` for the track length; the header row is omitted (fader columns
 *   carry their own labels).
 * - `stops`: discrete labeled positions (party speed). The active stop label
 *   is highlighted.
 * - `onChangeEnd`: fires once on release (pointer up / key up / blur) with the
 *   final value , for consumers that debounce writes to hardware.
 *
 * `RangeSlider` is the dual-thumb sibling (heat-cool low/high bands). It wraps
 * the shared `.range-dual` / `.range-thumb` classes , two pointer-transparent
 * native inputs stacked over one filled-band track.
 */

import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";

type SliderSize = "md" | "lg" | "scrub";

const SIZE_CLASS: Record<SliderSize, string> = {
  md: "range",
  lg: "range range-lg",
  scrub: "range range-scrub",
};

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  /** Fires once on release (pointer up / key up / blur) with the final value. */
  onChangeEnd?: (final: number) => void;
  /** Label shown to the left of the value; also the accessible name. */
  label: string;
  /** Format the value readout (e.g. `${n} min`, `${n}%`). Defaults to String. */
  format?: (value: number) => string;
  disabled?: boolean;
  /** Hide the label + value readout row (consumer renders its own). */
  showHeader?: boolean;
  size?: SliderSize;
  orientation?: "horizontal" | "vertical";
  /** Track length in px when vertical. Omit to fill the parent's height. */
  length?: number;
  /** Discrete stop labels rendered under the track; active one highlighted. */
  stops?: string[];
  /** data-testid applied to the input element. */
  testId?: string;
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  onChangeEnd,
  label,
  format = String,
  disabled,
  showHeader = true,
  size = "md",
  orientation = "horizontal",
  length,
  stops,
  testId,
}: SliderProps) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const vertical = orientation === "vertical";
  // Auto-length vertical sliders measure their box so faders can flex-fill.
  const boxRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(120);
  useLayoutEffect(() => {
    if (!vertical || length !== undefined || !boxRef.current) return;
    const box = boxRef.current;
    const update = () => setMeasured(box.clientHeight);
    update();
    // jsdom has no ResizeObserver; the initial measure alone is fine there.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(box);
    return () => ro.disconnect();
  }, [vertical, length]);
  const trackLength = length ?? measured;
  const activeStop = stops
    ? Math.round(((value - min) / (max - min || 1)) * (stops.length - 1))
    : -1;

  const commit = (e: PointerEvent<HTMLInputElement> | KeyboardEvent<HTMLInputElement>) => {
    onChangeEnd?.(Number(e.currentTarget.value));
  };

  const input = (
    <input
      className={SIZE_CLASS[size]}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      aria-orientation={vertical ? "vertical" : undefined}
      aria-valuetext={stops?.[activeStop] ?? format(value)}
      data-testid={testId}
      onChange={(e) => onChange(Number(e.target.value))}
      // Adjusting the slider must never double as a tap on the surface behind
      // it (tile open-modal handlers, board pan).
      onClick={(e) => e.stopPropagation()}
      onPointerUp={onChangeEnd ? commit : undefined}
      onKeyUp={onChangeEnd ? commit : undefined}
      onBlur={onChangeEnd ? (e) => onChangeEnd(Number(e.currentTarget.value)) : undefined}
      // --p drives the .range fill gradient (accent up to the value, dark rail
      // after). cursor:default when disabled overrides the class's pointer.
      style={
        {
          "--p": `${pct}%`,
          cursor: disabled ? "default" : "pointer",
          ...(vertical
            ? {
                position: "absolute",
                top: "50%",
                left: "50%",
                width: trackLength,
                transform: "translate(-50%, -50%) rotate(-90deg)",
              }
            : {}),
        } as CSSProperties
      }
    />
  );

  if (vertical) {
    // Rotated native input inside a sized box: full keyboard + pointer
    // behavior for free, identical rail/thumb rendering to horizontal.
    return (
      <div
        ref={boxRef}
        style={{
          position: "relative",
          width: 26,
          // Fixed length when given; otherwise fill the parent and measure.
          height: length ?? "100%",
          opacity: disabled ? 0.4 : 1,
        }}
      >
        {input}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, opacity: disabled ? 0.4 : 1 }}>
      {showHeader && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            fontFamily: "var(--ui)",
          }}
        >
          <span style={{ fontSize: 14, color: "var(--ink-2)" }}>{label}</span>
          <span
            className="mono"
            style={{
              fontFamily: "var(--mono)",
              fontSize: 13,
              color: "var(--ink)",
              letterSpacing: "-0.02em",
            }}
          >
            {format(value)}
          </span>
        </div>
      )}
      {input}
      {stops && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: "var(--mono)",
            fontSize: 11,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {stops.map((s, i) => (
            <span key={s} style={{ color: i === activeStop ? "var(--acc)" : "var(--ink-3)" }}>
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export interface RangeSliderProps {
  low: number;
  high: number;
  min: number;
  max: number;
  step?: number;
  /** Minimum distance the two thumbs keep between each other. */
  minGap?: number;
  onChange: (next: { low: number; high: number }) => void;
  /** Fires once on release of either thumb with the final pair. */
  onChangeEnd?: (final: { low: number; high: number }) => void;
  /** Accessible-name prefix; thumbs are `${label} low` / `${label} high`. */
  label: string;
  /** Override the accessible names when the defaults don't fit. */
  lowLabel?: string;
  highLabel?: string;
  disabled?: boolean;
  /** data-testid prefix; inputs get `${testId}-low` / `${testId}-high`. */
  testId?: string;
  /** Extra absolutely-positioned adornments (ambient caret, end labels). */
  children?: ReactNode;
  /** Merged onto the relative container (e.g. bottom padding for adornments). */
  style?: CSSProperties;
}

export function RangeSlider({
  low,
  high,
  min,
  max,
  step = 1,
  minGap = 0,
  onChange,
  onChangeEnd,
  label,
  lowLabel,
  highLabel,
  disabled,
  testId,
  children,
  style,
}: RangeSliderProps) {
  const span = max - min || 1;
  const loPct = ((low - min) / span) * 100;
  const hiPct = ((high - min) / span) * 100;

  const setLow = (next: number) => onChange({ low: Math.min(next, high - minGap), high });
  const setHigh = (next: number) => onChange({ low, high: Math.max(next, low + minGap) });
  const commit = () => onChangeEnd?.({ low, high });

  return (
    <div
      className="range-dual"
      style={{ position: "relative", opacity: disabled ? 0.4 : 1, ...style }}
    >
      <div
        className="range-dual-track"
        style={{ "--lo": `${loPct}%`, "--hi": `${hiPct}%` } as CSSProperties}
      />
      <input
        className="range-thumb"
        type="range"
        min={min}
        max={max}
        step={step}
        value={low}
        disabled={disabled}
        aria-label={lowLabel ?? `${label} low`}
        data-testid={testId ? `${testId}-low` : undefined}
        onChange={(e) => setLow(Number(e.target.value))}
        onPointerUp={onChangeEnd ? commit : undefined}
        onKeyUp={onChangeEnd ? commit : undefined}
      />
      <input
        className="range-thumb"
        type="range"
        min={min}
        max={max}
        step={step}
        value={high}
        disabled={disabled}
        aria-label={highLabel ?? `${label} high`}
        data-testid={testId ? `${testId}-high` : undefined}
        onChange={(e) => setHigh(Number(e.target.value))}
        onPointerUp={onChangeEnd ? commit : undefined}
        onKeyUp={onChangeEnd ? commit : undefined}
      />
      {children}
    </div>
  );
}

// Device frame dimensions (logical/CSS points). The app renders its iOS bezel
// at this size and scales it to fit the viewport.
//
// Default is the design's 402×874. Override via URL:
//   ?device=16promax   → iPhone 16 Pro Max (440×956 logical, DPR 3)
//   ?device=16pro      → iPhone 16 Pro (402×874)
//   ?w=440&h=956       → explicit logical points
export interface DeviceSize {
  w: number;
  h: number;
  label: string;
}

const PRESETS: Record<string, DeviceSize> = {
  default: { w: 402, h: 874, label: "iPhone (402×874)" },
  "16pro": { w: 402, h: 874, label: "iPhone 16 Pro (402×874)" },
  "16promax": { w: 440, h: 956, label: "iPhone 16 Pro Max (440×956)" },
  "16": { w: 393, h: 852, label: "iPhone 16 (393×852)" },
};

export function resolveDevice(): DeviceSize {
  if (typeof window === "undefined") return PRESETS.default;
  const q = new URLSearchParams(window.location.search);
  const w = Number(q.get("w"));
  const h = Number(q.get("h"));
  if (w > 0 && h > 0) return { w, h, label: `Custom (${w}×${h})` };
  const name = (q.get("device") || "default").toLowerCase();
  return PRESETS[name] ?? PRESETS.default;
}

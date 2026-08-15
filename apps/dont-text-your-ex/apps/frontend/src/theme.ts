// Design tokens for Text Your Ex - true black + gold, loud and roasty.
export const T = {
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
} as const;

// Whole-dollar only across the app (steps enforce whole dollars). Rounding here
// also makes the pot count-up tick $0 -> $N in integers, never fractional cents.
export function money(cents: number): string {
  return `$${Math.round(cents / 100)}`;
}

// Mirror of the design's streakLabel, computed from the member DTO.
import type { MemberDTO } from "./types";
export function streakLabel(m: MemberDTO): string | null {
  if (!m.shareStreak) return null;
  if (m.user.exes.length === 0) return "forever clean";
  if (m.daysClean === 0) return "just caved";
  if (m.daysClean < 0) return "forever clean";
  return `${m.daysClean} ${m.daysClean === 1 ? "day" : "days"} clean`;
}

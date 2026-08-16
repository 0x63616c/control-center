// Design tokens for Don’t Text Your Ex - true black + gold, playful and supportive.
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

export const NO_MONEY_DISCLOSURE =
  "No real money is charged, collected, paid, or transferred." as const;

// The data model retains integer cents for compatibility, but V1 presents those
// values exclusively as virtual accountability points. No money moves in the app.
export function formatPoints(cents: number): string {
  return `${Math.round(cents / 100)} pts`;
}

// Mirror of the design's streakLabel, computed from the member DTO.
import type { MemberDTO } from "./types";
export function streakLabel(m: MemberDTO): string | null {
  if (!m.shareStreak) return null;
  if (m.daysClean === 0) return "reset today";
  if (m.daysClean < 0) return "no slips yet";
  return `${m.daysClean} ${m.daysClean === 1 ? "day" : "days"} no-contact`;
}

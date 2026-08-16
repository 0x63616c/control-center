import { z } from "zod";

export const SharedStreakMilestoneDaysSchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(100),
  z.literal(365),
]);
export type SharedStreakMilestoneDays = z.infer<typeof SharedStreakMilestoneDaysSchema>;

const SHARED_STREAK_ACTIVITY_PATTERN = /^Reached a (7|30|100|365)-day clean streak[.]$/;

export function sharedStreakMilestoneActivityText(days: SharedStreakMilestoneDays): string {
  return `Reached a ${days}-day clean streak.`;
}

export function parseSharedStreakMilestoneActivityText(
  value: unknown,
): SharedStreakMilestoneDays | null {
  if (typeof value !== "string") return null;
  const match = SHARED_STREAK_ACTIVITY_PATTERN.exec(value);
  if (!match) return null;
  const parsed = SharedStreakMilestoneDaysSchema.safeParse(Number(match[1]));
  return parsed.success ? parsed.data : null;
}

import { randomInt } from "node:crypto";
import { genId } from "@www/platform";
import {
  type InviteCode,
  InviteCodeSchema,
  type JarId,
  type ReportId,
  type SessionToken,
  type UserId,
} from "../../../contracts";
import type {
  AccountDeletionId,
  EventId,
  InviteVersionId,
  JarMilestoneId,
  MembershipTenureId,
  NotificationId,
  RecapId,
  RescueInterventionId,
  SlipId,
  StreakAchievementId,
} from "./domain-events";

export function id(prefix: "usr", len?: number): UserId;
export function id(prefix: "jar", len?: number): JarId;
export function id(prefix: "rpt", len?: number): ReportId;
export function id(prefix: "sess", len?: number): SessionToken;
export function id(prefix: "evt", len?: number): EventId;
export function id(prefix: "inv", len?: number): InviteVersionId;
export function id(prefix: "mtn", len?: number): MembershipTenureId;
export function id(prefix: "slip", len?: number): SlipId;
export function id(prefix: "jms", len?: number): JarMilestoneId;
export function id(prefix: "rsi", len?: number): RescueInterventionId;
export function id(prefix: "sta", len?: number): StreakAchievementId;
export function id(prefix: "rcp", len?: number): RecapId;
export function id(prefix: "ntf", len?: number): NotificationId;
export function id(prefix: "del", len?: number): AccountDeletionId;
export function id(prefix: string, len?: number): string;
export function id(prefix: string, len = 32): string {
  return genId(prefix, { length: len });
}

// Short human-friendly invite code, e.g. "XEX24K"
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function inviteCode(len = 6): InviteCode {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return InviteCodeSchema.parse(s);
}

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

export function id(prefix: "usr", len?: number): UserId;
export function id(prefix: "jar", len?: number): JarId;
export function id(prefix: "rpt", len?: number): ReportId;
export function id(prefix: "sess", len?: number): SessionToken;
export function id(prefix: string, len?: number): string;
export function id(prefix: string, len = 8): string {
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

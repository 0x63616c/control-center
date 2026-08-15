import { genId } from "@www/platform";

export function id(prefix: string, len = 8): string {
  return genId(prefix, { length: len });
}

// Short human-friendly invite code, e.g. "XEX24K"
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function inviteCode(len = 6): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

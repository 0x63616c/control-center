export type ContentSafetyReason =
  | "severe_slur"
  | "sexual_threat"
  | "targeted_self_harm"
  | "invalid_content"
  | "input_too_large";

export type ContentSafetyResult =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: ContentSafetyReason }>;

export const MAX_CONTENT_SAFETY_INPUT_CODE_UNITS = 4096;

const SEVERE_SLURS = new Set([
  "nigger",
  "faggot",
  "kike",
  "chink",
  "spic",
  "tranny",
  "cunt",
  "retard",
]);

const EVASION_CHAR_MAP: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  $: "s",
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  і: "i",
  ј: "j",
  к: "k",
  м: "m",
  т: "t",
  н: "h",
  в: "b",
};

const SEXUAL_THREAT_PATTERNS = [
  /\b(?:i will|i am going to|im going to|we will|we are going to|were going to) rape (?:you|him|her|them)\b/,
  /\b(?:i will|i am going to|im going to|we will|we are going to|were going to) sexually assault (?:you|him|her|them)\b/,
  /\b(?:you|he|she|they) deserve(?:s)? to be raped\b/,
  /\b(?:i will|i am going to|im going to|we will|we are going to|were going to) force (?:myself|ourselves) on (?:you|him|her|them)\b/,
] as const;

const TARGETED_SELF_HARM_PATTERNS = [
  /\byou should die\b/,
  /\byou should (?:kill|hurt|cut) yourself\b/,
  /\byou should commit suicide\b/,
] as const;
const PROTECTIVE_NEGATIONS = new Set(["dont", "not", "never"]);

function containsUnnegatedSequence(
  tokens: readonly string[],
  sequence: readonly string[],
): boolean {
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    if (!sequence.every((token, offset) => tokens[index + offset] === token)) continue;
    if (!PROTECTIVE_NEGATIONS.has(tokens[index - 1] ?? "")) return true;
  }
  return false;
}

function safetyTokens(input: string): readonly string[] {
  const canonical = [...input.normalize("NFKC").toLowerCase().normalize("NFKD")]
    .filter((character) => !/[\p{Cf}\p{M}]/u.test(character))
    .map((character) => EVASION_CHAR_MAP[character] ?? character)
    .join("")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (canonical.length === 0) return [];

  const rawTokens = canonical.split(/ +/);
  const tokens: string[] = [];
  for (let index = 0; index < rawTokens.length; ) {
    if (rawTokens[index]?.length !== 1) {
      tokens.push(rawTokens[index] ?? "");
      index += 1;
      continue;
    }
    let end = index;
    while (rawTokens[end]?.length === 1) end += 1;
    const run = rawTokens.slice(index, end);
    tokens.push(run.length > 1 ? run.join("") : (run[0] ?? ""));
    index = end;
  }
  return tokens;
}

export function evaluateTextContent(input: unknown): ContentSafetyResult {
  if (typeof input !== "string") return { allowed: false, reason: "invalid_content" };
  if (input.length > MAX_CONTENT_SAFETY_INPUT_CODE_UNITS) {
    return { allowed: false, reason: "input_too_large" };
  }
  // Treat format characters both as an in-word insertion and as a word break.
  // Attackers use both; evaluating two bounded canonical forms avoids guessing.
  const tokenVariants = [safetyTokens(input), safetyTokens(input.replace(/\p{Cf}/gu, " "))];
  if (tokenVariants.every((tokens) => tokens.length === 0)) {
    return { allowed: false, reason: "invalid_content" };
  }
  if (tokenVariants.some((tokens) => tokens.some((token) => SEVERE_SLURS.has(token)))) {
    return { allowed: false, reason: "severe_slur" };
  }
  if (
    tokenVariants.some((tokens) =>
      SEXUAL_THREAT_PATTERNS.some((pattern) => pattern.test(tokens.join(" "))),
    )
  ) {
    return { allowed: false, reason: "sexual_threat" };
  }
  if (
    tokenVariants.some(
      (tokens) =>
        containsUnnegatedSequence(tokens, ["kys"]) ||
        containsUnnegatedSequence(tokens, ["kill", "yourself"]) ||
        containsUnnegatedSequence(tokens, ["go", "die"]) ||
        TARGETED_SELF_HARM_PATTERNS.some((pattern) => pattern.test(tokens.join(" "))),
    )
  ) {
    return { allowed: false, reason: "targeted_self_harm" };
  }
  return { allowed: true };
}

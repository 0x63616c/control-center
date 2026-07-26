// Stripe-style `prefix_<id>` is this repo's ID convention (AGENTS.md). Route
// every ID mint through here instead of hand-rolling `` `${prefix}_${crypto.randomUUID()}` ``
// at each call site — see scripts/check-no-inline-ids.sh, the CI guard that
// rejects that pattern outside this file.

const FALLBACK_ALPHABET_BASE = 36;

// crypto.randomUUID is present in every real runtime this repo ships to
// (browser webview, Bun, Node), but not always in test doubles (older jsdom,
// Storybook). The fallback keeps those environments from throwing.
function randomHex(length: number): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replaceAll("-", "").slice(0, length);
  }
  let out = "";
  while (out.length < length) {
    out += Math.random().toString(FALLBACK_ALPHABET_BASE).slice(2);
  }
  return out.slice(0, length);
}

/**
 * Mint a Stripe-style `prefix_<id>`. Without `length`, the id is a full
 * `crypto.randomUUID()` (36 chars incl. dashes). With `length`, it is that
 * many hex characters of a de-dashed UUID — for ids that also need to fit a
 * shorter validation pattern (e.g. an API's `^prefix_[0-9a-z]{1,32}$`).
 */
export function genId(prefix: string, options?: { length?: number }): string {
  const { length } = options ?? {};
  if (length === undefined) {
    const uuid =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : randomHex(32);
    return `${prefix}_${uuid}`;
  }
  return `${prefix}_${randomHex(length)}`;
}

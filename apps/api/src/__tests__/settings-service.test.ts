import { describe, expect, it } from "vitest";
import { DEFAULTS, getSettings } from "../services/settings-service";

// getSettings takes the db as an argument, so a hand-rolled fake standing in for
// the `select().from().where().limit()` chain is enough , no module mock needed.
function fakeDb(storedValue: unknown) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(storedValue === undefined ? [] : [{ value: storedValue }]),
        }),
      }),
    }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal stand-in for the drizzle db
  } as any;
}

describe("settings-service DEFAULTS", () => {
  it("carries the minimap + PIN defaults", () => {
    expect(DEFAULTS.showMinimap).toBe(true);
    expect(DEFAULTS.pinCode).toBe("000000");
    expect(DEFAULTS.showBuildNumber).toBe(false);
  });

  // Scrambling ships ON (#287): the feature exists because a fixed pad leaks the
  // PIN's digit set through fingerprints, and a security default that has to be
  // discovered in Settings protects nobody.
  it("defaults scramblePin to true", () => {
    expect(DEFAULTS.scramblePin).toBe(true);
  });
});

describe("getSettings", () => {
  it("returns DEFAULTS when the row is absent", async () => {
    const s = await getSettings(fakeDb(undefined));
    expect(s).toEqual(DEFAULTS);
  });

  it("merges a legacy blob (missing the new fields) over DEFAULTS", async () => {
    // A row written before the minimap + PIN fields existed.
    const legacy = {
      activeBrightness: 1,
      idleDimEnabled: true,
      idleDimTimeoutMs: 600_000,
      idleDimLevel: 0.25,
      recenterEnabled: true,
      recenterTimeoutMs: 600_000,
      showFps: false,
      showBuildBadge: true,
      snapMode: "mandatory-settle",
    };
    const s = await getSettings(fakeDb(legacy));
    expect(s.showMinimap).toBe(true);
    expect(s.pinCode).toBe("000000");
  });

  it("silently drops a stored blob's retired recenter fields", async () => {
    // recenterEnabled/recenterTimeoutMs were retired once the panel-session
    // module took over glide-home at session end (idleDimEnabled/idleDimTimeoutMs
    // on the Display page). Rows written before the retirement still carry these
    // keys; settingsSchema has no `.strict()`, so zod strips them rather than
    // throwing, and getSettings must not surface them.
    const legacyWithRecenter = { ...DEFAULTS, recenterEnabled: true, recenterTimeoutMs: 600_000 };
    const s = await getSettings(fakeDb(legacyWithRecenter));
    expect(s).toEqual(DEFAULTS);
    expect(s).not.toHaveProperty("recenterEnabled");
    expect(s).not.toHaveProperty("recenterTimeoutMs");
  });

  it("falls back to DEFAULTS for a stored timeout above the 10 min cap", async () => {
    // The server used to accept up to an hour while the panel clamped every edit
    // to 10 min, so the looser ceiling could only ever be reached by editing the
    // row by hand. Both sides now share one bound (contract/settings.ts), and an
    // out-of-range blob fails validation , which getSettings catches, logs, and
    // answers with DEFAULTS rather than propagating.
    const s = await getSettings(fakeDb({ ...DEFAULTS, idleDimTimeoutMs: 3_600_000 }));
    expect(s).toEqual(DEFAULTS);
  });
});

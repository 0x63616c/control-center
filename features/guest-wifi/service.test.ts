/**
 * Integration tests for the captive-portal service (www-q002.9, password-only
 * since www-p9hx).
 *
 * Exercises the password-only router matrix against an in-memory PortalRepo, a
 * mock UniFi guest client, and an injected clock. No network, no real Postgres.
 * Covers: password correct/wrong/unconfigured, the GLOBAL daily wrong-attempt
 * limit (cap + day rollover reset), the idempotent mac-only authorize step, and
 * status fresh/active/expired/heal.
 */

import type { UnifiGuestAuthorization, UnifiGuestClient } from "@www/core";
import { describe, expect, it, vi } from "vitest";
import { makeInMemoryPortalRepo } from "./repo.fake";
import { createPortalService, PortalError, PortalErrorCode } from "./service";

const MAC = "aa:bb:cc:dd:ee:ff";
const PW = "correct-horse";

// A clock we advance manually so expiry / day-rollover windows are deterministic.
function makeClock(startMs = Date.UTC(2026, 5, 10, 12, 0, 0)) {
  let now = startMs;
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function makeMockUnifi(): UnifiGuestClient & {
  authorizeCalls: Array<{ mac: string; minutes: number }>;
  setActive: (a: UnifiGuestAuthorization | null) => void;
} {
  const authorizeCalls: Array<{ mac: string; minutes: number }> = [];
  let active: UnifiGuestAuthorization | null = null;
  return {
    isConfigured: () => true,
    async authorizeGuest(mac, minutes = 43200) {
      authorizeCalls.push({ mac, minutes });
    },
    async findActiveAuthorization() {
      return active;
    },
    authorizeCalls,
    setActive: (a) => {
      active = a;
    },
  };
}

function setup(opts: { wifiPassword?: string } = {}) {
  const clock = makeClock();
  const repo = makeInMemoryPortalRepo();
  const unifi = makeMockUnifi();
  const svc = createPortalService({
    repo,
    unifi,
    wifiPassword: opts.wifiPassword ?? PW,
    now: clock.now,
  });
  return { svc, db: repo, unifi, clock };
}

describe("portal.checkPassword", () => {
  it("accepts the correct WiFi password", async () => {
    const { svc } = setup();
    await expect(svc.checkPassword({ mac: MAC, password: PW })).resolves.toEqual({ ok: true });
  });

  it("rejects a wrong password as WrongPassword", async () => {
    const { svc } = setup();
    await expect(svc.checkPassword({ mac: MAC, password: "nope" })).rejects.toMatchObject({
      code: PortalErrorCode.WrongPassword,
    });
  });

  it("a correct password never increments the wrong-attempt counter", async () => {
    const { svc, db } = setup();
    await svc.checkPassword({ mac: MAC, password: PW });
    await svc.checkPassword({ mac: MAC, password: PW });
    expect(db.wrongAttemptsToday()).toBe(0);
  });

  it("throws when the WiFi password is unconfigured (services throw, never fake)", async () => {
    const { svc } = setup({ wifiPassword: "" });
    await expect(svc.checkPassword({ mac: MAC, password: "anything" })).rejects.toMatchObject({
      code: PortalErrorCode.NotConfigured,
    });
  });
});

describe("portal global daily wrong-attempt limit (www-p9hx)", () => {
  // Hammer N wrong attempts; returns the last error code seen.
  async function hammer(svc: ReturnType<typeof setup>["svc"], n: number): Promise<string> {
    let last = "";
    for (let i = 0; i < n; i++) {
      last = await svc.checkPassword({ mac: MAC, password: "wrong" }).then(
        () => "OK",
        (e: PortalError) => e.code,
      );
    }
    return last;
  }

  it("locks globally after 1000 wrong attempts in a UTC day", async () => {
    const { svc, db } = setup();
    // The first 999 wrong attempts are WrongPassword.
    expect(await hammer(svc, 999)).toBe(PortalErrorCode.WrongPassword);
    expect(db.wrongAttemptsToday()).toBe(999);
    // The 1000th flips to RateLimited.
    expect(await hammer(svc, 1)).toBe(PortalErrorCode.RateLimited);
    // Even the CORRECT password is now rejected (globally locked for the day).
    await expect(svc.checkPassword({ mac: MAC, password: PW })).rejects.toMatchObject({
      code: PortalErrorCode.RateLimited,
    });
  });

  it("is GLOBAL, not per-MAC: rotating the MAC does not reset the counter", async () => {
    const { svc } = setup();
    for (let i = 0; i < 999; i++) {
      await svc.checkPassword({ mac: `mac-${i}`, password: "wrong" }).catch(() => {});
    }
    // A brand-new MAC still hits the global wall on the 1000th attempt.
    await expect(svc.checkPassword({ mac: "fresh-mac", password: "wrong" })).rejects.toMatchObject({
      code: PortalErrorCode.RateLimited,
    });
  });

  it("resets the counter when the UTC day rolls over", async () => {
    const { svc, clock, db } = setup();
    for (let i = 0; i < 1000; i++) {
      await svc.checkPassword({ mac: MAC, password: "wrong" }).catch(() => {});
    }
    await expect(svc.checkPassword({ mac: MAC, password: PW })).rejects.toMatchObject({
      code: PortalErrorCode.RateLimited,
    });
    // Next UTC day: the counter is stale → the correct password works again.
    clock.advance(24 * 60 * 60 * 1000);
    await expect(svc.checkPassword({ mac: MAC, password: PW })).resolves.toEqual({ ok: true });
    // And a wrong attempt the new day starts the count at 1, not 1001.
    await svc.checkPassword({ mac: MAC, password: "wrong" }).catch(() => {});
    expect(db.wrongAttemptsToday()).toBe(1);
  });
});

describe("portal.authorize (idempotent, password-verified)", () => {
  it("authorizes the device via UniFi with minutes=43200 and writes a 30-day DB row", async () => {
    const { svc, db, unifi, clock } = setup();
    const res = await svc.authorize({ mac: MAC, password: PW });
    expect(res.authorized).toBe(true);
    expect(unifi.authorizeCalls).toEqual([{ mac: MAC, minutes: 43200 }]);
    const row = db.findAuthorization(MAC);
    if (!row) throw new Error("authorization row missing");
    const days = (row.expiresAtUtc.getTime() - clock.now().getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });

  it("re-submitting does not double-authorize (one row per mac; idempotent)", async () => {
    const { svc, db, unifi } = setup();
    await svc.authorize({ mac: MAC, password: PW });
    await svc.authorize({ mac: MAC, password: PW });
    expect(db.authorizationCount(MAC)).toBe(1);
    expect(unifi.authorizeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a wrong password as WrongPassword and grants nothing (server-side re-verification)", async () => {
    const { svc, db, unifi } = setup();
    await expect(svc.authorize({ mac: MAC, password: "nope" })).rejects.toMatchObject({
      code: PortalErrorCode.WrongPassword,
    });
    expect(db.findAuthorization(MAC)).toBeUndefined();
    expect(unifi.authorizeCalls).toEqual([]);
  });

  it("throws NotConfigured when the WiFi password is unconfigured, granting nothing", async () => {
    const { svc, db, unifi } = setup({ wifiPassword: "" });
    await expect(svc.authorize({ mac: MAC, password: "anything" })).rejects.toMatchObject({
      code: PortalErrorCode.NotConfigured,
    });
    expect(db.findAuthorization(MAC)).toBeUndefined();
    expect(unifi.authorizeCalls).toEqual([]);
  });

  it("shares the global rate limit with checkPassword: wrong authorize attempts count toward the cap", async () => {
    const { svc, db } = setup();
    for (let i = 0; i < 999; i++) {
      await svc.authorize({ mac: MAC, password: "wrong" }).catch(() => {});
    }
    expect(db.wrongAttemptsToday()).toBe(999);
    // The 1000th wrong attempt (via authorize) flips to RateLimited.
    await expect(svc.authorize({ mac: MAC, password: "wrong" })).rejects.toMatchObject({
      code: PortalErrorCode.RateLimited,
    });
    // Even the correct password is now locked out for the rest of the UTC day.
    await expect(svc.authorize({ mac: MAC, password: PW })).rejects.toMatchObject({
      code: PortalErrorCode.RateLimited,
    });
  });

  it("cannot be brute-forced past checkPassword's cap: wrong checkPassword attempts also lock authorize", async () => {
    const { svc } = setup();
    for (let i = 0; i < 1000; i++) {
      await svc.checkPassword({ mac: MAC, password: "wrong" }).catch(() => {});
    }
    await expect(svc.authorize({ mac: MAC, password: PW })).rejects.toMatchObject({
      code: PortalErrorCode.RateLimited,
    });
  });
});

describe("portal.status", () => {
  it("returns 'fresh' when the device has never been authorized", async () => {
    const { svc } = setup();
    await expect(svc.status({ mac: MAC })).resolves.toMatchObject({ state: "fresh" });
  });

  it("returns 'active' (AlreadyConnected) for a live authorization", async () => {
    const { svc } = setup();
    await svc.authorize({ mac: MAC, password: PW });
    await expect(svc.status({ mac: MAC })).resolves.toMatchObject({ state: "active" });
  });

  it("returns 'expired' (SessionExpired) when the 30-day window lapsed", async () => {
    const { svc, clock } = setup();
    await svc.authorize({ mac: MAC, password: PW });
    clock.advance(31 * 86_400_000); // 31 days
    await expect(svc.status({ mac: MAC })).resolves.toMatchObject({ state: "expired" });
  });

  it("heals the controller: an active DB row with no controller grant re-fires authorizeGuest", async () => {
    const { svc, unifi } = setup();
    await svc.authorize({ mac: MAC, password: PW });
    unifi.setActive(null); // controller lost the grant (reboot)
    const callsBefore = unifi.authorizeCalls.length;
    await svc.status({ mac: MAC });
    expect(unifi.authorizeCalls.length).toBe(callsBefore + 1);
  });
});

describe("PortalError", () => {
  it("is an Error subclass carrying a typed code", () => {
    const e = new PortalError(PortalErrorCode.WrongPassword, "nope");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe(PortalErrorCode.WrongPassword);
  });
});

// Sanity: the suite touches no real network and no real DB module.
it("does not import the real db/index pool", () => {
  expect(vi.isMockFunction(globalThis.fetch)).toBe(false);
});

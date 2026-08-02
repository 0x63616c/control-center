/**
 * Tests for the Notification Center service + APNs sender (Track C, S1 fold).
 * One file (not service.test.ts + apns.test.ts) because apps/api's vitest
 * project only collects `features/**\/{service,api}.test.ts` by filename
 * convention (mirrors codegen's facet files) , see apps/api/vitest.config.ts.
 *
 * Behaviour that matters and is easy to regress: dedupe-key collapse (a repeat
 * raise must UPDATE, not insert, and must resurface the row as unread), the
 * unread badge being a global count rather than a count of the returned page,
 * markAllRead clearing it, the ES256 provider JWT (wrong claims or a
 * mis-encoded signature means every push 403s, invisibly), and the
 * stale-token path (a 410 / BadDeviceToken must DELETE the row rather than
 * retry forever).
 *
 * The DB is fully mocked (no Postgres), following frontend-log-service.test.ts:
 * each builder method records its argument and returns the chain, so a test can
 * assert the exact shape handed to drizzle. @www/core's enqueueJob is mocked
 * too , the real one writes through a real db. The JWT tests sign with a
 * locally generated P-256 key and verify the signature with the matching
 * public key (mirrors asc-version-service.test.ts), proving real cryptographic
 * correctness without a real .p8.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as schema from "./schema";

const queueMock = vi.hoisted(() => ({
  enqueued: [] as Array<{ type: string; payload: unknown }>,
}));
vi.mock("@www/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@www/core")>();
  return {
    ...actual,
    enqueueJob: vi.fn(async (_db: unknown, type: string, payload: unknown) => {
      queueMock.enqueued.push({ type, payload });
      return 1;
    }),
  };
});

// The service imports the feature's own singleton db (only the job handler
// uses it); stub it so importing the module never opens a connection.
vi.mock("./db", () => ({ db: {} }));

const configMock = vi.hoisted(() => ({
  DATABASE_URL: "postgresql://cc:cc@localhost:5432/controlcenter",
  APNS_KEY_ID: "TESTKEY123",
  APNS_TEAM_ID: "TEAM123456",
  APNS_KEY_CONTENT: "",
  APNS_BUNDLE_ID: "co.worldwidewebb.theworkflowengine",
  APNS_HOST: "https://api.push.apple.com",
}));
vi.mock("./config", () => ({ config: configMock }));

/**
 * node:http2 stand-in. APNs is HTTP/2-only and Bun's fetch cannot speak it, so
 * the sender uses node:http2 directly and these tests drive that transport
 * rather than a fetch stub. `h2` is the knob each test sets: a status+body to
 * reply with, or an error to emit instead.
 */
const h2 = vi.hoisted(() => ({
  status: 200,
  body: "",
  error: null as Error | null,
  /** Records what the sender actually sent, so header/path assertions can run. */
  lastRequest: null as { headers: Record<string, string>; body: string; origin: string } | null,
}));

vi.mock("node:http2", () => {
  const connect = (origin: string) => {
    const sessionHandlers: Record<string, (arg: unknown) => void> = {};
    return {
      on: (event: string, fn: (arg: unknown) => void) => {
        sessionHandlers[event] = fn;
      },
      close: () => {},
      request: (headers: Record<string, string>) => {
        const handlers: Record<string, (arg: unknown) => void> = {};
        return {
          on: (event: string, fn: (arg: unknown) => void) => {
            handlers[event] = fn;
          },
          setTimeout: () => {},
          setEncoding: () => {},
          destroy: () => {},
          end: (body: string) => {
            h2.lastRequest = { headers, body, origin };
            // Async so the sender's promise wiring is exercised for real.
            queueMicrotask(() => {
              if (h2.error) {
                handlers.error?.(h2.error);
                return;
              }
              handlers.response?.({ ":status": h2.status });
              if (h2.body) handlers.data?.(h2.body);
              handlers.end?.(undefined);
            });
          },
        };
      },
    };
  };
  return { default: { connect }, connect };
});

import { api } from "./api";
import {
  type ApnsAlert,
  buildApnsPayload,
  isApnsConfigured,
  sendApnsPush,
  signApnsJwt,
} from "./apns";
import {
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  newNotificationId,
  raiseNotification,
  registerPushToken,
  runRaiseNotificationJob,
} from "./service";

describe("runRaiseNotificationJob", () => {
  it("rejects durable intents without a stable dedupe key", async () => {
    await expect(
      runRaiseNotificationJob(
        { category: "home", severity: "info", title: "New weight logged" },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
});

type Db = NodePgDatabase<typeof schema>;

/** A notification row as the DB would return it. */
function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "notif_deadbeef",
    createdAt: new Date("2026-07-18T10:00:00Z"),
    category: "ci",
    severity: "warning",
    title: "Deploy failed",
    body: null,
    deepLink: null,
    data: null,
    readAt: null,
    dedupeKey: null,
    ...over,
  };
}

/**
 * Mock db recording every builder call.
 *
 * Drizzle chains are awaitable at any point, so the mock's chain objects ARE
 * promises with the builder methods attached (rather than hand-rolled `then`
 * properties, which biome bans). The two select shapes are told apart by
 * terminator, not by call order: a feed read ends in `.limit()` and resolves
 * `listRows`, while a count read is awaited directly off `.where()` and
 * resolves `countRows`.
 */
function makeDb(listRows: unknown[] = [], countRows: unknown[] = []) {
  const calls = {
    insertValues: [] as unknown[],
    onConflictDoUpdate: [] as unknown[],
    updateSets: [] as unknown[],
    deletes: 0,
  };
  let returningRows: unknown[] = [row()];

  const selectChain = () => {
    const chain = Object.assign(Promise.resolve(countRows), {
      limit: () => Promise.resolve(listRows),
    }) as unknown as Promise<unknown[]> & Record<string, unknown>;
    for (const m of ["from", "where", "orderBy"]) chain[m] = () => chain;
    return chain;
  };

  const db = {
    select: () => selectChain(),
    insert: () => ({
      values: (v: unknown) => {
        calls.insertValues.push(v);
        return Object.assign(Promise.resolve(undefined), {
          onConflictDoUpdate: (cfg: unknown) => {
            calls.onConflictDoUpdate.push(cfg);
            return Object.assign(Promise.resolve(undefined), {
              returning: () => Promise.resolve(returningRows),
            });
          },
          returning: () => Promise.resolve(returningRows),
        });
      },
    }),
    update: () => ({
      set: (s: unknown) => {
        calls.updateSets.push(s);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    delete: () => {
      calls.deletes++;
      return { where: () => Promise.resolve(undefined) };
    },
  } as unknown as Db;

  return {
    db,
    calls,
    setReturning: (rows: unknown[]) => {
      returningRows = rows;
    },
  };
}

beforeEach(() => {
  queueMock.enqueued.length = 0;
});

// ─── ids ─────────────────────────────────────────────────────────────────────

describe("newNotificationId", () => {
  it("mints a Stripe-style notif_<8hex> id", () => {
    expect(newNotificationId()).toMatch(/^notif_[0-9a-f]{8}$/);
  });

  it("does not collide across calls", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newNotificationId()));
    expect(ids.size).toBe(200);
  });
});

// ─── dedupe collapse ─────────────────────────────────────────────────────────

describe("raiseNotification dedupe", () => {
  it("collapses a keyed raise onto the existing row via onConflictDoUpdate", async () => {
    const { db, calls, setReturning } = makeDb();
    setReturning([row({ dedupeKey: "ci:deploy-failed" })]);

    await raiseNotification(db, {
      category: "ci",
      severity: "warning",
      title: "Deploy failed",
      dedupeKey: "ci:deploy-failed",
    });

    expect(calls.onConflictDoUpdate).toHaveLength(1);
    const cfg = calls.onConflictDoUpdate[0] as { set: Record<string, unknown> };
    // The repeat is news again: the collapse must clear readAt, otherwise a
    // recurring failure the user read once stays invisible.
    expect(cfg.set.readAt).toBeNull();
    expect(cfg.set.createdAt).toBeInstanceOf(Date);
  });

  it("does NOT upsert when no dedupeKey is given (every raise is distinct)", async () => {
    const { db, calls } = makeDb();

    await raiseNotification(db, { category: "home", severity: "info", title: "Door unlocked" });

    expect(calls.onConflictDoUpdate).toHaveLength(0);
    expect(calls.insertValues).toHaveLength(1);
    expect((calls.insertValues[0] as { dedupeKey: unknown }).dedupeKey).toBeNull();
  });

  it("enqueues exactly one notify job per raise", async () => {
    const { db } = makeDb();
    await raiseNotification(db, { category: "system", severity: "critical", title: "Disk full" });
    expect(queueMock.enqueued).toEqual([
      { type: "notify", payload: { notificationId: "notif_deadbeef" } },
    ]);
  });

  it("skips the upsert + notify job when a re-raise repeats an unread row's content unchanged", async () => {
    const existing = row({
      category: "system",
      severity: "info",
      dedupeKey: "app-update:2 builds behind",
      title: "Update available",
      body: "1.0 (68) · 2 builds behind",
    });
    const { db, calls } = makeDb([existing]);

    const item = await raiseNotification(db, {
      category: "system",
      severity: "info",
      title: "Update available",
      body: "1.0 (68) · 2 builds behind",
      dedupeKey: "app-update:2 builds behind",
    });

    expect(calls.insertValues).toHaveLength(0);
    expect(calls.onConflictDoUpdate).toHaveLength(0);
    expect(queueMock.enqueued).toHaveLength(0);
    expect(item.id).toBe(existing.id);
  });

  it("still re-raises when the repeated dedupeKey's content actually changed", async () => {
    const existing = row({
      dedupeKey: "app-update",
      title: "Update available",
      body: "1.0 (68) · 2 builds behind",
    });
    const { db, calls, setReturning } = makeDb([existing]);
    setReturning([row({ dedupeKey: "app-update", body: "1.0 (69) · 3 builds behind" })]);

    await raiseNotification(db, {
      category: "system",
      severity: "info",
      title: "Update available",
      body: "1.0 (69) · 3 builds behind",
      dedupeKey: "app-update",
    });

    expect(calls.onConflictDoUpdate).toHaveLength(1);
    expect(queueMock.enqueued).toHaveLength(1);
  });

  it("returns the persisted row as an ISO-stamped wire item", async () => {
    const { db } = makeDb();
    const item = await raiseNotification(db, {
      category: "ci",
      severity: "warning",
      title: "Deploy failed",
    });
    expect(item.createdAt).toBe("2026-07-18T10:00:00.000Z");
    expect(item.readAt).toBeNull();
  });
});

// ─── feed + unread count ─────────────────────────────────────────────────────

describe("listNotifications", () => {
  it("returns items plus the GLOBAL unread count, not the page size", async () => {
    // One item on the page, but seven unread overall.
    const { db } = makeDb([row()], [{ count: 7 }]);

    const res = await listNotifications(db, { filter: "all", limit: 50 });

    expect(res.items).toHaveLength(1);
    expect(res.unreadCount).toBe(7);
  });

  it("serves read rows on the All tab without disturbing the unread badge", async () => {
    const { db } = makeDb([row({ readAt: new Date("2026-07-18T11:00:00Z") })], [{ count: 4 }]);
    const res = await listNotifications(db, { filter: "all", limit: 50 });
    expect(res.items[0]?.readAt).toBe("2026-07-18T11:00:00.000Z");
    // The badge is the global unread total, not a property of the view.
    expect(res.unreadCount).toBe(4);
  });

  it("reports zero unread when the count query returns no rows", async () => {
    const { db } = makeDb([], []);
    const res = await listNotifications(db, { filter: "unread", limit: 50 });
    expect(res.items).toEqual([]);
    expect(res.unreadCount).toBe(0);
  });
});

describe("countUnread", () => {
  it("reads the ::int-cast count", async () => {
    const { db } = makeDb([], [{ count: 3 }]);
    expect(await countUnread(db)).toBe(3);
  });
});

// ─── read lifecycle ──────────────────────────────────────────────────────────

describe("markRead / markAllRead", () => {
  it("markRead stamps readAt and returns the fresh count", async () => {
    const { db, calls } = makeDb([], [{ count: 2 }]);
    const res = await markRead(db, "notif_deadbeef");
    expect((calls.updateSets[0] as { readAt: unknown }).readAt).toBeInstanceOf(Date);
    expect(res.unreadCount).toBe(2);
  });

  it("markAllRead clears the badge to zero", async () => {
    const { db, calls } = makeDb([], [{ count: 0 }]);
    const res = await markAllRead(db);
    expect(calls.updateSets).toHaveLength(1);
    expect((calls.updateSets[0] as { readAt: unknown }).readAt).toBeInstanceOf(Date);
    expect(res.unreadCount).toBe(0);
  });
});

// ─── push token registration ─────────────────────────────────────────────────

describe("registerPushToken", () => {
  it("upserts on deviceId so a rotated token replaces the old row", async () => {
    const { db, calls } = makeDb();
    await registerPushToken(db, {
      deviceId: "ipad13-1-3f9a2c1b",
      token: "abc123",
      platform: "ios",
      deviceName: "Wall Panel",
      pushEnabled: true,
    });
    expect(calls.onConflictDoUpdate).toHaveLength(1);
    const cfg = calls.onConflictDoUpdate[0] as { set: Record<string, unknown> };
    expect(cfg.set.token).toBe("abc123");
  });
});

// ─── router wiring ───────────────────────────────────────────────────────────

describe("notifications router", () => {
  it("exposes the full procedure surface the panel depends on", () => {
    const procs = Object.keys(
      (api as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures,
    ).filter((k) => k.startsWith("notifications."));
    expect(procs.sort()).toEqual(
      [
        "notifications.list",
        "notifications.markAllRead",
        "notifications.markRead",
        "notifications.raise",
        "notifications.registerToken",
      ].sort(),
    );
  });
});

// ─── APNs sender ─────────────────────────────────────────────────────────────

async function generateP8Pem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const b64 = Buffer.from(pkcs8).toString("base64");
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`,
    publicKey: pair.publicKey,
  };
}

function b64urlToJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString());
}

/** A minimal db mock that records delete() calls. */
function makeApnsDb() {
  const state = { deletes: 0 };
  const db = {
    delete: () => {
      state.deletes++;
      return { where: () => Promise.resolve(undefined) };
    },
  } as never;
  return { db, state };
}

const apnsAlert: ApnsAlert = {
  notificationId: "notif_deadbeef",
  title: "Deploy failed",
  body: "ci.yml failed on main",
  category: "ci",
  severity: "critical",
  deepLink: "/deploys",
  badge: 3,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isApnsConfigured", () => {
  beforeEach(() => {
    configMock.APNS_KEY_CONTENT = "";
  });

  it("is false without key content, and sending is a no-op", async () => {
    expect(isApnsConfigured()).toBe(false);
    h2.lastRequest = null;
    const { db } = makeApnsDb();
    expect(await sendApnsPush(db, "tok", apnsAlert)).toBe("skipped");
    // Nothing must hit the wire when APNs is unconfigured.
    expect(h2.lastRequest).toBeNull();
  });

  it("is true once all four values are present", async () => {
    configMock.APNS_KEY_CONTENT = (await generateP8Pem()).pem;
    expect(isApnsConfigured()).toBe(true);
  });
});

describe("signApnsJwt", () => {
  it("builds an ES256 header with the key id and APNs claims", async () => {
    const { pem } = await generateP8Pem();
    const jwt = await signApnsJwt("KEY123", "TEAM456", pem, 1_800_000_000_000);
    const [h, p] = jwt.split(".");
    expect(b64urlToJson(h as string)).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
    const payload = b64urlToJson(p as string);
    // APNs wants the TEAM id as iss and no aud  --  this is the one place it
    // differs from the otherwise-identical ASC token.
    expect(payload.iss).toBe("TEAM456");
    expect(payload).not.toHaveProperty("aud");
    expect(payload.iat).toBe(1_800_000_000);
    expect(payload.exp).toBe(1_800_000_000 + 30 * 60);
  });

  it("produces a signature that verifies against the key (raw R||S, not DER)", async () => {
    const { pem, publicKey } = await generateP8Pem();
    const jwt = await signApnsJwt("KEY123", "TEAM456", pem);
    const [h, p, s] = jwt.split(".");
    const sig = Buffer.from(s as string, "base64url");
    // ES256 raw signatures are exactly 64 bytes; a DER-encoded one would not be
    // and Apple would reject it.
    expect(sig.byteLength).toBe(64);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      sig,
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });

  it("accepts a base64-wrapped .p8 with no PEM armor (the vault's storage form)", async () => {
    const { pem } = await generateP8Pem();
    const wrapped = Buffer.from(pem, "utf-8").toString("base64");
    await expect(signApnsJwt("KEY123", "TEAM456", wrapped)).resolves.toContain(".");
  });
});

describe("buildApnsPayload", () => {
  it("nests title/body under aps.alert and hoists routing keys to the top level", () => {
    const body = buildApnsPayload(apnsAlert);
    expect(body.aps).toMatchObject({
      alert: { title: "Deploy failed", body: "ci.yml failed on main" },
      badge: 3,
    });
    expect(body.notificationId).toBe("notif_deadbeef");
    expect(body.deepLink).toBe("/deploys");
  });

  it("omits body and deepLink when absent rather than sending nulls", () => {
    const body = buildApnsPayload({
      notificationId: "notif_1",
      title: "Hi",
      category: "home",
      severity: "info",
    });
    expect((body.aps as { alert: object }).alert).toEqual({ title: "Hi" });
    expect(body).not.toHaveProperty("deepLink");
  });
});

describe("sendApnsPush", () => {
  beforeEach(async () => {
    configMock.APNS_KEY_CONTENT = (await generateP8Pem()).pem;
  });

  it("POSTs over HTTP/2 to the production host with the APNs headers", async () => {
    h2.status = 200;
    h2.body = "";
    h2.error = null;
    const { db } = makeApnsDb();

    expect(await sendApnsPush(db, "abc123token", apnsAlert)).toBe("sent");

    const sent = h2.lastRequest;
    // TestFlight builds are PRODUCTION push clients, so this must never be the
    // sandbox host.
    expect(sent?.origin).toBe("https://api.push.apple.com");
    expect(sent?.headers[":path"]).toBe("/3/device/abc123token");
    expect(sent?.headers[":method"]).toBe("POST");
    expect(sent?.headers.authorization).toMatch(/^bearer eyJ/);
    expect(sent?.headers["apns-topic"]).toBe("co.worldwidewebb.theworkflowengine");
    expect(sent?.headers["apns-push-type"]).toBe("alert");
  });

  it("deletes the token row on a 410 Unregistered", async () => {
    h2.status = 410;
    h2.body = JSON.stringify({ reason: "Unregistered" });
    h2.error = null;
    const { db, state } = makeApnsDb();
    expect(await sendApnsPush(db, "deadtoken", apnsAlert)).toBe("stale");
    expect(state.deletes).toBe(1);
  });

  it("deletes the token row on a 400 BadDeviceToken", async () => {
    h2.status = 400;
    h2.body = JSON.stringify({ reason: "BadDeviceToken" });
    h2.error = null;
    const { db, state } = makeApnsDb();
    expect(await sendApnsPush(db, "badtoken", apnsAlert)).toBe("stale");
    expect(state.deletes).toBe(1);
  });

  it("keeps the token on a transient 500 so a retry can still deliver", async () => {
    h2.status = 500;
    h2.body = "";
    h2.error = null;
    const { db, state } = makeApnsDb();
    expect(await sendApnsPush(db, "goodtoken", apnsAlert)).toBe("failed");
    expect(state.deletes).toBe(0);
  });

  it("absorbs a connection error instead of failing the whole fan-out", async () => {
    // The real regression: Bun's fetch could not do HTTP/2 and every push threw
    // Malformed_HTTP_Response. A transport error must stay contained here.
    h2.error = new Error("ECONNRESET");
    const { db } = makeApnsDb();
    expect(await sendApnsPush(db, "tok", apnsAlert)).toBe("failed");
  });
});

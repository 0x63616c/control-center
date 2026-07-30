/**
 * Seam-proof test for the S1 worker-job seam (Track C). Proves the worker's
 * generic fold is a REAL invocation path, not just a collection assertion:
 * imports the generated barrel the worker entrypoint spreads into `JOBS[]`,
 * finds the `notify` spec (features/notif's `defineJobs` facet), and INVOKES
 * its handler with a mocked feature db + mocked APNs sender, asserting the
 * notify path actually ran end-to-end through the generated import.
 *
 * The db/apns mocks target `@features/notif/db` and `@features/notif/apns` ,
 * the same absolute files features/notif/service.ts imports via its relative
 * `./db` / `./apns`, so vitest's module graph dedupes onto these mocks
 * regardless of which specifier resolves them.
 */
import { describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  notificationRow: null as Record<string, unknown> | null,
  deviceRows: [] as Array<{ token: string; pushEnabled: boolean }>,
  /** Reset before each invocation , handleNotifyJob issues exactly 3
   *  select()s in a fixed order: notification lookup (.limit(1)), device
   *  lookup (awaited directly), countUnread (awaited directly). */
  selectCallIndex: 0,
}));

vi.mock("@features/notif/db", () => ({
  db: {
    select: () => {
      const idx = dbMock.selectCallIndex++;
      return {
        from: () => ({
          where: () => {
            // Call 0: the notification row lookup , the caller chains .limit(1).
            if (idx === 0) {
              return {
                limit: () =>
                  Promise.resolve(dbMock.notificationRow ? [dbMock.notificationRow] : []),
              };
            }
            // Call 1: the push-enabled device list , awaited directly.
            if (idx === 1) {
              return Promise.resolve(dbMock.deviceRows);
            }
            // Call 2+: countUnread , awaited directly.
            return Promise.resolve([{ count: dbMock.deviceRows.length }]);
          },
        }),
      };
    },
  },
}));

const apnsMock = vi.hoisted(() => ({
  sent: [] as string[],
}));
vi.mock("@features/notif/apns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@features/notif/apns")>();
  return {
    ...actual,
    sendApnsPush: vi.fn(async (_db: unknown, token: string) => {
      apnsMock.sent.push(token);
      return "sent";
    }),
  };
});

import { GENERATED_JOBS } from "@features/_generated/jobs.gen";

describe("S1 worker job seam", () => {
  it("collects the notify job from features/notif via the generated barrel", () => {
    const notify = GENERATED_JOBS.find((s) => String(s.type) === "notify");
    expect(notify).toBeDefined();
    expect(typeof notify?.handler).toBe("function");
    expect(notify?.maxMs).toBe(60_000);
  });

  it("invokes the collected notify handler and runs the real APNs fan-out path", async () => {
    dbMock.notificationRow = {
      id: "notif_deadbeef",
      title: "Deploy failed",
      body: null,
      category: "ci",
      severity: "critical",
      deepLink: null,
      readAt: null,
    };
    dbMock.deviceRows = [{ token: "devtoken123", pushEnabled: true }];
    dbMock.selectCallIndex = 0;
    apnsMock.sent = [];

    const notify = GENERATED_JOBS.find((s) => String(s.type) === "notify");
    if (!notify) throw new Error("notify spec not found in GENERATED_JOBS");

    const controller = new AbortController();
    await notify.handler({ notificationId: "notif_deadbeef" }, controller.signal);

    // Proves the handler reachable through the generated barrel IS the real
    // `notify` handler: it loaded the mocked notification row and drove a real
    // APNs send attempt for the one push-enabled device.
    expect(apnsMock.sent).toEqual(["devtoken123"]);
  });
});

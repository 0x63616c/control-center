import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenMeteoBundle, runWeatherIngestCycle } from "./ingest";

// Capture every db.insert(...).values(rows) call. values() returns a thenable
// that also exposes onConflictDoUpdate, matching both the plain inserts and the
// heartbeat upsert in runWeatherIngestCycle.
// `streakRows` stands in for the current integrationSyncStatus row that
// markHeartbeat reads to increment consecutiveFailures on the error path.
const captured = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  streakRows: [] as { n: number }[],
}));
vi.mock("./db", () => ({
  db: {
    insert: () => ({
      values: (rows: unknown) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        captured.rows.push(...(arr as Record<string, unknown>[]));
        // A real Promise (natively awaitable for the plain inserts) with
        // onConflictDoUpdate attached for the heartbeat upsert path.
        return Object.assign(Promise.resolve(), {
          onConflictDoUpdate: () => Promise.resolve(),
        });
      },
    }),
    // currentFailureStreak(): select(...).from().where().limit() -> rows
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(captured.streakRows),
      };
      return chain;
    },
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function bundleResponse() {
  return {
    current: {
      time: "2026-06-04T18:00",
      temperature_2m: 72.4,
      apparent_temperature: 70.1,
      relative_humidity_2m: 58,
      weather_code: 2,
      wind_speed_10m: 9.3,
      is_day: 1,
      uv_index: 6.4,
    },
    hourly: {
      time: ["2026-06-04T17:00", "2026-06-04T18:00", "2026-06-04T19:00"],
      temperature_2m: [70, 72, 71],
      apparent_temperature: [68, 70, 69],
      relative_humidity_2m: [60, 58, 59],
      weather_code: [1, 2, 3],
      wind_speed_10m: [8, 9, 10],
      is_day: [1, 1, 0],
      precipitation_probability: [5, 10, 15],
    },
    daily: {
      time: ["2026-06-04", "2026-06-05"],
      temperature_2m_max: [80, 81],
      temperature_2m_min: [60, 61],
      weather_code: [2, 3],
      precipitation_probability_max: [20, 30],
      sunrise: ["2026-06-04T05:14", "2026-06-05T05:15"],
      sunset: ["2026-06-04T20:07", "2026-06-05T20:08"],
    },
  };
}

describe("fetchOpenMeteoBundle", () => {
  it("makes one request and returns parsed current/hourly/daily", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(bundleResponse()), { status: 200 }));

    const bundle = await fetchOpenMeteoBundle(34.0537, -118.2428);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bundle.hourly.time).toHaveLength(3);
    expect(bundle.daily.sunrise[0]).toBe("2026-06-04T05:14");
    expect(bundle.current.temperature_2m).toBe(72.4);
  });

  it("throws on non-OK upstream", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 502 }));
    await expect(fetchOpenMeteoBundle(0, 0)).rejects.toThrow("HTTP 502");
  });

  it("rejects a malformed payload at the edge (www-355t.16)", async () => {
    // 200 OK but the shape is wrong (current.temperature_2m is a string) , the
    // Zod schema must reject it rather than letting NaN rows be written.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ current: { temperature_2m: "warm" } }), { status: 200 }),
    );
    await expect(fetchOpenMeteoBundle(0, 0)).rejects.toThrow();
  });
});

describe("runWeatherIngestCycle", () => {
  it("appends forecast/observed hourly rows + a daily row per day + heartbeat", async () => {
    // Pin the clock inside the fixture's hour window (17:00–19:00 on 2026-06-04)
    // so 17:00 is observed and 18:00/19:00 are forecast. Without this the test
    // rots: once real wall-clock passes the fixture, every hour is in the past,
    // no forecast row is produced, and the forecast assertion fails (www-tfv).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 5, 4, 17, 30, 0));
    captured.rows.length = 0;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(bundleResponse()), { status: 200 }),
    );

    await runWeatherIngestCycle();

    const hourly = captured.rows.filter((r) => "kind" in r);
    const daily = captured.rows.filter((r) => "targetDate" in r);
    const heartbeat = captured.rows.filter((r) => "integrationId" in r);

    expect(hourly.length).toBe(3); // 3 hourly slots in the fixture
    expect(daily.length).toBe(2); // 2 daily entries
    expect(heartbeat.length).toBe(1);
    expect(heartbeat[0].integrationId).toBe("weather");
    // success resets the failure streak to 0
    expect(heartbeat[0].consecutiveFailures).toBe(0);

    // forecast rows carry integer temps and a Date target_hour
    const forecast = hourly.find((r) => r.kind === "forecast");
    expect(forecast).toBeDefined();
    expect(typeof forecast?.tempF).toBe("number");
    expect(forecast?.targetHour instanceof Date).toBe(true);
  });

  it("records the heartbeat with an error message, then rethrows, when the fetch fails", async () => {
    captured.rows.length = 0;
    captured.streakRows = [];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 502 }));

    // runCycle (www-bd0c) records the heartbeat BEFORE rethrowing, so the
    // worker runtime observes the failure and drives its own onset/recovery
    // liveness logging instead of this cycle silently swallowing it.
    await expect(runWeatherIngestCycle()).rejects.toThrow("HTTP 502");

    const heartbeat = captured.rows.filter((r) => "integrationId" in r);
    expect(heartbeat).toHaveLength(1);
    expect(heartbeat[0].lastError).toBe("HTTP 502");
    // no weather rows written on failure
    expect(captured.rows.filter((r) => "kind" in r)).toHaveLength(0);
  });

  it("increments consecutiveFailures from the prior streak on a failed cycle", async () => {
    // A prior row already shows 2 consecutive failures; the next failure makes 3.
    captured.rows.length = 0;
    captured.streakRows = [{ n: 2 }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 502 }));

    await expect(runWeatherIngestCycle()).rejects.toThrow();

    const heartbeat = captured.rows.filter((r) => "integrationId" in r);
    expect(heartbeat).toHaveLength(1);
    expect(heartbeat[0].consecutiveFailures).toBe(3);
  });
});

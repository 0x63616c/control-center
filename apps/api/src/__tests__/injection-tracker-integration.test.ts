import { scenario, usedVolume } from "@features/injections/model";
import { expect, it, vi } from "vitest";

// biome-ignore lint/style/noProcessEnv: Explicit opt-in to a disposable test database; never the application's DATABASE_URL.
const testUrl = process.env.INJECTION_TEST_DATABASE_URL;
it.skipIf(!testUrl)(
  "persists edits, protects vial capacity under concurrency, and keeps plans independent",
  async () => {
    if (
      !testUrl ||
      !/^postgresql:\/\/[^@]+@(?:localhost|127\.0\.0\.1):\d+\/injection_tracker$/.test(testUrl)
    )
      throw new Error("Use the disposable local injection_tracker database");
    vi.stubEnv("DATABASE_URL", testUrl);
    const { api } = await import("@features/injections/api");
    const { createContext } = await import("../trpc/context");
    const a = api.createCaller(createContext()).injections;
    const c = await a.saveCourse({
      config: {
        ...scenario("2026", "2026-09-04", "America/Los_Angeles"),
        name: "Integration test",
        status: "active",
      },
    });
    const initial = await a.detail({ courseId: c.id });
    const vial = initial.vials[0];
    expect(vial).toBeDefined();
    if (!vial) throw new Error("Initial vial missing");
    const draw = await a.saveInjection({
      courseId: c.id,
      vialId: vial.id,
      at: "2026-09-04T20:00:00Z",
      units: 3,
      notes: "test",
      plannedAt: null,
    });
    await a.saveInjection({
      id: draw.id,
      courseId: c.id,
      vialId: vial.id,
      at: "2026-09-04T21:00:00Z",
      units: 8,
      notes: "edited",
      plannedAt: null,
    });
    let data = await a.detail({ courseId: c.id });
    expect(usedVolume(vial, data.injections)).toBeCloseTo(0.08);
    expect(data.injections[0]?.at).toBe("2026-09-04T21:00:00.000Z");
    await expect(
      a.saveCourse({ id: c.id, config: { ...data.course, status: "scenario" } }),
    ).rejects.toThrow("cannot become a scenario");
    expect(data.course.stages).toEqual(initial.course.stages);
    const concurrent = await Promise.allSettled(
      [1, 2].map(() =>
        a.saveInjection({
          courseId: c.id,
          vialId: vial.id,
          at: "2026-09-04T22:00:00Z",
          units: 120,
          notes: "",
          plannedAt: null,
        }),
      ),
    );
    expect(concurrent.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((r) => r.status === "rejected")).toHaveLength(1);
    await expect(a.saveVial({ ...vial, concentration: 10 })).rejects.toThrow(
      "fixed after an injection",
    );
    await a.saveCheckIn({
      courseId: c.id,
      date: "2026-09-04",
      values: { Energy: 3 },
      notes: "first",
      weightId: null,
    });
    await a.saveCheckIn({
      courseId: c.id,
      date: "2026-09-04",
      values: { Energy: 2 },
      notes: "updated",
      weightId: null,
    });
    data = await a.detail({ courseId: c.id });
    expect(data.checkIns).toHaveLength(1);
    expect(data.checkIns[0]?.values.Energy).toBe(2);
    await a.deleteInjection({ id: draw.id, courseId: c.id });
    data = await a.detail({ courseId: c.id });
    expect(data.injections.some((i) => i.id === draw.id)).toBe(false);
    expect(usedVolume(vial, data.injections)).toBeCloseTo(1.2);
    const sc = await a.saveCourse({
      config: scenario("2024", "2024-07-05", "America/Los_Angeles"),
    });
    const sd = await a.detail({ courseId: sc.id });
    expect(sd.injections).toHaveLength(0);
    await expect(
      a.saveInjection({
        courseId: sc.id,
        vialId: sd.vials[0]?.id ?? vial.id,
        at: "2024-07-05T20:00:00Z",
        units: 5,
        notes: "",
        plannedAt: null,
      }),
    ).rejects.toThrow("Scenarios contain planned events only");
  },
  15000,
);

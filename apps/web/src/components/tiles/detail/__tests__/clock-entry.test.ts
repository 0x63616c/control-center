/**
 * Registry-shape test for the reworked clock detail entry (clock-suite plan
 * §10): Timer is the default variant, the switcher exposes exactly the five
 * clock variants in the Apple-Clock order (interactive trio first), and the
 * list is static , `loading: false` always, variants fetch/tick internally ,
 * so the switcher never pops.
 */

import { describe, expect, it, vi } from "vitest";

// Importing the clock wiring evaluates the time-suite stores (boot-resume runs
// at module load); keep any cue path silent , this test pins shape only.
vi.mock("@/lib/sound", () => ({ playCue: vi.fn(), warmAudio: vi.fn() }));

import { getTileDetailEntry } from "@features/_generated/web.gen";
import { renderHook } from "@testing-library/react";

describe("clock detail entry", () => {
  it("is a page titled 'Clock' defaulting to the Timer variant", () => {
    const entry = getTileDetailEntry("tile_clock");
    expect(entry?.kind).toBe("page");
    if (entry?.kind !== "page") throw new Error("expected a page entry");
    expect(entry.title).toBe("Clock");
    expect(entry.defaultSlug).toBe("timer");
    // No hand-wired gate , the clock page is not PIN-protected.
    expect(entry.sensitive).toBeUndefined();
  });

  it("exposes exactly the five variants, interactive trio first, never loading", () => {
    const entry = getTileDetailEntry("tile_clock");
    if (entry?.kind !== "page") throw new Error("expected a page entry");

    // The wiring hook subscribes to stores + the idle-hold seam but fetches
    // nothing itself (queries live inside the mounted variants), so it renders
    // bare , no trpc/query provider needed.
    const { result, unmount } = renderHook(() => entry.useVariants());

    expect(result.current.loading).toBe(false);
    expect(result.current.variants.map((v) => v.slug)).toEqual([
      "timer",
      "stopwatch",
      "alarm",
      "world-clocks",
      "countdown-horizon",
    ]);

    unmount();
  });
});

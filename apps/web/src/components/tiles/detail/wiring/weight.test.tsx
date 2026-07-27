/**
 * Wiring-level regression test for #250: switching the weight detail page's
 * metric selector must never render one metric's raw number under a
 * DIFFERENT metric's unit label ("wrong-scale flash"), and must not blank the
 * chart while the new metric's data is in flight.
 *
 * The trpc module is mocked directly (this repo's convention, see
 * Board.session.test.tsx) rather than wired to a real QueryClient: the mock
 * reproduces just enough of react-query's keepPreviousData semantics — serve
 * the previous metric's data with isPlaceholderData: true until the new
 * metric's data has "landed" — driven explicitly by the test via
 * resolveSummary().
 */

import "@testing-library/jest-dom";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Summary = {
  latestKg: number;
  latestMeasuredAt: string | null;
  daily: { day: string; kg: number }[];
  low: number;
  high: number;
  average: number;
  change: number;
};

// Module-level fake "server": metrics land here once resolveSummary() is
// called for them, and the mocked useQuery below re-renders subscribers via
// a tiny pub/sub (useSyncExternalStore) so the test can control timing
// explicitly instead of racing a real QueryClient.
let resolved: Map<string, Summary>;
let lastServedMetric: string | null;
let listeners: Set<() => void>;

function resetFakeServer() {
  resolved = new Map();
  lastServedMetric = null;
  listeners = new Set();
}

function resolveSummary(metric: string, data: Summary) {
  resolved.set(metric, data);
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

resetFakeServer();

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      weight: { summary: { invalidate: () => {} }, days: { invalidate: () => {} } },
    }),
    weight: {
      summary: {
        useQuery: (input: { metric: string }) => {
          // Re-render this hook's caller whenever resolveSummary() fires,
          // exactly like a real query would on cache update.
          useSyncExternalStore(subscribe, () => resolved.get(input.metric));
          const data = resolved.get(input.metric);
          if (data !== undefined) {
            lastServedMetric = input.metric;
            return { data, isPending: false, isPlaceholderData: false };
          }
          if (lastServedMetric !== null) {
            const prev = resolved.get(lastServedMetric);
            return { data: prev, isPending: false, isPlaceholderData: true };
          }
          return { data: undefined, isPending: true, isPlaceholderData: false };
        },
      },
      days: {
        useInfiniteQuery: () => ({
          data: { pages: [] },
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: () => {},
        }),
      },
      setExcluded: { useMutation: () => ({ mutate: () => {} }) },
      delete: { useMutation: () => ({ mutate: () => {} }) },
    },
  },
}));

const { weightDetailEntry } = await import("./weight");

function TrendPage() {
  const { variants } = weightDetailEntry.useVariants();
  const trend = variants.find((v) => v.slug === "trend");
  if (!trend) throw new Error("trend variant missing");
  return <>{trend.render()}</>;
}

/** The "Average" Stat's value — a single text node (unlike the hero number,
 *  which the view splits across sibling spans), so it's a stable assertion
 *  target for "which unit is this number labelled with right now". */
function averageStatText(): string {
  const label = screen.getByText("Average");
  const value = label.parentElement?.querySelector("[data-stat-value]");
  if (!value) throw new Error("Average stat value not found");
  return value.textContent ?? "";
}

const WEIGHT_KG: Summary = {
  latestKg: 84,
  latestMeasuredAt: "2026-07-27T12:00:00.000Z",
  daily: [{ day: "2026-07-27", kg: 84 }],
  low: 83,
  high: 85,
  average: 84,
  change: 1,
};

const FAT_RATIO: Summary = {
  latestKg: 17.1,
  latestMeasuredAt: "2026-07-27T12:00:00.000Z",
  daily: [{ day: "2026-07-27", kg: 17.1 }],
  low: 16.9,
  high: 17.3,
  average: 17.1,
  change: 0.2,
};

beforeEach(resetFakeServer);
afterEach(cleanup);

describe("weight detail page metric switch (#250)", () => {
  it("never pairs the previous metric's raw value with the new metric's unit label", async () => {
    resolveSummary("weight_kg", WEIGHT_KG);
    render(<TrendPage />);

    // Initial paint: weight_kg has already "landed", so it renders immediately.
    await screen.findByText("Average");
    expect(averageStatText()).toBe("185.2 lb");

    // Switch to Fat % before its query has resolved. keepPreviousData keeps
    // weight_kg's number on screen (no blank flash) — it must stay labelled
    // "lb", never picked up the new "%" unit ahead of its own data.
    const fatRadio = screen.getByRole("radio", { name: "Fat %" });
    act(() => {
      fatRadio.click();
    });

    expect(averageStatText()).toBe("185.2 lb");

    // Fat %'s own data lands: the number AND unit swap together.
    act(() => {
      resolveSummary("fat_ratio_percent", FAT_RATIO);
    });

    expect(averageStatText()).toBe("17.1%");
  });

  it("switching back to an already-seen metric renders its cached value instantly", async () => {
    resolveSummary("weight_kg", WEIGHT_KG);
    resolveSummary("fat_ratio_percent", FAT_RATIO);
    render(<TrendPage />);

    await screen.findByText("Average");
    expect(averageStatText()).toBe("185.2 lb");

    act(() => {
      screen.getByRole("radio", { name: "Fat %" }).click();
    });
    expect(averageStatText()).toBe("17.1%");

    act(() => {
      screen.getByRole("radio", { name: "Weight" }).click();
    });
    // Already resolved earlier — no intermediate placeholder/skeleton state.
    expect(averageStatText()).toBe("185.2 lb");
  });
});

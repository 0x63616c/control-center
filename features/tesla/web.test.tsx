import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeslaTile } from "./web";

// ── Mock MapLibre (WebGL , not available in jsdom) ───────────────────────────
vi.mock("maplibre-gl", () => {
  const MockMap = vi.fn(() => ({
    addControl: vi.fn(),
    on: vi.fn(),
    remove: vi.fn(),
    setCenter: vi.fn(),
    easeTo: vi.fn(),
  }));
  const Marker = vi.fn(() => ({
    setLngLat: vi.fn().mockReturnThis(),
    addTo: vi.fn().mockReturnThis(),
    remove: vi.fn().mockReturnThis(),
    getElement: vi.fn().mockReturnValue(document.createElement("div")),
  }));
  return {
    default: {
      Map: MockMap,
      Marker,
      NavigationControl: vi.fn(),
      addProtocol: vi.fn(),
      removeProtocol: vi.fn(),
    },
  };
});

// ── Mock pmtiles (no native modules in jsdom) ─────────────────────────────────
vi.mock("pmtiles", () => ({
  Protocol: vi.fn().mockImplementation(() => ({
    tile: vi.fn(),
  })),
}));

// ── Mock @protomaps/basemaps ──────────────────────────────────────────────────
vi.mock("@protomaps/basemaps", () => ({
  layers: vi.fn().mockReturnValue([]),
  namedFlavor: vi.fn().mockReturnValue({}),
}));

// ── Mock tRPC hook ───────────────────────────────────────────────────────────
// We mock the entire trpc module so the component never tries to reach a server.
vi.mock("@/lib/trpc", () => {
  const useQuery = vi.fn();
  return {
    trpc: {
      tesla: {
        get: { useQuery },
      },
    },
    queryClient: {},
    trpcClient: {},
  };
});

// Helper to grab the mock after it has been set up
async function getTeslaUseQuery() {
  const mod = await import("@/lib/trpc");
  return mod.trpc.tesla.get.useQuery as ReturnType<typeof vi.fn>;
}

const MOCK_DATA = {
  name: "Model Y",
  nick: "Evee",
  locked: true,
  place: "Home",
  lat: 34.0537,
  lon: -118.2428,
  charging: true,
  rate: 25,
  pct: 82,
  range: 264,
  odo: "24,113",
  climate: 70,
};

describe("TeslaTile", () => {
  it("renders vehicle data when query succeeds", async () => {
    const useQuery = await getTeslaUseQuery();
    useQuery.mockReturnValue({
      data: MOCK_DATA,
      isLoading: false,
      isError: false,
    });

    const { container } = render(<TeslaTile />);

    // Root element has tile chrome
    expect(container.firstChild).toHaveClass("tile");

    // Header: simplified to just 'Tesla' with lock pill (www-8c2)
    expect(screen.getByText("Tesla")).toBeInTheDocument();
    expect(screen.queryByText("MODEL Y")).not.toBeInTheDocument();
    expect(screen.queryByText(/Tesla · Home/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Evee")).not.toBeInTheDocument();
    expect(screen.getByText("Locked")).toBeInTheDocument();

    // Map overlays now show real place from API (not hardcoded fake labels)
    // The place text appears in both the cap label and the status pill
    const placeEls = screen.getAllByText("Home");
    expect(placeEls.length).toBeGreaterThanOrEqual(1);

    // Charging bar
    expect(screen.getByText(/Charging/i)).toBeInTheDocument();
    expect(screen.getByText("+25 mi/hr", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("82%")).toBeInTheDocument();

    // Stats
    expect(screen.getByText("264 mi")).toBeInTheDocument();
    expect(screen.getByText("24,113")).toBeInTheDocument();
    expect(screen.getByText("70°F")).toBeInTheDocument();
  });

  it("renders unlocked state with amber pill when car is unlocked", async () => {
    const useQuery = await getTeslaUseQuery();
    useQuery.mockReturnValue({
      data: { ...MOCK_DATA, locked: false },
      isLoading: false,
      isError: false,
    });

    render(<TeslaTile />);
    expect(screen.getByText("Unlocked")).toBeInTheDocument();
    // pill should have amber class
    const pill = screen.getByText("Unlocked").closest(".pill");
    expect(pill).toHaveClass("amber");
  });

  it("renders skeleton (no fake data) while loading", async () => {
    const useQuery = await getTeslaUseQuery();
    useQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });

    render(<TeslaTile />);

    // Real data must NOT be rendered , skeleton shows instead
    expect(screen.queryByText("82%")).not.toBeInTheDocument();
    expect(screen.queryByText("264 mi")).not.toBeInTheDocument();
  });

  it("renders a distinct Offline state on error, not the loading skeleton (#42)", async () => {
    const useQuery = await getTeslaUseQuery();
    useQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      dataUpdatedAt: 0,
    });

    render(<TeslaTile />);

    // Real data must NOT be rendered
    expect(screen.queryByText("264 mi")).not.toBeInTheDocument();
    // ... and it reads as offline, not as a perpetual shimmer.
    expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
    expect(screen.getByText("Last online unknown")).toBeInTheDocument();
  });

  it("shows the last-seen age on the Offline state from react-query's dataUpdatedAt (#42)", async () => {
    const useQuery = await getTeslaUseQuery();
    const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000;
    useQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      dataUpdatedAt: fiveHoursAgo,
    });

    render(<TeslaTile />);
    expect(screen.getByText("Last online 5hrs ago")).toBeInTheDocument();
  });

  it("shows a stale pill and keeps the last-known snapshot when a poll fails but cached data remains (#42)", async () => {
    const useQuery = await getTeslaUseQuery();
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    useQuery.mockReturnValue({
      data: MOCK_DATA,
      isLoading: false,
      isError: true,
      dataUpdatedAt: twoHoursAgo,
    });

    render(<TeslaTile />);
    // Data-first precedence (www-355t.13): still shows the last-known values...
    expect(screen.getByText("82%")).toBeInTheDocument();
    // ...but now honestly flagged as unconfirmed rather than silently shown as live.
    expect(screen.getByText(/Offline · synced 2hrs ago/)).toBeInTheDocument();
  });

  it("www-lad: stat rows use shared Stat primitive (data-stat-value attribute present)", async () => {
    const useQuery = await getTeslaUseQuery();
    useQuery.mockReturnValue({
      data: MOCK_DATA,
      isLoading: false,
      isError: false,
    });

    const { container } = render(<TeslaTile />);
    // Shared Stat component renders spans with data-stat-value attribute
    const statValues = container.querySelectorAll("[data-stat-value]");
    expect(statValues.length).toBeGreaterThanOrEqual(3);
  });

  it("shows Idle pill when not charging", async () => {
    const useQuery = await getTeslaUseQuery();
    useQuery.mockReturnValue({
      data: { ...MOCK_DATA, charging: false, rate: 0 },
      isLoading: false,
      isError: false,
    });

    render(<TeslaTile />);
    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(screen.queryByText(/Charging/i)).not.toBeInTheDocument();
  });
});

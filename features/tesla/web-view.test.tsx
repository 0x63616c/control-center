/**
 * TeslaTileView , pure presentational component tests.
 * No trpc mocking needed: all inputs are props.
 */
import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeslaMap } from "./tesla-map";
import type { TeslaTileViewProps } from "./web";
import { TeslaTileView } from "./web";

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

// ── Mock pmtiles ──────────────────────────────────────────────────────────────
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

afterEach(cleanup);

const populatedProps: TeslaTileViewProps = {
  status: "populated",
  locked: true,
  charging: false,
  rate: 0,
  pct: 80,
  range: 240,
  odo: "12,345 mi",
  climate: 72,
  lat: 34.0537,
  lon: -118.2428,
  place: "Home",
};

const chargingProps: TeslaTileViewProps = {
  status: "populated",
  locked: false,
  charging: true,
  rate: 25,
  pct: 55,
  range: 165,
  odo: "12,345 mi",
  climate: 68,
  lat: 34.0537,
  lon: -118.2428,
  place: "Home",
};

describe("TeslaTileView , loading/skeleton state", () => {
  it("renders a .tile container", () => {
    const { container } = render(<TeslaTileView status="loading" />);
    const tile = container.querySelector(".tile") as HTMLElement;
    expect(tile).toBeInTheDocument();
  });

  it("keeps the Tesla header visible while loading so the tile is identifiable", () => {
    render(<TeslaTileView status="loading" />);
    expect(screen.getByText("Tesla")).toBeInTheDocument();
  });

  it("does not render charge percentage text", () => {
    render(<TeslaTileView status="loading" />);
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
  });
});

describe("TeslaTileView , error/offline state (#42)", () => {
  it("renders a .tile container", () => {
    const { container } = render(<TeslaTileView status="error" />);
    const tile = container.querySelector(".tile") as HTMLElement;
    expect(tile).toBeInTheDocument();
  });

  it("keeps the Tesla header visible in the offline state so the tile is identifiable", () => {
    render(<TeslaTileView status="error" />);
    expect(screen.getByText("Tesla")).toBeInTheDocument();
  });

  it("renders a distinct Offline state, not the loading skeleton", () => {
    render(<TeslaTileView status="error" />);
    expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
  });

  it("shows last-seen age when lastSeenAt is provided", () => {
    render(
      <TeslaTileView
        status="error"
        lastSeenAt={new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()}
      />,
    );
    expect(screen.getByText("Last online 5hrs ago")).toBeInTheDocument();
  });

  it("says last-seen is unknown rather than fabricating an age when there is none", () => {
    render(<TeslaTileView status="error" lastSeenAt={null} />);
    expect(screen.getByText("Last online unknown")).toBeInTheDocument();
  });
});

describe("TeslaTileView , stale-but-populated state (#42)", () => {
  it("renders a stale pill and dims the data block when the latest poll failed", () => {
    const { container } = render(
      <TeslaTileView
        {...populatedProps}
        stale
        updatedAt={new Date(Date.now() - 90 * 60 * 1000).toISOString()}
      />,
    );
    expect(screen.getByText(/Offline · synced/)).toBeInTheDocument();
    expect(container.querySelector("[data-asleep]")).not.toBeNull();
  });

  it("does not render the stale pill when the poll is healthy", () => {
    render(<TeslaTileView {...populatedProps} />);
    expect(screen.queryByText(/Offline · synced/)).not.toBeInTheDocument();
  });
});

describe("TeslaTileView , populated state (locked, not charging)", () => {
  it("renders the Tesla tile header", () => {
    render(<TeslaTileView {...populatedProps} />);
    expect(screen.getByText("Tesla")).toBeInTheDocument();
  });

  it("renders a Locked pill when locked=true", () => {
    render(<TeslaTileView {...populatedProps} />);
    expect(screen.getByText("Locked")).toBeInTheDocument();
    expect(screen.queryByText("Unlocked")).not.toBeInTheDocument();
  });

  it("renders Idle pill when not charging", () => {
    render(<TeslaTileView {...populatedProps} />);
    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(screen.queryByText(/Charging/)).not.toBeInTheDocument();
  });

  it("renders the charge percentage", () => {
    render(<TeslaTileView {...populatedProps} />);
    expect(screen.getByText("80%")).toBeInTheDocument();
  });

  it("renders Range stat with mi suffix", () => {
    render(<TeslaTileView {...populatedProps} />);
    expect(screen.getByText("240 mi")).toBeInTheDocument();
  });

  it("renders Odometer stat", () => {
    render(<TeslaTileView {...populatedProps} />);
    expect(screen.getByText("12,345 mi")).toBeInTheDocument();
  });

  it("renders Cabin temperature with degree F suffix", () => {
    render(<TeslaTileView {...populatedProps} />);
    expect(screen.getByText("72°F")).toBeInTheDocument();
  });
});

describe("TeslaTileView , populated state (unlocked, charging)", () => {
  it("renders Unlocked pill when locked=false", () => {
    render(<TeslaTileView {...chargingProps} />);
    expect(screen.getByText("Unlocked")).toBeInTheDocument();
    expect(screen.queryByText("Locked")).not.toBeInTheDocument();
  });

  it("renders Charging pill with rate when charging=true", () => {
    render(<TeslaTileView {...chargingProps} />);
    expect(screen.getByText(/Charging/)).toBeInTheDocument();
    expect(screen.getByText(/25 mi\/hr/)).toBeInTheDocument();
  });

  it("does not render Idle when charging", () => {
    render(<TeslaTileView {...chargingProps} />);
    expect(screen.queryByText("Idle")).not.toBeInTheDocument();
  });

  it("renders the charge percentage for charging state", () => {
    render(<TeslaTileView {...chargingProps} />);
    expect(screen.getByText("55%")).toBeInTheDocument();
  });
});

// ── TeslaMap , overlay and null-location path ─────────────────────────────────
describe("TeslaMap", () => {
  it("renders the place overlay when lat/lon are provided", () => {
    render(<TeslaMap lat={34.0537} lon={-118.2428} place="Home" />);
    // place appears in both the cap label and the status pill
    const placeEls = screen.getAllByText("Home");
    expect(placeEls.length).toBeGreaterThanOrEqual(1);
  });

  it("does not crash and renders the place overlay when lat/lon are null (default-center path)", () => {
    render(<TeslaMap lat={null} lon={null} place="Home" />);
    // Overlays should still render even without a location
    const placeEls = screen.getAllByText("Home");
    expect(placeEls.length).toBeGreaterThanOrEqual(1);
  });
});

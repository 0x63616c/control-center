/**
 * Vitest component tests for TeslaTileView stories.
 * Uses composeStories to execute each story (including play functions) in jsdom.
 */

import "@testing-library/jest-dom";
import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stories from "../TeslaTileView.stories";

// MapLibre uses WebGL which is unavailable in jsdom , mock the module.
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

vi.mock("pmtiles", () => ({
  Protocol: vi.fn().mockImplementation(() => ({ tile: vi.fn() })),
}));

vi.mock("@protomaps/basemaps", () => ({
  layers: vi.fn().mockReturnValue([]),
  namedFlavor: vi.fn().mockReturnValue({}),
}));

const {
  Loading,
  ErrorState,
  OfflineWithLastSeen,
  Populated,
  Charging,
  NoLocation,
  Asleep,
  StalePolling,
} = composeStories(stories);

afterEach(cleanup);

describe("TeslaTileView stories , Loading", () => {
  it("renders .tile container, keeps the Tesla header, but no percentage while loading", async () => {
    const { container } = render(<Loading />);
    if (Loading.play) await Loading.play({ canvasElement: container });
    expect(container.querySelector(".tile")).not.toBeNull();
    expect(screen.getByText("Tesla")).toBeInTheDocument();
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
  });
});

describe("TeslaTileView stories , ErrorState (Offline, #42)", () => {
  it("renders .tile container, keeps the Tesla header, and shows a distinct Offline state", async () => {
    const { container } = render(<ErrorState />);
    if (ErrorState.play) await ErrorState.play({ canvasElement: container });
    expect(container.querySelector(".tile")).not.toBeNull();
    expect(screen.getByText("Tesla")).toBeInTheDocument();
    expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
  });
});

describe("TeslaTileView stories , OfflineWithLastSeen", () => {
  it("shows the last-seen age", async () => {
    const { container } = render(<OfflineWithLastSeen />);
    if (OfflineWithLastSeen.play) await OfflineWithLastSeen.play({ canvasElement: container });
    expect(screen.getByText("Last online 5hrs ago")).toBeInTheDocument();
  });
});

describe("TeslaTileView stories , StalePolling (populated but currently offline)", () => {
  it("keeps the last-known snapshot but flags it as stale", async () => {
    const { container } = render(<StalePolling />);
    if (StalePolling.play) await StalePolling.play({ canvasElement: container });
    expect(screen.getByText(/Offline · synced 2hrs ago/)).toBeInTheDocument();
    expect(screen.getByText("64%")).toBeInTheDocument();
  });
});

describe("TeslaTileView stories , Populated (locked, idle)", () => {
  it("renders header, Locked pill, Idle pill, stats", async () => {
    const { container } = render(<Populated />);
    if (Populated.play) await Populated.play({ canvasElement: container });
    expect(screen.getByText("Tesla")).toBeInTheDocument();
    expect(screen.getByText("Locked")).toBeInTheDocument();
    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("240 mi")).toBeInTheDocument();
    expect(screen.getByText("12,345 mi")).toBeInTheDocument();
    expect(screen.getByText("72°F")).toBeInTheDocument();
  });
});

describe("TeslaTileView stories , Charging (unlocked, charging)", () => {
  it("renders header, Unlocked pill, Charging pill with +25 rate, no Idle", async () => {
    const { container } = render(<Charging />);
    if (Charging.play) await Charging.play({ canvasElement: container });
    expect(screen.getByText("Tesla")).toBeInTheDocument();
    expect(screen.getByText("Unlocked")).toBeInTheDocument();
    // Charging pill text: "Charging · +25 mi/hr"
    expect(screen.getByText(/Charging/)).toBeInTheDocument();
    expect(screen.getByText(/\+25 mi\/hr/)).toBeInTheDocument();
    expect(screen.queryByText("Idle")).not.toBeInTheDocument();
    expect(screen.getByText("55%")).toBeInTheDocument();
    expect(screen.getByText("165 mi")).toBeInTheDocument();
    expect(screen.getByText("68°F")).toBeInTheDocument();
  });
});

describe("TeslaTileView stories , Asleep (stale snapshot)", () => {
  it("renders Asleep pill with snapshot age, dimmed last-known data, no Idle/Charging", async () => {
    const { container } = render(<Asleep />);
    if (Asleep.play) await Asleep.play({ canvasElement: container });
    expect(screen.getByText(/Asleep · 2hrs/)).toBeInTheDocument();
    expect(screen.queryByText("Idle")).not.toBeInTheDocument();
    expect(screen.queryByText(/Charging/)).not.toBeInTheDocument();
    expect(screen.getByText("64%")).toBeInTheDocument();
    expect(screen.getByText("192 mi")).toBeInTheDocument();
    expect(container.querySelector("[data-asleep]")).not.toBeNull();
  });
});

describe("TeslaTileView stories , NoLocation (null lat/lon)", () => {
  it("renders tile fully with null GPS, shows place label", async () => {
    const { container } = render(<NoLocation />);
    if (NoLocation.play) await NoLocation.play({ canvasElement: container });
    expect(screen.getByText("Tesla")).toBeInTheDocument();
    expect(screen.getByText("Locked")).toBeInTheDocument();
    expect(screen.getByText("91%")).toBeInTheDocument();
    expect(screen.getByText("Location unavailable")).toBeInTheDocument();
  });
});

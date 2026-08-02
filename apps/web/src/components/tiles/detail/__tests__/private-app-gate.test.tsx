import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSessionForTests, panelSession } from "../../../../lib/panel-session";
import { resetSettings } from "../../../../lib/settings";
import { GatedTileDetail } from "../TileDetailHost";
import type { TileDetailPageEntry } from "../types";

const entry: TileDetailPageEntry = {
  kind: "page",
  tileId: "tile_booth",
  title: "Photo Booth",
  defaultSlug: "booth",
  useVariants: () => ({
    loading: false,
    variants: [{ slug: "booth", label: "Booth", render: () => <div>camera</div> }],
  }),
};

afterEach(() => {
  cleanup();
  __resetSessionForTests();
  resetSettings();
  vi.useRealTimers();
});

describe("private app gate", () => {
  it("prompts freshly for Photo Booth on every opening, even with an unlocked session", () => {
    vi.useFakeTimers();
    panelSession.unlock();
    const first = render(<GatedTileDetail entry={entry} initialSlug={undefined} />);
    expect(screen.getByTestId("pin-gate-backdrop")).toBeTruthy();
    expect(screen.queryByText("camera")).toBeNull();

    for (const digit of "000000") fireEvent.click(screen.getByRole("button", { name: digit }));
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByText("camera")).toBeTruthy();
    expect(panelSession.isUnlocked()).toBe(true);

    first.unmount();
    render(<GatedTileDetail entry={entry} initialSlug={undefined} />);
    expect(screen.getByTestId("pin-gate-backdrop")).toBeTruthy();
    expect(screen.queryByText("camera")).toBeNull();
  });

  it("reuses the panel session unlock for Activity without a view-local flag", () => {
    vi.useFakeTimers();
    const activityEntry = { ...entry, tileId: "tile_wakes", title: "Activity" };
    const first = render(<GatedTileDetail entry={activityEntry} initialSlug={undefined} />);
    expect(screen.getByTestId("pin-gate-backdrop")).toBeTruthy();

    for (const digit of "000000") fireEvent.click(screen.getByRole("button", { name: digit }));
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByText("camera")).toBeTruthy();
    expect(panelSession.isUnlocked()).toBe(true);

    first.unmount();
    render(<GatedTileDetail entry={activityEntry} initialSlug={undefined} />);
    expect(screen.queryByTestId("pin-gate-backdrop")).toBeNull();
    expect(screen.getByText("camera")).toBeTruthy();
  });
});

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClockGreeting } from "../ClockGreeting";

// jsdom doesn't ship @testing-library/react by default , use the vitest jsdom env.
// The component is purely client-side (no tRPC), so no provider wrapping needed.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ClockGreeting", () => {
  it("renders the time, date, greeting, and location with a fixed clock", () => {
    // 2026-05-29 09:30:00 UTC , a Friday morning
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T16:30:00Z"));

    render(<ClockGreeting />);

    // Greeting , 09:xx → "Good morning"
    expect(screen.getByText(/good morning/i)).toBeDefined();

    // Time display , 9:30 AM (12-hour)
    expect(screen.getByText(/9:30/)).toBeDefined();
    expect(screen.getByText(/AM/)).toBeDefined();

    // Full date , should include "Friday", "May", "29"
    expect(screen.getByText(/friday/i)).toBeDefined();
    expect(screen.getByText(/may/i)).toBeDefined();
    expect(screen.getByText(/29/)).toBeDefined();

    // Location
    expect(screen.getByText(/los angeles/i)).toBeDefined();
  });

  it("shows 'Good afternoon' for a 14:xx hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T21:00:00Z"));

    render(<ClockGreeting />);

    expect(screen.getByText(/good afternoon/i)).toBeDefined();
    expect(screen.getByText(/2:00/)).toBeDefined();
    expect(screen.getByText(/PM/)).toBeDefined();
  });

  it("shows 'Good evening' for a 19:xx hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T02:45:00Z"));

    render(<ClockGreeting />);

    expect(screen.getByText(/good evening/i)).toBeDefined();
    expect(screen.getByText(/7:45/)).toBeDefined();
  });

  it("shows 'Good night' for a 23:xx hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T06:15:00Z"));

    render(<ClockGreeting />);

    expect(screen.getByText(/good night/i)).toBeDefined();
  });

  it("shows 'Good night' for a 02:xx hour", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T09:05:00Z"));

    render(<ClockGreeting />);

    expect(screen.getByText(/good night/i)).toBeDefined();
  });

  it("ticks the clock every second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T16:30:00Z"));

    render(<ClockGreeting />);

    expect(screen.getByText(/9:30/)).toBeDefined();

    // Advance one minute
    act(() => {
      vi.setSystemTime(new Date("2026-05-29T16:31:00Z"));
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText(/9:31/)).toBeDefined();
  });

  it("uses 12:xx for noon (12-hour roll-over)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T19:00:00Z"));

    render(<ClockGreeting />);

    expect(screen.getByText(/12:00/)).toBeDefined();
    expect(screen.getByText(/PM/)).toBeDefined();
  });

  it("www-882: tile wrapper has padding 28", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T16:30:00Z"));

    const { container } = render(<ClockGreeting />);
    const tile = container.firstChild as HTMLElement;

    expect(tile.style.padding).toBe("28px");
  });

  it("www-882: date line has font-size 18", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T16:30:00Z"));

    render(<ClockGreeting />);

    const dateEl = screen.getByTestId("clock-date");
    expect(dateEl.style.fontSize).toBe("18px");
  });

  it("www-oi9: AM/PM span has non-negative letter-spacing (not inherited -.05em)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T16:30:00Z"));

    render(<ClockGreeting />);

    const ampm = screen.getByTestId("clock-ampm");
    // letterSpacing must be explicitly set to break inheritance from the -.05em mono wrapper
    expect(ampm.style.letterSpacing).toBe("0.02em");
  });

  it("www-902: seconds ring is wired into the clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T16:30:45Z"));

    const { container } = render(<ClockGreeting />);

    // The ring is a presentational overlay (BorderProgressRing via ClockSecondsRing);
    // its geometry is covered by BorderProgressRing's own tests. jsdom has no layout
    // engine, so here we only assert the ring is mounted.
    const ring = container.querySelector("[data-testid='seconds-ring']");
    expect(ring).not.toBeNull();
  });
});

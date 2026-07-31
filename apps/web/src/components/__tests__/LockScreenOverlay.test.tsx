import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blurPixelsForPercent, LockScreenOverlay } from "../LockScreenOverlay";

vi.mock("../../lib/hooks", () => ({ useNow: () => new Date(2026, 0, 1, 9, 5) }));

afterEach(cleanup);

describe("LockScreenOverlay", () => {
  it("maps the configured percentage to the bounded blur range", () => {
    expect(blurPixelsForPercent(0)).toBe(0);
    expect(blurPixelsForPercent(10)).toBe(2);
    expect(blurPixelsForPercent(100)).toBe(20);
  });

  it("renders only the time visual over the live board when active", () => {
    render(<LockScreenOverlay active blurPercent={10} onRequestUnlock={() => {}} />);
    const overlay = screen.getByTestId("lock-screen-overlay");
    expect(overlay.style.backdropFilter).toBe("blur(2px)");
    expect(overlay.textContent).toBe("09:05");
  });
});

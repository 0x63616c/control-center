import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { CONFETTI_DURATION_MS, ConfettiCelebration } from "../ConfettiCelebration";

function mockReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
}

describe("ConfettiCelebration", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("is decorative and finishes after its animation window", () => {
    mockReducedMotion(false);
    const onFinished = vi.fn();
    render(<ConfettiCelebration onFinished={onFinished} />);
    expect(screen.getByTestId("confetti-celebration")).toHaveAttribute("aria-hidden", "true");
    expect(onFinished).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CONFETTI_DURATION_MS));
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("renders no animation when reduced motion is preferred", () => {
    mockReducedMotion(true);
    const onFinished = vi.fn();
    render(<ConfettiCelebration onFinished={onFinished} />);
    expect(screen.queryByTestId("confetti-celebration")).toBeNull();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});

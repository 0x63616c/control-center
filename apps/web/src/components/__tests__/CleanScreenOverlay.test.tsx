import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { CLEAN_MODE_DURATION_MS, CleanScreenOverlay, HOLD_TO_EXIT_MS } from "../CleanScreenOverlay";

describe("CleanScreenOverlay", () => {
  const renderOverlay = (props?: {
    open?: boolean;
    onComplete?: () => void;
    onCancel?: () => void;
  }) =>
    render(
      <CleanScreenOverlay
        open={props?.open ?? true}
        onComplete={props?.onComplete ?? (() => {})}
        onCancel={props?.onCancel ?? (() => {})}
      />,
    );

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders nothing while closed", () => {
    renderOverlay({ open: false });
    expect(screen.queryByTestId("clean-screen-overlay")).toBeNull();
  });

  it("shows the full countdown when opened", () => {
    renderOverlay();
    expect(screen.getByText("Cleaning mode")).toBeInTheDocument();
    expect(screen.getByText("10:00")).toBeInTheDocument();
  });

  it("counts down while open", () => {
    renderOverlay();
    act(() => vi.advanceTimersByTime(79_000));
    expect(screen.getByText("8:41")).toBeInTheDocument();
  });

  it("completes after the hold completes, not before", () => {
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    renderOverlay({ onComplete, onCancel });
    fireEvent.pointerDown(screen.getByRole("button"));
    act(() => vi.advanceTimersByTime(HOLD_TO_EXIT_MS - 500));
    expect(onComplete).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(600));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("releasing early resets the hold", () => {
    const onComplete = vi.fn();
    renderOverlay({ onComplete });
    const button = screen.getByRole("button");
    fireEvent.pointerDown(button);
    act(() => vi.advanceTimersByTime(HOLD_TO_EXIT_MS - 500));
    fireEvent.pointerUp(button);
    act(() => vi.advanceTimersByTime(HOLD_TO_EXIT_MS));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("cancels at the 10 minute failsafe without completing", () => {
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    renderOverlay({ onComplete, onCancel });
    act(() => vi.advanceTimersByTime(CLEAN_MODE_DURATION_MS + 1000));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("restarts the countdown on reopen", () => {
    const props = { onComplete: () => {}, onCancel: () => {} };
    const { rerender } = render(<CleanScreenOverlay open {...props} />);
    act(() => vi.advanceTimersByTime(120_000));
    rerender(<CleanScreenOverlay open={false} {...props} />);
    rerender(<CleanScreenOverlay open {...props} />);
    expect(screen.getByText("10:00")).toBeInTheDocument();
  });
});

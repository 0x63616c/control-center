/**
 * Vitest component tests for WeightReadingsView stories.
 * Uses composeStories to execute each story (including play functions) in jsdom.
 */

import "@testing-library/jest-dom";
import { composeStories } from "@storybook/react-vite";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stories from "../WeightReadingsView.stories";

const {
  Populated,
  DayExpanded,
  EditIndividualMetric,
  CorrectIndividualMetric,
  RejectInvalidMetric,
  SaveFailure,
  BodyComposition,
  AutoFlagged,
  SingleDay,
  NoCountedReading,
  LoadingMore,
  Loading,
  Empty,
} = composeStories(stories);

// jsdom has no IntersectionObserver; the real one fires only in a real
// viewport, so this stub reports the sentinel as intersecting immediately,
// which is all WeightReadingsView's effect needs to call onLoadMore.
class StubIntersectionObserver {
  #callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback;
  }
  observe(target: Element) {
    this.#callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);

afterEach(cleanup);

describe("WeightReadingsView stories", () => {
  it("Populated: days collapse by default and expand to their readings", async () => {
    const { container } = render(<Populated />);
    if (Populated.play) await Populated.play({ canvasElement: container });
    expect(screen.getByText("160.6")).toBeInTheDocument();
  });

  it("DayExpanded: delete is gated behind the confirm dialog", async () => {
    const { container } = render(<DayExpanded />);
    if (DayExpanded.play) await DayExpanded.play({ canvasElement: container });
  });

  it("EditIndividualMetric: clears fat without changing weight", async () => {
    const { container } = render(<EditIndividualMetric />);
    if (EditIndividualMetric.play) {
      await EditIndividualMetric.play({ canvasElement: container });
    }
  });

  it("CorrectIndividualMetric: corrects fat without changing weight", async () => {
    const { container } = render(<CorrectIndividualMetric />);
    if (CorrectIndividualMetric.play) {
      await CorrectIndividualMetric.play({ canvasElement: container });
    }
  });

  it("RejectInvalidMetric: validates fat percentage before saving", async () => {
    const { container } = render(<RejectInvalidMetric />);
    if (RejectInvalidMetric.play) {
      await RejectInvalidMetric.play({ canvasElement: container });
    }
  });

  it("SaveFailure: reports a failed save and keeps the editor open", async () => {
    const { container } = render(<SaveFailure />);
    if (SaveFailure.play) await SaveFailure.play({ canvasElement: container });
  });

  it("BodyComposition: shows on Withings rows, absent on ha_ble-era rows", async () => {
    const { container } = render(<BodyComposition />);
    if (BodyComposition.play) await BodyComposition.play({ canvasElement: container });
  });

  it("AutoFlagged: only an auto-flagged reading offers to be counted again", async () => {
    const { container } = render(<AutoFlagged />);
    if (AutoFlagged.play) await AutoFlagged.play({ canvasElement: container });
  });

  it("SingleDay: no earlier day, so no day-over-day figure", async () => {
    const { container } = render(<SingleDay />);
    if (SingleDay.play) await SingleDay.play({ canvasElement: container });
  });

  it("NoCountedReading: an all-excluded day renders an em dash, never 0.0", async () => {
    const { container } = render(<NoCountedReading />);
    if (NoCountedReading.play) await NoCountedReading.play({ canvasElement: container });
  });

  it("LoadingMore: the sentinel triggers onLoadMore", async () => {
    const { container } = render(<LoadingMore />);
    if (LoadingMore.play) await LoadingMore.play({ canvasElement: container });
  });

  it("Loading: skeleton only, no medians", async () => {
    const { container } = render(<Loading />);
    if (Loading.play) await Loading.play({ canvasElement: container });
  });

  it("Empty: prompts for a first weigh-in", async () => {
    const { container } = render(<Empty />);
    if (Empty.play) await Empty.play({ canvasElement: container });
  });
});

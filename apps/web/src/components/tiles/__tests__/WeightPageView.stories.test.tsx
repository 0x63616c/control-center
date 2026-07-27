/**
 * Vitest component tests for WeightPageView stories.
 * Uses composeStories to execute each story (including play functions) in jsdom.
 */

import "@testing-library/jest-dom";
import { composeStories } from "@storybook/react-vite";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, it } from "vitest";
import * as stories from "../WeightPageView.stories";

const { SingleDay, WithGap, FatRatio, Loading, NoDataForMetric } = composeStories(stories);

afterEach(cleanup);

describe("WeightPageView stories", () => {
  it("SingleDay: explains itself instead of drawing a flat line", async () => {
    const { container } = render(<SingleDay />);
    if (SingleDay.play) await SingleDay.play({ canvasElement: container });
  });

  it("WithGap: a skipped day widens the interval", async () => {
    const { container } = render(<WithGap />);
    if (WithGap.play) await WithGap.play({ canvasElement: container });
  });

  it("FatRatio: a percentage metric is never lb-converted or lb-labelled", async () => {
    const { container } = render(<FatRatio />);
    if (FatRatio.play) await FatRatio.play({ canvasElement: container });
  });

  it("Loading: the metric picker stays mounted", async () => {
    const { container } = render(<Loading />);
    if (Loading.play) await Loading.play({ canvasElement: container });
  });

  it("NoDataForMetric: names the empty metric and keeps the picker usable", async () => {
    const { container } = render(<NoDataForMetric />);
    if (NoDataForMetric.play) await NoDataForMetric.play({ canvasElement: container });
  });
});

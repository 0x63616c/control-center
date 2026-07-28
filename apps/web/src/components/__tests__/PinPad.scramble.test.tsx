/**
 * PIN-pad scrambling (#287). The security claim is narrow but exact: with a
 * fixed pad, finger grease wears into the four keys the PIN uses, so anyone who
 * looks at the glass learns the digit SET and only has to guess the order.
 * Scrambling has to satisfy three properties for that to stop being true, and
 * this suite pins all three:
 *
 *   1. every layout is a full permutation , all ten digits, none missing or
 *      duplicated, or the pad would be unusable AND leak which digits are live;
 *   2. layouts actually differ between prompts , the whole point;
 *   3. with the setting off, the layout is exactly the familiar phone pad.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PinPadView, scrambledDigits } from "../pin/PinPad";

afterEach(cleanup);

/** The pad's digit keys in DOM order, which is visual order (CSS grid, no
 *  reordering): nine grid cells then the bottom-centre one. */
function renderedOrder(): string[] {
  return screen
    .getAllByRole("button")
    .map((el) => el.getAttribute("aria-label") ?? "")
    .filter((label) => /^\d$/.test(label));
}

const STANDARD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

describe("scrambledDigits", () => {
  it("returns all ten digits exactly once", () => {
    // Repeated because a permutation bug (a duplicate, a dropped digit) can hide
    // behind one lucky draw.
    for (let i = 0; i < 200; i++) {
      expect([...scrambledDigits()].sort()).toEqual([...STANDARD].sort());
    }
  });

  it("does not keep producing the same order", () => {
    const seen = new Set(Array.from({ length: 50 }, () => scrambledDigits().join("")));
    // 50 uniform draws from 10! landing on one value has probability ~0; any
    // failure here means the shuffle is not shuffling.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("covers every position with every digit over many draws", () => {
    // Guards the subtler failure: a shuffle that varies but never moves, say,
    // the first cell. Each of the ten cells should see several distinct digits.
    const perPosition = Array.from({ length: 10 }, () => new Set<string>());
    for (let i = 0; i < 300; i++) {
      scrambledDigits().forEach((d, pos) => {
        perPosition[pos]?.add(d);
      });
    }
    for (const digits of perPosition) expect(digits.size).toBe(10);
  });
});

describe("PinPadView layout", () => {
  it("renders the standard phone-pad order when scrambling is off", () => {
    render(<PinPadView entered={0} onDigit={() => {}} onBackspace={() => {}} />);
    expect(renderedOrder()).toEqual(STANDARD);
  });

  it("renders a full permutation when scrambling is on", () => {
    render(<PinPadView entered={0} scramble onDigit={() => {}} onBackspace={() => {}} />);
    const order = renderedOrder();
    expect(order).toHaveLength(10);
    expect([...order].sort()).toEqual([...STANDARD].sort());
  });

  it("reshuffles when shuffleKey changes, and holds still when it doesn't", () => {
    const { rerender } = render(
      <PinPadView entered={0} scramble shuffleKey={0} onDigit={() => {}} onBackspace={() => {}} />,
    );
    const first = renderedOrder().join("");

    // Same key, new render (e.g. a digit tapped mid-entry): the layout must NOT
    // move , keys shifting under a half-typed PIN is how you mistype it.
    rerender(
      <PinPadView entered={3} scramble shuffleKey={0} onDigit={() => {}} onBackspace={() => {}} />,
    );
    expect(renderedOrder().join("")).toBe(first);

    // New key = new prompt (next stage, or a rejected attempt). Try a handful of
    // keys: any single reshuffle can coincidentally repeat (1 in 10!), but all
    // of them repeating cannot.
    const after = new Set<string>();
    for (const key of [1, 2, 3, 4, 5]) {
      rerender(
        <PinPadView
          entered={0}
          scramble
          shuffleKey={key}
          onDigit={() => {}}
          onBackspace={() => {}}
        />,
      );
      after.add(renderedOrder().join(""));
    }
    expect(after.size).toBeGreaterThan(1);
  });

  it("snaps back to the standard order when the setting is turned off", () => {
    const { rerender } = render(
      <PinPadView entered={0} scramble onDigit={() => {}} onBackspace={() => {}} />,
    );
    rerender(<PinPadView entered={0} scramble={false} onDigit={() => {}} onBackspace={() => {}} />);
    expect(renderedOrder()).toEqual(STANDARD);
  });
});

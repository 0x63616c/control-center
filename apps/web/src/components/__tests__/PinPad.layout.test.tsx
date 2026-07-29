/**
 * PIN-pad layouts (#287, #291). The security claim is narrow but exact: with a
 * fixed pad, finger grease wears into the four keys the PIN uses, so anyone who
 * looks at the glass learns the digit SET and only has to guess the order.
 *
 * Both moving layouts have to satisfy the same properties for that to stop being
 * true, and this suite pins them:
 *
 *   1. every layout is a full permutation , all ten digits, none missing or
 *      duplicated, or the pad would be unusable AND leak which digits are live;
 *   2. layouts actually differ between prompts , the whole point;
 *   3. each digit reaches every cell across draws , wear spreads evenly, which
 *      is the property that defeats smudge analysis;
 *   4. `fixed` is exactly the familiar phone pad.
 *
 * `rotated` additionally has to KEEP ASCENDING ORDER (that is what makes it
 * readable, and the only reason it exists next to `scrambled`).
 *
 * WHEN each mode redraws is the other half of the contract, and #302 split it in
 * two. `fixed`/`rotated`/`scrambled` must hold still for a whole entry; only
 * `scrambled-per-key` moves mid-entry, because it answers a different threat (a
 * person watching the hand, not grease on the glass). Both halves are asserted
 * separately below , the new mode must not be allowed to erode the guarantee the
 * others still make.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PinPadView, rotatedDigits, scrambledDigits } from "../pin/PinPad";

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

/** Shared by both generators: whatever else they do, they must deal all ten
 *  digits exactly once. */
function expectFullPermutation(digits: string[]) {
  expect([...digits].sort()).toEqual([...STANDARD].sort());
}

describe.each([
  ["scrambledDigits", scrambledDigits],
  ["rotatedDigits", rotatedDigits],
])("%s", (_name, generate) => {
  it("returns all ten digits exactly once", () => {
    // Repeated because a permutation bug (a duplicate, a dropped digit) can hide
    // behind one lucky draw.
    for (let i = 0; i < 200; i++) expectFullPermutation(generate());
  });

  it("does not keep producing the same order", () => {
    const seen = new Set(Array.from({ length: 60 }, () => generate().join("")));
    // Scrambling draws from 10!, rotation from 10; either way, 60 draws landing
    // on a single value means it is not moving at all.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("puts every digit in every cell across many draws", () => {
    // This is the property the whole feature rests on: if some digit could never
    // reach some cell, wear would still concentrate and the smudge trail would
    // still carry information. Rotation satisfies it just as fully as shuffling
    // (each of its ten shifts is equally likely), which is why it is a real
    // alternative rather than a weaker gesture.
    const perPosition = Array.from({ length: 10 }, () => new Set<string>());
    for (let i = 0; i < 400; i++) {
      generate().forEach((d, pos) => {
        perPosition[pos]?.add(d);
      });
    }
    for (const digits of perPosition) expect(digits.size).toBe(10);
  });
});

describe("rotatedDigits", () => {
  it("keeps the standard sequence, only shifted", () => {
    // The readability guarantee: find one digit and the rest follow. Every draw
    // must be a cyclic rotation of 1..9,0 , never an arbitrary permutation.
    const rotations = new Set(
      STANDARD.map((_, k) => [...STANDARD.slice(k), ...STANDARD.slice(0, k)].join("")),
    );
    for (let i = 0; i < 200; i++) {
      expect(rotations).toContain(rotatedDigits().join(""));
    }
  });

  it("reaches all ten rotations, including the unshifted one", () => {
    // k = 0 is deliberately left in the draw , excluding it would make "no
    // shift" the single outcome an observer could rule out.
    const seen = new Set(Array.from({ length: 400 }, () => rotatedDigits().join("")));
    expect(seen.size).toBe(10);
    expect(seen).toContain(STANDARD.join(""));
  });
});

describe("PinPadView layout", () => {
  it("renders the standard phone-pad order when the layout is fixed", () => {
    render(<PinPadView entered={0} onDigit={() => {}} onBackspace={() => {}} />);
    expect(renderedOrder()).toEqual(STANDARD);
  });

  it.each([
    "rotated",
    "scrambled",
    "scrambled-per-key",
  ] as const)("renders a full permutation when %s", (layout) => {
    render(<PinPadView entered={0} layout={layout} onDigit={() => {}} onBackspace={() => {}} />);
    const order = renderedOrder();
    expect(order).toHaveLength(10);
    expectFullPermutation(order);
  });

  // Scoped to the PER-PROMPT modes on purpose (#302). Holding still mid-entry is
  // still exactly right for these , and it is a real guarantee, so adding a mode
  // that breaks it must not quietly delete it for the modes that keep it.
  // `scrambled-per-key` asserts the opposite, below.
  it.each([
    "rotated",
    "scrambled",
  ] as const)("redraws when shuffleKey changes, and holds still when it doesn't (%s)", (layout) => {
    const { rerender } = render(
      <PinPadView
        entered={0}
        layout={layout}
        shuffleKey={0}
        onDigit={() => {}}
        onBackspace={() => {}}
      />,
    );
    const first = renderedOrder().join("");

    // Same key, new render (e.g. a digit tapped mid-entry): the layout must NOT
    // move , keys shifting under a half-typed PIN is how you mistype it.
    rerender(
      <PinPadView
        entered={3}
        layout={layout}
        shuffleKey={0}
        onDigit={() => {}}
        onBackspace={() => {}}
      />,
    );
    expect(renderedOrder().join("")).toBe(first);

    // New key = new prompt (next stage, or a rejected attempt). Try a handful of
    // keys: any single redraw can coincidentally repeat, but all of them cannot.
    const after = new Set<string>();
    for (const key of [1, 2, 3, 4, 5]) {
      rerender(
        <PinPadView
          entered={0}
          layout={layout}
          shuffleKey={key}
          onDigit={() => {}}
          onBackspace={() => {}}
        />,
      );
      after.add(renderedOrder().join(""));
    }
    expect(after.size).toBeGreaterThan(1);
  });

  it("reshuffles on every digit entered when scrambled-per-key", () => {
    // The inverse of the assertion above, and the whole reason this mode exists:
    // a watched finger position must mean a different digit by the next press.
    // The prompt (shuffleKey) never changes here , only `entered` does, which is
    // precisely the mid-entry redraw the other modes forbid.
    const { rerender } = render(
      <PinPadView
        entered={0}
        layout="scrambled-per-key"
        shuffleKey={0}
        onDigit={() => {}}
        onBackspace={() => {}}
      />,
    );

    const seen = [renderedOrder().join("")];
    for (const entered of [1, 2, 3, 4, 5, 6]) {
      rerender(
        <PinPadView
          entered={entered}
          layout="scrambled-per-key"
          shuffleKey={0}
          onDigit={() => {}}
          onBackspace={() => {}}
        />,
      );
      const order = renderedOrder();
      // Still a usable pad after each redraw, not just a different one.
      expectFullPermutation(order);
      seen.push(order.join(""));
    }
    // Any single redraw can coincidentally repeat (1 in 10!), but seven draws
    // collapsing to one value means it is not moving at all.
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  it("also reshuffles on backspace when scrambled-per-key", () => {
    // A corrected digit is still a digit an observer watched being pressed, so
    // `entered` falling has to redraw just as `entered` rising does.
    const { rerender } = render(
      <PinPadView
        entered={3}
        layout="scrambled-per-key"
        shuffleKey={0}
        onDigit={() => {}}
        onBackspace={() => {}}
      />,
    );
    const seen = new Set([renderedOrder().join("")]);
    for (const entered of [2, 1, 0]) {
      rerender(
        <PinPadView
          entered={entered}
          layout="scrambled-per-key"
          shuffleKey={0}
          onDigit={() => {}}
          onBackspace={() => {}}
        />,
      );
      seen.add(renderedOrder().join(""));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("snaps back to the standard order when the layout is set to fixed", () => {
    const { rerender } = render(
      <PinPadView entered={0} layout="scrambled" onDigit={() => {}} onBackspace={() => {}} />,
    );
    rerender(<PinPadView entered={0} layout="fixed" onDigit={() => {}} onBackspace={() => {}} />);
    expect(renderedOrder()).toEqual(STANDARD);
  });
});

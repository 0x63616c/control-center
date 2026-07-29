import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { PIN_LENGTH, type PinPadLayout } from "../../lib/settings";
import { PinPadView } from "./PinPad";

/**
 * PinPadView , the dumb tap pad used by every PIN surface: entry dots plus the
 * 3x4 keypad. State lives in the parent; this story wires a tiny local model so
 * you can tap digits and watch the dots fill (and backspace to clear them).
 */
function PinPadHarness({ layout = "fixed" }: { layout?: PinPadLayout }) {
  const [pin, setPin] = useState("");
  // Each full-length entry counts as one prompt, so a moving pad redraws exactly
  // where the real gates do , between attempts, never mid-entry.
  const [prompt, setPrompt] = useState(0);
  return (
    <div
      style={{ display: "flex", justifyContent: "center", padding: 48, background: "var(--bg)" }}
    >
      <PinPadView
        entered={pin.length}
        layout={layout}
        shuffleKey={prompt}
        onDigit={(d) => {
          if (pin.length < PIN_LENGTH - 1) {
            setPin(pin + d);
            return;
          }
          // Sixth digit: the entry is complete, so this prompt is over.
          setPin("");
          setPrompt((n) => n + 1);
        }}
        onBackspace={() => setPin((p) => p.slice(0, -1))}
      />
    </div>
  );
}

const meta = {
  title: "Pin/PinPad",
  component: PinPadView,
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "fullscreen" },
} satisfies Meta<typeof PinPadView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Live pad: tap digits to fill the dots, backspace to clear. */
export const Interactive: Story = {
  // Args satisfy the presentational prop types; the harness ignores them and
  // drives its own local state, so the pad is genuinely interactive here.
  args: { entered: 0, onDigit: () => {}, onBackspace: () => {} },
  render: () => <PinPadHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Every key is reachable by its accessible name.
    for (const d of ["0", "5", "9"]) {
      await expect(canvas.getByRole("button", { name: d })).toBeInTheDocument();
    }
    await expect(canvas.getByRole("button", { name: "backspace" })).toBeInTheDocument();

    // Tapping three digits fills three of the six dots.
    await userEvent.click(canvas.getByRole("button", { name: "1" }));
    await userEvent.click(canvas.getByRole("button", { name: "2" }));
    await userEvent.click(canvas.getByRole("button", { name: "3" }));
    const filled = () =>
      canvasElement.querySelectorAll<HTMLElement>('div[style*="border-radius: 50%"]');
    // 6 dots + 12 round keys share the selector; assert by counting solid-fill dots.
    const solid = Array.from(filled()).filter(
      (el) => el.style.width === "14px" && el.style.background !== "transparent",
    );
    await expect(solid).toHaveLength(3);
  },
};

/**
 * Rotated pad (#291) , `pinPadLayout: "rotated"`. Ascending order is preserved
 * and only the starting digit moves, so the pad still reads at a glance (find
 * one key and the rest follow) while the grease trail still spreads across all
 * ten. The everyday trade: nearly all of the smudge defence for a fraction of
 * the scanning cost. Reload the story to draw a new shift.
 */
export const Rotated: Story = {
  args: { entered: 0, onDigit: () => {}, onBackspace: () => {} },
  render: () => <PinPadHarness layout="rotated" />,
  play: async ({ canvasElement }) => {
    const order = Array.from(canvasElement.querySelectorAll<HTMLElement>("button[aria-label]"))
      .map((el) => el.getAttribute("aria-label") ?? "")
      .filter((label) => /^\d$/.test(label));

    // All ten digits, and the sequence is a cyclic shift of the standard pad ,
    // that is exactly what makes this layout readable.
    await expect(order).toHaveLength(10);
    const standard = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
    const rotations = standard.map((_, k) =>
      [...standard.slice(k), ...standard.slice(0, k)].join(""),
    );
    await expect(rotations).toContain(order.join(""));
  },
};

/**
 * Scrambled pad (#287) , `pinPadLayout: "scrambled"`. The digits sit in a
 * random order and land somewhere else on the next prompt, so the grease trail
 * on the panel glass stops spelling out which four keys the PIN uses. Hides the
 * most; costs a lookup per key. Reload the story to draw a new layout.
 */
export const Scrambled: Story = {
  args: { entered: 0, onDigit: () => {}, onBackspace: () => {} },
  render: () => <PinPadHarness layout="scrambled" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const digitOrder = () =>
      Array.from(canvasElement.querySelectorAll<HTMLElement>("button[aria-label]"))
        .map((el) => el.getAttribute("aria-label") ?? "")
        .filter((label) => /^\d$/.test(label));

    // Scrambling must never cost a key: all ten digits, exactly once each.
    const before = digitOrder();
    await expect(before).toHaveLength(10);
    await expect([...before].sort().join("")).toBe("0123456789");
    await expect(canvas.getByRole("button", { name: "backspace" })).toBeInTheDocument();

    // Mid-entry the layout must hold still , keys moving under a half-typed PIN
    // is how you mistype it.
    await userEvent.click(canvas.getByRole("button", { name: before[0] ?? "1" }));
    await expect(digitOrder()).toEqual(before);
  },
};

/**
 * Per-keypress scramble (#302) , `pinPadLayout: "scrambled-per-key"`, the
 * shipped default. Unlike every other layout this one redraws MID-ENTRY, after
 * each digit, which is the only way to make a shoulder-surfer's view of your
 * finger worthless: the position they watched means a different digit by the
 * next press. Tap a key and watch the whole pad move.
 */
export const ScrambledPerKey: Story = {
  args: { entered: 0, onDigit: () => {}, onBackspace: () => {} },
  render: () => <PinPadHarness layout="scrambled-per-key" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const digitOrder = () =>
      Array.from(canvasElement.querySelectorAll<HTMLElement>("button[aria-label]"))
        .map((el) => el.getAttribute("aria-label") ?? "")
        .filter((label) => /^\d$/.test(label));

    const before = digitOrder();
    await expect(before).toHaveLength(10);
    await expect([...before].sort().join("")).toBe("0123456789");

    // Three taps, all well inside one entry (PIN_LENGTH is 6), so the prompt
    // never turns over , any movement here is the per-keypress redraw and
    // nothing else. Collect the orders rather than asserting each differs: a
    // single redraw can land on the same permutation, three cannot all collapse.
    const seen = new Set([before.join("")]);
    for (let i = 0; i < 3; i++) {
      await userEvent.click(canvas.getByRole("button", { name: digitOrder()[0] ?? "1" }));
      const after = digitOrder();
      await expect([...after].sort().join("")).toBe("0123456789");
      seen.add(after.join(""));
    }
    await expect(seen.size).toBeGreaterThan(1);
  },
};

/** Keyboard entry: digit keys append, Backspace/Delete remove, Cmd/Ctrl+digit is ignored. */
export const KeyboardEntry: Story = {
  args: { entered: 0, onDigit: () => {}, onBackspace: () => {} },
  render: () => <PinPadHarness />,
  play: async ({ canvasElement }) => {
    const solidDots = () =>
      Array.from(
        canvasElement.querySelectorAll<HTMLElement>('div[style*="border-radius: 50%"]'),
      ).filter((el) => el.style.width === "14px" && el.style.background !== "transparent");

    // Typing digit keys fills dots, same as tapping.
    await userEvent.keyboard("123");
    await expect(solidDots()).toHaveLength(3);

    // Backspace removes the last digit.
    await userEvent.keyboard("{Backspace}");
    await expect(solidDots()).toHaveLength(2);

    // Delete also removes the last digit.
    await userEvent.keyboard("{Delete}");
    await expect(solidDots()).toHaveLength(1);

    // Cmd+digit (e.g. browser zoom-reset) must NOT enter a digit.
    await userEvent.keyboard("{Meta>}0{/Meta}");
    await expect(solidDots()).toHaveLength(1);
  },
};

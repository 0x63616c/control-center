import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { PIN_LENGTH } from "../../lib/settings";
import { PinPadView } from "./PinPad";

/**
 * PinPadView , the dumb tap pad used by every PIN surface: entry dots plus the
 * 3x4 keypad. State lives in the parent; this story wires a tiny local model so
 * you can tap digits and watch the dots fill (and backspace to clear them).
 */
function PinPadHarness({ scramble = false }: { scramble?: boolean }) {
  const [pin, setPin] = useState("");
  // Each full-length entry counts as one prompt, so the scrambled pad reshuffles
  // exactly where the real gates do , between attempts, never mid-entry.
  const [prompt, setPrompt] = useState(0);
  return (
    <div
      style={{ display: "flex", justifyContent: "center", padding: 48, background: "var(--bg)" }}
    >
      <PinPadView
        entered={pin.length}
        scramble={scramble}
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
 * Scrambled pad (#287) , the `scramblePin` setting on. The digits sit in a
 * random order and land somewhere else on the next prompt, so the grease trail
 * on the panel glass stops spelling out which four keys the PIN uses. Reload the
 * story to draw a new layout.
 */
export const Scrambled: Story = {
  args: { entered: 0, onDigit: () => {}, onBackspace: () => {} },
  render: () => <PinPadHarness scramble />,
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

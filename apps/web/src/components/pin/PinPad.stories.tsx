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
function PinPadHarness() {
  const [pin, setPin] = useState("");
  return (
    <div
      style={{ display: "flex", justifyContent: "center", padding: 48, background: "var(--bg)" }}
    >
      <PinPadView
        entered={pin.length}
        onDigit={(d) => setPin((p) => (p.length < PIN_LENGTH ? p + d : p))}
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

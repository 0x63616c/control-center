import type { Meta, StoryObj } from "@storybook/react-vite";
import type React from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { setPinCode } from "../../lib/settings";
import { PinGateModal } from "./PinGateModal";

// Thin wrapper so Storybook infers props from the function-component signature.
function PinGateStory(props: React.ComponentProps<typeof PinGateModal>) {
  return <PinGateModal {...props} />;
}

const meta = {
  title: "Pin/PinGateModal",
  component: PinGateStory,
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "fullscreen" },
  // The PIN lives in the shared settings store, which persists to localStorage
  // across every story in the run (SecurityPage's walkthrough changes it to
  // 123456). Pin it back to 000000 before each render so this story never
  // depends on story order.
  decorators: [
    (Story) => {
      setPinCode("000000");
      return <Story />;
    },
  ],
  args: {
    title: "Settings",
    onClose: fn(),
    onSuccess: fn(),
  },
} satisfies Meta<typeof PinGateStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Open gate over the fullscreen frame. The decorator pins the PIN to 000000,
 * so tapping 0 six times unlocks , the dialog flips to "Unlocked" and
 * (after a short beat) calls onSuccess.
 */
export const Open: Story = {
  args: { open: true },
  play: async ({ args }) => {
    // The gate portals into document.body, so it lives OUTSIDE canvasElement.
    const doc = within(document.body);
    await expect(doc.getByText("Enter PIN")).toBeInTheDocument();
    await expect(doc.getByText("Enter your PIN to continue")).toBeInTheDocument();

    // Tap the default PIN (000000). Re-query the 0 key before EVERY tap rather
    // than holding a reference: the default layout is `scrambled-per-key`
    // (#302), so the pad reshuffles after each digit and the cell that held 0 a
    // moment ago now holds something else. Keys are keyed by position, so the
    // stale element stays mounted and clicking it would silently enter the
    // wrong digit. Re-scanning per digit is exactly what the mode costs a
    // person, so the story paying it is the honest test.
    for (let i = 0; i < 6; i++) {
      await userEvent.click(doc.getByRole("button", { name: "0" }));
    }

    // Correct entry flips the dialog to the unlocked state. Generous timeouts:
    // CI runs this under coverage instrumentation, which is slow enough that
    // the default 1s findBy window flakes (same reason the Board tests carry
    // long timeouts under coverage).
    await expect(
      await doc.findByText("Unlocked", undefined, { timeout: 10_000 }),
    ).toBeInTheDocument();
    // And, after the handoff beat, calls onSuccess.
    await waitFor(() => expect(args.onSuccess).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  },
};

/** Closed gate renders nothing into the document. */
export const Closed: Story = {
  args: { open: false },
  play: async () => {
    const doc = within(document.body);
    await expect(doc.queryByText("Enter PIN")).not.toBeInTheDocument();
  },
};

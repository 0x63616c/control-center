import type { Meta, StoryObj } from "@storybook/react-vite";
import type React from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { setPinCode } from "../../lib/settings";
import { PinChangeModal } from "./PinChangeModal";

// Thin wrapper so Storybook infers props from the function-component signature.
function PinChangeStory(props: React.ComponentProps<typeof PinChangeModal>) {
  return <PinChangeModal {...props} />;
}

const meta = {
  title: "Pin/PinChangeModal",
  component: PinChangeStory,
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "fullscreen" },
  // The PIN lives in the shared settings store, which persists to localStorage
  // across every story in the run (these stories change it themselves). Pin it
  // back to 000000 before each render so nothing depends on story order.
  decorators: [
    (Story) => {
      setPinCode("000000");
      return <Story />;
    },
  ],
  args: {
    onClose: fn(),
    onChanged: fn(),
  },
} satisfies Meta<typeof PinChangeStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The surface portals into document.body, so it is OUTSIDE canvasElement. */
async function tap(digits: string) {
  const doc = within(document.body);
  for (const d of digits) {
    await userEvent.click(doc.getByRole("button", { name: d }));
  }
}

/** Stage one, as the surface looks the moment the Change PIN row is tapped. */
export const Open: Story = {
  args: { open: true },
  play: async () => {
    const doc = within(document.body);
    await expect(doc.getByText("Enter current PIN")).toBeInTheDocument();
    await expect(doc.getByText("Confirm it's you before changing the PIN.")).toBeInTheDocument();
  },
};

/**
 * All three stages. The matching confirm saves the PIN and calls onChanged ,
 * there is no terminal "PIN changed" screen for it to land on any more, the
 * caller dismisses us instead.
 */
export const Walkthrough: Story = {
  args: { open: true },
  play: async ({ args }) => {
    const doc = within(document.body);
    await tap("000000");
    await expect(doc.getByText("Enter new PIN")).toBeInTheDocument();
    await tap("123456");
    await expect(doc.getByText("Confirm new PIN")).toBeInTheDocument();
    await tap("123456");
    // Generous timeout: CI runs stories under coverage instrumentation.
    await waitFor(() => expect(args.onChanged).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  },
};

/**
 * A confirm that doesn't match drops back to "Enter new PIN" rather than
 * committing anything , and does NOT make you re-prove the current PIN you just
 * entered.
 */
export const Mismatch: Story = {
  args: { open: true },
  play: async ({ args }) => {
    const doc = within(document.body);
    await tap("000000");
    await tap("123456");
    await tap("654321");
    await expect(
      await doc.findByText("PINs didn't match, start over", undefined, { timeout: 10_000 }),
    ).toBeInTheDocument();
    await expect(doc.getByText("Enter new PIN")).toBeInTheDocument();
    await expect(args.onChanged).not.toHaveBeenCalled();
  },
};

/** Closed surface renders nothing into the document. */
export const Closed: Story = {
  args: { open: false },
  play: async () => {
    const doc = within(document.body);
    await expect(doc.queryByText("Enter current PIN")).not.toBeInTheDocument();
  },
};

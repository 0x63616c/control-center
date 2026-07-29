import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { setPinCode } from "../../../lib/settings";
import { SecurityPage } from "./SecurityPage";

// The page lives inside the full-page Settings content column (720px, on
// var(--bg)); this frame reproduces that footprint. The change-PIN flow reads
// and writes the shared settings store, so it is fully live here , the decorator
// resets the PIN back to the default before each run so the walkthrough (and any
// rerun) always starts from a known "000000".
function ColumnFrame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 40, background: "var(--bg)", minHeight: "100vh" }}>
      <div
        style={{
          width: 720,
          margin: "0 auto",
          color: "var(--ink)",
          fontFamily: "var(--ui)",
          display: "flex",
          flexDirection: "column",
          gap: 28,
        }}
      >
        {children}
      </div>
    </div>
  );
}

const meta = {
  title: "Pages/Settings/Security",
  component: SecurityPage,
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "fullscreen" },
  decorators: [
    (Story) => {
      setPinCode("000000");
      return (
        <ColumnFrame>
          <Story />
        </ColumnFrame>
      );
    },
  ],
} satisfies Meta<typeof SecurityPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The change-PIN surface portals into document.body, so it lives OUTSIDE
 *  canvasElement , everything past the row has to be queried from the document. */
async function tap(digits: string) {
  const doc = within(document.body);
  for (const d of digits) {
    await userEvent.click(doc.getByRole("button", { name: d }));
  }
}

/** The page at rest: keypad layout picker, then Change PIN as a plain row. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Change PIN")).toBeInTheDocument();
    // No flow on screen until the row is tapped , that is the whole point of
    // #298 (it used to be permanently mounted here).
    await expect(within(document.body).queryByText("Enter current PIN")).not.toBeInTheDocument();
  },
};

/** Tapping the row opens the three-stage flow on its own surface. */
export const ChangingPin: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Change PIN" }));
    await expect(within(document.body).getByText("Enter current PIN")).toBeInTheDocument();
  },
};

/**
 * The full walkthrough. A matching confirm confirms itself on the surface the
 * person is looking at, then dismisses , the row's "Changed" is the echo, not
 * the confirmation, and the old "Change again" dead end stays gone.
 */
export const Changed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const doc = within(document.body);
    await userEvent.click(canvas.getByRole("button", { name: "Change PIN" }));

    // Stage 1: current PIN (default 000000) unlocks the change.
    await expect(doc.getByText("Enter current PIN")).toBeInTheDocument();
    await tap("000000");
    // Stage 2: new PIN.
    await expect(doc.getByText("Enter new PIN")).toBeInTheDocument();
    await tap("123456");
    // Stage 3: confirm the new PIN.
    await expect(doc.getByText("Confirm new PIN")).toBeInTheDocument();
    await tap("123456");

    // The success beat, on the surface itself , and still nothing to dismiss.
    await expect(doc.getByText("PIN changed")).toBeInTheDocument();
    await expect(doc.queryByRole("button", { name: "Change again" })).not.toBeInTheDocument();

    // Then it leaves on its own, and the row echoes it. Generous timeout: CI
    // runs this under coverage instrumentation (same reason the PinGateModal
    // and Board stories carry long ones).
    await waitFor(() => expect(doc.queryByText("Confirm new PIN")).not.toBeInTheDocument(), {
      timeout: 10_000,
    });
    await waitFor(() => expect(canvas.getByText("Changed")).toBeInTheDocument(), {
      timeout: 10_000,
    });
  },
};

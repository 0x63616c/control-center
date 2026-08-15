import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { Stepper, Toggle } from "./bits";
import { T } from "./theme";
import { Avatar, Btn } from "./ui";

function PrimitiveGallery() {
  const [enabled, setEnabled] = useState(false);
  const [cents, setCents] = useState(500);
  const [clicks, setClicks] = useState(0);

  return (
    <div
      style={{
        width: 390,
        minHeight: 700,
        boxSizing: "border-box",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 28,
        background: T.bg,
        color: T.text,
        fontFamily: T.ui,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Avatar user={{ name: "Alex Rivera", color: "#5E5CE6", emoji: null }} size={52} />
        <strong>Alex Rivera</strong>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Share streak</span>
        <Toggle on={enabled} onChange={setEnabled} />
      </div>
      <output data-testid="toggle-value">{enabled ? "enabled" : "disabled"}</output>
      <Stepper cents={cents} onChange={setCents} />
      <output data-testid="stepper-value">{cents}</output>
      <Btn onClick={() => setClicks((value) => value + 1)}>Save</Btn>
      <output data-testid="button-clicks">{clicks}</output>
    </div>
  );
}

const meta = {
  title: "Don't Text Your Ex/Shared primitives",
  component: PrimitiveGallery,
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "centered" },
} satisfies Meta<typeof PrimitiveGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Interactive: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("toggle-value")).toHaveTextContent("disabled");
    await userEvent.click(canvas.getAllByRole("button")[0]);
    await expect(canvas.getByTestId("toggle-value")).toHaveTextContent("enabled");

    await userEvent.click(canvas.getByRole("button", { name: "+" }));
    await expect(canvas.getByTestId("stepper-value")).toHaveTextContent("600");

    await userEvent.click(canvas.getByRole("button", { name: "Save" }));
    await expect(canvas.getByTestId("button-clicks")).toHaveTextContent("1");
  },
};

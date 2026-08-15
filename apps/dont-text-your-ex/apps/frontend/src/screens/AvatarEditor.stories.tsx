import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { type AvatarDraft, AvatarEditor } from "./common";

function EditableAvatar() {
  const [draft, setDraft] = useState<AvatarDraft>({
    name: "Calum",
    color: "#5E5CE6",
    emoji: "🫠",
    photo: null,
  });
  return <AvatarEditor draft={draft} setDraft={setDraft} />;
}

const meta = {
  title: "Don't Text Your Ex/Components/Avatar Editor",
  component: EditableAvatar,
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "centered" },
  decorators: [
    (Story) => (
      <div style={{ width: 400, minHeight: 700, padding: 20, background: "#000" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EditableAvatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EightAcross: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("button", { name: /Use profile color/ })).toHaveLength(8);
    await expect(
      canvas.getAllByRole("button", { name: /Use (?:initials|.+) avatar/ }),
    ).toHaveLength(8);
  },
};

export const CropCanBeCancelled: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvasElement.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("profile photo input missing");
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      ),
      (character) => character.charCodeAt(0),
    );
    await userEvent.upload(input, new File([png], "avatar.png", { type: "image/png" }));
    const dialog = await canvas.findByRole("dialog", { name: "Crop profile photo" });
    await expect(within(dialog).getByRole("button", { name: "Move photo crop" })).toBeEnabled();
    await expect(within(dialog).getByRole("slider", { name: "Zoom photo" })).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await expect(
      canvas.queryByRole("dialog", { name: "Crop profile photo" }),
    ).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Choose profile photo" })).toHaveFocus();
  },
};

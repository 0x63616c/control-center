import type { Meta, StoryObj } from "@storybook/react-vite";
import { BentoHome } from "./BentoHome";

const meta = {
  title: "Prototypes/Bento home",
  component: BentoHome,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen", boardWrapper: false },
} satisfies Meta<typeof BentoHome>;
export default meta;
type Story = StoryObj<typeof meta>;
export const White: Story = {};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { LauncherCard } from "@/components/LauncherCard";
import { TOOLS } from "@/registry";

const github = TOOLS.find((tool) => tool.id === "github");
const unifi = TOOLS.find((tool) => tool.id === "unifi");
if (!github || !unifi) throw new Error("registry no longer has the tools this story renders");

const meta = {
  tags: ["autodocs"],
  component: LauncherCard,
  decorators: [
    (Story) => (
      <div style={{ position: "relative", width: 900, height: 520, background: "var(--tile)" }}>
        <Story />
      </div>
    ),
  ],
  args: { tool: github },
} satisfies Meta<typeof LauncherCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** What a pane shows when the extension is not installed. */
export const GitHub: Story = {};

export const UniFi: Story = { args: { tool: unifi } };

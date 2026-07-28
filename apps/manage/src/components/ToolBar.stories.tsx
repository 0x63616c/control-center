import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToolBar } from "@/components/ToolBar";
import { TOOLS } from "@/registry";

const meta = {
  tags: ["autodocs"],
  component: ToolBar,
  decorators: [
    (Story) => (
      <div style={{ width: 900, background: "var(--tile)" }}>
        <Story />
      </div>
    ),
  ],
  args: { tool: TOOLS[0], onReload: () => {} },
} satisfies Meta<typeof ToolBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A long URL truncates in the mono chip rather than pushing the buttons off. */
export const LongUrl: Story = {
  args: {
    tool: {
      ...TOOLS[0],
      label: "Grafana",
      url: "https://grafana.worldwidewebb.co/d/abcdefghijk/control-center-overview?orgId=1&from=now-24h&to=now&refresh=30s",
    },
  },
};

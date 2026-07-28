import type { Meta, StoryObj } from "@storybook/react-vite";
import { type PaneState, Sidebar } from "@/components/Sidebar";
import { TOOLS } from "@/registry";

function states(fn: (id: string, index: number) => PaneState): Record<string, PaneState> {
  return Object.fromEntries(TOOLS.map((tool, index) => [tool.id, fn(tool.id, index)]));
}

const meta = {
  tags: ["autodocs"],
  component: Sidebar,
  decorators: [
    (Story) => (
      <div style={{ width: 248, height: 720, display: "grid" }}>
        <Story />
      </div>
    ),
  ],
  args: {
    activeId: TOOLS[0].id,
    onSelect: () => {},
    paneStates: states(() => "idle"),
    extensionVersion: "1.0.0",
  },
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** All five groups, nothing opened yet. */
export const Default: Story = {};

/** The active row: nest fill, hairline border, accent bar bleeding off the left. */
export const ActiveRowDeepInAGroup: Story = {
  args: { activeId: "temporal" },
};

/** A working session — some panes loaded, the rest never opened. */
export const PanesLoaded: Story = {
  args: {
    activeId: "grafana",
    paneStates: states((_id, index) => (index % 3 === 0 ? "loaded" : "idle")),
  },
};

/** No extension: every tool that needs it reports blocked, and so does the footer. */
export const ExtensionMissing: Story = {
  args: {
    extensionVersion: null,
    paneStates: states((id) => (id === "cc" ? "idle" : "blocked")),
  },
};

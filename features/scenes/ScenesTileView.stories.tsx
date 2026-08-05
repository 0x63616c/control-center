import type { Meta, StoryObj } from "@storybook/react-vite";
import { TileStatus } from "@/components/ui";
import type { SceneDefinition } from "./model";
import { ScenesTileView } from "./web";

const scenes: SceneDefinition[] = [
  {
    id: "scene_explicit",
    name: "Explicit",
    description: "Red lights and music",
    icon: "🔥",
    createdAt: "2026-08-04T12:00:00Z",
    updatedAt: "2026-08-04T12:00:00Z",
    actions: [
      {
        kind: "lighting",
        targets: [{ kind: "entity", entityId: "light.living_room_globe" }],
        power: true,
        brightness: 50,
        color: { kind: "rgb", red: 255, green: 0, blue: 0 },
        transitionSeconds: 2,
      },
      {
        kind: "music",
        source: {
          kind: "spotify",
          playlists: [{ name: "Explicit", uri: "spotify:playlist:4p2s0B2eI2goKbj6CN20pV" }],
          selection: "prompt",
          shuffleTracks: true,
        },
        outputs: [{ kind: "all", volume: 30 }],
      },
    ],
  },
  {
    id: "scene_morning",
    name: "Morning",
    description: "Bright warm-white lights with light EDM",
    icon: "🌅",
    createdAt: "2026-08-04T12:00:00Z",
    updatedAt: "2026-08-04T12:00:00Z",
    actions: [
      {
        kind: "lighting",
        targets: [{ kind: "all" }],
        power: true,
        brightness: 100,
        color: { kind: "temperature", kelvin: 4000 },
        transitionSeconds: 5,
      },
    ],
  },
];

const meta = {
  title: "Scenes/Tile",
  component: ScenesTileView,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div style={{ width: 420, height: 320 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ScenesTileView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  args: { status: TileStatus.Populated, scenes },
};

export const Running: Story = {
  args: { status: TileStatus.Populated, scenes, runningName: "Explicit" },
};

export const Loading: Story = {
  args: { status: TileStatus.Loading },
};

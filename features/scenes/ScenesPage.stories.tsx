import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { SceneDefinition } from "./model";
import {
  RunningSceneView,
  SceneEditorView,
  SceneLaunchView,
  ScenePickerView,
  type SceneResourceView,
} from "./web";

const explicit: SceneDefinition = {
  id: "scene_explicit",
  name: "Explicit",
  description: "Red lights and an explicit playlist across the house.",
  icon: "🔥",
  createdAt: "2026-08-04T12:00:00Z",
  updatedAt: "2026-08-04T12:00:00Z",
  actions: [
    {
      kind: "lighting",
      targets: [{ kind: "all" }],
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
};

const morning: SceneDefinition = {
  ...explicit,
  id: "scene_morning",
  name: "Morning",
  icon: "🌅",
  description: "Bright warm-white lights with light EDM.",
  actions: [
    {
      kind: "lighting",
      targets: [{ kind: "all" }],
      power: true,
      brightness: 100,
      color: { kind: "temperature", kelvin: 4000 },
      transitionSeconds: 5,
    },
    {
      kind: "music",
      source: {
        kind: "spotify",
        playlists: [{ name: "Light EDM", uri: "spotify:playlist:7aVilKgwoscbq0R36H0kuq" }],
        selection: "fixed",
        shuffleTracks: true,
      },
      outputs: [{ kind: "all", volume: 20 }],
    },
  ],
};

const resources: SceneResourceView = {
  lights: [
    {
      entityId: "light.living_room_globe",
      label: "Globe",
      room: "Living Room",
      capabilities: ["onOff", "brightness", "rgb", "colorTemp"],
    },
    {
      entityId: "light.bed_lamp_left",
      label: "Bed Left",
      room: "Bedroom",
      capabilities: ["onOff", "brightness", "rgb", "colorTemp"],
    },
  ],
  speakers: {
    status: "ready",
    items: [
      { uuid: "living", name: "Living Room", deviceIp: "192.0.2.1", volume: 30 },
      { uuid: "kitchen", name: "Kitchen", deviceIp: "192.0.2.2", volume: 25 },
      { uuid: "bedroom", name: "Bedroom", deviceIp: "192.0.2.3", volume: 20 },
    ],
  },
  spotify: {
    status: "ready",
    playlists: [
      {
        id: "explicit",
        name: "Explicit",
        uri: "spotify:playlist:4p2s0B2eI2goKbj6CN20pV",
        imageUrl: null,
      },
      {
        id: "morning",
        name: "Light EDM",
        uri: "spotify:playlist:7aVilKgwoscbq0R36H0kuq",
        imageUrl: null,
      },
    ],
  },
};

function SceneShowcase({ view }: { view: "picker" | "launch" | "editor" | "running" }) {
  if (view === "launch") {
    return (
      <SceneLaunchView
        scene={explicit}
        resources={resources}
        onBack={fn()}
        onEdit={fn()}
        onLaunch={fn()}
        onSaveDefaults={fn()}
      />
    );
  }
  if (view === "editor") {
    return (
      <SceneEditorView
        scene={explicit}
        resources={resources}
        onCancel={fn()}
        onSave={fn()}
        onDelete={fn()}
      />
    );
  }
  if (view === "running") {
    return (
      <RunningSceneView
        run={{
          id: "scene_run_story",
          sceneName: "Explicit",
          startedAt: "2026-08-04T19:30:00Z",
          resolved: {
            sceneName: "Explicit",
            playlist: { name: "Explicit", uri: "spotify:playlist:4p2s0B2eI2goKbj6CN20pV" },
            speakers: resources.speakers.status === "ready" ? resources.speakers.items : [],
            lighting: explicit.actions[0]?.kind === "lighting" ? explicit.actions[0] : null,
            spotifyDeviceId: "living",
          },
        }}
        playback={{
          status: "ready",
          value: {
            trackTitle: "The Hills",
            artist: "The Weeknd",
            progressMs: 102000,
            durationMs: 242000,
            isPlaying: true,
          },
        }}
        onBack={fn()}
        onStop={fn()}
      />
    );
  }
  return (
    <ScenePickerView
      scenes={[explicit, morning]}
      runningName={null}
      onLaunch={fn()}
      onEdit={fn()}
      onCreate={fn()}
      onRunning={fn()}
    />
  );
}

const meta = {
  title: "Scenes/Full-screen app",
  component: SceneShowcase,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div style={{ minHeight: 860, padding: 24, background: "var(--bg)", color: "var(--ink)" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SceneShowcase>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Picker: Story = { args: { view: "picker" } };
export const Launch: Story = { args: { view: "launch" } };
export const Editor: Story = { args: { view: "editor" } };
export const Running: Story = { args: { view: "running" } };

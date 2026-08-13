import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TileStatus } from "@/components/ui";
import type { SceneDefinition } from "./model";
import { SceneLaunchView, ScenePickerView, type SceneResourceView, ScenesTileView } from "./web";

afterEach(cleanup);

const scene: SceneDefinition = {
  id: "scene_explicit",
  name: "Explicit",
  description: "Red lights and music",
  icon: "🔥",
  createdAt: "2026-08-04T00:00:00Z",
  updatedAt: "2026-08-04T00:00:00Z",
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
        playlists: [{ name: "Explicit", uri: "spotify:playlist:explicit" }],
        selection: "prompt",
        shuffleTracks: true,
      },
      outputs: [{ kind: "all", volume: 30 }],
    },
  ],
};

const resources: SceneResourceView = {
  lights: [],
  speakers: {
    status: "ready",
    items: [
      { uuid: "living", name: "Living Room", deviceIp: "192.0.2.1", volume: 10 },
      { uuid: "kitchen", name: "Kitchen", deviceIp: "192.0.2.2", volume: 15 },
    ],
  },
  spotify: { status: "ready", playlists: [] },
};

describe("Scenes tile", () => {
  it("shows scene names without their stored emoji icons", () => {
    const { container } = render(<ScenesTileView status={TileStatus.Populated} scenes={[scene]} />);

    expect(screen.getByText("Explicit")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("🔥");
  });
});

describe("Scenes full-screen picker", () => {
  it("opens a scene for review instead of launching immediately", () => {
    const onLaunch = vi.fn();
    render(
      <ScenePickerView
        scenes={[scene]}
        onLaunch={onLaunch}
        onEdit={vi.fn()}
        onCreate={vi.fn()}
        onRunning={vi.fn()}
      />,
    );
    expect(screen.getByText("Which scene?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review & start" }));
    expect(onLaunch).toHaveBeenCalledWith("scene_explicit");
  });
});

describe("Scene launch overrides", () => {
  it("requires an explicit choice for prompt mode with multiple playlists", () => {
    const promptScene: SceneDefinition = {
      ...scene,
      actions: scene.actions.map((action) =>
        action.kind === "music"
          ? {
              ...action,
              source: {
                ...action.source,
                playlists: [
                  ...action.source.playlists,
                  { name: "Another", uri: "spotify:playlist:another" },
                ],
              },
            }
          : action,
      ),
    };
    render(
      <SceneLaunchView
        scene={promptScene}
        resources={resources}
        onBack={vi.fn()}
        onEdit={vi.fn()}
        onLaunch={vi.fn()}
        onSaveDefaults={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Start Explicit" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Playlist" })).toHaveValue("");
  });

  it("submits temporary per-speaker volume changes without mutating saved defaults", () => {
    const onLaunch = vi.fn();
    render(
      <SceneLaunchView
        scene={scene}
        resources={resources}
        onBack={vi.fn()}
        onEdit={vi.fn()}
        onLaunch={onLaunch}
        onSaveDefaults={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Living Room volume"), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Start Explicit" }));
    expect(onLaunch).toHaveBeenCalledWith({
      playlistUri: "spotify:playlist:explicit",
      speakers: [
        { speakerUuid: "living", enabled: true, volume: 42 },
        { speakerUuid: "kitchen", enabled: true, volume: 30 },
      ],
    });
    expect(scene.actions[1]).toMatchObject({ outputs: [{ kind: "all", volume: 30 }] });
  });

  it("persists launch changes only through the explicit save-defaults action", () => {
    const onSaveDefaults = vi.fn();
    render(
      <SceneLaunchView
        scene={scene}
        resources={resources}
        onBack={vi.fn()}
        onEdit={vi.fn()}
        onLaunch={vi.fn()}
        onSaveDefaults={onSaveDefaults}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save as scene defaults" }));
    expect(onSaveDefaults).toHaveBeenCalledOnce();
    expect(onSaveDefaults.mock.calls[0]?.[0]).toMatchObject({
      actions: [
        expect.objectContaining({ kind: "lighting" }),
        expect.objectContaining({
          kind: "music",
          outputs: [
            expect.objectContaining({ speakerUuid: "living", volume: 30 }),
            expect.objectContaining({ speakerUuid: "kitchen", volume: 30 }),
          ],
        }),
      ],
    });
  });
});

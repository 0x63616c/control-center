export const SceneActionKind = {
  Lighting: "lighting",
  Music: "music",
} as const;
export type SceneActionKind = (typeof SceneActionKind)[keyof typeof SceneActionKind];

export const PlaylistSelection = {
  Fixed: "fixed",
  Prompt: "prompt",
  Random: "random",
} as const;
export type PlaylistSelection = (typeof PlaylistSelection)[keyof typeof PlaylistSelection];

type LightTarget =
  | { readonly kind: "all" }
  | { readonly kind: "entity"; readonly entityId: string };

type SceneColor =
  | { readonly kind: "rgb"; readonly red: number; readonly green: number; readonly blue: number }
  | { readonly kind: "temperature"; readonly kelvin: number }
  | { readonly kind: "none" };

export interface LightingAction {
  readonly kind: "lighting";
  readonly targets: LightTarget[];
  readonly power: boolean;
  readonly brightness: number;
  readonly color: SceneColor;
  readonly transitionSeconds: number;
}

export interface ScenePlaylist {
  readonly name: string;
  readonly uri: string;
}

type SpeakerTarget =
  | { readonly kind: "all"; readonly volume: number }
  | {
      readonly kind: "speaker";
      readonly speakerUuid: string;
      readonly label: string;
      readonly volume: number;
    };

export interface MusicAction {
  readonly kind: "music";
  readonly source: {
    readonly kind: "spotify";
    readonly playlists: ScenePlaylist[];
    readonly selection: PlaylistSelection;
    readonly shuffleTracks: boolean;
  };
  readonly outputs: SpeakerTarget[];
}

export type SceneAction = LightingAction | MusicAction;

export interface SceneDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly icon: string;
  readonly actions: SceneAction[];
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

export interface SceneSpeaker {
  readonly uuid: string;
  readonly name: string;
  readonly deviceIp: string;
  readonly volume: number;
}

export interface LaunchOverrides {
  readonly playlistUri?: string;
  readonly speakers?: {
    readonly speakerUuid: string;
    readonly enabled: boolean;
    readonly volume: number;
  }[];
}

export interface ResolvedSceneExecution {
  readonly sceneName: string;
  readonly playlist: ScenePlaylist | null;
  readonly speakers: SceneSpeaker[];
  readonly lighting: LightingAction | null;
  readonly spotifyDeviceId: string | null;
}

export const SceneRunStatus = {
  Starting: "starting",
  Running: "running",
  Failed: "failed",
  Stopped: "stopped",
} as const;
export type SceneRunStatus = (typeof SceneRunStatus)[keyof typeof SceneRunStatus];

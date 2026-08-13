import { genId } from "@www/platform";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  CheckboxRow,
  ConfirmDialog,
  Pill,
  PillTone,
  Slider,
  Switch,
  TextInput,
  Tile,
  TileHeader,
  TileStatus,
} from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useTileQuery } from "@/lib/useTileQuery";
import type { SceneInput } from "./contract";
import type {
  LaunchOverrides,
  LightingAction,
  MusicAction,
  SceneAction,
  SceneDefinition,
  SceneSpeaker,
} from "./model";
import { PlaylistSelection, SceneActionKind } from "./model";

export interface SceneResourceView {
  lights: readonly {
    entityId: string;
    label: string;
    room: string;
    capabilities: readonly string[];
  }[];
  speakers:
    | { status: "ready"; items: readonly SceneSpeaker[] }
    | { status: "unavailable"; message: string };
  spotify:
    | {
        status: "ready";
        playlists: readonly { id: string; name: string; uri: string; imageUrl: string | null }[];
      }
    | { status: "unavailable"; message: string };
}

type Screen =
  | { kind: "picker" }
  | { kind: "launch"; sceneId: string }
  | { kind: "editor"; sceneId: string | null }
  | { kind: "running" };

function findAction(
  scene: Pick<SceneDefinition, "actions">,
  kind: typeof SceneActionKind.Lighting,
): LightingAction | null;
function findAction(
  scene: Pick<SceneDefinition, "actions">,
  kind: typeof SceneActionKind.Music,
): MusicAction | null;
function findAction(
  scene: Pick<SceneDefinition, "actions">,
  kind: SceneAction["kind"],
): SceneAction | null {
  return scene.actions.find((action) => action.kind === kind) ?? null;
}

function sceneSummaryParts(
  scene: Pick<SceneDefinition, "actions">,
  lightingSummary: (lighting: LightingAction) => string,
): string[] {
  const lighting = findAction(scene, SceneActionKind.Lighting);
  const music = findAction(scene, SceneActionKind.Music);
  const parts: string[] = [];
  if (lighting) {
    parts.push(lightingSummary(lighting));
  }
  if (music) {
    parts.push(
      `${music.source.playlists.length} playlist${music.source.playlists.length === 1 ? "" : "s"}`,
    );
  }
  return parts;
}

function sceneSummary(scene: Pick<SceneDefinition, "actions">): string {
  return sceneSummaryParts(scene, (lighting) => {
    const color =
      lighting.color.kind === "rgb"
        ? `rgb(${lighting.color.red}, ${lighting.color.green}, ${lighting.color.blue})`
        : lighting.color.kind === "temperature"
          ? `${lighting.color.kelvin}K`
          : "no color change";
    return lighting.power ? `${color} · ${lighting.brightness}%` : "lights off";
  }).join(" · ");
}

function tileSceneSummary(scene: Pick<SceneDefinition, "actions">): string {
  return sceneSummaryParts(scene, (lighting) =>
    lighting.power ? `Lights ${lighting.brightness}%` : "Lights off",
  ).join(" · ");
}

type SceneTileRowProps =
  | { kind: "running"; name: string }
  | { kind: "saved"; name: string; summary: string };

function SceneTileRow(props: SceneTileRowProps) {
  const running = props.kind === "running";
  return (
    <div style={running ? runningSceneTileRowStyle : sceneTileRowStyle}>
      <span style={running ? runningSceneTileMarkerStyle : sceneTileMarkerStyle} />
      <div style={{ minWidth: 0 }}>
        <strong style={sceneTileNameStyle}>{props.name}</strong>
        <span style={sceneTileSummaryStyle}>{running ? "Playing now" : props.summary}</span>
      </div>
    </div>
  );
}

export function ScenesTileView({
  status,
  scenes,
  runningScene,
}: {
  status: TileStatus;
  scenes?: readonly Pick<SceneDefinition, "id" | "name" | "icon" | "actions">[];
  runningScene?: { id: string | null; name: string } | null;
}) {
  const visibleScenes = runningScene
    ? scenes?.filter((scene) => scene.id !== runningScene.id).slice(0, 2)
    : scenes?.slice(0, 3);

  return (
    <Tile padding={18}>
      <TileHeader
        icon="sparkles"
        title="Scenes"
        right={
          runningScene ? (
            <Pill tone={PillTone.On}>Live</Pill>
          ) : scenes ? (
            <span style={sceneCountStyle}>{scenes.length} saved</span>
          ) : undefined
        }
      />
      {status !== TileStatus.Populated || !scenes ? (
        <div style={{ flex: 1, borderRadius: 14, background: "var(--nest)" }} />
      ) : scenes.length === 0 ? (
        <div style={emptyScenesStyle}>Create a scene to set the room in one tap.</div>
      ) : (
        <div style={sceneTileListStyle}>
          {runningScene && <SceneTileRow kind="running" name={runningScene.name} />}
          {visibleScenes?.map((scene) => (
            <SceneTileRow
              key={scene.id}
              kind="saved"
              name={scene.name}
              summary={tileSceneSummary(scene)}
            />
          ))}
        </div>
      )}
    </Tile>
  );
}

export function ScenesTile() {
  const list = useTileQuery(trpc.scenes.list.useQuery());
  const current = trpc.scenes.current.useQuery(undefined, { refetchInterval: 5_000 });
  return (
    <ScenesTileView
      status={list.status}
      scenes={list.data}
      runningScene={
        current.data?.run
          ? { id: current.data.run.sceneId, name: current.data.run.sceneName }
          : null
      }
    />
  );
}

export function ScenePickerView({
  scenes,
  runningName,
  onLaunch,
  onEdit,
  onCreate,
  onRunning,
}: {
  scenes: readonly SceneDefinition[];
  runningName?: string | null;
  onLaunch: (id: string) => void;
  onEdit: (id: string) => void;
  onCreate: () => void;
  onRunning: () => void;
}) {
  return (
    <section style={pageStyle}>
      <div style={headingRowStyle}>
        <div>
          <h2 style={headingStyle}>Which scene?</h2>
          <p style={ledeStyle}>Review the defaults, make one-time changes, then start it.</p>
        </div>
        <Button onClick={onCreate} style={{ width: 160 }}>
          + Create scene
        </Button>
      </div>
      {runningName && (
        <button type="button" onClick={onRunning} style={runningBannerStyle}>
          <span>●</span>
          <strong>{runningName} is running</strong>
          <span style={{ marginLeft: "auto" }}>View status →</span>
        </button>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 18 }}>
        {scenes.map((scene) => (
          <article key={scene.id} style={{ ...cardStyle, minHeight: 190, padding: 22 }}>
            <div style={{ fontSize: 34 }}>{scene.icon}</div>
            <h3 style={{ margin: "4px 0 0", fontSize: 24 }}>{scene.name}</h3>
            <p style={{ ...ledeStyle, minHeight: 38 }}>
              {scene.description ?? sceneSummary(scene)}
            </p>
            <div style={{ color: "var(--ink-2)", fontSize: 13 }}>{sceneSummary(scene)}</div>
            <div style={{ display: "flex", gap: 10, marginTop: "auto" }}>
              <Button onClick={() => onLaunch(scene.id)} style={{ flex: 1 }}>
                Review & start
              </Button>
              <Button variant="ghost" onClick={() => onEdit(scene.id)} style={{ width: 92 }}>
                Edit
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

interface SpeakerOverrideState {
  speakerUuid: string;
  name: string;
  enabled: boolean;
  volume: number;
}

function defaultSpeakerOverrides(scene: SceneDefinition, speakers: readonly SceneSpeaker[]) {
  const music = findAction(scene, SceneActionKind.Music);
  if (!music) return [];
  const all = music.outputs.find((output) => output.kind === "all");
  return speakers.map((speaker): SpeakerOverrideState => {
    const explicit = music.outputs.find(
      (output) => output.kind === "speaker" && output.speakerUuid === speaker.uuid,
    );
    return {
      speakerUuid: speaker.uuid,
      name: speaker.name,
      enabled: Boolean(all || explicit),
      volume: explicit?.volume ?? all?.volume ?? speaker.volume,
    };
  });
}

export function SceneLaunchView({
  scene,
  resources,
  launching,
  onBack,
  onEdit,
  onLaunch,
  onSaveDefaults,
}: {
  scene: SceneDefinition;
  resources: SceneResourceView;
  launching?: boolean;
  onBack: () => void;
  onEdit: () => void;
  onLaunch: (overrides: LaunchOverrides) => void;
  onSaveDefaults: (scene: SceneInput) => void;
}) {
  const music = findAction(scene, SceneActionKind.Music);
  const lighting = findAction(scene, SceneActionKind.Lighting);
  const availableSpeakers = useMemo(
    () => (resources.speakers.status === "ready" ? resources.speakers.items : []),
    [resources.speakers],
  );
  const [playlistUri, setPlaylistUri] = useState(
    music?.source.selection === PlaylistSelection.Random ||
      (music?.source.selection === PlaylistSelection.Prompt && music.source.playlists.length > 1)
      ? ""
      : (music?.source.playlists[0]?.uri ?? ""),
  );
  const [speakers, setSpeakers] = useState<SpeakerOverrideState[]>(() =>
    defaultSpeakerOverrides(scene, availableSpeakers),
  );
  useEffect(() => {
    setSpeakers(defaultSpeakerOverrides(scene, availableSpeakers));
  }, [scene, availableSpeakers]);

  const overrides: LaunchOverrides = {
    ...(playlistUri ? { playlistUri } : {}),
    ...(music
      ? {
          speakers: speakers.map(({ speakerUuid, enabled, volume }) => ({
            speakerUuid,
            enabled,
            volume,
          })),
        }
      : {}),
  };
  return (
    <section style={pageStyle}>
      <div style={headingRowStyle}>
        <div>
          <button type="button" onClick={onBack} style={linkButtonStyle}>
            ← All scenes
          </button>
          <h2 style={headingStyle}>
            {scene.icon} {scene.name}
          </h2>
          <p style={ledeStyle}>{scene.description}</p>
        </div>
        <Button variant="ghost" onClick={onEdit} style={{ width: 110 }}>
          Edit scene
        </Button>
      </div>

      {lighting && (
        <section style={sectionStyle}>
          <h3 style={sectionHeadingStyle}>Lighting</h3>
          <div style={summaryGridStyle}>
            <Summary label="Power" value={lighting.power ? "On" : "Off"} />
            <Summary label="Brightness" value={`${lighting.brightness}%`} />
            <Summary
              label="Color"
              value={
                lighting.color.kind === "rgb"
                  ? `RGB ${lighting.color.red}, ${lighting.color.green}, ${lighting.color.blue}`
                  : lighting.color.kind === "temperature"
                    ? `${lighting.color.kelvin}K`
                    : "Keep current"
              }
            />
            <Summary label="Transition" value={`${lighting.transitionSeconds}s`} />
          </div>
        </section>
      )}

      {music && (
        <section style={sectionStyle}>
          <h3 style={sectionHeadingStyle}>Playlist</h3>
          <select
            aria-label="Playlist"
            value={playlistUri}
            onChange={(event) => setPlaylistUri(event.target.value)}
            style={inputStyle}
          >
            {music.source.selection === PlaylistSelection.Random && (
              <option value="">Choose randomly</option>
            )}
            {music.source.selection === PlaylistSelection.Prompt &&
              music.source.playlists.length > 1 && <option value="">Choose a playlist…</option>}
            {music.source.playlists.map((playlist) => (
              <option key={playlist.uri} value={playlist.uri}>
                {playlist.name}
              </option>
            ))}
          </select>
          <span style={mutedStyle}>
            Track shuffle {music.source.shuffleTracks ? "on" : "off"} · {music.source.selection}{" "}
            mode
          </span>
        </section>
      )}

      {music && (
        <section style={sectionStyle}>
          <h3 style={sectionHeadingStyle}>Speakers</h3>
          {resources.speakers.status === "unavailable" ? (
            <Alert title="Sonos unavailable">{resources.speakers.message}</Alert>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {speakers.map((speaker, index) => (
                <div key={speaker.speakerUuid} style={speakerRowStyle}>
                  <Switch
                    label={`Use ${speaker.name}`}
                    checked={speaker.enabled}
                    onChange={(enabled) =>
                      setSpeakers((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, enabled } : item,
                        ),
                      )
                    }
                  />
                  <strong>{speaker.name}</strong>
                  <div style={{ flex: 1 }}>
                    <Slider
                      label={`${speaker.name} volume`}
                      min={0}
                      max={90}
                      value={speaker.volume}
                      showHeader={false}
                      onChange={(volume) =>
                        setSpeakers((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, volume } : item,
                          ),
                        )
                      }
                    />
                  </div>
                  <span style={{ width: 34, textAlign: "right" }}>{speaker.volume}%</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
        <Button
          variant="ghost"
          onClick={() => onSaveDefaults(withLaunchDefaults(scene, playlistUri, speakers))}
          style={{ width: 220 }}
        >
          Save as scene defaults
        </Button>
        <Button
          loading={launching}
          onClick={() => onLaunch(overrides)}
          disabled={Boolean(
            music &&
              (!speakers.some((speaker) => speaker.enabled) ||
                (!playlistUri && music.source.selection !== PlaylistSelection.Random)),
          )}
          style={{ width: 210 }}
        >
          Start {scene.name}
        </Button>
      </div>
    </section>
  );
}

function withLaunchDefaults(
  scene: SceneDefinition,
  playlistUri: string,
  speakers: readonly SpeakerOverrideState[],
): SceneInput {
  return {
    name: scene.name,
    description: scene.description,
    icon: scene.icon,
    actions: scene.actions.map((action) => {
      if (action.kind !== SceneActionKind.Music) {
        return { ...action, targets: [...action.targets] };
      }
      const selected = playlistUri
        ? action.source.playlists.find((playlist) => playlist.uri === playlistUri)
        : null;
      return {
        ...action,
        source: {
          ...action.source,
          playlists: selected
            ? [selected, ...action.source.playlists.filter((item) => item.uri !== selected.uri)]
            : [...action.source.playlists],
          ...(selected
            ? {
                selection: PlaylistSelection.Fixed,
              }
            : {}),
        },
        outputs: speakers
          .filter((speaker) => speaker.enabled)
          .map((speaker): MusicAction["outputs"][number] => ({
            kind: "speaker",
            speakerUuid: speaker.speakerUuid,
            label: speaker.name,
            volume: speaker.volume,
          })),
      };
    }),
  };
}

interface EditorState {
  name: string;
  description: string;
  icon: string;
  lightingEnabled: boolean;
  lightTargets: string[];
  power: boolean;
  brightness: number;
  colorKind: "rgb" | "temperature" | "none";
  red: number;
  green: number;
  blue: number;
  kelvin: number;
  transitionSeconds: number;
  musicEnabled: boolean;
  playlists: Array<{ key: string; name: string; uri: string }>;
  selection: PlaylistSelection;
  shuffleTracks: boolean;
  allSpeakers: boolean;
  allSpeakerVolume: number;
  speakers: Array<{ speakerUuid: string; label: string; enabled: boolean; volume: number }>;
}

function editorState(scene: SceneDefinition | null, resources: SceneResourceView): EditorState {
  const lighting = scene ? findAction(scene, SceneActionKind.Lighting) : null;
  const music = scene ? findAction(scene, SceneActionKind.Music) : null;
  const rgb = lighting?.color.kind === "rgb" ? lighting.color : null;
  const temperature = lighting?.color.kind === "temperature" ? lighting.color : null;
  const resourceSpeakers = resources.speakers.status === "ready" ? resources.speakers.items : [];
  const all = music?.outputs.find((output) => output.kind === "all");
  return {
    name: scene?.name ?? "",
    description: scene?.description ?? "",
    icon: scene?.icon ?? "✨",
    lightingEnabled: Boolean(lighting) || !scene,
    lightTargets:
      lighting?.targets.some((target) => target.kind === "all") || !lighting
        ? ["all"]
        : lighting.targets.flatMap((target) => (target.kind === "entity" ? [target.entityId] : [])),
    power: lighting?.power ?? true,
    brightness: lighting?.brightness ?? 50,
    colorKind: lighting?.color.kind ?? "rgb",
    red: rgb?.red ?? 255,
    green: rgb?.green ?? 0,
    blue: rgb?.blue ?? 0,
    kelvin: temperature?.kelvin ?? 4000,
    transitionSeconds: lighting?.transitionSeconds ?? 2,
    musicEnabled: Boolean(music) || !scene,
    playlists: music?.source.playlists.map((playlist) => ({
      key: genId("draft_playlist"),
      ...playlist,
    })) ?? [{ key: genId("draft_playlist"), name: "", uri: "" }],
    selection: music?.source.selection ?? PlaylistSelection.Fixed,
    shuffleTracks: music?.source.shuffleTracks ?? true,
    allSpeakers: Boolean(all) || !music,
    allSpeakerVolume: all?.volume ?? 25,
    speakers: resourceSpeakers.map((speaker) => {
      const target = music?.outputs.find(
        (output) => output.kind === "speaker" && output.speakerUuid === speaker.uuid,
      );
      return {
        speakerUuid: speaker.uuid,
        label: speaker.name,
        enabled: Boolean(target),
        volume: target?.volume ?? speaker.volume,
      };
    }),
  };
}

function inputFromEditor(state: EditorState): SceneInput {
  const actions: SceneInput["actions"] = [];
  if (state.lightingEnabled) {
    const color: LightingAction["color"] =
      state.colorKind === "rgb"
        ? { kind: "rgb", red: state.red, green: state.green, blue: state.blue }
        : state.colorKind === "temperature"
          ? { kind: "temperature", kelvin: state.kelvin }
          : { kind: "none" };
    actions.push({
      kind: SceneActionKind.Lighting,
      targets: state.lightTargets.includes("all")
        ? [{ kind: "all" }]
        : state.lightTargets.map((entityId) => ({ kind: "entity", entityId })),
      power: state.power,
      brightness: state.brightness,
      color,
      transitionSeconds: state.transitionSeconds,
    });
  }
  if (state.musicEnabled) {
    actions.push({
      kind: SceneActionKind.Music,
      source: {
        kind: "spotify",
        playlists: state.playlists.map(({ name, uri }) => ({ name, uri })),
        selection: state.selection,
        shuffleTracks: state.shuffleTracks,
      },
      outputs: state.allSpeakers
        ? [{ kind: "all", volume: state.allSpeakerVolume }]
        : state.speakers
            .filter((speaker) => speaker.enabled)
            .map((speaker) => ({
              kind: "speaker",
              speakerUuid: speaker.speakerUuid,
              label: speaker.label,
              volume: speaker.volume,
            })),
    } satisfies MusicAction);
  }
  return {
    name: state.name,
    description: state.description.trim() || null,
    icon: state.icon,
    actions,
  };
}

export function SceneEditorView({
  scene,
  resources,
  saving,
  onCancel,
  onSave,
  onDelete,
}: {
  scene: SceneDefinition | null;
  resources: SceneResourceView;
  saving?: boolean;
  onCancel: () => void;
  onSave: (input: SceneInput) => void;
  onDelete?: () => void;
}) {
  const [state, setState] = useState(() => editorState(scene, resources));
  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    setState((current) => ({ ...current, [key]: value }));
  return (
    <section style={pageStyle}>
      <div style={headingRowStyle}>
        <div>
          <button type="button" onClick={onCancel} style={linkButtonStyle}>
            ← Cancel
          </button>
          <h2 style={headingStyle}>{scene ? `Edit ${scene.name}` : "Create scene"}</h2>
        </div>
        {onDelete && (
          <Button variant="ghost" onClick={onDelete} style={{ width: 130, color: "var(--danger)" }}>
            Delete scene
          </Button>
        )}
      </div>

      <section style={sectionStyle}>
        <h3 style={sectionHeadingStyle}>General</h3>
        <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 10 }}>
          <TextInput label="Icon" value={state.icon} onChange={(value) => set("icon", value)} />
          <TextInput
            label="Scene name"
            placeholder="Scene name"
            value={state.name}
            onChange={(value) => set("name", value)}
          />
        </div>
        <TextInput
          label="Description"
          placeholder="What should this scene feel like?"
          value={state.description}
          onChange={(value) => set("description", value)}
        />
      </section>

      <section style={sectionStyle}>
        <ToggleLabel
          label="Lighting"
          checked={state.lightingEnabled}
          onChange={(checked) => set("lightingEnabled", checked)}
        />
        {state.lightingEnabled && (
          <>
            <label style={fieldLabelStyle}>
              Targets
              <select
                value={state.lightTargets.includes("all") ? "all" : "selected"}
                onChange={(event) =>
                  set("lightTargets", event.target.value === "all" ? ["all"] : [])
                }
                style={inputStyle}
              >
                <option value="all">All configured lights</option>
                <option value="selected">Selected lights</option>
              </select>
            </label>
            {!state.lightTargets.includes("all") && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                {resources.lights.map((light) => (
                  <div key={light.entityId} style={checkRowStyle}>
                    <CheckboxRow
                      id={`scene-light-${light.entityId.replaceAll(".", "-")}`}
                      checked={state.lightTargets.includes(light.entityId)}
                      onChange={(checked) =>
                        set(
                          "lightTargets",
                          checked
                            ? [...state.lightTargets, light.entityId]
                            : state.lightTargets.filter((id) => id !== light.entityId),
                        )
                      }
                    >
                      {light.room} · {light.label}
                    </CheckboxRow>
                  </div>
                ))}
              </div>
            )}
            <ToggleLabel
              label="Power on"
              checked={state.power}
              onChange={(checked) => set("power", checked)}
            />
            <RangeField
              label="Brightness"
              value={state.brightness}
              min={0}
              max={100}
              suffix="%"
              onChange={(value) => set("brightness", value)}
            />
            <label style={fieldLabelStyle}>
              Color
              <select
                value={state.colorKind}
                onChange={(event) => set("colorKind", parseColorKind(event.target.value))}
                style={inputStyle}
              >
                <option value="rgb">RGB color</option>
                <option value="temperature">White temperature</option>
                <option value="none">Keep current color</option>
              </select>
            </label>
            {state.colorKind === "rgb" && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                {(["red", "green", "blue"] as const).map((channel) => (
                  <label key={channel} style={fieldLabelStyle}>
                    {channel}
                    <input
                      type="number"
                      min="0"
                      max="255"
                      value={state[channel]}
                      onChange={(event) => set(channel, Number(event.target.value))}
                      style={inputStyle}
                    />
                  </label>
                ))}
              </div>
            )}
            {state.colorKind === "temperature" && (
              <RangeField
                label="Color temperature"
                value={state.kelvin}
                min={1500}
                max={9000}
                suffix="K"
                onChange={(value) => set("kelvin", value)}
              />
            )}
            <RangeField
              label="Transition"
              value={state.transitionSeconds}
              min={0}
              max={30}
              suffix="s"
              onChange={(value) => set("transitionSeconds", value)}
            />
          </>
        )}
      </section>

      <section style={sectionStyle}>
        <ToggleLabel
          label="Music"
          checked={state.musicEnabled}
          onChange={(checked) => set("musicEnabled", checked)}
        />
        {state.musicEnabled && (
          <>
            <label style={fieldLabelStyle}>
              Playlist behavior
              <select
                value={state.selection}
                onChange={(event) => set("selection", parsePlaylistSelection(event.target.value))}
                style={inputStyle}
              >
                <option value="fixed">Always use the first playlist</option>
                <option value="prompt">Ask when launched</option>
                <option value="random">Choose randomly</option>
              </select>
            </label>
            {state.playlists.map((playlist, index) => (
              <div
                key={playlist.key}
                style={{ display: "grid", gridTemplateColumns: "1fr 2fr auto", gap: 8 }}
              >
                <TextInput
                  label={`Playlist ${index + 1} name`}
                  placeholder="Playlist name"
                  value={playlist.name}
                  onChange={(name) =>
                    set(
                      "playlists",
                      state.playlists.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, name } : item,
                      ),
                    )
                  }
                />
                <TextInput
                  label={`Playlist ${index + 1} URI`}
                  placeholder="spotify:playlist:…"
                  value={playlist.uri}
                  onChange={(uri) =>
                    set(
                      "playlists",
                      state.playlists.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, uri: normalizeSpotifyUri(uri) } : item,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  onClick={() =>
                    set(
                      "playlists",
                      state.playlists.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                  style={{ width: 84 }}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              onClick={() =>
                set("playlists", [
                  ...state.playlists,
                  { key: genId("draft_playlist"), name: "", uri: "" },
                ])
              }
              style={{ width: 150 }}
            >
              + Add playlist
            </Button>
            <ToggleLabel
              label="Shuffle tracks"
              checked={state.shuffleTracks}
              onChange={(checked) => set("shuffleTracks", checked)}
            />
          </>
        )}
      </section>

      {state.musicEnabled && (
        <section style={sectionStyle}>
          <h3 style={sectionHeadingStyle}>Speakers</h3>
          <ToggleLabel
            label="Use every available speaker"
            checked={state.allSpeakers}
            onChange={(checked) => set("allSpeakers", checked)}
          />
          {state.allSpeakers ? (
            <RangeField
              label="Default volume"
              value={state.allSpeakerVolume}
              min={0}
              max={90}
              suffix="%"
              onChange={(value) => set("allSpeakerVolume", value)}
            />
          ) : resources.speakers.status === "unavailable" ? (
            <Alert title="Sonos unavailable">{resources.speakers.message}</Alert>
          ) : (
            state.speakers.map((speaker, index) => (
              <div key={speaker.speakerUuid} style={speakerRowStyle}>
                <Switch
                  label={`Use ${speaker.label}`}
                  checked={speaker.enabled}
                  onChange={(enabled) =>
                    set(
                      "speakers",
                      state.speakers.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, enabled } : item,
                      ),
                    )
                  }
                />
                <strong>{speaker.label}</strong>
                <div style={{ flex: 1 }}>
                  <Slider
                    label={`${speaker.label} volume`}
                    min={0}
                    max={90}
                    value={speaker.volume}
                    showHeader={false}
                    onChange={(volume) =>
                      set(
                        "speakers",
                        state.speakers.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, volume } : item,
                        ),
                      )
                    }
                  />
                </div>
                <span>{speaker.volume}%</span>
              </div>
            ))
          )}
        </section>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button
          loading={saving}
          disabled={!state.name.trim() || (!state.lightingEnabled && !state.musicEnabled)}
          onClick={() => onSave(inputFromEditor(state))}
          style={{ width: 180 }}
        >
          Save scene
        </Button>
      </div>
    </section>
  );
}

function normalizeSpotifyUri(value: string): string {
  const match = value.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/);
  return match?.[1] ? `spotify:playlist:${match[1]}` : value;
}

function parseColorKind(value: string): EditorState["colorKind"] {
  if (value === "rgb" || value === "temperature" || value === "none") return value;
  throw new Error(`Unknown scene color kind: ${value}`);
}

function parsePlaylistSelection(value: string): PlaylistSelection {
  if (
    value === PlaylistSelection.Fixed ||
    value === PlaylistSelection.Prompt ||
    value === PlaylistSelection.Random
  ) {
    return value;
  }
  throw new Error(`Unknown playlist selection: ${value}`);
}

export function RunningSceneView({
  run,
  playback,
  stopping,
  onBack,
  onStop,
}: {
  run: {
    id: string;
    sceneName: string;
    startedAt: Date | string;
    resolved: import("./model").ResolvedSceneExecution | null;
  };
  playback:
    | { status: "idle" }
    | { status: "unavailable"; message: string }
    | {
        status: "ready";
        value: {
          trackTitle: string;
          artist: string;
          progressMs: number;
          durationMs: number;
          isPlaying: boolean;
        };
      };
  stopping?: boolean;
  onBack: () => void;
  onStop: () => void;
}) {
  return (
    <section style={pageStyle}>
      <button type="button" onClick={onBack} style={linkButtonStyle}>
        ← All scenes
      </button>
      <div style={{ ...sectionStyle, textAlign: "center", padding: 36 }}>
        <div style={{ color: "var(--acc)", fontSize: 22 }}>● Running</div>
        <h2 style={{ ...headingStyle, fontSize: 36 }}>{run.sceneName}</h2>
        <p style={ledeStyle}>Started {new Date(run.startedAt).toLocaleTimeString()}</p>
      </div>
      <div style={summaryGridStyle}>
        <Summary
          label="Lights"
          value={
            run.resolved?.lighting
              ? `${run.resolved.lighting.brightness}% · ${run.resolved.lighting.power ? "on" : "off"}`
              : "No change"
          }
        />
        <Summary label="Playlist" value={run.resolved?.playlist?.name ?? "None"} />
        <Summary
          label="Speakers"
          value={run.resolved ? String(run.resolved.speakers.length) : "0"}
        />
        <Summary
          label="Playback"
          value={
            playback.status === "ready"
              ? `${playback.value.trackTitle} — ${playback.value.artist}`
              : playback.status === "unavailable"
                ? "Unavailable"
                : "Idle"
          }
        />
      </div>
      {run.resolved && (
        <section style={sectionStyle}>
          {run.resolved.speakers.map((speaker) => (
            <div key={speaker.uuid} style={speakerRowStyle}>
              <strong>{speaker.name}</strong>
              <span style={{ marginLeft: "auto" }}>{speaker.volume}%</span>
            </div>
          ))}
        </section>
      )}
      <Button
        variant="ghost"
        loading={stopping}
        onClick={onStop}
        style={{ width: 200, alignSelf: "center", color: "var(--danger)" }}
      >
        Stop scene
      </Button>
    </section>
  );
}

export function ScenesPage() {
  const [screen, setScreen] = useState<Screen>({ kind: "picker" });
  const [deleteSceneId, setDeleteSceneId] = useState<string | null>(null);
  const list = trpc.scenes.list.useQuery();
  const resources = trpc.scenes.resources.useQuery();
  const current = trpc.scenes.current.useQuery(undefined, { refetchInterval: 4_000 });
  const utils = trpc.useUtils();
  const create = trpc.scenes.create.useMutation({
    onSuccess: async () => {
      await utils.scenes.list.invalidate();
      setScreen({ kind: "picker" });
    },
  });
  const update = trpc.scenes.update.useMutation({
    onSuccess: async () => {
      await utils.scenes.list.invalidate();
      setScreen({ kind: "picker" });
    },
  });
  const remove = trpc.scenes.delete.useMutation({
    onSuccess: async () => {
      await utils.scenes.list.invalidate();
      setScreen({ kind: "picker" });
    },
  });
  const launch = trpc.scenes.launch.useMutation({
    onSuccess: async () => {
      await utils.scenes.current.invalidate();
      setScreen({ kind: "running" });
    },
  });
  const stop = trpc.scenes.stop.useMutation({
    onSuccess: async () => {
      await utils.scenes.current.invalidate();
      setScreen({ kind: "picker" });
    },
  });

  const queryError = list.error ?? resources.error ?? current.error;
  if (queryError) {
    return (
      <div style={pageStyle}>
        <Alert title="Scenes could not be loaded">{queryError.message}</Alert>
        <Button
          variant="ghost"
          onClick={() => {
            void list.refetch();
            void resources.refetch();
            void current.refetch();
          }}
          style={{ width: 120 }}
        >
          Try again
        </Button>
      </div>
    );
  }
  const mutationError =
    create.error ?? update.error ?? remove.error ?? launch.error ?? stop.error ?? null;
  const withError = (content: ReactNode) => (
    <>
      {mutationError && (
        <div style={{ maxWidth: 1040, margin: "0 auto 12px" }}>
          <Alert>{mutationError.message}</Alert>
        </div>
      )}
      {content}
      <ConfirmDialog
        open={deleteSceneId !== null}
        title="Delete scene?"
        message="This removes the saved scene. Existing run history is retained."
        confirmLabel="Delete scene"
        tone="danger"
        onClose={() => setDeleteSceneId(null)}
        onConfirm={() => {
          if (deleteSceneId) remove.mutate({ id: deleteSceneId });
          setDeleteSceneId(null);
        }}
      />
    </>
  );

  const scenes = list.data ?? [];
  const resourceData = resources.data;
  const selectedScene =
    screen.kind === "launch" || (screen.kind === "editor" && screen.sceneId)
      ? (scenes.find((scene) => scene.id === screen.sceneId) ?? null)
      : null;
  if (!list.data || !resourceData || !current.data)
    return <div style={pageStyle}>Loading scenes…</div>;
  if (screen.kind === "running" && current.data.run) {
    return withError(
      <RunningSceneView
        run={current.data.run}
        playback={current.data.playback}
        stopping={stop.isPending}
        onBack={() => setScreen({ kind: "picker" })}
        onStop={() => stop.mutate({ runId: current.data.run?.id ?? "" })}
      />,
    );
  }
  if (screen.kind === "launch" && selectedScene) {
    return withError(
      <SceneLaunchView
        scene={selectedScene}
        resources={resourceData}
        launching={launch.isPending}
        onBack={() => setScreen({ kind: "picker" })}
        onEdit={() => setScreen({ kind: "editor", sceneId: selectedScene.id })}
        onLaunch={(overrides) =>
          launch.mutate({
            id: selectedScene.id,
            overrides: {
              ...(overrides.playlistUri ? { playlistUri: overrides.playlistUri } : {}),
              ...(overrides.speakers
                ? { speakers: overrides.speakers.map((speaker) => ({ ...speaker })) }
                : {}),
            },
          })
        }
        onSaveDefaults={(input) => update.mutate({ id: selectedScene.id, ...input })}
      />,
    );
  }
  if (screen.kind === "editor") {
    return withError(
      <SceneEditorView
        key={screen.sceneId ?? "new"}
        scene={selectedScene}
        resources={resourceData}
        saving={create.isPending || update.isPending}
        onCancel={() => setScreen({ kind: "picker" })}
        onSave={(input) =>
          screen.sceneId ? update.mutate({ id: screen.sceneId, ...input }) : create.mutate(input)
        }
        onDelete={screen.sceneId ? () => setDeleteSceneId(screen.sceneId) : undefined}
      />,
    );
  }
  return withError(
    <ScenePickerView
      scenes={scenes}
      runningName={current.data.run?.sceneName}
      onLaunch={(sceneId) => setScreen({ kind: "launch", sceneId })}
      onEdit={(sceneId) => setScreen({ kind: "editor", sceneId })}
      onCreate={() => setScreen({ kind: "editor", sceneId: null })}
      onRunning={() => setScreen({ kind: "running" })}
    />,
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div style={cardStyle}>
      <span style={mutedStyle}>{label}</span>
      <strong style={{ fontSize: 17 }}>{value}</strong>
    </div>
  );
}
function ToggleLabel({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div style={{ ...speakerRowStyle, fontSize: 16 }}>
      <strong>{label}</strong>
      <span style={{ marginLeft: "auto" }}>
        <Switch label={label} checked={checked} onChange={onChange} />
      </span>
    </div>
  );
}
function RangeField({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <Slider
      label={label}
      min={min}
      max={max}
      value={value}
      format={(next) => `${next}${suffix}`}
      onChange={onChange}
    />
  );
}

const pageStyle = {
  width: "100%",
  boxSizing: "border-box",
  maxWidth: 1040,
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: 18,
} as const;
const headingRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 20,
} as const;
const headingStyle = { margin: "6px 0", fontSize: 30, letterSpacing: "-0.03em" } as const;
const ledeStyle = { margin: 0, color: "var(--ink-2)", lineHeight: 1.45 } as const;
const mutedStyle = { color: "var(--ink-2)", fontSize: 13 } as const;
const sceneCountStyle = { color: "var(--ink-2)", fontSize: 12 } as const;
const sceneTileListStyle = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  overflow: "hidden",
  borderTop: "1px solid var(--hair)",
} as const;
const sceneTileRowStyle = {
  display: "grid",
  gridTemplateColumns: "3px minmax(0, 1fr)",
  alignItems: "center",
  gap: 12,
  flex: 1,
  minHeight: 0,
  padding: "10px 2px",
  borderBottom: "1px solid var(--hair)",
} as const;
const runningSceneTileRowStyle = {
  ...sceneTileRowStyle,
  margin: "6px 0 0",
  padding: "9px 10px",
  border: "1px solid color-mix(in srgb, var(--acc) 38%, var(--hair))",
  borderRadius: 12,
  background: "color-mix(in srgb, var(--acc) 8%, var(--nest))",
} as const;
const sceneTileMarkerStyle = {
  width: 3,
  height: 22,
  borderRadius: 999,
  background: "var(--hair-2)",
} as const;
const runningSceneTileMarkerStyle = {
  ...sceneTileMarkerStyle,
  background: "var(--acc)",
  boxShadow: "0 0 12px color-mix(in srgb, var(--acc) 65%, transparent)",
} as const;
const sceneTileNameStyle = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 15,
  lineHeight: 1.2,
} as const;
const sceneTileSummaryStyle = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--ink-2)",
  fontSize: 12,
  lineHeight: 1.45,
} as const;
const emptyScenesStyle = {
  flex: 1,
  display: "grid",
  placeItems: "center",
  padding: 24,
  textAlign: "center",
  color: "var(--ink-2)",
  fontSize: 14,
  lineHeight: 1.5,
} as const;
const cardStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 18,
  border: "1px solid var(--hair)",
  borderRadius: 16,
  background: "var(--nest)",
} as const;
const sectionStyle = { ...cardStyle, gap: 14 } as const;
const sectionHeadingStyle = { margin: 0, fontSize: 17 } as const;
const summaryGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 10,
} as const;
const speakerRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: 10,
  border: "1px solid var(--hair)",
  borderRadius: 11,
} as const;
const checkRowStyle = { ...speakerRowStyle, fontSize: 13 } as const;
const fieldLabelStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 7,
  color: "var(--ink-2)",
  fontSize: 13,
} as const;
const inputStyle = {
  minHeight: 42,
  borderRadius: 10,
  border: "1px solid var(--hair-2)",
  background: "var(--bg)",
  color: "var(--ink)",
  padding: "0 11px",
  font: "14px var(--ui)",
} as const;
const linkButtonStyle = {
  border: 0,
  background: "transparent",
  color: "var(--ink-2)",
  padding: 0,
  cursor: "pointer",
  font: "600 14px var(--ui)",
} as const;
const runningBannerStyle = {
  ...speakerRowStyle,
  borderColor: "var(--acc)",
  background: "color-mix(in srgb, var(--acc) 10%, var(--nest))",
  color: "var(--ink)",
  cursor: "pointer",
  font: "14px var(--ui)",
} as const;

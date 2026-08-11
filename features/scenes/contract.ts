import { z } from "zod";
import { PlaylistSelection, SceneActionKind } from "./model";

const lightTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("entity"), entityId: z.string().min(1).max(160) }),
]);

const sceneColorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rgb"),
    red: z.number().int().min(0).max(255),
    green: z.number().int().min(0).max(255),
    blue: z.number().int().min(0).max(255),
  }),
  z.object({ kind: z.literal("temperature"), kelvin: z.number().int().min(1500).max(9000) }),
  z.object({ kind: z.literal("none") }),
]);

const lightingActionSchema = z.object({
  kind: z.literal(SceneActionKind.Lighting),
  targets: z.array(lightTargetSchema).min(1).max(64),
  power: z.boolean(),
  brightness: z.number().int().min(0).max(100),
  color: sceneColorSchema,
  transitionSeconds: z.number().min(0).max(300),
});

const scenePlaylistSchema = z.object({
  name: z.string().trim().min(1).max(120),
  uri: z
    .string()
    .trim()
    .regex(/^spotify:playlist:[A-Za-z0-9]+$/, "must be a Spotify playlist URI"),
});

const speakerTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all"), volume: z.number().int().min(0).max(90) }),
  z.object({
    kind: z.literal("speaker"),
    speakerUuid: z.string().min(1).max(160),
    label: z.string().trim().min(1).max(120),
    volume: z.number().int().min(0).max(90),
  }),
]);

const musicActionSchema = z.object({
  kind: z.literal(SceneActionKind.Music),
  source: z.object({
    kind: z.literal("spotify"),
    playlists: z.array(scenePlaylistSchema).min(1).max(40),
    selection: z.enum([
      PlaylistSelection.Fixed,
      PlaylistSelection.Prompt,
      PlaylistSelection.Random,
    ]),
    shuffleTracks: z.boolean(),
  }),
  outputs: z.array(speakerTargetSchema).min(1).max(40),
});

export const sceneActionSchema = z.discriminatedUnion("kind", [
  lightingActionSchema,
  musicActionSchema,
]);

export const sceneInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).nullable(),
  icon: z.string().trim().min(1).max(24),
  actions: z.array(sceneActionSchema).min(1).max(20),
});

export const launchOverridesSchema = z.object({
  playlistUri: z
    .string()
    .regex(/^spotify:playlist:[A-Za-z0-9]+$/)
    .optional(),
  speakers: z
    .array(
      z.object({
        speakerUuid: z.string().min(1).max(160),
        enabled: z.boolean(),
        volume: z.number().int().min(0).max(90),
      }),
    )
    .max(40)
    .optional(),
});

export const resolvedSceneExecutionSchema = z.object({
  sceneName: z.string(),
  playlist: scenePlaylistSchema.nullable(),
  speakers: z.array(
    z.object({
      uuid: z.string(),
      name: z.string(),
      deviceIp: z.string(),
      volume: z.number().int().min(0).max(90),
    }),
  ),
  lighting: lightingActionSchema.nullable(),
  // Kept optional to read historical runs created before the HA audio cutover.
  spotifyDeviceId: z.string().nullable().optional(),
  mediaPlayerEntityId: z.string().nullable().default(null),
});

export const sceneRunStatusSchema = z.enum(["starting", "running", "failed", "stopped"]);

export type SceneInput = z.infer<typeof sceneInputSchema>;

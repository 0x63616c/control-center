/**
 * tRPC `sound` facet (Track C, Wave 6 fold), split out of the shared
 * apps/api/src/trpc/routers/media.ts into features/sound. Procedure names
 * mounted as the `sound` API facet. Sonos control is delegated exclusively to
 * Home Assistant's media-player services.
 */
import { defineApi } from "@app-kit";
import { publicProcedure, router } from "@app-kit/server";
import { z } from "zod";
import { getSoundSystem } from "./sonos-sound-system-service";
import {
  playMediaOnRoom,
  sonosGrabTvToBeam,
  sonosGroupJoin,
  sonosGroupLeave,
  sonosSetLineIn,
  sonosSetMute,
  sonosSetVolume,
  sonosTransport,
} from "./sonos-write-service";
import { spotifyBrowse } from "./spotify-service";

const SoundSystemRoomSchema = z.object({
  name: z.string(),
  uuid: z.string(),
  deviceIp: z.string(),
  coordinatorUuid: z.string(),
  memberUuids: z.array(z.string()),
  isCoordinator: z.boolean(),
  volume: z.number(),
  muted: z.boolean(),
  transportState: z.string(),
  sourceLabel: z.string().nullable(),
  sourceKind: z.enum(["line-in", "tv", "spotify", "airplay", "other", "idle"]),
  trackTitle: z.string().nullable(),
  trackArtist: z.string().nullable(),
  albumArtUri: z.string().nullable(),
  availability: z.enum(["available", "unavailable", "unknown"]),
  groupStatus: z.string(),
});

const SoundSystemSchema = z.object({
  rooms: z.array(SoundSystemRoomSchema),
  diagnostics: z.object({
    controlPlane: z.literal("home-assistant"),
    queriedAt: z.string(),
    message: z.string(),
  }),
});

// Spotify browse schemas (A16).
const SpotifyRecentTrackSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  albumArtUrl: z.string().nullable(),
  uri: z.string(),
});

const SpotifyPlaylistItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  uri: z.string(),
});

const SpotifyBrowseResultSchema = z.object({
  recentlyPlayed: z.array(SpotifyRecentTrackSchema),
  playlists: z.array(SpotifyPlaylistItemSchema),
});

// Spotify is used only to browse a user's library. Playback is sent to HA.
const spotifyRouter = router({
  browse: publicProcedure
    .input(z.object({}).optional())
    .output(SpotifyBrowseResultSchema)
    .query(() => spotifyBrowse()),
});

export const soundRouter = router({
  soundSystem: publicProcedure
    .input(z.object({}).optional())
    .output(SoundSystemSchema)
    .query(() => getSoundSystem()),

  // ── Sonos write mutations (www-51hf.10 / A12) ──────────────────────────────

  // Desired-state write (www-5mek): accepted instantly, the 1s sonos-volume-
  // enforcer worker pushes it to the player. No UPnP call on this path.
  sonosSetVolume: publicProcedure
    .input(z.object({ deviceIp: z.string(), volume: z.number().int().min(0).max(100) }))
    .mutation(({ input }) => sonosSetVolume(input)),

  sonosSetMute: publicProcedure
    .input(z.object({ deviceIp: z.string(), muted: z.boolean() }))
    .mutation(({ input }) => sonosSetMute(input)),

  sonosTransport: publicProcedure
    .input(
      z.object({
        coordinatorIp: z.string(),
        command: z.enum(["play", "pause", "next", "previous"]),
      }),
    )
    .mutation(({ input }) => sonosTransport(input)),

  sonosGroupJoin: publicProcedure
    .input(z.object({ memberIp: z.string(), coordinatorUuid: z.string().min(1) }))
    .mutation(({ input }) => sonosGroupJoin(input)),

  sonosGroupLeave: publicProcedure
    .input(z.object({ memberIp: z.string(), memberUuid: z.string().min(1) }))
    .mutation(({ input }) => sonosGroupLeave(input)),

  sonosSetLineIn: publicProcedure
    .input(z.object({ deviceIp: z.string(), sourceUuid: z.string().min(1) }))
    .mutation(({ input }) => sonosSetLineIn(input)),

  sonosGrabTvToBeam: publicProcedure
    .input(z.object({ beamIp: z.string(), beamUuid: z.string().min(1) }))
    .mutation(({ input }) => sonosGrabTvToBeam(input)),

  playMedia: publicProcedure
    .input(z.object({ entityId: z.string().startsWith("media_player."), uri: z.string().min(1) }))
    .mutation(({ input }) => playMediaOnRoom(input)),

  spotify: spotifyRouter,
});

/**
 * The branded `api` facet. Its single top-level key `sound` is the router
 * namespace the generated app router mounts.
 */
export const api = defineApi(router({ sound: soundRouter }));

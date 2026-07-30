/**
 * tRPC `sound` facet (Track C, Wave 6 fold), split out of the shared
 * apps/api/src/trpc/routers/media.ts into features/sound. Procedure names
 * kept VERBATIM (soundSystem, sonosSetVolume, sonosFavorites, spotify.*, …) ,
 * only the mount key changed from `media` to `sound`.
 */
import { defineApi } from "@app-kit";
import { publicProcedure, router } from "@app-kit/server";
import { z } from "zod";
import { setSpeakerDesiredVolume } from "./enforcer";
import { getSonosFavorites } from "./sonos-favorites-service";
import { getSoundSystem } from "./sonos-sound-system-service";
import {
  sonosGrabTvToBeam,
  sonosGroupJoin,
  sonosGroupLeave,
  sonosSetLineIn,
  sonosSetMute,
  sonosTransport,
} from "./sonos-write-service";
import {
  spotifyBrowse,
  spotifyNext,
  spotifyNowPlaying,
  spotifyPause,
  spotifyPlay,
  spotifyPrevious,
  spotifySeek,
} from "./spotify-service";

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
});

const SoundSystemSchema = z.object({
  rooms: z.array(SoundSystemRoomSchema),
});

const SonosFavoriteSchema = z.object({
  title: z.string(),
  uri: z.string(),
  albumArtUri: z.string().nullable(),
});

// Spotify now-playing output schema (A14). isIdle=true when 204 (nothing playing).
const SpotifyPlayerStateSchema = z.object({
  isIdle: z.boolean(),
  isPlaying: z.boolean(),
  trackTitle: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  albumArtUrl: z.string().nullable(),
  progressMs: z.number().nullable(),
  durationMs: z.number().nullable(),
  deviceName: z.string().nullable(),
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

// Spotify sub-router , nowPlaying query + transport mutations + browse query
// (www-51hf.12 / A14, A15; www-51hf.13 / A16).
const spotifyRouter = router({
  nowPlaying: publicProcedure
    .input(z.object({}).optional())
    .output(SpotifyPlayerStateSchema)
    .query(() => spotifyNowPlaying()),

  browse: publicProcedure
    .input(z.object({}).optional())
    .output(SpotifyBrowseResultSchema)
    .query(() => spotifyBrowse()),

  play: publicProcedure.mutation(() => spotifyPlay()),

  pause: publicProcedure.mutation(() => spotifyPause()),

  next: publicProcedure.mutation(() => spotifyNext()),

  previous: publicProcedure.mutation(() => spotifyPrevious()),

  seek: publicProcedure
    .input(z.object({ positionMs: z.number().int().nonnegative() }))
    .mutation(({ input }) => spotifySeek(input.positionMs)),
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
    .mutation(({ input }) => setSpeakerDesiredVolume(input)),

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

  // ── Sonos favorites query (www-51hf.11 / A13) ──────────────────────────────

  sonosFavorites: publicProcedure
    .input(z.object({}).optional())
    .output(z.array(SonosFavoriteSchema))
    .query(() => getSonosFavorites()),

  // ── Spotify sub-router (www-51hf.12 / A14, A15; www-51hf.13 / A16) ──────────

  spotify: spotifyRouter,
});

/**
 * The branded `api` facet. Its single top-level key `sound` is the router
 * namespace the generated app router mounts.
 */
export const api = defineApi(router({ sound: soundRouter }));

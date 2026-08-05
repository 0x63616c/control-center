/**
 * SpotifyClient , lazily mints and caches a Spotify access token from a
 * refresh token, then provides thin wrappers over the Spotify Web API.
 *
 * Token lifetime: 1 hour. Cache is invalidated 60s before expiry so the next
 * call mints a fresh token before the old one expires in flight.
 *
 * Every method THROWS SpotifyError when credentials are unconfigured, the
 * token refresh fails, or the upstream API returns an error , never returns
 * fabricated data (www-51hf.33, A3, A4).
 */

import { getLogger } from "@www/logger";
import { SpotifyError } from "./errors";
import type {
  SpotifyBrowseResult,
  SpotifyCredentials,
  SpotifyDevice,
  SpotifyNowPlaying,
  SpotifyPlaylistItem,
  SpotifyRecentTrack,
} from "./types";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
// Refresh 60s before the token actually expires so in-flight requests never
// hit a stale token.
const EXPIRY_BUFFER_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export class SpotifyClient {
  private readonly creds: SpotifyCredentials;
  private cache: CachedToken | null = null;

  constructor(creds: SpotifyCredentials) {
    this.creds = creds;
  }

  /**
   * Returns a valid access token, refreshing if the cache is empty or near
   * expiry. THROWS SpotifyError if credentials are unconfigured or the refresh
   * API call fails.
   */
  async getAccessToken(): Promise<string> {
    if (!this.creds.clientId || !this.creds.clientSecret || !this.creds.refreshToken) {
      throw new SpotifyError(
        "Spotify credentials unconfigured: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and SPOTIFY_REFRESH_TOKEN must all be non-empty",
      );
    }

    const now = Date.now();
    if (this.cache && this.cache.expiresAtMs > now) {
      return this.cache.accessToken;
    }

    return this.refreshToken();
  }

  /**
   * GET /v1/me/player , current playback state. Returns null when nothing is
   * playing (204 No Content). THROWS SpotifyError on any error or when the
   * response contains an item but is missing critical fields (A3: never
   * return fabricated empty strings or zero durations).
   */
  async getNowPlaying(): Promise<SpotifyNowPlaying | null> {
    const token = await this.getAccessToken();
    let res: Response;
    try {
      res = await fetch("https://api.spotify.com/v1/me/player", {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new SpotifyError(`getNowPlaying: network error , ${(err as Error).message}`);
    }

    // 204 = nothing playing
    if (res.status === 204) return null;

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new SpotifyError(`getNowPlaying: HTTP ${res.status} , ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const item = data.item as Record<string, unknown> | null;
    if (!item) return null;

    // Validate critical fields , if any are absent we must throw rather than
    // return fabricated empty strings or zero numbers (A3).
    const trackTitle = item.name as string | undefined;
    if (typeof trackTitle !== "string" || !trackTitle) {
      throw new SpotifyError("getNowPlaying: item.name is missing or empty in Spotify response");
    }

    const durationMs = item.duration_ms as number | undefined;
    if (typeof durationMs !== "number") {
      throw new SpotifyError("getNowPlaying: item.duration_ms is missing in Spotify response");
    }

    const album = item.album as Record<string, unknown> | undefined;
    const albumName = album?.name as string | undefined;
    if (typeof albumName !== "string" || !albumName) {
      throw new SpotifyError("getNowPlaying: item.album.name is missing in Spotify response");
    }

    // progress_ms is a top-level field on the player object (not item). null is
    // returned by the API when the player context is missing; undefined means
    // the field was absent entirely , both indicate we cannot report real state.
    const progressMs = data.progress_ms as number | null | undefined;
    if (progressMs === null || progressMs === undefined) {
      throw new SpotifyError("getNowPlaying: progress_ms is missing in Spotify response");
    }

    const artists = (item.artists as Array<{ name: string }> | undefined) ?? [];
    const images = (album?.images as Array<{ url: string }> | undefined) ?? [];
    const device = (data.device as Record<string, unknown> | undefined) ?? null;

    return {
      isPlaying: data.is_playing === true,
      trackTitle,
      artist: artists.map((a) => a.name).join(", "),
      album: albumName,
      albumArtUrl: images[0]?.url ?? null,
      progressMs,
      durationMs,
      deviceName: (device?.name as string) ?? null,
    };
  }

  /**
   * GET /v1/me/player/recently-played + GET /v1/me/playlists , returns
   * recently-played tracks and user playlists for the Quick-Play modal (A16).
   * THROWS SpotifyError on any error.
   */
  async browse(): Promise<SpotifyBrowseResult> {
    const token = await this.getAccessToken();

    const [recentlyPlayed, playlists] = await Promise.all([
      this.fetchRecentlyPlayed(token),
      this.fetchPlaylists(token),
    ]);

    return { recentlyPlayed, playlists };
  }

  /** Lists real Spotify Connect devices available to the account. */
  async getDevices(): Promise<SpotifyDevice[]> {
    const token = await this.getAccessToken();
    const data = await this.requestJson(
      "GET",
      "https://api.spotify.com/v1/me/player/devices",
      token,
    );
    const rawDevices = data.devices;
    if (!Array.isArray(rawDevices)) {
      throw new SpotifyError("devices: response missing devices array");
    }
    return rawDevices.map((raw, index) => {
      if (typeof raw !== "object" || raw === null) {
        throw new SpotifyError(`devices: invalid device at index ${index}`);
      }
      if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.name !== "string") {
        throw new SpotifyError(`devices: device at index ${index} is missing id or name`);
      }
      if (typeof raw.is_active !== "boolean" || typeof raw.is_restricted !== "boolean") {
        throw new SpotifyError(`devices: device at index ${index} is missing availability state`);
      }
      return {
        id: raw.id,
        name: raw.name,
        type: typeof raw.type === "string" ? raw.type : "unknown",
        isActive: raw.is_active,
        isRestricted: raw.is_restricted,
      };
    });
  }

  /** Selects a Spotify Connect device without beginning playback. */
  async transferPlayback(deviceId: string): Promise<void> {
    await this.playerWrite("PUT", "https://api.spotify.com/v1/me/player", "transfer", {
      device_ids: [deviceId],
      play: false,
    });
  }

  /** Configures shuffle on a specific active Spotify Connect device. */
  async setShuffle(enabled: boolean, deviceId: string): Promise<void> {
    const params = new URLSearchParams({ state: String(enabled), device_id: deviceId });
    await this.playerWrite(
      "PUT",
      `https://api.spotify.com/v1/me/player/shuffle?${params}`,
      "shuffle",
    );
  }

  /** Starts a playlist/album context on the requested Spotify Connect device. */
  async playContext(contextUri: string, deviceId: string): Promise<void> {
    const params = new URLSearchParams({ device_id: deviceId });
    await this.playerWrite(
      "PUT",
      `https://api.spotify.com/v1/me/player/play?${params}`,
      "play-context",
      { context_uri: contextUri },
    );
  }

  /** Pauses one explicit Spotify Connect device. */
  async pauseDevice(deviceId: string): Promise<void> {
    const params = new URLSearchParams({ device_id: deviceId });
    await this.playerWrite(
      "PUT",
      `https://api.spotify.com/v1/me/player/pause?${params}`,
      "pause-device",
    );
  }

  /**
   * PUT /v1/me/player/play , resume or start playback. THROWS SpotifyError on any error.
   */
  async play(): Promise<void> {
    await this.playerCommand("PUT", "https://api.spotify.com/v1/me/player/play", "play");
  }

  /**
   * PUT /v1/me/player/pause , pause playback. THROWS SpotifyError on any error.
   */
  async pause(): Promise<void> {
    await this.playerCommand("PUT", "https://api.spotify.com/v1/me/player/pause", "pause");
  }

  /**
   * POST /v1/me/player/next , skip to next track. THROWS SpotifyError on any error.
   */
  async next(): Promise<void> {
    await this.playerCommand("POST", "https://api.spotify.com/v1/me/player/next", "next");
  }

  /**
   * POST /v1/me/player/previous , skip to previous track. THROWS SpotifyError on any error.
   */
  async previous(): Promise<void> {
    await this.playerCommand("POST", "https://api.spotify.com/v1/me/player/previous", "previous");
  }

  /**
   * PUT /v1/me/player/seek?position_ms=<ms> , seek to position. THROWS SpotifyError on any error.
   */
  async seek(positionMs: number): Promise<void> {
    const url = `https://api.spotify.com/v1/me/player/seek?position_ms=${positionMs}`;
    await this.playerCommand("PUT", url, "seek");
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async fetchRecentlyPlayed(token: string): Promise<SpotifyRecentTrack[]> {
    let res: Response;
    try {
      res = await fetch("https://api.spotify.com/v1/me/player/recently-played?limit=20", {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new SpotifyError(`browse/recently-played: network error , ${(err as Error).message}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new SpotifyError(`browse/recently-played: HTTP ${res.status} , ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as { items?: unknown[] };
    const items = data.items ?? [];

    // Deduplicate by track id , the recently-played list can repeat the same
    // track if it was played multiple times.
    const seen = new Set<string>();
    const tracks: SpotifyRecentTrack[] = [];

    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      const track = item.track as Record<string, unknown> | undefined;
      if (!track) continue;

      const id = track.id as string | undefined;
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const artists = (track.artists as Array<{ name: string }> | undefined) ?? [];
      const album = track.album as Record<string, unknown> | undefined;
      const images = (album?.images as Array<{ url: string }> | undefined) ?? [];

      // Validate required fields , throw rather than fabricate empty strings (A3).
      const trackTitle = track.name as string | undefined;
      if (typeof trackTitle !== "string" || !trackTitle) {
        throw new SpotifyError(
          `browse/recently-played: track.name is missing or empty for track id "${id}"`,
        );
      }
      const trackUri = track.uri as string | undefined;
      if (typeof trackUri !== "string" || !trackUri) {
        throw new SpotifyError(
          `browse/recently-played: track.uri is missing or empty for track id "${id}"`,
        );
      }

      tracks.push({
        id,
        title: trackTitle,
        artist: artists.map((a) => a.name).join(", "),
        albumArtUrl: images[0]?.url ?? null,
        uri: trackUri,
      });
    }

    return tracks;
  }

  private async fetchPlaylists(token: string): Promise<SpotifyPlaylistItem[]> {
    let res: Response;
    try {
      res = await fetch("https://api.spotify.com/v1/me/playlists?limit=20", {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new SpotifyError(`browse/playlists: network error , ${(err as Error).message}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new SpotifyError(`browse/playlists: HTTP ${res.status} , ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as { items?: unknown[] };
    const items = data.items ?? [];
    const playlists: SpotifyPlaylistItem[] = [];

    for (const raw of items) {
      const pl = raw as Record<string, unknown>;
      const id = pl.id as string | undefined;
      if (!id) continue;

      const images = (pl.images as Array<{ url: string }> | undefined) ?? [];

      // Validate required fields , throw rather than fabricate empty strings (A3).
      const plTitle = pl.name as string | undefined;
      if (typeof plTitle !== "string" || !plTitle) {
        throw new SpotifyError(
          `browse/playlists: pl.name is missing or empty for playlist id "${id}"`,
        );
      }
      const plUri = pl.uri as string | undefined;
      if (typeof plUri !== "string" || !plUri) {
        throw new SpotifyError(
          `browse/playlists: pl.uri is missing or empty for playlist id "${id}"`,
        );
      }

      playlists.push({
        id,
        title: plTitle,
        description: (pl.description as string | null) ?? null,
        imageUrl: images[0]?.url ?? null,
        uri: plUri,
      });
    }

    return playlists;
  }

  private async refreshToken(): Promise<string> {
    const { clientId, clientSecret, refreshToken } = this.creds;
    const basic = btoa(`${clientId}:${clientSecret}`);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
    } catch (err) {
      throw new SpotifyError(`Token refresh: network error , ${(err as Error).message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SpotifyError(`Token refresh: HTTP ${res.status} , ${text.slice(0, 200)}`);
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    const accessToken = json.access_token;
    const expiresIn = json.expires_in ?? 3600;

    if (!accessToken) {
      throw new SpotifyError("Token refresh: response missing access_token");
    }

    this.cache = {
      accessToken,
      expiresAtMs: Date.now() + expiresIn * 1000 - EXPIRY_BUFFER_MS,
    };

    // Log success with expires_in but NEVER the token value (redacted anyway,
    // but discipline is the primary layer , docs/logging.md §4).
    getLogger().info({ expiresIn }, "spotify token refreshed");

    return accessToken;
  }

  private async requestJson(
    method: string,
    url: string,
    token: string,
  ): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      throw new SpotifyError(`request: network error , ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new SpotifyError(`request: HTTP ${res.status} , ${body.slice(0, 200)}`);
    }
    const raw: unknown = await res.json();
    if (!isRecord(raw)) {
      throw new SpotifyError("request: expected an object response");
    }
    return raw;
  }

  private async playerWrite(
    method: string,
    url: string,
    label: string,
    body?: Record<string, unknown>,
  ): Promise<void> {
    const token = await this.getAccessToken();
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new SpotifyError(`${label}: network error , ${(err as Error).message}`);
    }
    if (res.ok || res.status === 204) return;
    const responseBody = await res.text().catch(() => "");
    throw new SpotifyError(`${label}: HTTP ${res.status} , ${responseBody.slice(0, 200)}`);
  }

  /**
   * Executes a player command (play/pause/next/previous/seek) using the given
   * HTTP method and URL. Accepts 200, 204, and 403 (no active device) as
   * "success" , the mutation fired, Spotify's response is informational.
   * THROWS SpotifyError on network failure or unexpected server errors.
   */
  private async playerCommand(method: string, url: string, label: string): Promise<void> {
    const token = await this.getAccessToken();
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new SpotifyError(`${label}: network error , ${(err as Error).message}`);
    }

    // 200/204 = success; 403 = no active device (non-fatal , command was accepted)
    if (res.ok || res.status === 204 || res.status === 403) return;

    const body = await res.text().catch(() => "");
    throw new SpotifyError(`${label}: HTTP ${res.status} , ${body.slice(0, 200)}`);
  }
}

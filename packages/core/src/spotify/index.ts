/**
 * Spotify Web API client , lazily mints/caches access tokens from a refresh
 * token, with throw-on-unconfigured and throw-on-error semantics (www-51hf.33).
 *
 * Design rules (A3, A4):
 *  - THROWS SpotifyError when credentials are missing or the refresh fails.
 *  - No fabricated data , callers see an error, never an invented value.
 *  - Token is cached in-process until 60s before the 1h Spotify expiry.
 */

export { SpotifyClient } from "./client";
export { SpotifyError } from "./errors";
/** @public , consumed by the media router Spotify procedures */
export type {
  SpotifyBrowseResult,
  SpotifyCredentials,
  SpotifyDevice,
  SpotifyNowPlaying,
  SpotifyPlaylistItem,
  SpotifyRecentTrack,
} from "./types";

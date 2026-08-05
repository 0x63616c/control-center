/**
 * Types for the Spotify Web API client (www-51hf.33, www-51hf.13).
 */

/** Constructor credentials for SpotifyClient. */
export interface SpotifyCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Spotify track playing state. */
export interface SpotifyNowPlaying {
  isPlaying: boolean;
  trackTitle: string;
  artist: string;
  album: string;
  albumArtUrl: string | null;
  progressMs: number;
  durationMs: number;
  deviceName: string | null;
}

/** A recently-played track returned by the browse query (A16). */
export interface SpotifyRecentTrack {
  id: string;
  title: string;
  artist: string;
  albumArtUrl: string | null;
  uri: string;
}

/** A playlist item returned by the browse query (A16). */
export interface SpotifyPlaylistItem {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  uri: string;
}

/** Combined browse result: recently-played + playlists/made-for-you (A16). */
export interface SpotifyBrowseResult {
  recentlyPlayed: SpotifyRecentTrack[];
  playlists: SpotifyPlaylistItem[];
}

/** One currently available Spotify Connect playback target. */
export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
}

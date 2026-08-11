/** Spotify is browse-only; playback always routes through Home Assistant. */
import { type SpotifyBrowseResult, SpotifyClient } from "@www/core";
import { config } from "./config";

let client: SpotifyClient | null = null;

function spotifyClient(): SpotifyClient {
  client ??= new SpotifyClient({
    clientId: config.SPOTIFY_CLIENT_ID,
    clientSecret: config.SPOTIFY_CLIENT_SECRET,
    refreshToken: config.SPOTIFY_REFRESH_TOKEN,
  });
  return client;
}

/** Read library choices only. Selected URIs are played through HA media_player.play_media. */
export async function spotifyBrowse(): Promise<SpotifyBrowseResult> {
  return spotifyClient().browse();
}

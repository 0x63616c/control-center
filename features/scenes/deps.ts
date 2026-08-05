import { haFromConfig, SpotifyClient } from "@www/core";
import { config } from "./config";

export const ha = haFromConfig(config);
export const spotify = new SpotifyClient({
  clientId: config.SPOTIFY_CLIENT_ID,
  clientSecret: config.SPOTIFY_CLIENT_SECRET,
  refreshToken: config.SPOTIFY_REFRESH_TOKEN,
});

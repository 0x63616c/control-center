/** Typed slice of the central env registry (`@www/platform/env`). */
import { ENV } from "@www/platform/env";

export const config = ENV.pick(
  "HA_URL",
  "HA_TOKEN",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_REFRESH_TOKEN",
);

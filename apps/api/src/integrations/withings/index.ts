import { createWithingsClient } from "@www/core";
import { ENV as config } from "@www/platform/env";

/**
 * The api-side Withings singleton. The client itself is env-free in
 * `@www/core`; this binds it to the worker's env (WITHINGS_CLIENT_ID/SECRET).
 * Mirrors the HA singleton in ../homeassistant.
 */
export const withings = createWithingsClient({
  clientId: config.WITHINGS_CLIENT_ID ?? "",
  clientSecret: config.WITHINGS_CLIENT_SECRET ?? "",
});

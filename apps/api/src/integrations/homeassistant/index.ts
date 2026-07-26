import { haFromConfig } from "@www/core";
import { ENV as config } from "@www/platform/env";

/**
 * The api-side HA singleton. The client itself is env-free in `@www/core`; this
 * binds it to the api's env (HA_URL/HA_TOKEN) so every service shares one
 * instance. Mirrors the UniFi hoist: the shared client lives in `@www/core`,
 * and each caller builds its own instance from its config slice — the api keeps
 * this singleton until the HA tiles fold into `features/*` (Track C).
 */
export { HomeAssistantClient } from "@www/core";
export const ha = haFromConfig(config);

/**
 * The ctrl feature's own HA client (Track C, Wave 7). The client itself is
 * env-free in `@www/core`; this binds it to the feature's own config slice, the
 * same pattern `features/ac/deps.ts` and apps/api's
 * `integrations/homeassistant/index.ts` singleton use. Kept out of `service.ts`
 * so tests can `vi.mock("./deps")` and stub just `ha`, without touching
 * `@www/core`'s other exports (DeviceKind, mergeDeviceState, etc.) that
 * `service.ts` also imports directly from `@www/core`.
 */
import { haFromConfig } from "@www/core";
import { config } from "./config";

export const ha = haFromConfig(config);

/**
 * The tv feature's own HA client (Track C, Wave 6). The client itself is
 * env-free in `@www/core`; this binds it to the feature's own config slice,
 * mirroring features/ac/deps.ts and features/ctrl/deps.ts.
 */
import { haFromConfig } from "@www/core";
import { config } from "./config";

export const ha = haFromConfig(config);

/** Typed slice of the central env registry (`@www/platform/env`). */
import { ENV } from "@www/platform/env";

export const config = ENV.pick("DATABASE_URL", "WITHINGS_CLIENT_ID", "WITHINGS_CLIENT_SECRET");

import { ENV } from "@www/platform/env";

export const config = ENV.pick(
  "DATABASE_URL",
  "ASC_KEY_ID",
  "ASC_ISSUER_ID",
  "ASC_KEY_CONTENT",
  "ASC_APP_ID",
);

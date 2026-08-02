import { createWithingsClient } from "@www/core";
import { config } from "./config";

export const withings = createWithingsClient({
  clientId: config.WITHINGS_CLIENT_ID ?? "",
  clientSecret: config.WITHINGS_CLIENT_SECRET ?? "",
});

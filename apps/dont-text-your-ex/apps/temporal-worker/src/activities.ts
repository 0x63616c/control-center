export interface DtyeHealthCheckActivityInput {
  readonly iteration: number;
}
export interface DtyeHealthCheckActivityOutput {
  readonly status: "ok";
}

export async function DtyeHealthCheckActivity(
  input: DtyeHealthCheckActivityInput,
): Promise<DtyeHealthCheckActivityOutput> {
  void input;
  return { status: "ok" };
}

let notificationActivities: ReturnType<typeof createNotificationActivities> | undefined;

function getNotificationActivities(): ReturnType<typeof createNotificationActivities> {
  if (notificationActivities) return notificationActivities;
  const config = ENV.pick(
    "DATABASE_URL",
    "APNS_KEY_ID",
    "APNS_TEAM_ID",
    "APNS_KEY_CONTENT",
    "PUSH_TOKEN_KEYRING",
  );
  if (
    !config.APNS_KEY_ID ||
    !config.APNS_TEAM_ID ||
    !config.APNS_KEY_CONTENT ||
    !config.PUSH_TOKEN_KEYRING
  ) {
    throw new Error("notification delivery secrets are not configured");
  }
  const authorization = createCachedApnsAuthorization({
    keyId: config.APNS_KEY_ID,
    teamId: config.APNS_TEAM_ID,
    keyContent: config.APNS_KEY_CONTENT,
  });
  const transport = createHttp2ApnsTransport();
  const clients = {
    production: createApnsClient({
      authorization,
      transport,
      host: "https://api.push.apple.com",
      topic: "co.worldwidewebb.textyourex",
    }),
    sandbox: createApnsClient({
      authorization,
      transport,
      host: "https://api.sandbox.push.apple.com",
      topic: "co.worldwidewebb.textyourex",
    }),
  } as const;
  notificationActivities = createNotificationActivities({
    store: createNotificationStore(
      new Pool({ connectionString: config.DATABASE_URL }),
      createTokenCipher(parseTokenKeyring(JSON.parse(config.PUSH_TOKEN_KEYRING))),
    ),
    apnsClient: (environment) => clients[environment],
  });
  return notificationActivities;
}

export async function prepareNotification(
  input: Parameters<ReturnType<typeof createNotificationActivities>["prepareNotification"]>[0],
): ReturnType<ReturnType<typeof createNotificationActivities>["prepareNotification"]> {
  return getNotificationActivities().prepareNotification(input);
}

export async function deliverNotification(
  input: Parameters<ReturnType<typeof createNotificationActivities>["deliverNotification"]>[0],
): ReturnType<ReturnType<typeof createNotificationActivities>["deliverNotification"]> {
  return getNotificationActivities().deliverNotification(input);
}

import {
  createApnsClient,
  createCachedApnsAuthorization,
  createHttp2ApnsTransport,
  createNotificationStore,
  createTokenCipher,
  parseTokenKeyring,
} from "@dont-text-your-ex/notifications";
import { ENV } from "@www/platform/env";
import { Pool } from "pg";
import { createNotificationActivities } from "./notification-activities";

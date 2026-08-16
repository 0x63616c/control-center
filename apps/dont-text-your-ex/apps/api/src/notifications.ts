import {
  createNotificationStore,
  createTokenCipher,
  parseTokenKeyring,
} from "@dont-text-your-ex/notifications";
import { pool } from "./db/index";
import { pushTokenKeyringSource } from "./env";

let singleton: ReturnType<typeof createNotificationStore> | undefined;

export function notificationStore(): ReturnType<typeof createNotificationStore> {
  singleton ??= createNotificationStore(
    pool,
    createTokenCipher(parseTokenKeyring(pushTokenKeyringSource())),
  );
  return singleton;
}

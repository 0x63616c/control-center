import { Capacitor } from "@capacitor/core";
import { genId } from "@www/platform";
import {
  NotificationIdSchema,
  PushInstallationIdSchema,
  type RegisterPushDeviceRequest,
} from "../../../../contracts";

const INSTALLATION_KEY = "tye_push_installation_id";
const ENABLED_KEY = "tye_push_enabled";

export interface PushPlugin {
  checkPermissions(): Promise<{
    receive: "prompt" | "prompt-with-rationale" | "granted" | "denied";
  }>;
  requestPermissions(): Promise<{
    receive: "prompt" | "prompt-with-rationale" | "granted" | "denied";
  }>;
  register(): Promise<void>;
  addListener(
    event: string,
    callback: (value: never) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

type RegisterDevice = (input: RegisterPushDeviceRequest) => Promise<unknown>;
type AppInfo = () => Promise<{ version: string; build: string }>;

let pluginPromise: Promise<PushPlugin | null> | null = null;
let listenersAttached = false;
let currentRegistration: { registerDevice: RegisterDevice; appInfo: AppInfo } | undefined;

function installationId(): RegisterPushDeviceRequest["installationId"] {
  const existing = PushInstallationIdSchema.safeParse(localStorage.getItem(INSTALLATION_KEY));
  if (existing.success) return existing.data;
  const created = PushInstallationIdSchema.parse(genId("dev", { length: 24 }));
  localStorage.setItem(INSTALLATION_KEY, created);
  return created;
}

async function loadPlugin(): Promise<PushPlugin | null> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("PushNotifications")) {
    return null;
  }
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    return {
      checkPermissions: () => PushNotifications.checkPermissions(),
      requestPermissions: () => PushNotifications.requestPermissions(),
      register: () => PushNotifications.register(),
      addListener: (event, callback) =>
        PushNotifications.addListener(event as never, callback as never) as Promise<{
          remove(): Promise<void>;
        }>,
    };
  } catch {
    return null;
  }
}

function getPlugin(): Promise<PushPlugin | null> {
  pluginPromise ??= loadPlugin().catch(() => null);
  return pluginPromise;
}

async function attachRegistrationListeners(plugin: PushPlugin): Promise<void> {
  if (listenersAttached) return;
  await plugin.addListener("registration", async (value: never) => {
    const token = value as { value?: string };
    if (!token.value || !currentRegistration) return;
    try {
      const info = await currentRegistration.appInfo();
      await currentRegistration.registerDevice({
        installationId: installationId(),
        token: token.value,
        platform: "ios",
        environment:
          import.meta.env.VITE_APNS_ENVIRONMENT === "production" ? "production" : "sandbox",
        appVersion: info.version,
        appBuild: info.build,
      });
    } catch {
      // APNs will issue the token again on the next authenticated launch.
    }
  });
  await plugin.addListener("registrationError", () => undefined);
  listenersAttached = true;
}

async function startRegistration(
  registerDevice: RegisterDevice,
  appInfo: AppInfo,
  mayPrompt: boolean,
): Promise<{ ok: true } | { ok: false; reason: "unsupported" | "denied" | "error" }> {
  const plugin = await getPlugin();
  if (!plugin) return { ok: false, reason: "unsupported" };
  try {
    let permission = await plugin.checkPermissions();
    if (permission.receive !== "granted" && mayPrompt) {
      permission = await plugin.requestPermissions();
    }
    if (permission.receive !== "granted") return { ok: false, reason: "denied" };
    currentRegistration = { registerDevice, appInfo };
    await attachRegistrationListeners(plugin);
    await plugin.register();
    localStorage.setItem(ENABLED_KEY, "1");
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export function enablePush(registerDevice: RegisterDevice, appInfo: AppInfo) {
  return startRegistration(registerDevice, appInfo, true);
}

export async function refreshEnabledPush(registerDevice: RegisterDevice, appInfo: AppInfo) {
  if (localStorage.getItem(ENABLED_KEY) !== "1") return { ok: false, reason: "disabled" } as const;
  return startRegistration(registerDevice, appInfo, false);
}

export async function disableCurrentPush(
  disableDevice: (installationId: RegisterPushDeviceRequest["installationId"]) => Promise<unknown>,
  clearLocalPreference = true,
): Promise<void> {
  const existing = PushInstallationIdSchema.safeParse(localStorage.getItem(INSTALLATION_KEY));
  if (existing.success) await disableDevice(existing.data);
  if (clearLocalPreference) localStorage.removeItem(ENABLED_KEY);
}

export async function installNotificationActionListener(
  onNotification: (notificationId: string) => void,
): Promise<() => Promise<void>> {
  const plugin = await getPlugin();
  if (!plugin) return async () => undefined;
  const listener = await plugin.addListener("pushNotificationActionPerformed", (value: never) => {
    const candidate = (value as { notification?: { data?: { notificationId?: unknown } } })
      .notification?.data?.notificationId;
    const notificationId = NotificationIdSchema.safeParse(candidate);
    if (notificationId.success) onNotification(notificationId.data);
  });
  return () => listener.remove();
}

export function setPushPluginForTests(plugin: PushPlugin | null): void {
  pluginPromise = Promise.resolve(plugin);
  listenersAttached = false;
  currentRegistration = undefined;
}

import { Capacitor, registerPlugin } from "@capacitor/core";

type NativeAppInfo = {
  readonly version: string;
  readonly build: string;
};

type AppInfoPlugin = {
  getInfo(): Promise<NativeAppInfo>;
};

const AppInfo = registerPlugin<AppInfoPlugin>("AppInfo");

export async function getNativeAppInfo(): Promise<NativeAppInfo | null> {
  if (!Capacitor.isNativePlatform()) return null;
  return AppInfo.getInfo();
}

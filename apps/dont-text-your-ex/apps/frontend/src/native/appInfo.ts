import { Capacitor, registerPlugin } from "@capacitor/core";
import { z } from "zod";

const NativeAppInfoSchema = z
  .object({
    version: z.string().min(1),
    build: z.string().min(1),
  })
  .strict();

type NativeAppInfo = z.infer<typeof NativeAppInfoSchema>;

type AppInfoPlugin = {
  getInfo(): Promise<unknown>;
};

const AppInfo = registerPlugin<AppInfoPlugin>("AppInfo");

export async function getNativeAppInfo(): Promise<NativeAppInfo | null> {
  if (!Capacitor.isNativePlatform()) return null;
  return NativeAppInfoSchema.parse(await AppInfo.getInfo());
}

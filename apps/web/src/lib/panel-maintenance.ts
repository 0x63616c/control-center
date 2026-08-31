import { Capacitor, registerPlugin } from "@capacitor/core";
import { z } from "zod";
import { log } from "./log/logger";

const maintenanceLog = log.child("panel-maintenance");
const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const configurationSchema = z.object({
  enabled: z.boolean(),
  time: localTimeSchema,
  nextRunAtMs: z.number().finite().nonnegative().nullable(),
});

export type PanelMaintenanceConfiguration = z.infer<typeof configurationSchema>;
export type PanelMaintenanceUpdate = Readonly<
  Pick<PanelMaintenanceConfiguration, "enabled" | "time">
>;

interface PanelMaintenancePlugin {
  getConfiguration(): Promise<unknown>;
  setConfiguration(options: PanelMaintenanceUpdate): Promise<unknown>;
  runNow(): Promise<unknown>;
}

const plugin = registerPlugin<PanelMaintenancePlugin>("PanelMaintenance");

export interface PanelMaintenanceClient {
  isAvailable(): boolean;
  get(): Promise<PanelMaintenanceConfiguration | null>;
  set(update: PanelMaintenanceUpdate): Promise<PanelMaintenanceConfiguration | null>;
  runNow(): Promise<boolean>;
}

export function isPanelMaintenanceAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("PanelMaintenance");
}

function parseConfiguration(raw: unknown): PanelMaintenanceConfiguration | null {
  const parsed = configurationSchema.safeParse(raw);
  if (!parsed.success) {
    maintenanceLog.warn("configuration rejected", {
      issues: parsed.error.issues.slice(0, 4).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return null;
  }
  return parsed.data;
}

export async function getPanelMaintenance(): Promise<PanelMaintenanceConfiguration | null> {
  if (!isPanelMaintenanceAvailable()) return null;
  try {
    return parseConfiguration(await plugin.getConfiguration());
  } catch (error) {
    maintenanceLog.warn("configuration read failed", { error: String(error) });
    return null;
  }
}

export async function setPanelMaintenance(
  update: PanelMaintenanceUpdate,
): Promise<PanelMaintenanceConfiguration | null> {
  if (!isPanelMaintenanceAvailable() || !localTimeSchema.safeParse(update.time).success)
    return null;
  try {
    return parseConfiguration(await plugin.setConfiguration(update));
  } catch (error) {
    maintenanceLog.warn("configuration write failed", { error: String(error) });
    return null;
  }
}

export async function runPanelMaintenanceNow(): Promise<boolean> {
  if (!isPanelMaintenanceAvailable()) return false;
  try {
    const result = z.object({ accepted: z.literal(true) }).safeParse(await plugin.runNow());
    return result.success;
  } catch (error) {
    maintenanceLog.warn("manual maintenance failed", { error: String(error) });
    return false;
  }
}

export const panelMaintenanceClient: PanelMaintenanceClient = {
  isAvailable: isPanelMaintenanceAvailable,
  get: getPanelMaintenance,
  set: setPanelMaintenance,
  runNow: runPanelMaintenanceNow,
};

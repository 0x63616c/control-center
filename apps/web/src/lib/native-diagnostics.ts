/**
 * Web bridge for the native Panel run recorder.
 *
 * WKWebView cannot expose the process footprint or iOS memory-pressure events.
 * The native shell records those values to an atomic file every five minutes
 * and on lifecycle transitions. A fresh process can therefore report the last
 * state of the previous process even when jetsam killed it without running any
 * JavaScript or termination callback.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import { z } from "zod";
import { log } from "./log/logger";

const HEARTBEAT_MS = 5 * 60 * 1_000;
const diagnosticsLog = log.child("native-diagnostics");

interface KioskDiagnosticsPlugin {
  getSnapshot(): Promise<unknown>;
}

const plugin = registerPlugin<KioskDiagnosticsPlugin>("KioskDiagnostics");
let previousRunLogged = false;
const metricKitRecordKeysLogged = new Set<string>();
const nativeEventIdsLogged = new Set<string>();

const timestampSchema = z.number().finite().nonnegative();
const byteCountSchema = z.number().finite().nonnegative();
const lifecycleSchema = z.enum([
  "launching",
  "inactive",
  "background",
  "foreground",
  "active",
  "terminating",
]);
const memoryWarningEventSchema = z.object({
  timestampMs: timestampSchema,
  lifecycleState: lifecycleSchema,
  footprintBytes: byteCountSchema,
  peakFootprintBytes: byteCountSchema,
});
const webContentTerminationEventSchema = z.object({
  timestampMs: timestampSchema,
  lifecycleState: lifecycleSchema,
  footprintBytes: byteCountSchema,
});
const recoveryEventSchema = z.object({
  timestampMs: timestampSchema,
  trigger: z.literal("memory-warning"),
  outcome: z.enum(["authenticated-origin-reload", "suppressed-by-loop-protection"]),
});
const nativeRunRecordBaseSchema = z.object({
  runId: z.string().min(1).max(128),
  startedAtMs: timestampSchema,
  lastUpdatedAtMs: timestampSchema,
  lifecycleState: lifecycleSchema,
  memoryWarnings: z.number().int().nonnegative(),
  footprintBytes: byteCountSchema,
  peakFootprintBytes: byteCountSchema,
});
const nativeRunRecordBuild104Schema = nativeRunRecordBaseSchema
  .extend({
    warningEvents: z.array(memoryWarningEventSchema).max(16),
    webContentTerminations: z.array(webContentTerminationEventSchema).max(16),
    recoveryEvents: z.array(recoveryEventSchema).max(16),
    cpuTimeSeconds: z.number().finite().nonnegative(),
    cpuPercentOfOneCore: z.number().finite().nonnegative(),
    thermalState: z.enum(["nominal", "fair", "serious", "critical", "unknown"]),
    batteryLevel: z
      .number()
      .finite()
      .min(0)
      .max(100)
      .nullish()
      .transform((level) => level ?? null),
    batteryState: z.enum(["unknown", "unplugged", "charging", "full"]),
    appUptimeSeconds: z.number().finite().nonnegative(),
    systemUptimeSeconds: z.number().finite().nonnegative(),
  })
  .transform((run) => ({ ...run, diagnosticsSchema: "build-104" as const }));

// The remote web bundle deploys before the TestFlight update is installed. Keep
// this exact old boundary shape so Build 103 continues reporting its available
// evidence during that staggered rollout, without letting partially malformed
// Build 104 records fall through as legacy data.
const nativeRunRecordBuild103Schema = nativeRunRecordBaseSchema.strict().transform((run) => ({
  ...run,
  diagnosticsSchema: "build-103" as const,
  warningEvents: [],
  webContentTerminations: [],
  recoveryEvents: [],
  cpuTimeSeconds: null,
  cpuPercentOfOneCore: null,
  thermalState: "unknown" as const,
  batteryLevel: null,
  batteryState: "unknown" as const,
  appUptimeSeconds: null,
  systemUptimeSeconds: null,
}));

const nativeRunRecordSchema = z.union([
  nativeRunRecordBuild104Schema,
  nativeRunRecordBuild103Schema,
]);
type NativeRunRecord = z.infer<typeof nativeRunRecordSchema>;
const nativeMetricKitRecordSchema = z.object({
  sequence: z.number().int().positive(),
  kind: z.enum(["metric", "diagnostic"]),
  receivedAtMs: timestampSchema,
  rawPayloadBytes: byteCountSchema,
  truncated: z.boolean(),
  evidence: z
    .array(z.object({ path: z.string().min(1).max(120), value: z.string().max(80) }))
    .max(8),
});
const nativeDiagnosticsSnapshotSchema = z.object({
  currentRun: nativeRunRecordSchema,
  previousRun: nativeRunRecordSchema.optional(),
  physicalMemoryBytes: byteCountSchema,
  osVersion: z.string().min(1).max(64),
  metricKitRecords: z.array(nativeMetricKitRecordSchema).max(4).optional(),
});
type NativeDiagnosticsSnapshot = z.infer<typeof nativeDiagnosticsSnapshotSchema>;

function compactRunRecord(run: NativeRunRecord): Omit<
  NativeRunRecord,
  "warningEvents" | "webContentTerminations" | "recoveryEvents"
> & {
  readonly warningEventHistoryCount: number;
  readonly webContentTerminationHistoryCount: number;
  readonly recoveryEventHistoryCount: number;
} {
  const { warningEvents, webContentTerminations, recoveryEvents, ...metrics } = run;
  return {
    ...metrics,
    warningEventHistoryCount: warningEvents.length,
    webContentTerminationHistoryCount: webContentTerminations.length,
    recoveryEventHistoryCount: recoveryEvents.length,
  };
}

function recordRunEvents(run: NativeRunRecord, runOrigin: "current" | "previous"): void {
  for (const event of run.warningEvents) {
    const id = `${run.runId}:memory-warning:${event.timestampMs}`;
    if (nativeEventIdsLogged.has(id)) continue;
    nativeEventIdsLogged.add(id);
    diagnosticsLog.warn("memory warning evidence", { runId: run.runId, runOrigin, ...event });
  }
  for (const event of run.webContentTerminations) {
    const id = `${run.runId}:web-content-termination:${event.timestampMs}`;
    if (nativeEventIdsLogged.has(id)) continue;
    nativeEventIdsLogged.add(id);
    diagnosticsLog.warn("WebKit content process termination", {
      runId: run.runId,
      runOrigin,
      ...event,
    });
  }
  for (const event of run.recoveryEvents) {
    const id = `${run.runId}:recovery:${event.timestampMs}:${event.outcome}`;
    if (nativeEventIdsLogged.has(id)) continue;
    nativeEventIdsLogged.add(id);
    diagnosticsLog.info("memory pressure recovery", { runId: run.runId, runOrigin, ...event });
  }
}

function isNativeDiagnosticsAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("KioskDiagnostics");
}

async function recordSnapshot(reason: "boot" | "foreground" | "heartbeat"): Promise<void> {
  try {
    const parsed = nativeDiagnosticsSnapshotSchema.safeParse(await plugin.getSnapshot());
    if (!parsed.success) {
      diagnosticsLog.warn("snapshot rejected", {
        reason,
        issues: parsed.error.issues.slice(0, 4).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }
    const snapshot: NativeDiagnosticsSnapshot = parsed.data;
    for (const record of snapshot.metricKitRecords ?? []) {
      const recordKey = `${record.sequence}:${record.kind}:${record.receivedAtMs}`;
      if (metricKitRecordKeysLogged.has(recordKey)) continue;
      metricKitRecordKeysLogged.add(recordKey);
      diagnosticsLog.info("MetricKit evidence", {
        sequence: record.sequence,
        kind: record.kind,
        receivedAtMs: record.receivedAtMs,
        rawPayloadBytes: record.rawPayloadBytes,
        rawPayloadTruncated: record.truncated,
        evidence: record.evidence,
      });
    }
    recordRunEvents(snapshot.currentRun, "current");
    if (!previousRunLogged && snapshot.previousRun)
      recordRunEvents(snapshot.previousRun, "previous");
    diagnosticsLog.info("process snapshot", {
      reason,
      currentRun: compactRunRecord(snapshot.currentRun),
      physicalMemoryBytes: snapshot.physicalMemoryBytes,
      osVersion: snapshot.osVersion,
      ...(!previousRunLogged && snapshot.previousRun
        ? { previousRun: compactRunRecord(snapshot.previousRun) }
        : {}),
    });
    previousRunLogged = true;
  } catch (err) {
    diagnosticsLog.warn("snapshot failed", { reason, error: String(err) });
  }
}

/** Start bounded native diagnostics. Returns a stop function for tests. */
export function startNativeDiagnostics(): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};
  if (!isNativeDiagnosticsAvailable()) {
    diagnosticsLog.info("native recorder unavailable; install the latest TestFlight build");
    return () => {};
  }

  void recordSnapshot("boot");
  const timer = window.setInterval(() => void recordSnapshot("heartbeat"), HEARTBEAT_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") void recordSnapshot("foreground");
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export function resetNativeDiagnosticsForTests(): void {
  previousRunLogged = false;
  metricKitRecordKeysLogged.clear();
  nativeEventIdsLogged.clear();
}

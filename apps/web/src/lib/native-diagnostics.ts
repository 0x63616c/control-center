/**
 * Web bridge for the native kiosk run recorder.
 *
 * WKWebView cannot expose the process footprint or iOS memory-pressure events.
 * The native shell records those values to an atomic file every five minutes
 * and on lifecycle transitions. A fresh process can therefore report the last
 * state of the previous process even when jetsam killed it without running any
 * JavaScript or termination callback.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import { log } from "./log/logger";

const HEARTBEAT_MS = 5 * 60 * 1_000;
const diagnosticsLog = log.child("native-diagnostics");

interface NativeRunRecord {
  readonly runId: string;
  readonly startedAtMs: number;
  readonly lastUpdatedAtMs: number;
  readonly lifecycleState: string;
  readonly memoryWarnings: number;
  readonly warningEvents: readonly NativeMemoryWarningEvent[];
  readonly webContentTerminations: readonly NativeWebContentTerminationEvent[];
  readonly recoveryEvents: readonly NativeRecoveryEvent[];
  readonly footprintBytes: number;
  readonly peakFootprintBytes: number;
  /** Cumulative user + system CPU seconds for the native app process. */
  readonly cpuTimeSeconds: number;
  /** CPU used since the previous native sample, where 100 is one full core. */
  readonly cpuPercentOfOneCore: number;
  readonly thermalState: "nominal" | "fair" | "serious" | "critical" | "unknown";
  readonly batteryLevel: number | null;
  readonly batteryState: "unknown" | "unplugged" | "charging" | "full";
  readonly appUptimeSeconds: number;
  readonly systemUptimeSeconds: number;
}

interface NativeMemoryWarningEvent {
  readonly timestampMs: number;
  readonly lifecycleState: string;
  readonly footprintBytes: number;
  readonly peakFootprintBytes: number;
}

interface NativeWebContentTerminationEvent {
  readonly timestampMs: number;
  readonly lifecycleState: string;
  readonly footprintBytes: number;
}

interface NativeRecoveryEvent {
  readonly timestampMs: number;
  readonly trigger: string;
  readonly outcome: string;
}

interface NativeMetricKitRecord {
  readonly id: string;
  readonly kind: "metric" | "diagnostic";
  readonly receivedAtMs: number;
  readonly payloadUTF8: string;
  readonly truncated: boolean;
}

interface NativeDiagnosticsSnapshot {
  readonly currentRun: NativeRunRecord;
  readonly previousRun?: NativeRunRecord;
  readonly physicalMemoryBytes: number;
  readonly osVersion: string;
  readonly metricKitRecords?: readonly NativeMetricKitRecord[];
}

interface KioskDiagnosticsPlugin {
  getSnapshot(): Promise<NativeDiagnosticsSnapshot>;
}

const plugin = registerPlugin<KioskDiagnosticsPlugin>("KioskDiagnostics");
let previousRunLogged = false;
const metricKitRecordIdsLogged = new Set<string>();
const nativeEventIdsLogged = new Set<string>();
const METRICKIT_EVIDENCE_KEY = /(memory|exit|crash|hang|cpu|thermal|termination|peak|jetsam)/i;
const METRICKIT_EVIDENCE_LIMIT = 8;
const METRICKIT_CANDIDATE_LIMIT = 200;

interface MetricKitEvidenceValue {
  readonly path: string;
  readonly value: string | number | boolean | null;
}

function summarizeMetricKitPayload(payloadUTF8: string): {
  evidence: readonly MetricKitEvidenceValue[];
  parseError: boolean;
} {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadUTF8);
  } catch {
    return { evidence: [], parseError: true };
  }

  const candidates: MetricKitEvidenceValue[] = [];
  const visit = (value: unknown, path: readonly string[]): void => {
    if (candidates.length >= METRICKIT_CANDIDATE_LIMIT) return;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      if (!path.some((part) => METRICKIT_EVIDENCE_KEY.test(part))) return;
      candidates.push({
        path: path.join(".").slice(0, 120),
        value: typeof value === "string" ? value.slice(0, 80) : value,
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        visit(item, [...path, String(index)]);
      });
      return;
    }
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    }
  };
  visit(payload, []);
  const score = (item: MetricKitEvidenceValue): number => {
    const path = item.path.toLowerCase();
    if (path.includes("memoryresourcelimit") || path.includes("jetsam")) return 0;
    if (path.includes("termination") || path.includes("exit")) return 1;
    if (path.includes("peak") && path.includes("memory")) return 2;
    if (path.includes("crash")) return 3;
    if (path.includes("hang")) return 4;
    if (path.includes("memory")) return 5;
    if (path.includes("cpu")) return 6;
    return 7;
  };
  const evidence = candidates
    .map((item, index) => ({ item, index }))
    .sort((left, right) => score(left.item) - score(right.item) || left.index - right.index)
    .slice(0, METRICKIT_EVIDENCE_LIMIT)
    .map(({ item }) => item);
  return { evidence, parseError: false };
}

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
    const snapshot = await plugin.getSnapshot();
    for (const record of snapshot.metricKitRecords ?? []) {
      if (metricKitRecordIdsLogged.has(record.id)) continue;
      metricKitRecordIdsLogged.add(record.id);
      const summary = summarizeMetricKitPayload(record.payloadUTF8);
      diagnosticsLog.info("MetricKit evidence", {
        id: record.id,
        kind: record.kind,
        receivedAtMs: record.receivedAtMs,
        rawPayloadTruncated: record.truncated,
        ...summary,
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
  metricKitRecordIdsLogged.clear();
  nativeEventIdsLogged.clear();
}

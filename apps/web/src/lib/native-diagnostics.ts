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

export interface NativeRunRecord {
  readonly runId: string;
  readonly startedAtMs: number;
  readonly lastUpdatedAtMs: number;
  readonly lifecycleState: string;
  readonly memoryWarnings: number;
  readonly footprintBytes: number;
  readonly peakFootprintBytes: number;
}

interface NativeDiagnosticsSnapshot {
  readonly currentRun: NativeRunRecord;
  readonly previousRun?: NativeRunRecord;
  readonly physicalMemoryBytes: number;
  readonly osVersion: string;
}

interface KioskDiagnosticsPlugin {
  getSnapshot(): Promise<NativeDiagnosticsSnapshot>;
}

const plugin = registerPlugin<KioskDiagnosticsPlugin>("KioskDiagnostics");
let previousRunLogged = false;

export function isNativeDiagnosticsAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("KioskDiagnostics");
}

async function recordSnapshot(reason: "boot" | "foreground" | "heartbeat"): Promise<void> {
  try {
    const snapshot = await plugin.getSnapshot();
    diagnosticsLog.info("process snapshot", {
      reason,
      currentRun: snapshot.currentRun,
      physicalMemoryBytes: snapshot.physicalMemoryBytes,
      osVersion: snapshot.osVersion,
      ...(!previousRunLogged && snapshot.previousRun ? { previousRun: snapshot.previousRun } : {}),
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
}

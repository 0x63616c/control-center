import { useCallback, useEffect, useState } from "react";
import {
  type PanelMaintenanceClient,
  type PanelMaintenanceConfiguration,
  panelMaintenanceClient,
} from "../../../lib/panel-maintenance";
import { setGoalDayCutoffHour, setTimeZone, useSettings } from "../../../lib/settings";
import { Switch } from "../../ui/Switch";
import { WheelPicker, type WheelPickerValue } from "../../ui/WheelPicker";
import { ActionButton, RowShell, SectionCard } from "../blocks";
import type { PageProps } from "../SettingsPage";

const FALLBACK_TIME_ZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
] as const;

function supportedTimeZones(): readonly string[] {
  if (typeof Intl.supportedValuesOf !== "function") return FALLBACK_TIME_ZONES;
  return Intl.supportedValuesOf("timeZone");
}

const TIME_ZONES = supportedTimeZones();

function timeZoneLabel(timeZone: string): string {
  return timeZone.replaceAll("_", " ");
}

type MaintenanceState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready" | "saving";
      readonly configuration: PanelMaintenanceConfiguration;
    };

const HOURS: readonly WheelPickerValue<number>[] = Array.from({ length: 24 }, (_, hour) => ({
  value: hour,
  label: String(hour).padStart(2, "0"),
}));
const MINUTES: readonly WheelPickerValue<number>[] = Array.from({ length: 60 }, (_, minute) => ({
  value: minute,
  label: String(minute).padStart(2, "0"),
}));

function maintenanceTimeParts(time: string): { hour: number; minute: number } {
  const [hour = "3", minute = "0"] = time.split(":");
  return { hour: Number(hour), minute: Number(minute) };
}

function maintenanceTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function nextRunLabel(nextRunAtMs: number | null): string {
  if (nextRunAtMs === null) return "Paused";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(nextRunAtMs));
}

export function TimePage({
  maintenance = panelMaintenanceClient,
}: PageProps & { readonly maintenance?: PanelMaintenanceClient }) {
  const { goalDayCutoffHour, timeZone } = useSettings();
  const [maintenanceState, setMaintenanceState] = useState<MaintenanceState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    if (!maintenance.isAvailable()) {
      setMaintenanceState({ status: "unavailable" });
      return () => {
        active = false;
      };
    }
    void maintenance.get().then((configuration) => {
      if (!active) return;
      setMaintenanceState(
        configuration ? { status: "ready", configuration } : { status: "unavailable" },
      );
    });
    return () => {
      active = false;
    };
  }, [maintenance]);

  const updateMaintenance = useCallback(
    (update: Pick<PanelMaintenanceConfiguration, "enabled" | "time">) => {
      if (maintenanceState.status !== "ready") return;
      const previousConfiguration = maintenanceState.configuration;
      setMaintenanceState({ status: "saving", configuration: previousConfiguration });
      void maintenance.set(update).then((configuration) => {
        setMaintenanceState({
          status: "ready",
          configuration: configuration ?? previousConfiguration,
        });
      });
    },
    [maintenance, maintenanceState],
  );

  const maintenanceConfiguration =
    maintenanceState.status === "ready" || maintenanceState.status === "saving"
      ? maintenanceState.configuration
      : null;
  const savingMaintenance = maintenanceState.status === "saving";
  const timeParts = maintenanceConfiguration
    ? maintenanceTimeParts(maintenanceConfiguration.time)
    : null;

  return (
    <>
      <SectionCard title="Local time">
        {[
          <RowShell
            key="time-zone"
            label="Time zone"
            sub="Used for dates, day boundaries, and schedules across the panel."
            control={
              <select
                aria-label="Time zone"
                value={timeZone}
                onChange={(event) => setTimeZone(event.target.value)}
                style={{
                  width: 260,
                  padding: "9px 12px",
                  color: "var(--ink)",
                  background: "var(--nest)",
                  border: "1px solid var(--hair)",
                  borderRadius: 10,
                  fontFamily: "var(--ui)",
                  fontSize: 14,
                }}
              >
                {TIME_ZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {timeZoneLabel(zone)}
                  </option>
                ))}
              </select>
            }
          />,
          <RowShell
            key="goal-day-cutoff"
            label="Goal-day cutoff"
            sub="A check-in before this hour belongs to the previous day."
            control={
              <select
                aria-label="Goal-day cutoff"
                value={goalDayCutoffHour}
                onChange={(event) => setGoalDayCutoffHour(Number(event.target.value))}
                style={{
                  width: 160,
                  padding: "9px 12px",
                  color: "var(--ink)",
                  background: "var(--nest)",
                  border: "1px solid var(--hair)",
                  borderRadius: 10,
                  fontFamily: "var(--ui)",
                  fontSize: 14,
                }}
              >
                {[2, 3, 4, 5, 6].map((hour) => (
                  <option key={hour} value={hour}>
                    {hour}:00 AM
                  </option>
                ))}
              </select>
            }
          />,
        ]}
      </SectionCard>

      <SectionCard title="Panel maintenance">
        {maintenanceConfiguration && timeParts
          ? [
              <RowShell
                key="enabled"
                label="Nightly WebKit refresh"
                sub="Rebuilds the dashboard document before long-running WebKit pressure can accumulate."
                control={
                  <Switch
                    label="Nightly WebKit refresh"
                    checked={maintenanceConfiguration.enabled}
                    disabled={savingMaintenance}
                    onChange={(enabled) =>
                      updateMaintenance({ enabled, time: maintenanceConfiguration.time })
                    }
                  />
                }
              />,
              <RowShell
                key="time"
                label="Maintenance time"
                sub="Uses this iPad's local clock. The screen briefly shows a dark refresh cover."
                control={
                  <div
                    aria-disabled={savingMaintenance}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      opacity: savingMaintenance ? 0.55 : 1,
                      pointerEvents: savingMaintenance ? "none" : "auto",
                    }}
                  >
                    <WheelPicker
                      label="Maintenance hour"
                      values={HOURS}
                      value={timeParts.hour}
                      visibleRows={3}
                      width={68}
                      onChange={(hour) =>
                        updateMaintenance({
                          enabled: maintenanceConfiguration.enabled,
                          time: maintenanceTime(hour, timeParts.minute),
                        })
                      }
                    />
                    <span aria-hidden style={{ fontSize: 22, color: "var(--ink-2)" }}>
                      :
                    </span>
                    <WheelPicker
                      label="Maintenance minute"
                      values={MINUTES}
                      value={timeParts.minute}
                      visibleRows={3}
                      width={68}
                      onChange={(minute) =>
                        updateMaintenance({
                          enabled: maintenanceConfiguration.enabled,
                          time: maintenanceTime(timeParts.hour, minute),
                        })
                      }
                    />
                  </div>
                }
              />,
              <RowShell
                key="next"
                label="Next refresh"
                sub="The native app stays running, so Guided Access and continuous uptime are preserved."
                control={
                  <span style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--ink)" }}>
                    {nextRunLabel(maintenanceConfiguration.nextRunAtMs)}
                  </span>
                }
              />,
              <RowShell
                key="run-now"
                label="Refresh now"
                sub="Runs the same bounded reset now to verify the transition without waiting overnight."
                control={
                  <ActionButton
                    disabled={savingMaintenance}
                    onClick={() => void maintenance.runNow()}
                  >
                    Run now
                  </ActionButton>
                }
              />,
            ]
          : [
              <RowShell
                key="availability"
                label="Nightly WebKit refresh"
                sub={
                  maintenanceState.status === "loading"
                    ? "Reading the installed Panel app…"
                    : "Available after installing the latest TestFlight Panel build."
                }
                control={
                  <span style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--ink-3)" }}>
                    {maintenanceState.status === "loading" ? "Checking…" : "Unavailable"}
                  </span>
                }
              />,
            ]}
      </SectionCard>
    </>
  );
}

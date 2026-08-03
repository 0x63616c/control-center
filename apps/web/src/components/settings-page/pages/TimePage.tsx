import { setGoalDayCutoffHour, setTimeZone, useSettings } from "../../../lib/settings";
import { RowShell, SectionCard } from "../blocks";
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

export function TimePage(_props: PageProps) {
  const { goalDayCutoffHour, timeZone } = useSettings();

  return (
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
  );
}

import { useSettings } from "./settings";

/** The selected installation zone, shared by every panel-facing date formatter. */
export function useTimeZone(): string {
  return useSettings().timeZone;
}

/** Read the named calendar parts instead of using the browser or server zone. */
export function timeZoneParts(date: Date, timeZone: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

/** Hour on a 0–23 clock, kept separate from the 12-hour display parts. */
export function timeZoneHour(date: Date, timeZone: string): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" })
    .formatToParts(date)
    .find((value) => value.type === "hour");
  return Number(part?.value) || 0;
}

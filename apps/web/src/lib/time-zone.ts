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

/** Format an instant without falling back to the browser's local zone. */
export function formatInTimeZone(instant: Date | string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(new Date(instant));
}

/** The configured calendar date containing an instant, retained as a date key. */
export function timeZoneDateKey(instant: Date | string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value;
  return [part("year"), part("month"), part("day")].join("-");
}

/** Render a YYYY-MM-DD key as a date, never as browser-local midnight. */
export function formatDateKey(dateKey: string, options: Intl.DateTimeFormatOptions): string {
  const [year, month, day] = dateKey.split("-");
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(new Date(`${year}-${month}-${day}T12:00:00Z`));
}

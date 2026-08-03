import { HOME_LABEL } from "@/config/home";
import { useNow } from "@/lib/hooks";
import { timeZoneHour, timeZoneParts, useTimeZone } from "@/lib/time-zone";
import { ClockGreetingView } from "./ClockGreetingView";

function greeting(hour: number): string {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Good night";
}

export function ClockGreeting() {
  const d = useNow();
  const timeZone = useTimeZone();
  const parts = timeZoneParts(d, timeZone);
  const rawHour = timeZoneHour(d, timeZone);
  const hour12 = Number(parts.hour) || 12;
  const minutes = parts.minute ?? "00";
  const ampm = parts.dayPeriod === "PM" ? "PM" : "AM";
  const fullDate = `${parts.weekday}, ${parts.month} ${parts.day}`;

  return (
    <ClockGreetingView
      greeting={greeting(rawHour)}
      hour12={hour12}
      minutes={minutes}
      ampm={ampm}
      fullDate={fullDate}
      location={HOME_LABEL}
      seconds={Number(parts.second) || 0}
    />
  );
}

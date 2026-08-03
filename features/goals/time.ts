/** A local goal-day is a date key, deliberately not an instant. */
export type GoalDay = `${number}-${number}-${number}`;

function partsAt(date: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function shiftGoalDay(day: string, amount: number): GoalDay {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + amount));
  return shifted.toISOString().slice(0, 10) as GoalDay;
}

export function goalDayAt(now: Date, timeZone: string, cutoffHour: number): GoalDay {
  const parts = partsAt(now, timeZone);
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return Number(parts.hour) < cutoffHour ? shiftGoalDay(day, -1) : (day as GoalDay);
}

/** Monday is the explicit, stable first day for weekly goals. */
export function mondayOf(day: string): GoalDay {
  const [year, month, date] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return shiftGoalDay(day, weekday === 0 ? -6 : 1 - weekday);
}

export function weekdayOf(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

/**
 * Weather ingest (Track C, Wave 7 fold — was apps/api's weather-ingest-service.ts).
 * Registered as a 5-minute App-owned interval through worker.ts. It is not a
 * durable queue job or a Temporal Schedule.
 */
import { createPgIntegrationSyncStore, heartbeat, runCycle } from "@www/core";
import { getLogger } from "@www/logger";
import { z } from "zod";

import { config } from "./config";
import { db } from "./db";
import { weatherDailyReading, weatherReading } from "./schema";

const INGEST_INTEGRATION_ID = "weather";

// This feature's own integration-sync store, over its own drizzle db (mirrors
// the shared pg adapter's pattern against this App's db).
const integrationSyncStore = createPgIntegrationSyncStore(db);

// Edge schema: Open-Meteo's response is parsed here so the ingest cycle works
// with validated data and a malformed/changed payload fails loudly at the
// boundary instead of writing garbage rows (www-355t.16). The type is inferred
// from the schema so there's a single source of truth.
const openMeteoBundleSchema = z.object({
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    apparent_temperature: z.number(),
    relative_humidity_2m: z.number(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
    is_day: z.number(),
    uv_index: z.number(),
  }),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(z.number()),
    apparent_temperature: z.array(z.number()),
    relative_humidity_2m: z.array(z.number()),
    weather_code: z.array(z.number()),
    wind_speed_10m: z.array(z.number()),
    is_day: z.array(z.number()),
    precipitation_probability: z.array(z.number().nullable()),
  }),
  daily: z.object({
    time: z.array(z.string()),
    temperature_2m_max: z.array(z.number()),
    temperature_2m_min: z.array(z.number()),
    weather_code: z.array(z.number()),
    precipitation_probability_max: z.array(z.number().nullable()),
    sunrise: z.array(z.string()),
    sunset: z.array(z.string()),
  }),
});

export type OpenMeteoBundle = z.infer<typeof openMeteoBundleSchema>;

// One Open-Meteo call per ingest cycle. past_days=1 returns the recently settled
// hours (used to record observed actuals); forecast_days=7 gives 24h+ of forward
// hourly plus the 7-day daily outlook the week modal needs.
export async function fetchOpenMeteoBundle(
  lat = config.HOME_LAT,
  lon = config.HOME_LON,
): Promise<OpenMeteoBundle> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day,uv_index` +
    `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day,precipitation_probability` +
    `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,sunrise,sunset` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&past_days=1&forecast_days=7`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return openMeteoBundleSchema.parse(await res.json());
}

// Round to the current wall-clock hour. timezone=auto means Open-Meteo's
// strings are already location-local, so a past hour < this boundary becomes an
// observed actual and the current hour and beyond become forecasts.
function hourBoundaryMs(): number {
  const h = new Date();
  h.setMinutes(0, 0, 0);
  return h.getTime();
}

// Routed through the shared runCycle helper (www-bd0c) instead of a hand-rolled
// try/catch/heartbeat block: this cycle used to swallow its own errors after
// recording the heartbeat, which hid every ingest failure from the worker
// runtime's onset/recovery liveness logging (docs/logging.md §6) the same way
// the other four heartbeat-backed cycles did before the fix.
export async function runWeatherIngestCycle(): Promise<void> {
  await runCycle(
    heartbeat(integrationSyncStore, INGEST_INTEGRATION_ID),
    "weather-ingest",
    async () => {
      const bundle = await fetchOpenMeteoBundle();
      const now = new Date();
      const boundary = hourBoundaryMs();
      const h = bundle.hourly;

      const hourlyRows = h.time.map((iso, i) => {
        const target = new Date(iso);
        const isPast = target.getTime() < boundary;
        return {
          kind: isPast ? ("observed" as const) : ("forecast" as const),
          targetHour: target,
          recordedAt: now,
          tempF: Math.round(h.temperature_2m[i]),
          feelsF: Math.round(h.apparent_temperature[i]),
          humidity: Math.round(h.relative_humidity_2m[i]),
          weatherCode: h.weather_code[i],
          windMph: Math.round(h.wind_speed_10m[i]),
          isDay: h.is_day[i] === 1,
          precipProbability: h.precipitation_probability[i] ?? null,
          uvIndex: null as number | null, // uv only present on `current`, not hourly
        };
      });
      if (hourlyRows.length > 0) await db.insert(weatherReading).values(hourlyRows);

      const d = bundle.daily;
      const dailyRows = d.time.map((date, i) => ({
        targetDate: date,
        recordedAt: now,
        hiF: Math.round(d.temperature_2m_max[i]),
        loF: Math.round(d.temperature_2m_min[i]),
        weatherCode: d.weather_code[i],
        precipProbability:
          d.precipitation_probability_max[i] == null
            ? null
            : Math.round(d.precipitation_probability_max[i] as number),
        sunriseIso: d.sunrise[i] ?? null,
        sunsetIso: d.sunset[i] ?? null,
      }));
      if (dailyRows.length > 0) await db.insert(weatherDailyReading).values(dailyRows);

      // Log every successful cycle, including a degenerate 0/0 response, so a
      // live-but-quiet ingest is distinguishable from a wedged one that has
      // stopped running (this cycle's own heartbeat write is a silent DB row,
      // not a log line the worker's stdout/kubectl logs would show).
      getLogger().info(
        { hourlyRows: hourlyRows.length, dailyRows: dailyRows.length },
        "weather ingest cycle completed",
      );
    },
  );
}

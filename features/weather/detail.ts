import { defineTileViews } from "@app-kit";
import { next12HoursDetailEntry } from "./web/wiring/next12hours";
import { weatherDetailEntry } from "./web/wiring/weather";

export const tileViews = defineTileViews([next12HoursDetailEntry, weatherDetailEntry]);

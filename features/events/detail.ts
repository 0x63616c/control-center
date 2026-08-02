import { defineTileViews } from "@app-kit";
import { clockDetailEntry } from "./web/wiring/clock";
import { eventsDetailEntry } from "./web/wiring/events";

export const tileViews = defineTileViews([clockDetailEntry, eventsDetailEntry]);

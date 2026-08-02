import { defineTileViews } from "@app-kit";
import { tvDetailEntry } from "./web/wiring/tv";
import { tvAppsDetailEntry } from "./web/wiring/tv-apps";

export const tileViews = defineTileViews([tvAppsDetailEntry, tvDetailEntry]);

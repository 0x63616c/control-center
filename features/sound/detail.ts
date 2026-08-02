import { defineTileViews } from "@app-kit";
import { quickPlayDetailEntry } from "./web/wiring/quickplay";
import { soundDetailEntry } from "./web/wiring/sound";

export const tileViews = defineTileViews([quickPlayDetailEntry, soundDetailEntry]);

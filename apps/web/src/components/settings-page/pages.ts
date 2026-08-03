/**
 * Settings-page registry , the ordered list of pages the full-page Settings
 * sidebar renders, each with its tinted icon chip and one-line blurb. Copied
 * from approved Concept A (`SettingsConceptGroupedCards`), with a Security page
 * inserted between Notifications and Debug.
 *
 * #64: Debug and About folded into Device (build info + the developer
 * overlay toggle now live there instead of on their own pages), so those two
 * keys are gone , 10 pages down to 8.
 */

import type { IconName } from "../Icon";

export type PageKey =
  | "device"
  | "display"
  | "sound"
  | "board"
  | "network"
  | "notifications"
  | "security"
  | "time"
  | "logs";

export interface PageDef {
  key: PageKey;
  label: string;
  icon: IconName;
  /** Tinted chip color for the iOS-style sidebar. */
  tint: string;
  blurb: string;
  /**
   * Render the page body at the shell's full height with no 720px column cap,
   * so a component that owns its own internal scroll region (the log viewer)
   * gets the definite height its `height:100%` child needs. Non-fill pages keep
   * the scrolling 720px column.
   */
  fill?: boolean;
}

export const PAGES: PageDef[] = [
  {
    key: "device",
    label: "Device",
    icon: "settings",
    tint: "#8e8e93",
    blurb: "Name, battery, build, developer tools",
  },
  {
    key: "display",
    label: "Display",
    icon: "sun",
    tint: "#e0a83c",
    blurb: "Brightness and idle dimming",
  },
  {
    key: "sound",
    label: "Sound",
    icon: "speaker",
    tint: "#c77dbb",
    blurb: "Panel output volume",
  },
  { key: "board", label: "Board", icon: "apps", tint: "#4a90d9", blurb: "Snap, minimap, layout" },
  {
    key: "network",
    label: "Network",
    icon: "wifi",
    tint: "#43a56c",
    blurb: "Wi-Fi and connectivity",
  },
  {
    key: "notifications",
    label: "Notifications",
    icon: "bell",
    tint: "#c95c5c",
    blurb: "Push and category mutes",
  },
  {
    key: "security",
    label: "Security",
    icon: "lock",
    // Indigo, not the red it used to share with Notifications , adjacent rows
    // in the sidebar read as one group when their chips are the same hue. Kept
    // clear of Board's sky blue (#4a90d9).
    tint: "#5c6bc0",
    blurb: "PIN for locked tiles and settings",
  },
  {
    key: "time",
    label: "Time",
    icon: "globe",
    tint: "#7e89c2",
    blurb: "Time zone and day boundaries",
  },
  {
    key: "logs",
    label: "Logs",
    icon: "apps",
    tint: "#5aa2c7",
    blurb: "On-device log viewer",
    fill: true,
  },
];

export const PAGE_BY_KEY = Object.fromEntries(PAGES.map((p) => [p.key, p])) as Record<
  PageKey,
  PageDef
>;

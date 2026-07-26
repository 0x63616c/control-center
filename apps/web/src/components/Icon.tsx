import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bell,
  Calendar,
  Camera,
  Car,
  ChevronRight,
  Cloud,
  CloudSun,
  Dog,
  Fan,
  Globe,
  Lamp,
  LayoutGrid,
  Lightbulb,
  LightbulbOff,
  Lock,
  LockOpen,
  MapPin,
  Moon,
  PawPrint,
  Plus,
  QrCode,
  Settings,
  Sparkles,
  Sun,
  Thermometer,
  Timer,
  Users,
  Video,
  Volume2,
  Weight,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";

export type IconName =
  | "sun"
  | "moon"
  | "cloud"
  | "cloud-sun"
  | "lamp"
  | "bulb"
  | "bulb-off"
  | "fan"
  | "thermo"
  | "car"
  | "bolt"
  | "lock"
  | "unlock"
  | "wifi"
  | "wifi-off"
  | "pin"
  | "cam"
  | "camera"
  | "timer"
  | "dog"
  | "paw"
  | "calendar"
  | "plus"
  | "qr-code"
  | "bell"
  | "chevron"
  | "up"
  | "down"
  | "sparkles"
  | "globe"
  | "speaker"
  | "apps"
  | "settings"
  | "groups"
  | "weight"
  | "alert";

export interface IconProps {
  name: IconName;
  /** Square size in px. */
  s?: number;
  /** Stroke color (defaults to currentColor). */
  c?: string;
  /** Stroke width. */
  sw?: number;
}

// The icon vocabulary is a deliberately small, curated set (a fixed wall panel,
// not a free-for-all). Each IconName maps to one lucide-react glyph; the wrapper
// below enforces the house conventions (size scale, stroke width, currentColor,
// a11y) in ONE place, so the library stays swappable and call sites never inline
// per-icon styling. Adding an icon = add a union member + a lucide glyph here.
export const GLYPHS: Record<IconName, LucideIcon> = {
  sun: Sun,
  moon: Moon,
  cloud: Cloud,
  "cloud-sun": CloudSun,
  lamp: Lamp,
  bulb: Lightbulb,
  "bulb-off": LightbulbOff,
  fan: Fan,
  thermo: Thermometer,
  car: Car,
  bolt: Zap,
  lock: Lock,
  unlock: LockOpen,
  wifi: Wifi,
  "wifi-off": WifiOff,
  pin: MapPin,
  cam: Video,
  camera: Camera,
  timer: Timer,
  dog: Dog,
  paw: PawPrint,
  calendar: Calendar,
  plus: Plus,
  "qr-code": QrCode,
  bell: Bell,
  chevron: ChevronRight,
  up: ArrowUp,
  down: ArrowDown,
  sparkles: Sparkles,
  globe: Globe,
  speaker: Volume2,
  apps: LayoutGrid,
  settings: Settings,
  groups: Users,
  weight: Weight,
  alert: AlertCircle,
};

export function Icon({ name, s = 22, c = "currentColor", sw = 1.7 }: IconProps) {
  const Glyph = GLYPHS[name];
  // lucide maps size→width/height, color→stroke, strokeWidth→stroke-width, and
  // stamps a `lucide-<name>` class. We keep the same block/flex layout + aria the
  // hand-drawn svg used so nothing downstream shifts.
  return (
    <Glyph
      size={s}
      color={c}
      strokeWidth={sw}
      style={{ display: "block", flex: "0 0 auto" }}
      aria-hidden="true"
    />
  );
}

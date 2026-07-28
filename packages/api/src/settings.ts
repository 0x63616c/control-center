// Re-export the settings contract for the web client. Unlike ./trpc, this is a
// VALUE re-export , the constants really do ship in the browser bundle. That is
// safe only because `@control-center/api/contract` imports nothing at all; keep
// it that way, or the panel starts pulling drizzle and pg over the wire.
export {
  ACCENTS,
  type Accent,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  DIM_MAX,
  DIM_MIN,
  PIN_PAD_LAYOUTS,
  type PinPadLayout,
  SETTINGS_DEFAULTS,
  SNAP_MODES,
  type SnapMode,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  TYPEFACES,
  type Typeface,
} from "@control-center/api/contract";

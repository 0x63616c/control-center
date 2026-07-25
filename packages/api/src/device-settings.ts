// Re-export the per-device settings contract for the web client. Like ./settings
// this is a VALUE re-export , the constants really do ship in the browser bundle.
// That is safe only because `@control-center/api/contract-device-settings`
// imports nothing at all; keep it that way, or the panel starts pulling drizzle
// and pg over the wire.
export {
  DEVICE_SETTINGS_DEFAULTS,
  NAME_MAX_LENGTH,
  VOLUME_MAX,
  VOLUME_MIN,
} from "@control-center/api/contract-device-settings";

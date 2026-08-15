#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SERVER_URL="${TYE_IOS_SERVER_URL:-http://192.168.0.250:5173}"
COREDEVICE_ID="${TYE_IOS_DEVICE_ID:-2F181E57-7722-5F53-8BBB-A505A1C33979}"
DESTINATION_ID="${TYE_IOS_DESTINATION_ID:-00008140-00100894367B001C}"
DEVELOPMENT_TEAM="${TYE_IOS_DEVELOPMENT_TEAM:-X9E4HG27NK}"
DERIVED_DATA="${TYE_IOS_DERIVED_DATA:-ios/DerivedData/$DESTINATION_ID}"
APP_PATH="$DERIVED_DATA/Build/Products/Debug-iphoneos/App.app"
CONFIG_PATH="ios/App/App/capacitor.config.json"

printf 'Preparing Text Your Ex for iPhone (%s)\n' "$COREDEVICE_ID"
printf 'Live reload: %s\n' "$SERVER_URL"

bunx cap sync ios

node --input-type=module - "$SERVER_URL" "$CONFIG_PATH" <<'NODE'
import fs from "node:fs";

const [serverUrl, configPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.server = { url: serverUrl, cleartext: serverUrl.startsWith("http://") };
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE

xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Debug \
  -destination "platform=iOS,id=$DESTINATION_ID" \
  -derivedDataPath "$DERIVED_DATA" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
  build

plutil -extract server raw "$APP_PATH/capacitor.config.json" >/dev/null
/usr/bin/codesign -d --entitlements :- "$APP_PATH" >/dev/null

xcrun devicectl device install app --device "$COREDEVICE_ID" "$APP_PATH"
xcrun devicectl device process launch --device "$COREDEVICE_ID" --terminate-existing co.worldwidewebb.textyourex

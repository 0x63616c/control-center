import type { LightColor } from "./schema";

const XY_PRECISION = 1_000;
const RGB_CHANNEL_TOLERANCE = 12;
const XY_COMPONENT_TOLERANCE = 0.005;
const KELVIN_TOLERANCE = 250;

function linearizeSrgb(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function roundXy(component: number): number {
  return Math.round(component * XY_PRECISION) / XY_PRECISION;
}

/** Convert an sRGB color intent to the CIE 1931 xy mode used by Hue lights. */
export function rgbToXy(rgb: Readonly<NonNullable<LightColor["rgb"]>>): [number, number] {
  const red = linearizeSrgb(rgb[0]);
  const green = linearizeSrgb(rgb[1]);
  const blue = linearizeSrgb(rgb[2]);
  const x = red * 0.4124 + green * 0.3576 + blue * 0.1805;
  const y = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  const z = red * 0.0193 + green * 0.1192 + blue * 0.9505;
  const sum = x + y + z;
  if (sum === 0) return [0, 0];
  return [roundXy(x / sum), roundXy(y / sum)];
}

/** Compare desired and reported colors using HA round-trip tolerances. */
export function lightColorConverged(
  desired: LightColor | undefined,
  reported: LightColor | undefined,
): boolean {
  if (!desired && !reported) return true;
  if (!desired || !reported) return false;
  if (desired.kelvin != null || reported.kelvin != null) {
    return (
      desired.kelvin != null &&
      reported.kelvin != null &&
      Math.abs(desired.kelvin - reported.kelvin) <= KELVIN_TOLERANCE
    );
  }
  if (desired.xy || reported.xy) {
    return (
      !!desired.xy &&
      !!reported.xy &&
      desired.xy.every(
        (component, index) => Math.abs(component - reported.xy[index]) <= XY_COMPONENT_TOLERANCE,
      )
    );
  }
  return (
    !!desired.rgb &&
    !!reported.rgb &&
    desired.rgb.every(
      (channel, index) => Math.abs(channel - reported.rgb[index]) <= RGB_CHANNEL_TOLERANCE,
    )
  );
}

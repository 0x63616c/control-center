import { describe, expect, it } from "vitest";

import { rgbToXy } from "../src/device-state/color";

describe("rgbToXy", () => {
  it("converts sRGB primaries into CIE 1931 xy coordinates", () => {
    expect(rgbToXy([255, 0, 0])).toEqual([0.64, 0.33]);
    expect(rgbToXy([0, 0, 255])).toEqual([0.15, 0.06]);
  });
});

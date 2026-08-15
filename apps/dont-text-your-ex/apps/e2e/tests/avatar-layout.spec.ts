import { expect, test } from "@playwright/test";
import { startSignUpNew } from "./helpers";

test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
});

async function rowCounts(page: import("@playwright/test").Page, label: RegExp): Promise<number[]> {
  const tops = await page
    .getByRole("button", { name: label })
    .evaluateAll((buttons) =>
      buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
    );
  return [...new Set(tops)].map((top) => tops.filter((candidate) => candidate === top).length);
}

for (const device of [
  { name: "iPhone 16 Pro", width: 402, height: 874 },
  { name: "iPhone 16 Pro Max", width: 440, height: 956 },
]) {
  test(`profile choices stay eight-across on ${device.name}`, async ({ page }) => {
    const { width, height } = device;
    await page.setViewportSize({ width, height });
    await startSignUpNew(page);
    expect(await rowCounts(page, /Use (?:initials|.+) avatar/)).toEqual([8]);
    expect(await rowCounts(page, /Use profile color/)).toEqual([8]);
  });
}

test("truly narrow phones use balanced four-by-two rows without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await startSignUpNew(page);
  expect(await rowCounts(page, /Use (?:initials|.+) avatar/)).toEqual([4, 4]);
  expect(await rowCounts(page, /Use profile color/)).toEqual([4, 4]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

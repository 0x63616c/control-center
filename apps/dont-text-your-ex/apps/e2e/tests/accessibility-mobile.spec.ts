import { expect, test } from "@playwright/test";
import { signInAsCalum } from "./helpers";

test.use({ viewport: { width: 320, height: 700 }, hasTouch: true });

test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
});

test("320px touch layout keeps named controls reachable and keyboard-operable", async ({
  page,
}) => {
  await signInAsCalum(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  const createJar = page.getByRole("button", { name: "Create jar" });
  const createBox = await createJar.boundingBox();
  // Chromium can report a 44 CSS-pixel edge as 43.999998 after device-pixel
  // conversion. Keep a sub-pixel tolerance without accepting a 43px target.
  expect(createBox?.width).toBeGreaterThan(43.9);
  expect(createBox?.height).toBeGreaterThan(43.9);
  await createJar.tap();

  await expect(page.getByText("New jar", { exact: true })).toBeVisible();
  const back = page.getByRole("button", { name: "Back" });
  const backBox = await back.boundingBox();
  expect(backBox?.width).toBeGreaterThan(43.9);
  expect(backBox?.height).toBeGreaterThan(43.9);
  await back.tap();

  await page.getByTestId("tab-profile").tap();
  const share = page.getByRole("switch", { name: /Share streak for/ }).first();
  const before = await share.getAttribute("aria-checked");
  const shareBox = await share.boundingBox();
  expect(shareBox?.height).toBeGreaterThan(43.9);
  await share.focus();
  await page.keyboard.press("Space");
  await expect(share).not.toHaveAttribute("aria-checked", before ?? "false");
});

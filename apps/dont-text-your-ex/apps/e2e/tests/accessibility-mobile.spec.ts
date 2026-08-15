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
  expect(createBox?.width).toBeGreaterThanOrEqual(44);
  expect(createBox?.height).toBeGreaterThanOrEqual(44);
  await createJar.tap();

  await expect(page.getByText("New jar", { exact: true })).toBeVisible();
  const back = page.getByRole("button", { name: "Back" });
  const backBox = await back.boundingBox();
  expect(backBox?.width).toBeGreaterThanOrEqual(44);
  expect(backBox?.height).toBeGreaterThanOrEqual(44);
  await back.tap();

  await page.getByTestId("tab-profile").tap();
  const share = page.getByRole("switch", { name: /Share streak for/ }).first();
  const before = await share.getAttribute("aria-checked");
  const shareBox = await share.boundingBox();
  expect(shareBox?.height).toBeGreaterThanOrEqual(44);
  await share.focus();
  await page.keyboard.press("Space");
  await expect(share).not.toHaveAttribute("aria-checked", before ?? "false");
});

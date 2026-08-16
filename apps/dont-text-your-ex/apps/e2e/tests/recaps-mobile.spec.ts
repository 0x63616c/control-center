import { expect, test } from "@playwright/test";
import { signInAsCalum } from "./helpers";

const mobileViewport = { width: 390, height: 844 };
const recap = {
  id: "rcp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  jarId: "jar_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  jarName: "The Group Chat",
  calendarMonth: "2026-07",
  timezone: "America/Los_Angeles",
  periodStartAt: 1_782_889_200_000,
  periodEndAt: 1_785_567_600_000,
  slipCount: 2,
  totalAmountCents: 1_200,
  tallyChangeCents: 1_200,
  sharedStreakHighlights: [{ days: 7, count: 2 }],
  crossedMilestonesCents: [1_000],
  createdAt: 1_788_246_000_000,
};

test.beforeEach(async ({ page, request }) => {
  await request.post("/api/test/reset");
  await page.setViewportSize(mobileViewport);
  await signInAsCalum(page);
  await page.getByTestId("tab-profile").click();
});

test("mobile recaps expose loading, offline, retry, and populated states", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/recaps", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return route.abort("internetdisconnected");
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([recap]),
    });
  });

  await page.getByRole("button", { name: "Monthly recaps" }).click();
  await expect(page.getByText("Loading recaps…")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("couldn’t be loaded");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "The Group Chat" })).toBeVisible();
  await expect(page.getByText("July 2026")).toBeVisible();
  await expect(page.getByText("2 × 7 days", { exact: false })).toBeVisible();
  expect(attempts).toBe(2);
});

test("mobile recaps distinguish empty from unavailable", async ({ page }) => {
  await page.route("**/api/recaps", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.getByRole("button", { name: "Monthly recaps" }).click();
  await expect(page.getByRole("status")).toContainText("No recaps yet");

  await page.getByRole("button", { name: "Back" }).click();
  await page.unroute("**/api/recaps");
  await page.route("**/api/recaps", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not_found"}' }),
  );
  await page.getByRole("button", { name: "Monthly recaps" }).click();
  await expect(page.getByRole("status")).toContainText("no longer available");
});

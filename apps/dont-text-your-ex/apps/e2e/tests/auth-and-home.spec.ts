import { expect, test } from "@playwright/test";
import { openJar, signInAsCalum } from "./helpers";

// Each test starts from the seeded baseline (non-prod reset seam) so
// absolute assertions on seeded values stay order-independent.
test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
});

test("onboarding shows the wordmark and taglines", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Don't\s*Text\s*Your\s*Ex/i })).toBeVisible();
  await expect(page.getByText("Stop texting your ex.")).toBeVisible();
  await expect(page.getByText("Payments coming soon.", { exact: false })).toHaveCount(0);
});

test("Apple sign-in lands on home with seeded jars and total damage", async ({ page }) => {
  await signInAsCalum(page);
  // Calum is in two jars; total damage = 4000 + 3000 = $70
  await expect(page.getByTestId("total-damage")).toHaveText("$70");
  await expect(page.getByText("The Group Chat")).toBeVisible();
  await expect(page.getByText("Dry January (Failed)")).toBeVisible();
});

test("jar detail shows the pot, rule, and wall of shame ordered by tally", async ({ page }) => {
  await signInAsCalum(page);
  await openJar(page, "The Group Chat");
  // pot total = 6500 + 4000 = $105
  await expect(page.getByTestId("jar-pot")).toHaveText("$105");
  await expect(
    page.getByText("Don't text your ex. We all know who.", { exact: false }),
  ).toBeVisible();
  // Ali leads the wall of shame ($65)
  const rows = page.getByTestId("shame-row");
  await expect(rows.first()).toContainText("Ali");
  await expect(rows.first()).toContainText("$65");
});

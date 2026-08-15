import { expect, test } from "@playwright/test";
import { openJar, signInAsCalum, signUpNew } from "./helpers";

// Each test starts from the seeded baseline (non-prod reset seam) so
// absolute assertions on seeded values stay order-independent.
test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
});

test("create a jar → invite screen shows a code → land in the new jar", async ({ page }) => {
  await signUpNew(page, "Maker");
  await page.getByTestId("create-jar").click();
  await expect(page.getByText("New jar")).toBeVisible();

  await page.getByPlaceholder("“The Group Chat”").fill("My Test Jar");
  await page.getByPlaceholder("“Don't text your ex. We mean it.”").fill("no texting allowed");
  await page.getByRole("button", { name: "Create jar & invite friends" }).click();

  await expect(page.getByText("Your jar code")).toBeVisible();
  await expect(page.getByText("Jar created.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Take me to my jar" }).click();
  await expect(page.getByText("My Test Jar")).toBeVisible();
  await expect(page.getByTestId("jar-pot")).toHaveText("$0");
});

test("settle up is inert with a 'payments coming soon' badge", async ({ page }) => {
  await signInAsCalum(page);
  await openJar(page, "The Group Chat");
  await page.getByRole("button", { name: "Settle up" }).click();
  await expect(page.getByText("YOU OWE THE JAR")).toBeVisible();
  await expect(page.getByText("Payments coming soon")).toBeVisible();
  await expect(page.getByText("guilt scoreboard", { exact: false })).toBeVisible();
});

test("profile: edit name and toggle share-streak", async ({ page }) => {
  await signInAsCalum(page);
  await page.getByTestId("tab-profile").click();
  await expect(page.getByText("Share my clean streak")).toBeVisible();

  // edit name
  await page.getByText("Edit", { exact: true }).click();
  await expect(page.getByText("Edit profile")).toBeVisible();
  const nameInput = page.getByPlaceholder("Your name");
  await nameInput.fill("Calum the Weak");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Calum the Weak")).toBeVisible();

  // toggle the first jar's share-streak switch and confirm the subtitle flips
  const firstShareRow = page.getByTestId("share-row").first();
  const wasHidden = (await firstShareRow.innerText()).includes("Hidden");
  await firstShareRow.getByRole("button").click();
  await expect(firstShareRow).toContainText(wasHidden ? "Friends see your streak" : "Hidden");
});

test("activity tab shows the carnage feed", async ({ page }) => {
  await signInAsCalum(page);
  await page.getByTestId("tab-activity").click();
  // the feed renders slip rows with the roasty "caved" copy
  await expect(page.getByText("caved", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("That's all the carnage for now.")).toBeVisible();
});

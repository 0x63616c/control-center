import { expect, test } from "@playwright/test";
import { AuthResponseSchema } from "../../../contracts";
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

test("first-run unnamed Apple profile requires a name, persists it, and shows a useful empty home", async ({
  page,
}) => {
  const response = await page.request.post("/api/auth/dev", { data: { as: "new" } });
  expect(response.ok()).toBeTruthy();
  const { token, status, user } = AuthResponseSchema.parse(await response.json());
  expect(status).toBe("needs_profile");
  expect(user.name).toBe("");
  await page.addInitScript(
    (sessionToken) => localStorage.setItem("tye_token", sessionToken),
    token,
  );

  await page.goto("/");
  await expect(page.getByText("Make it official")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start the shame →" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Your name" }).fill("New Apple QA");
  await page.getByRole("button", { name: "Start the shame →" }).click();

  await expect(
    page.getByText("No jars yet. Start one and drag your friends down with you."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Join a jar with a code" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create jar" })).toBeVisible();

  await page.reload();
  await expect(
    page.getByText("No jars yet. Start one and drag your friends down with you."),
  ).toBeVisible();
  await page.getByTestId("tab-profile").click();
  await expect(page.getByText("New Apple QA", { exact: true })).toBeVisible();
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

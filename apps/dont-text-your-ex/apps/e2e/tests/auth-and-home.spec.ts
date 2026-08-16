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
  await expect(page.getByText("does not read your messages", { exact: false })).toBeVisible();
});

test("Apple sign-in lands on home with seeded jars and a virtual tally", async ({ page }) => {
  await signInAsCalum(page);
  // Calum is in two jars; the virtual tally is 4000 + 3000 cents = 70 pts.
  await expect(page.getByTestId("total-tally")).toHaveText("70 pts");
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
  await expect(page.getByText("Make it yours")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start your reset →" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Your name" }).fill("New Apple QA");
  await page.getByRole("button", { name: "Start your reset →" }).click();

  await expect(
    page.getByText("No jars yet. Start one with friends, or join with an invite code."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Join a jar with a code" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create jar" })).toBeVisible();

  await page.reload();
  await expect(
    page.getByText("No jars yet. Start one with friends, or join with an invite code."),
  ).toBeVisible();
  await page.getByTestId("tab-profile").click();
  await expect(page.getByText("New Apple QA", { exact: true })).toBeVisible();
});

test("jar detail shows the virtual tally, rule, and progress board ordered by tally", async ({
  page,
}) => {
  await signInAsCalum(page);
  await openJar(page, "The Group Chat");
  // Group tally = 6500 + 4000 cents = 105 pts.
  await expect(page.getByTestId("jar-total-tally")).toHaveText("105 pts");
  await expect(
    page.getByText("Don't text your ex. We all know who.", { exact: false }),
  ).toBeVisible();
  // Ali leads the progress board with 65 pts.
  const rows = page.getByTestId("progress-row");
  await expect(rows.first()).toContainText("Ali");
  await expect(rows.first()).toContainText("65 pts");
});

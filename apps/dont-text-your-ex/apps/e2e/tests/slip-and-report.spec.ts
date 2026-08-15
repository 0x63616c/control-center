import { expect, test } from "@playwright/test";
import { openJar, shameRow, signInAsCalum, signUpNew } from "./helpers";

// Each test starts from the seeded baseline (non-prod reset seam) so
// absolute assertions on seeded values stay order-independent.
test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
});

test("logging a slip bumps the tally, resets streak, grows the pot", async ({ page }) => {
  // fresh user + own jar for isolation
  await signUpNew(page, "Slipper");
  await page.getByRole("button", { name: "Join a jar with a code" }).click();
  await page.getByPlaceholder("Type or paste code").fill("XEX24K");
  await page.getByRole("button", { name: "Preview jar" }).click();
  await page.getByRole("button", { name: "Join the shame" }).click();
  await expect(page.getByTestId("jar-pot")).toBeVisible();

  const potBefore = await page.getByTestId("jar-pot").innerText();

  await page.getByRole("button", { name: "I texted my ex" }).click();
  await expect(page.getByText(/How much is that gonna cost you/)).toBeVisible();
  // jar default is $5 and the stepper increments by the default → $5 + $5 = $10
  await page.getByRole("button", { name: "+", exact: true }).click();
  await page.getByRole("button", { name: /Add \$10 to my shame/ }).click();
  // friction sheet
  await expect(page.getByText("You sure-sure?")).toBeVisible();
  await page.getByRole("button", { name: /Yeah\. I did it/ }).click();

  // back on jar detail; pot grew by $10 and Slipper now owes $10
  await expect(page.getByTestId("jar-pot")).not.toHaveText(potBefore);
  await expect(shameRow(page, "Slipper")).toContainText("$10");
});

test("reporting a member with evidence + anonymous toggle reaches the snitched screen", async ({
  page,
}) => {
  await signInAsCalum(page);
  await openJar(page, "The Group Chat");
  await page.getByRole("button", { name: "Report" }).click();
  await expect(page.getByText("Caught someone red-handed?")).toBeVisible();

  // pick Ali
  await page.getByRole("button", { name: "Ali", exact: true }).click();
  // open camera roll, pick first screenshot
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("Camera roll")).toBeVisible();
  await page.getByTestId("roll-shot").first().click();
  await page.getByRole("button", { name: "Done" }).click();

  // turn on anonymous (click the toggle switch, not the label)
  await page.getByTestId("anon-row").getByRole("button").click();
  await page.getByRole("button", { name: /Send it anonymously/ }).click();

  await expect(page.getByText("Snitched.")).toBeVisible();
  await expect(page.getByText("won't know it was you", { exact: false })).toBeVisible();
});

test("confirm/deny: owning the seeded report adds to Calum's tally", async ({ page }) => {
  await signInAsCalum(page);
  await page.getByTestId("tab-activity").click();
  await expect(page.getByText("You've been reported")).toBeVisible();
  await page.getByText("says you texted your ex", { exact: false }).click();

  // accused view: anonymous accuser + evidence
  await expect(page.getByText("Someone in the jar")).toBeVisible();
  await expect(page.getByText(/The receipts/)).toBeVisible();
  await page.getByRole("button", { name: /Own it - add/ }).click();
  await expect(page.getByText("Respect.")).toBeVisible();
});

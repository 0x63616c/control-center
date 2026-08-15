import { expect, test } from "@playwright/test";
import { openJar, shameRow, signInAsCalum } from "./helpers";

// Each test starts from the seeded baseline (non-prod reset seam) so
// absolute assertions on seeded values stay order-independent.
test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
});

test("logging a slip bumps the tally, resets streak, grows the pot", async ({ page }) => {
  await signInAsCalum(page);
  await openJar(page, "The Group Chat");

  const potBefore = await page.getByTestId("jar-pot").innerText();
  await expect(shameRow(page, "Calum")).toContainText("$40");

  await page.getByRole("button", { name: "I texted my ex" }).click();
  await expect(page.getByText(/How much is that gonna cost you/)).toBeVisible();
  // jar default is $5 and the stepper increments by the default → $5 + $5 = $10
  await page.getByRole("button", { name: "+", exact: true }).click();
  await page.getByRole("button", { name: /Add \$10 to my shame/ }).click();
  // friction sheet
  await expect(page.getByText("You sure-sure?")).toBeVisible();
  await page.getByRole("button", { name: /Yeah\. I did it/ }).click();

  // back on jar detail; pot grew by $10 and Calum's seeded $40 became $50
  await expect(page.getByTestId("jar-pot")).not.toHaveText(potBefore);
  await expect(shameRow(page, "Calum")).toContainText("$50");
});

test("reporting with a real screenshot + anonymous toggle reaches the snitched screen", async ({
  page,
}) => {
  await signInAsCalum(page);
  await openJar(page, "The Group Chat");
  await page.getByRole("button", { name: "Report" }).click();
  await expect(page.getByText("Caught someone red-handed?")).toBeVisible();

  // pick Ali
  await page.getByRole("button", { name: "Ali", exact: true }).click();
  await page.getByTestId("evidence-input").setInputFiles({
    name: "receipt.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.getByRole("img", { name: "Report attachment" })).toBeVisible();

  await page.getByRole("switch", { name: "Send anonymously" }).click();
  await page.getByRole("button", { name: /Send it anonymously/ }).click();

  await expect(page.getByText("Snitched.")).toBeVisible();
  await expect(page.getByText("won't know it was you", { exact: false })).toBeVisible();
});

test("report member fetch/send failures preserve every choice and retry without false success", async ({
  page,
}) => {
  await signInAsCalum(page);
  await openJar(page, "The Group Chat");

  let fetchAttempt = 0;
  await page.route("**/api/jars/*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    fetchAttempt += 1;
    if (fetchAttempt === 1)
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: '{"error":"not_authenticated"}',
      });
    if (fetchAttempt === 2)
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        body: '{"error":"forbidden"}',
      });
    if (fetchAttempt === 3)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"busy"}',
      });
    if (fetchAttempt === 4) return route.abort("internetdisconnected");
    return route.continue();
  });
  await page.getByRole("button", { name: "Report" }).click();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await expect(page.getByRole("alert")).toContainText("couldn’t be loaded");
    await expect(page.getByText("Caught someone red-handed?")).toHaveCount(0);
    await page.getByRole("button", { name: "Retry" }).click();
  }
  await expect(page.getByText("Caught someone red-handed?")).toBeVisible();

  await page.getByRole("button", { name: "Ali", exact: true }).click();
  const note = page.getByPlaceholder("“replied to her story in 4 seconds flat…”");
  await note.fill("Preserve this exact note");
  await page.getByTestId("evidence-input").setInputFiles({
    name: "retry-receipt.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  const anonymous = page.getByRole("switch", { name: "Send anonymously" });
  await anonymous.click();

  let submitAttempt = 0;
  await page.route("**/api/jars/*/reports", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submitAttempt += 1;
    if (submitAttempt === 1) return route.abort("internetdisconnected");
    return route.continue();
  });
  await page.getByRole("button", { name: "Send it anonymously" }).click();
  await expect(page.getByRole("alert")).toContainText("wasn’t sent");
  await expect(page.getByText("Snitched.")).toHaveCount(0);
  await expect(note).toHaveValue("Preserve this exact note");
  await expect(anonymous).toBeChecked();
  await expect(page.getByRole("img", { name: "Report attachment" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ali", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: "Retry sending report" }).click();
  await expect(page.getByText("Snitched.")).toBeVisible();
  await expect(page.getByText("Ali is getting pinged", { exact: false })).toBeVisible();
  await expect(page.getByText("won't know it was you", { exact: false })).toBeVisible();
  expect(submitAttempt).toBe(2);
});

test("confirm/deny: owning the seeded report adds to Calum's tally", async ({ page }) => {
  await signInAsCalum(page);
  await page.getByTestId("tab-activity").click();
  await expect(page.getByText("You've been reported")).toBeVisible();
  await page.getByText("says you texted your ex", { exact: false }).click();

  // The seeded report is note-only; evidence is never fabricated for tests.
  await expect(page.getByText("Someone in the jar")).toBeVisible();
  await expect(page.getByText(/Christie posted a story/)).toBeVisible();
  await expect(page.getByText(/The receipts/)).toHaveCount(0);
  await page.getByRole("button", { name: /Own it - add/ }).click();
  await expect(page.getByText("Respect.")).toBeVisible();

  // Resolution is durable: after a full reload the linked activity and history
  // both reach the owned report detail rather than losing it with the pending queue.
  await page.reload();
  await expect(page.getByText("Your jars", { exact: true })).toBeVisible();
  await page.getByTestId("tab-activity").click();
  await page.getByRole("button", { name: "View report in The Group Chat" }).click();
  await expect(page.getByText("Owned", { exact: true })).toBeVisible();
  await expect(page.getByText(/Christie posted a story/)).toBeVisible();
  await expect(page.getByText("Someone in the jar reported Calum")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "View report history" }).click();
  await expect(page.getByText("Report history", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Calum · The Group Chat/ }).click();
  await expect(page.getByText("Owned", { exact: true })).toBeVisible();
  await expect(page.getByText(/Christie posted a story/)).toBeVisible();
});

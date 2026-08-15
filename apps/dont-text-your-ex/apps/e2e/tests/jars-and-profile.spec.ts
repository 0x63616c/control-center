import { expect, test } from "@playwright/test";
import { openJar, signInAsCalum, signUpNew, signUpNewFromInvite } from "./helpers";

// Each test starts from the seeded baseline (non-prod reset seam) so
// absolute assertions on seeded values stay order-independent.
test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
});

test("create a jar → invite screen shows a code → land in the new jar", async ({ page }) => {
  await signUpNew(page);
  await page.getByTestId("create-jar").click();
  await expect(page.getByText("New jar")).toBeVisible();

  await page.getByPlaceholder("“The Group Chat”").fill("My Test Jar");
  await page.getByPlaceholder("“Don't text your ex. We mean it.”").fill("no texting allowed");

  let createAttempts = 0;
  await page.route("**/api/jars", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    createAttempts += 1;
    if (createAttempts === 1) return route.abort("internetdisconnected");
    return route.continue();
  });
  await page.getByRole("button", { name: "Create jar & invite friends" }).click();
  await expect(page.getByRole("alert")).toContainText("couldn’t be created");

  let inviteAttempts = 0;
  await page.route("**/api/jars/*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    inviteAttempts += 1;
    if (inviteAttempts === 1) {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"busy"}',
      });
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "Retry creating jar" }).click();
  expect(createAttempts).toBe(2);

  await expect(page.getByRole("alert")).toContainText("invite couldn’t be loaded");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Your jar code")).toBeVisible();
  await expect(page.getByText("Jar created.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Take me to my jar" }).click();
  await expect(page.getByText("My Test Jar")).toBeVisible();
  await expect(page.getByTestId("jar-pot")).toHaveText("$0");
  await page.reload();
  await expect(page.getByTestId("jar-card").filter({ hasText: "My Test Jar" })).toBeVisible();
});

test("production invite path survives profile setup → previews → joins the jar", async ({
  page,
}) => {
  await signUpNewFromInvite(page, "XEX24K");
  await expect(page.getByText("The Group Chat")).toBeVisible();
  await expect(page.getByText("$5")).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Members: Ali, Calum, Giselle, Alyssa" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  let joinAttempt = 0;
  await page.route("**/api/jars/join", async (route) => {
    joinAttempt += 1;
    if (joinAttempt === 1)
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        body: '{"error":"forbidden"}',
      });
    if (joinAttempt === 2)
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: '{"error":"jar_closed"}',
      });
    if (joinAttempt === 3)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"busy"}',
      });
    if (joinAttempt === 4) return route.abort("internetdisconnected");
    await route.continue();
  });
  await page.getByRole("button", { name: "Join the shame" }).click();
  await expect(page.getByRole("alert")).toContainText("don’t have permission");
  await page.getByRole("button", { name: "Retry joining jar" }).click();
  await expect(page.getByRole("alert")).toContainText("can’t be joined anymore");
  await page.getByRole("button", { name: "Retry joining jar" }).click();
  await expect(page.getByRole("alert")).toContainText("Check your connection");
  await page.getByRole("button", { name: "Retry joining jar" }).click();
  await expect(page.getByRole("alert")).toContainText("Check your connection");
  await page.getByRole("button", { name: "Retry joining jar" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("jar-pot")).toBeVisible();
  await expect(page.getByText("The Group Chat")).toBeVisible();
});

test("settle up is inert with a 'payments coming soon' badge", async ({ page }) => {
  await signInAsCalum(page);
  await openJar(page, "The Group Chat");
  await page.getByRole("button", { name: "Settle up" }).click();
  await expect(page.getByText("YOU OWE THE JAR")).toBeVisible();
  await expect(page.getByText("Payments coming soon")).toBeVisible();
  await expect(page.getByText("guilt scoreboard", { exact: false })).toBeVisible();
});

test("log slip fetch and submit failures stay retryable without false success", async ({
  page,
}) => {
  await signInAsCalum(page);
  await openJar(page, "The Group Chat");

  let detailAttempts = 0;
  await page.route("**/api/jars/*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    detailAttempts += 1;
    if (detailAttempts === 1) {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"busy"}',
      });
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "I texted my ex" }).click();
  await expect(page.getByRole("alert")).toContainText("jar couldn’t be loaded");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("button", { name: /Add .* to my shame/ })).toBeVisible();

  let slipAttempts = 0;
  await page.route("**/api/jars/*/slips", async (route) => {
    slipAttempts += 1;
    if (slipAttempts === 1) {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"busy"}',
      });
    }
    return route.continue();
  });
  await page.getByRole("button", { name: /Add .* to my shame/ }).click();
  await page.getByRole("button", { name: "Yeah. I did it. 💸" }).click();
  await expect(page.getByRole("alert")).toContainText("tally has not changed");
  await expect(page.getByText("You sure-sure?")).toBeVisible();
  expect(slipAttempts).toBe(1);
  await page.getByRole("button", { name: "Retry logging slip" }).click();
  await expect(page.getByTestId("jar-pot")).toBeVisible();
  expect(slipAttempts).toBe(2);
  await page.reload();
  await openJar(page, "The Group Chat");
  await expect(page.getByTestId("jar-pot")).toBeVisible();
});

test("profile: edit avatar and toggle share-streak", async ({ page }) => {
  await signInAsCalum(page);
  await page.getByTestId("tab-profile").click();
  await expect(page.getByText("Share my clean streak")).toBeVisible();

  // edit the profile avatar
  await page.getByText("Edit", { exact: true }).click();
  await expect(page.getByText("Edit profile")).toBeVisible();

  const invalidChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose profile photo" }).click();
  await (await invalidChooser).setFiles({
    name: "spoofed.png",
    mimeType: "image/png",
    buffer: Buffer.from("not a png"),
  });
  await expect(page.getByRole("alert")).toHaveText("Choose a real PNG, JPEG, or WebP image.");

  const validChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose profile photo" }).click();
  await (await validChooser).setFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.getByRole("button", { name: "Remove photo" })).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  const editProfile = page.getByRole("button", { name: /Edit$/ });
  await expect(editProfile.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);

  await page.reload();
  await page.getByTestId("tab-profile").click();
  await expect(page.getByRole("button", { name: /Edit$/ }).locator("img")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );

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

test("owner closes a jar → history survives → invite and mutations stay revoked", async ({
  page,
  request,
}) => {
  await signInAsCalum(page);
  await openJar(page, "Dry January (Failed)");

  const token = await page.evaluate(() => localStorage.getItem("tye_token"));
  if (!token) throw new Error("signed-in session token missing");
  const headers = { Authorization: `Bearer ${token}` };
  const jarsResponse = await request.get("/api/jars", { headers });
  const jars = (await jarsResponse.json()) as Array<{ id: string; name: string }>;
  const jar = jars.find((item) => item.name === "Dry January (Failed)");
  if (!jar) throw new Error("owner jar missing");
  const detailResponse = await request.get(`/api/jars/${jar.id}`, { headers });
  const openDetail = (await detailResponse.json()) as { inviteCode: string };

  await page.getByRole("button", { name: "Close jar" }).click();
  await expect(page.getByRole("alert")).toContainText("Close this jar permanently?");
  await page.getByRole("button", { name: "Close jar permanently" }).click();
  await expect(page.getByRole("status")).toContainText("history is read-only");
  await expect(page.getByText("WALL OF SHAME", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "I texted my ex" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Invite people" })).toHaveCount(0);

  await page.reload();
  await openJar(page, "Dry January (Failed)");
  await expect(page.getByRole("status")).toContainText("history is read-only");
  expect((await request.get(`/api/jars/code/${openDetail.inviteCode}`, { headers })).status()).toBe(
    404,
  );
  const slip = await request.post(`/api/jars/${jar.id}/slips`, {
    headers: { ...headers, "Content-Type": "application/json" },
    data: { amountCents: 500 },
  });
  expect(slip.status()).toBe(409);
  expect(await slip.json()).toEqual({ error: "jar_closed" });
});

test("member confirms leave → loses access while owner-only close stays unavailable", async ({
  page,
  request,
}) => {
  await signInAsCalum(page);
  await openJar(page, "The Group Chat");
  await expect(page.getByRole("button", { name: "Close jar" })).toHaveCount(0);

  const token = await page.evaluate(() => localStorage.getItem("tye_token"));
  if (!token) throw new Error("signed-in session token missing");
  const headers = { Authorization: `Bearer ${token}` };
  const jarsResponse = await request.get("/api/jars", { headers });
  const jars = (await jarsResponse.json()) as Array<{ id: string; name: string }>;
  const jar = jars.find((item) => item.name === "The Group Chat");
  if (!jar) throw new Error("member jar missing");

  await page.getByRole("button", { name: "Leave jar" }).click();
  await expect(page.getByRole("alert")).toContainText("Leave this jar?");
  await page.getByRole("button", { name: "Leave jar permanently" }).click();
  await expect(page.getByText("Your jars")).toBeVisible();
  await expect(page.getByTestId("jar-card").filter({ hasText: "The Group Chat" })).toHaveCount(0);
  expect((await request.get(`/api/jars/${jar.id}`, { headers })).status()).toBe(403);

  await page.reload();
  await expect(page.getByText("Your jars")).toBeVisible();
  await expect(page.getByTestId("jar-card").filter({ hasText: "The Group Chat" })).toHaveCount(0);
});

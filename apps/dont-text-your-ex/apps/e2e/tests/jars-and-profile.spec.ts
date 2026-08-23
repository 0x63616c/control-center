import { expect, test } from "@playwright/test";
import { JarDetailSchema, JarSummarySchema } from "../../../contracts";
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
  await page
    .getByPlaceholder("“No texting our exes. We’ve got each other.”")
    .fill("no texting allowed");

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
  await expect(page.getByTestId("jar-total-tally")).toHaveText("0 pts");
  await page.reload();
  await expect(page.getByTestId("jar-card").filter({ hasText: "My Test Jar" })).toBeVisible();
});

test("production invite path survives profile setup → previews → joins the jar", async ({
  page,
}) => {
  await signUpNewFromInvite(page, "XEX24K");
  await expect(page.getByText("The Group Chat")).toBeVisible();
  await expect(page.getByText("5 pts")).toBeVisible();
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
  await page.getByRole("button", { name: "Join this jar" }).click();
  await expect(page.getByRole("alert")).toContainText("don’t have permission");
  await page.getByRole("button", { name: "Retry joining jar" }).click();
  await expect(page.getByRole("alert")).toContainText("can’t be joined anymore");
  await page.getByRole("button", { name: "Retry joining jar" }).click();
  await expect(page.getByRole("alert")).toContainText("Check your connection");
  await page.getByRole("button", { name: "Retry joining jar" }).click();
  await expect(page.getByRole("alert")).toContainText("Check your connection");
  await page.getByRole("button", { name: "Retry joining jar" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("jar-total-tally")).toBeVisible();
  await expect(page.getByText("The Group Chat")).toBeVisible();
});

test("invite preview errors are explicit, non-contradictory, and recoverable", async ({ page }) => {
  await signUpNew(page, "Preview QA");
  await page.getByRole("button", { name: "Join a jar with a code" }).click();
  const input = page.getByPlaceholder("Invite code");
  await input.fill("BAD");
  await page.getByRole("button", { name: "Preview jar" }).click();
  await expect(page.getByRole("alert")).toContainText("full six-letter");

  let previewAttempt = 0;
  await page.route("**/api/jars/preview", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ code: "TRY123" });
    previewAttempt += 1;
    if (previewAttempt === 1)
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: '{"error":"not_found"}',
      });
    if (previewAttempt === 2)
      return route.fulfill({
        status: 403,
        contentType: "application/json",
        body: '{"error":"forbidden"}',
      });
    if (previewAttempt === 3)
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: '{"error":"jar_closed"}',
      });
    if (previewAttempt === 4)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"busy"}',
      });
    if (previewAttempt === 5) return route.abort("internetdisconnected");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "jar_previewqa",
        name: "Recovered preview",
        rule: "No contact.",
        defaultCents: 500,
        members: [],
        memberCount: 0,
      }),
    });
  });
  await input.fill("TRY123");
  const expectedErrors = [
    "No active jar has that code",
    "don’t have permission to view",
    "no longer active",
    "Check your connection and retry",
    "Check your connection and retry",
  ];
  for (const expected of expectedErrors) {
    await page.getByRole("button", { name: /Preview jar|Retry invite/ }).click();
    await expect(page.getByRole("alert")).toContainText(expected);
    await expect(page.getByText("Recovered preview")).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Retry invite" }).click();
  await expect(page.getByText("Recovered preview")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Join this jar" })).toBeVisible();
});

test("owner replaces a seven-day invite → old deep link stays revoked after reload", async ({
  page,
  request,
}) => {
  await signInAsCalum(page);
  await openJar(page, "Dry January (Failed)");
  await page.getByRole("button", { name: "Invite people" }).click();
  await expect(page.getByRole("status")).toContainText("Expires");
  await page.getByRole("button", { name: "Share invite" }).click();
  await expect(page.getByText("Copied to clipboard")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Dry January (Failed)")).toBeVisible();
  await page.getByRole("button", { name: "Invite people" }).click();

  const token = await page.evaluate(() => localStorage.getItem("tye_token"));
  if (!token) throw new Error("signed-in session token missing");
  const headers = { Authorization: `Bearer ${token}` };
  const jars = JarSummarySchema.array().parse(
    await (await request.get("/api/jars", { headers })).json(),
  );
  const jar = jars.find((candidate) => candidate.name === "Dry January (Failed)");
  if (!jar) throw new Error("owner jar missing");
  const before = JarDetailSchema.parse(
    await (await request.get(`/api/jars/${jar.id}`, { headers })).json(),
  );
  if (!before.inviteCode) throw new Error("owner jar invite missing before rotation");

  await page.getByRole("button", { name: "Replace invite" }).click();
  await expect(page.getByRole("alert")).toContainText("stop working immediately");
  await page.getByRole("button", { name: "Replace invite now" }).click();
  await expect(page.getByRole("button", { name: "Replace invite" })).toBeVisible();

  const after = JarDetailSchema.parse(
    await (await request.get(`/api/jars/${jar.id}`, { headers })).json(),
  );
  if (!after.inviteCode) throw new Error("owner jar invite missing after rotation");
  expect(after.inviteCode).not.toBe(before.inviteCode);
  await expect(page.getByText(after.inviteCode)).toBeVisible();
  expect(
    (
      await request.post("/api/jars/preview", {
        headers: { ...headers, "Content-Type": "application/json" },
        data: { code: before.inviteCode },
      })
    ).status(),
  ).toBe(404);

  await page.reload();
  await openJar(page, "Dry January (Failed)");
  await page.getByRole("button", { name: "Invite people" }).click();
  await expect(page.getByText(after.inviteCode)).toBeVisible();
  await page.goto(`/j/${before.inviteCode}`);
  await expect(page.getByRole("alert")).toHaveText(
    "No active jar has that code. Check it and retry.",
  );
  await page.goto(`/j/${after.inviteCode}`);
  await expect(page.getByText("Dry January (Failed)")).toBeVisible();
});

test("about my tally explains that points are virtual", async ({ page }) => {
  await signInAsCalum(page);
  await openJar(page, "The Group Chat");
  await page.getByRole("button", { name: "About my tally" }).click();
  await expect(page.getByText("YOUR VIRTUAL TALLY")).toBeVisible();
  const disclosure = page.getByText("scoreboard value only", { exact: false });
  await expect(disclosure).toContainText(
    "No real money is charged, collected, paid, or transferred.",
  );
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
  await page.getByRole("button", { name: "Log a slip" }).click();
  await expect(page.getByRole("alert")).toContainText("jar couldn’t be loaded");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("button", { name: /Add .* pts to my virtual tally/ })).toBeVisible();

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
  await page.getByRole("button", { name: /Add .* pts to my virtual tally/ }).click();
  await page.getByRole("button", { name: "Confirm and reset streak" }).click();
  await expect(page.getByRole("alert")).toContainText("tally has not changed");
  await expect(page.getByText("Log this slip?")).toBeVisible();
  expect(slipAttempts).toBe(1);
  await page.getByRole("button", { name: "Retry logging slip" }).click();
  await expect(page.getByTestId("jar-total-tally")).toBeVisible();
  expect(slipAttempts).toBe(2);
  await page.reload();
  await openJar(page, "The Group Chat");
  await expect(page.getByTestId("jar-total-tally")).toBeVisible();
});

test("profile: edit avatar and toggle share-streak", async ({ page }) => {
  await signInAsCalum(page);
  await page.getByTestId("tab-profile").click();
  await expect(page.getByText("Share my no-contact streak")).toBeVisible();

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
  await firstShareRow.getByRole("switch").click();
  await expect(firstShareRow).toContainText(wasHidden ? "Friends see your streak" : "Hidden");
});

test("activity tab shows the supportive check-in feed", async ({ page }) => {
  await signInAsCalum(page);
  await page.getByTestId("tab-activity").click();
  await expect(page.getByText("logged a slip", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("You’re all caught up.")).toBeVisible();
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
  const jars = JarSummarySchema.array().parse(await jarsResponse.json());
  const jar = jars.find((item) => item.name === "Dry January (Failed)");
  if (!jar) throw new Error("owner jar missing");
  const detailResponse = await request.get(`/api/jars/${jar.id}`, { headers });
  const openDetail = JarDetailSchema.parse(await detailResponse.json());
  if (!openDetail.inviteCode) throw new Error("owner jar invite missing before close");

  await page.getByRole("button", { name: "Close jar" }).click();
  await expect(page.getByRole("alert")).toContainText("Close this jar permanently?");
  await page.getByRole("button", { name: "Close jar permanently" }).click();
  await expect(page.getByRole("status")).toContainText("history is read-only");
  await expect(page.getByText("PROGRESS BOARD", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "I texted my ex" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Invite people" })).toHaveCount(0);

  await page.reload();
  await openJar(page, "Dry January (Failed)");
  await expect(page.getByRole("status")).toContainText("history is read-only");
  expect(
    (
      await request.post("/api/jars/preview", {
        headers: { ...headers, "Content-Type": "application/json" },
        data: { code: openDetail.inviteCode },
      })
    ).status(),
  ).toBe(404);
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
  const jars = JarSummarySchema.array().parse(await jarsResponse.json());
  const jar = jars.find((item) => item.name === "The Group Chat");
  if (!jar) throw new Error("member jar missing");
  const detailResponse = await request.get(`/api/jars/${jar.id}`, { headers });
  const detail = JarDetailSchema.parse(await detailResponse.json());
  if (!detail.inviteCode) throw new Error("member jar invite missing before leave");

  await page.getByRole("button", { name: "Leave jar" }).click();
  await expect(page.getByRole("alert")).toContainText("Leave this jar?");
  await page.getByRole("button", { name: "Leave jar permanently" }).click();
  await expect(page.getByText("Your jars", { exact: true })).toBeVisible();
  await expect(page.getByText("Loading your jars…", { exact: true })).toBeHidden();
  await expect(page.getByTestId("jar-card").filter({ hasText: "The Group Chat" })).toHaveCount(0);
  const departedDetail = await request.get(`/api/jars/${jar.id}`, { headers });
  expect(departedDetail.status()).toBe(404);
  expect(await departedDetail.json()).toEqual({ error: "not_found" });

  await page.reload();
  await expect(page.getByText("Your jars", { exact: true })).toBeVisible();
  await expect(page.getByText("Loading your jars…", { exact: true })).toBeHidden();
  await expect(page.getByTestId("jar-card").filter({ hasText: "The Group Chat" })).toHaveCount(0);

  await page.goto(`/j/${detail.inviteCode}`);
  await expect(page.getByText("Join jar")).toBeVisible();
  await page.getByRole("button", { name: "Join this jar" }).click();
  await expect(page.getByTestId("jar-total-tally")).toBeVisible();
  await page.reload();
  await openJar(page, "The Group Chat");
  await expect(page.locator('[data-testid="progress-row"][data-member="Calum"]')).toContainText(
    "40 pts",
  );

  await page.goto("/");
  await openJar(page, "The Group Chat");
  await expect(page.locator('[data-testid="progress-row"][data-member="Calum"]')).toContainText(
    "40 pts",
  );
});

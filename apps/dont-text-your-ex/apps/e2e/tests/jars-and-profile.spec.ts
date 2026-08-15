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
  await page.getByRole("button", { name: "Create jar & invite friends" }).click();

  await expect(page.getByText("Your jar code")).toBeVisible();
  await expect(page.getByText("Jar created.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Take me to my jar" }).click();
  await expect(page.getByText("My Test Jar")).toBeVisible();
  await expect(page.getByTestId("jar-pot")).toHaveText("$0");
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

  let firstJoin = true;
  await page.route("**/api/jars/join", async (route) => {
    if (firstJoin) {
      firstJoin = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"busy"}',
      });
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Join the shame" }).click();
  await expect(page.getByText("This invite could not be joined")).toBeVisible();
  await page.getByRole("button", { name: "Join the shame" }).click();
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

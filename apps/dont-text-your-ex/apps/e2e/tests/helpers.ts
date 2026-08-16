import { expect, type Page } from "@playwright/test";
import { AuthResponseSchema } from "../../../contracts";

// The only real login is the native "Sign in with Apple" sheet, which can't run
// in a headless browser. Tests obtain a session through the non-production
// /auth/dev seam instead, then drive the real UI. The web preview proxies /api
// to the API, so a relative path works.
async function devLogin(page: Page, body: { as: "calum" | "new" }): Promise<void> {
  const res = await page.request.post("/api/auth/dev", { data: body });
  expect(res.ok()).toBeTruthy();
  const { token } = AuthResponseSchema.parse(await res.json());
  await page.addInitScript((t) => localStorage.setItem("tye_token", t), token);
}

async function waitForHomeReady(page: Page): Promise<void> {
  await expect(page.getByText("Your jars", { exact: true })).toBeVisible();
  await expect(page.getByText("Loading your jars…", { exact: true })).toBeHidden();
}

// Sign in as the seeded primary user (Calum), who already has jars + slips.
export async function signInAsCalum(page: Page): Promise<void> {
  await devLogin(page, { as: "calum" });
  await page.goto("/");
  await waitForHomeReady(page);
}

// Sign in as a brand-new user (no name yet) and complete profile setup, mirroring
// a first-time Apple sign-in where Apple returned no name.
export async function signUpNew(page: Page, name = "Maker"): Promise<void> {
  await devLogin(page, { as: "new" });
  await page.goto("/");
  await expect(page.getByText("Make it official")).toBeVisible();
  await page.getByRole("textbox", { name: "Your name" }).fill(name);
  await page.getByRole("button", { name: "Start your reset →" }).click();
  await waitForHomeReady(page);
}

export async function signUpNewFromInvite(
  page: Page,
  code: string,
  name = "Invitee",
): Promise<void> {
  await devLogin(page, { as: "new" });
  await page.goto(`/j/${code}`);
  await expect(page.getByText("Make it official")).toBeVisible();
  await page.getByRole("textbox", { name: "Your name" }).fill(name);
  await page.getByRole("button", { name: "Start your reset →" }).click();
  await expect(page.getByText("Join jar")).toBeVisible();
}

export async function openJar(page: Page, name: string) {
  await page.locator(`[data-testid="jar-card"][data-jar-name="${name}"]`).click();
  await expect(page.getByTestId("jar-pot")).toBeVisible();
}

export function memberRow(page: Page, member: string) {
  return page.locator(`[data-testid="progress-row"][data-member="${member}"]`);
}

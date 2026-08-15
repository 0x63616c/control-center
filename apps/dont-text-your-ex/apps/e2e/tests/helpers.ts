import { expect, type Page } from "@playwright/test";

// The only real login is the native "Sign in with Apple" sheet, which can't run
// in a headless browser. Tests obtain a session through the non-production
// /auth/dev seam instead, then drive the real UI. The web preview proxies /api
// to the API, so a relative path works.
async function devLogin(page: Page, body: { as: "calum" | "new" }): Promise<void> {
  const res = await page.request.post("/api/auth/dev", { data: body });
  expect(res.ok()).toBeTruthy();
  const { token } = (await res.json()) as { token: string };
  await page.addInitScript((t) => localStorage.setItem("tye_token", t), token);
}

// Sign in as the seeded primary user (Calum), who already has jars + slips.
export async function signInAsCalum(page: Page): Promise<void> {
  await devLogin(page, { as: "calum" });
  await page.goto("/");
  await expect(page.getByText("Your jars")).toBeVisible();
}

// Sign in as a brand-new user (no name yet) and complete profile setup, mirroring
// a first-time Apple sign-in where Apple returned no name.
export async function signUpNew(page: Page, name: string): Promise<void> {
  await devLogin(page, { as: "new" });
  await page.goto("/");
  await expect(page.getByText("Make it official")).toBeVisible();
  await page.getByPlaceholder("Calum").fill(name);
  await page.getByRole("button", { name: "Start the shame →" }).click();
  await expect(page.getByText("Your jars")).toBeVisible();
}

export async function openJar(page: Page, name: string) {
  await page.locator(`[data-testid="jar-card"][data-jar-name="${name}"]`).click();
  await expect(page.getByTestId("jar-pot")).toBeVisible();
}

export function shameRow(page: Page, member: string) {
  return page.locator(`[data-testid="shame-row"][data-member="${member}"]`);
}

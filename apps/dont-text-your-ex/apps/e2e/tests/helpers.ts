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
  await startSignUpNew(page);
  await page.getByRole("textbox", { name: "Your name" }).fill(name);
  await page.getByRole("button", { name: "Start the shame →" }).click();
  await waitForHomeReady(page);
}

export async function startSignUpNew(page: Page): Promise<void> {
  await devLogin(page, { as: "new" });
  await page.goto("/");
  await expect(page.getByText("Make it official")).toBeVisible();
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
  await page.getByRole("button", { name: "Start the shame →" }).click();
  await expect(page.getByText("Join jar")).toBeVisible();
}

export async function openJar(page: Page, name: string) {
  await page.locator(`[data-testid="jar-card"][data-jar-name="${name}"]`).click();
  await expect(page.getByTestId("jar-pot")).toBeVisible();
}

export function shameRow(page: Page, member: string) {
  return page.locator(`[data-testid="shame-row"][data-member="${member}"]`);
}

/** A decodable 2400x1600 camera-sized image with no compressed-fixture shortcut. */
export function cameraPhotoBmp(): Buffer {
  const width = 2400;
  const height = 1600;
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowBytes * height;
  const bitmap = Buffer.allocUnsafe(54 + pixelBytes);
  bitmap.write("BM", 0, "ascii");
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(width, 18);
  bitmap.writeInt32LE(height, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(24, 28);
  bitmap.writeUInt32LE(pixelBytes, 34);

  for (let y = 0; y < height; y += 1) {
    const rowStart = 54 + y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + x * 3;
      bitmap[offset] = Math.floor((x / width) * 255);
      bitmap[offset + 1] = Math.floor((y / height) * 255);
      bitmap[offset + 2] = 180;
    }
  }
  return bitmap;
}

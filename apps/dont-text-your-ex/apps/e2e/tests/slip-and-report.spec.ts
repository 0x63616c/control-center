import { expect, type Page, test } from "@playwright/test";
import { memberRow, openJar, signInAsCalum } from "./helpers";

async function transcodeInBrowser(page: Page, png: Buffer, mimeType: string): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ({ dataUrl, mimeType: outputType }) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d")?.drawImage(image, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error("fixture encode failed"))),
          outputType,
        ),
      );
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    { dataUrl: `data:image/png;base64,${png.toString("base64")}`, mimeType },
  );
  return Buffer.from(bytes);
}

// Each test starts from the seeded baseline (non-prod reset seam) so
// absolute assertions on seeded values stay order-independent.
test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
});

test("logging a check-in bumps the virtual tally, resets streak, and grows the group tally", async ({
  page,
}) => {
  await signInAsCalum(page);
  await openJar(page, "The Group Chat");

  const tallyBefore = await page.getByTestId("jar-total-tally").innerText();
  await expect(memberRow(page, "Calum")).toContainText("40 pts");

  await page.getByRole("button", { name: "Log a slip" }).click();
  await expect(page.getByText(/Choose the virtual amount/)).toBeVisible();
  // The jar default is 5 pts and the stepper increments once to 10 pts.
  await page.getByRole("button", { name: "+", exact: true }).click();
  await page.getByRole("button", { name: "Add 10 pts to my virtual tally" }).click();
  // friction sheet
  await expect(page.getByText("Log this slip?")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and reset streak" }).click();

  // Back on jar detail; the group grew by 10 pts and Calum moved from 40 to 50 pts.
  await expect(page.getByTestId("jar-total-tally")).not.toHaveText(tallyBefore);
  await expect(memberRow(page, "Calum")).toContainText("50 pts");
});

test("an accountability check with an attachment can keep the sender private", async ({ page }) => {
  await signInAsCalum(page);
  await openJar(page, "The Group Chat");
  await page.getByRole("button", { name: "Accountability check" }).click();
  await expect(page.getByText("Think someone slipped?", { exact: false })).toBeVisible();

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
  await expect(page.getByRole("img", { name: "Accountability check attachment" })).toBeVisible();

  await page.getByRole("switch", { name: "Hide my name from jar members" }).click();
  await page.getByRole("button", { name: "Send check anonymously" }).click();

  await expect(page.getByText("Check sent", { exact: true })).toBeVisible();
  await expect(page.getByText("name is hidden from jar members", { exact: false })).toBeVisible();
});

test("accountability check enforces note-or-image, malicious boundaries, and three real formats", async ({
  page,
}) => {
  await signInAsCalum(page);
  await openJar(page, "The Group Chat");
  await page.getByRole("button", { name: "Accountability check" }).click();
  await page.getByRole("button", { name: "Ali", exact: true }).click();

  const send = page.getByRole("button", { name: "Send accountability check" });
  await expect(send).toBeDisabled();
  await page.getByPlaceholder("“I saw a message come through…”").fill("   ");
  await expect(send).toBeDisabled();

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const [jpeg, webp] = await Promise.all([
    transcodeInBrowser(page, png, "image/jpeg"),
    transcodeInBrowser(page, png, "image/webp"),
  ]);
  await page.getByTestId("evidence-input").setInputFiles(
    Array.from({ length: 4 }, (_, index) => ({
      name: `too-many-${index}.png`,
      mimeType: "image/png",
      buffer: png,
    })),
  );
  await expect(page.getByRole("alert")).toHaveText("Add no more than 3 screenshots.");
  await expect(page.getByRole("img", { name: "Accountability check attachment" })).toHaveCount(0);

  await page.getByTestId("evidence-input").setInputFiles({
    name: "spoofed.png",
    mimeType: "image/png",
    buffer: Buffer.from("this is not a PNG"),
  });
  await expect(page.getByRole("alert")).toHaveText(
    "That screenshot could not be read. Try another file.",
  );

  await page.getByTestId("evidence-input").setInputFiles([
    { name: "receipt.png", mimeType: "image/png", buffer: png },
    { name: "receipt.jpg", mimeType: "image/jpeg", buffer: jpeg },
    { name: "receipt.webp", mimeType: "image/webp", buffer: webp },
  ]);
  await expect(page.getByRole("img", { name: "Accountability check attachment" })).toHaveCount(3);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText("Check sent", { exact: true })).toBeVisible();
});

test("accountability-check fetch/send failures preserve every choice and retry without false success", async ({
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
  await page.getByRole("button", { name: "Accountability check" }).click();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await expect(page.getByRole("alert")).toContainText("couldn’t be loaded");
    await expect(page.getByText("Think someone slipped?", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "Retry" }).click();
  }
  await expect(page.getByText("Think someone slipped?", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Ali", exact: true }).click();
  const note = page.getByPlaceholder("“I saw a message come through…”");
  await note.fill("Preserve this exact note");
  await page.getByTestId("evidence-input").setInputFiles({
    name: "retry-receipt.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  const hideName = page.getByRole("switch", { name: "Hide my name from jar members" });
  await hideName.click();

  let submitAttempt = 0;
  await page.route("**/api/jars/*/reports", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submitAttempt += 1;
    if (submitAttempt === 1) return route.abort("internetdisconnected");
    return route.continue();
  });
  await page.getByRole("button", { name: "Send check anonymously" }).click();
  await expect(page.getByRole("alert")).toContainText("wasn’t sent");
  await expect(page.getByText("Check sent", { exact: true })).toHaveCount(0);
  await expect(note).toHaveValue("Preserve this exact note");
  await expect(hideName).toBeChecked();
  await expect(page.getByRole("img", { name: "Accountability check attachment" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ali", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: "Retry sending check" }).click();
  await expect(page.getByText("Check sent", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Ali will be asked to accept or deny it", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("name is hidden from jar members", { exact: false })).toBeVisible();
  expect(submitAttempt).toBe(2);
});

test("confirm or dismiss: confirming the seeded check adds to Calum's tally", async ({ page }) => {
  await signInAsCalum(page);
  await page.getByTestId("tab-activity").click();
  await expect(page.getByText("You have an accountability check")).toBeVisible();
  await page.getByText("sent you a check", { exact: false }).click();

  // The seeded report is note-only; evidence is never fabricated for tests.
  await expect(page.getByText("Someone in the jar")).toBeVisible();
  await expect(page.getByText(/A reply came through/)).toBeVisible();
  await expect(page.getByText(/Supporting screenshots/)).toHaveCount(0);
  await page.getByRole("button", { name: /Accept and add/ }).click();
  await expect(page.getByText("Respect.")).toBeVisible();

  // Resolution is durable: after a full reload the linked activity and history
  // both reach the owned report detail rather than losing it with the pending queue.
  await page.reload();
  await expect(page.getByText("Your jars", { exact: true })).toBeVisible();
  await page.getByTestId("tab-activity").click();
  await page.getByRole("button", { name: "View accountability check in The Group Chat" }).click();
  await expect(page.getByText("Accepted", { exact: true })).toBeVisible();
  await expect(page.getByText(/A reply came through/)).toBeVisible();
  await expect(page.getByText("Someone in the jar sent a check to Calum")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "View check history" }).click();
  await expect(page.getByText("Check history", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Calum · The Group Chat/ }).click();
  await expect(page.getByText("Accepted", { exact: true })).toBeVisible();
  await expect(page.getByText(/A reply came through/)).toBeVisible();
});

/**
 * Proves the one mechanism manage is built on: a locally-loaded MV3 extension
 * strips `x-frame-options` / CSP `frame-ancestors` from FRAMED sub-documents on
 * an explicit allowlist, and nothing else.
 *
 * Everything here is served by this file. No real tool is touched: no Cloudflare
 * Access, no network, no chance of a green run that only proves the header
 * happened to be absent that day.
 *
 * Three assertions carry the whole design:
 *
 *  1. WITHOUT the extension, a frame-denying child MUST be blocked. This is the
 *     negative control. Without it a passing test proves nothing — the header
 *     might simply never have been sent.
 *  2. WITH the extension, the same child MUST render.
 *  3. WITH the extension, a child on a host that is NOT allowlisted MUST still
 *     be blocked. This is what makes "the allowlist is the blast radius" a
 *     tested property rather than a claim in a comment.
 *
 * The extension used here is rendered by the SAME generator that emits the
 * committed one (apps/manage/src/extension-rules.ts), pointed at throwaway local
 * hosts. A hand-written stand-in would test a rule shape that never ships.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, expect, test } from "@playwright/test";
import { renderManifest, renderRules } from "../src/extension-rules";

/** Child page. Refuses framing every way a real tool does. */
const CHILD_HTML = `<!doctype html><meta charset="utf-8"><title>child</title>
<body style="background:#0a0a0a;color:#ededed;font:13px system-ui">framed child
<script>parent.postMessage("child-rendered", "*")</script>`;

/** Parent page. Records whether the child ever announced itself. */
function parentHtml(childUrl: string): string {
  return `<!doctype html><meta charset="utf-8"><title>parent</title>
<body style="background:#000">
<div id="state">waiting</div>
<iframe id="f" src="${childUrl}" style="width:400px;height:200px"></iframe>
<script>
  addEventListener("message", (e) => {
    if (e.data === "child-rendered") document.getElementById("state").textContent = "rendered";
  });
</script>`;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  return address.port;
}

/**
 * Serves the frame-denying child. `127.0.0.1` and `localhost` resolve to the
 * same interface but are DIFFERENT origins to the browser, which is what makes
 * the parent→child relationship genuinely cross-origin.
 */
function childServer(): Server {
  return createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html",
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
    });
    res.end(CHILD_HTML);
  });
}

function parentServer(childUrl: string): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(parentHtml(childUrl));
  });
}

/** Writes a real, loadable extension for `hosts` using the production emitter. */
function buildExtension(hosts: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "manage-ext-"));
  writeFileSync(
    join(dir, "manifest.json"),
    renderManifest({ hosts, origins: ["http://127.0.0.1/*"], scheme: "http" }),
  );
  writeFileSync(join(dir, "rules.gen.json"), renderRules({ hosts }));
  writeFileSync(
    join(dir, "content.js"),
    "document.documentElement.dataset.manageExt = chrome.runtime.getManifest().version;\n",
  );
  return dir;
}

async function launch(extensionDir: string | null): Promise<BrowserContext> {
  const profile = mkdtempSync(join(tmpdir(), "manage-profile-"));
  const args = extensionDir
    ? [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
    : [];
  // MV3 extensions need a persistent profile. Headless "new" mode loads them;
  // if a runner ever disagrees, wrap the command in xvfb-run rather than
  // dropping the extension arm of this test.
  return chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args,
  });
}

/** Opens the parent and reports whether the child announced itself. */
async function childRendered(context: BrowserContext, parentUrl: string): Promise<boolean> {
  const page = await context.newPage();
  await page.goto(parentUrl);
  try {
    await expect(page.locator("#state")).toHaveText("rendered", { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

test.describe("frame unlock", () => {
  let child: Server;
  let parent: Server;
  let parentUrl: string;
  let childHost: string;

  test.beforeAll(async () => {
    child = childServer();
    const childPort = await listen(child);
    // Cross-origin on purpose: the child is `localhost`, the parent `127.0.0.1`.
    childHost = "localhost";
    parent = parentServer(`http://localhost:${childPort}/`);
    const parentPort = await listen(parent);
    parentUrl = `http://127.0.0.1:${parentPort}/`;
  });

  test.afterAll(() => {
    child.close();
    parent.close();
  });

  test("without the extension, a frame-denying child is blocked", async () => {
    const context = await launch(null);
    expect(await childRendered(context, parentUrl)).toBe(false);
    await context.close();
  });

  test("with the extension, the same child renders", async () => {
    const context = await launch(buildExtension([childHost]));
    expect(await childRendered(context, parentUrl)).toBe(true);
    await context.close();
  });

  test("with the extension, a host outside the allowlist is still blocked", async () => {
    // Same extension shape, allowlisting something else entirely. If this ever
    // passes, the allowlist has stopped bounding the blast radius.
    const context = await launch(buildExtension(["example.invalid"]));
    expect(await childRendered(context, parentUrl)).toBe(false);
    await context.close();
  });
});

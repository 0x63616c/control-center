#!/usr/bin/env bun
// Creates the `www-software-factory-bot` GitHub App via GitHub's App-manifest
// flow, so no credential is ever hand-copied (#125).
//
// GitHub has no REST endpoint that creates an App, but the manifest flow is
// browser-mediated AND fully scriptable: we POST a manifest to
// /settings/apps/new, the human (or an agent driving cmux browser) clicks one
// confirm button, and GitHub redirects back to this server with a short-lived
// code. Exchanging that code returns EVERY credential in one JSON response.
//
// Usage:
//   bun scripts/create-github-bot-app.ts [--port 8931] [--out <path>]
//
// Then open http://127.0.0.1:<port>/ in a browser that is signed in to GitHub
// as the account that should own the App, and click "Create GitHub App".
//
// The conversion response is written to --out (default: a 0600 file under
// $TMPDIR) and NEVER printed: it holds the private key, client secret and
// webhook secret. Feed that file to scripts/save-github-bot.sh.

import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const argOf = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const PORT = Number(argOf("--port") ?? 8931);
const OUT = argOf("--out") ?? join(tmpdir(), "github-bot-app-credentials.json");
const REDIRECT = `http://127.0.0.1:${PORT}/cb`;

// Guards the manifest POST against CSRF; GitHub echoes it back on the redirect.
const nonce = crypto.randomUUID();

// Subscribe BROAD and filter in the receiver: adding an event later means
// re-editing the App, whereas an unused event costs nothing but a row.
const manifest = {
  name: "www-software-factory-bot",
  url: "https://github.com/0x63616c/world-wide-webb",
  description: "Autonomous software factory for world-wide-webb.",
  public: false,
  redirect_url: REDIRECT,
  hook_attributes: {
    url: "https://hooks.worldwidewebb.co/hooks/github",
    active: true,
  },
  default_permissions: {
    contents: "write",
    issues: "write",
    pull_requests: "write",
    // Agents edit .github/workflows, which needs its own permission.
    workflows: "write",
    // Rerun / cancel CI.
    actions: "write",
    checks: "read",
    statuses: "read",
    metadata: "read",
  },
  default_events: [
    "issues",
    "issue_comment",
    "label",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "push",
    "create",
    "delete",
    "check_suite",
    "check_run",
    "workflow_run",
    "workflow_job",
    "release",
    "status",
  ],
};

const formPage = () => `<!doctype html>
<html><head><meta charset="utf-8"><title>Create www-software-factory-bot</title></head>
<body>
  <p>Submitting the App manifest to GitHub&hellip;</p>
  <form id="f" method="post" action="https://github.com/settings/apps/new?state=${nonce}">
    <input type="hidden" name="manifest" id="manifest">
    <noscript><button type="submit">Continue</button></noscript>
  </form>
  <script>
    document.getElementById("manifest").value = ${JSON.stringify(JSON.stringify(manifest))};
    document.getElementById("f").submit();
  </script>
</body></html>`;

let resolveDone: (value: "ok" | "error") => void;
const done = new Promise<"ok" | "error">((resolve) => {
  resolveDone = resolve;
});

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response(formPage(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/cb") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (state !== nonce) {
        resolveDone("error");
        return new Response("state mismatch", { status: 400 });
      }
      if (!code) {
        resolveDone("error");
        return new Response("missing code", { status: 400 });
      }

      // Unauthenticated by design: the one-time code IS the credential, and it
      // expires in an hour.
      const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "www-software-factory-bot-provisioner",
        },
      });

      if (!res.ok) {
        console.error(`conversion failed: HTTP ${res.status}`);
        resolveDone("error");
        return new Response("conversion failed", { status: 502 });
      }

      const app = (await res.json()) as {
        id: number;
        slug: string;
        client_id: string;
        html_url: string;
      };

      // 0600 BEFORE the write would race, so write then tighten immediately.
      writeFileSync(OUT, JSON.stringify(app, null, 2), { mode: 0o600 });
      chmodSync(OUT, 0o600);

      // Only non-secret identifiers are ever logged.
      console.log(`app created: id=${app.id} slug=${app.slug}`);
      console.log(`settings: ${app.html_url}`);
      console.log(`credentials written to ${OUT} (0600, contains secrets - do not cat)`);

      resolveDone("ok");
      return new Response(
        `<!doctype html><meta charset="utf-8"><p>App <b>${app.slug}</b> created. You can close this tab.</p>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`listening on http://127.0.0.1:${PORT}/ - open it in a signed-in browser`);

const outcome = await done;
// Give the browser a beat to render the response before tearing the server down.
await Bun.sleep(500);
server.stop(true);
process.exit(outcome === "ok" ? 0 : 1);

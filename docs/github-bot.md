# www-software-factory-bot

The machine identity autonomous agents act as in this repo: a **GitHub App**,
not a second GitHub account. Written so a cold agent can redo the whole thing
unattended.

- App: <https://github.com/apps/www-software-factory-bot> (`id 4399553`)
- Settings: <https://github.com/settings/apps/www-software-factory-bot>
- Installed on `0x63616c/world-wide-webb` **only** (installation `149184348`)
- Owner: `0x63616c`, private (`"public": false`), so it is installable only on
  Calum's own repos.

## Why an App and not a machine user

A second GitHub account needs a new email, an interactive CAPTCHA and usually SMS
verification — a hard human gate. An App is created from the *existing* session,
so the whole flow is scriptable. It also gets short-lived (1 hour) installation
tokens instead of a long-lived PAT, fine-grained per-repo permissions, and a
built-in webhook config.

The one thing an App loses: **it cannot be assigned an issue, and cannot be
@-mentioned.** So agent triggering must be **label-driven** (`agent/take`) or
**comment-driven** (`/agent go`), never assignee-driven. Both are readable and
writable by an App.

## Creating it from scratch

`scripts/create-github-bot-app.ts` serves a self-submitting form that POSTs an
App manifest to GitHub, then captures the one-time code GitHub redirects back
with and exchanges it for every credential in a single response.

```sh
bun scripts/create-github-bot-app.ts --out /tmp/gh-bot.json
# then open http://127.0.0.1:8931/ in a browser signed in as the owning account
```

The manifest (permissions, events, webhook URL) lives in that script — edit it
there, not in the UI, so the next re-creation matches.

Then store the credentials and install:

```sh
scripts/save-github-bot.sh /tmp/gh-bot.json                  # 5 keys
# install the App on the repo (see below), then re-run with the installation id:
scripts/save-github-bot.sh /tmp/gh-bot.json <installation-id>
git commit secrets/vault.yaml   # re-encrypted by set-secret.sh
```

### Driving it with cmux browser

| Step | Page | What to do |
|---|---|---|
| Submit the manifest | `http://127.0.0.1:8931/` | auto-submits; no click needed |
| Confirm creation | `https://github.com/settings/apps/manifest` | click `input[name=commit]` ("Create GitHub App for &lt;owner&gt;") |
| Install on the repo | `https://github.com/apps/<slug>/installations/new` | see below |
| Upload the avatar | `https://github.com/settings/apps/<slug>` | **manual**, see below |

**GitHub sudo mode.** The manifest POST goes through a "Confirm access" page
(passkey / GitHub Mobile / password) if the session has not recently
re-authenticated. This is a **hard human gate** — an agent cannot pass it. Worse,
the sudo redirect **drops the manifest POST**: after confirming, the form comes
back *empty*. Re-navigate to `http://127.0.0.1:8931/` to re-submit; the second
attempt renders prefilled.

**Installing.** The repository picker is a `<details>` dropdown that collapses
whenever a script fills its filter box, so driving it element-by-element does not
work. Submit the form directly instead:

```js
const f = [...document.querySelectorAll("form")]
  .find((x) => x.method === "post" && /installations$/.test(x.action));
[...f.elements].filter((e) => e.name === "install_target")
  .forEach((e) => { e.checked = e.value === "selected"; });
const i = document.createElement("input");
i.type = "hidden"; i.name = "repository_ids[]"; i.value = "<repo id>";
f.appendChild(i);
f.submit();
```

Repo id: `gh api /repos/0x63616c/world-wide-webb --jq .id`. The resulting URL is
`/settings/installations/<installation-id>` — that trailing number is the
installation id to store.

**Avatar — the one genuinely manual step.** There is no API for App logos, and
the upload cannot be driven from cmux browser either: the control is a
`<file-attachment>` custom element that **never registers** in the cmux webview
(`customElements.get("file-attachment")` stays `undefined`), so assigning
`input.files` via `DataTransfer` attaches the file but fires no handler. Do it by
hand: open the App settings page in a normal browser, "Upload a logo...", pick
`docs/assets/www-software-factory-bot-avatar.png`, then **Save changes**.

Everything after installation is plain `gh api` / HTTP.

## How the bot authenticates

1. **App JWT** — RS256 over `{iat: now-60, exp: now+540, iss: <client_id>}`,
   signed with the PEM. Sign with **`crypto.subtle`, not `node:crypto`** (same
   constraint as App Store Connect; see
   `apps/api/src/services/asc-version-service.ts`).
   The manifest returns a **PKCS#1** key but `crypto.subtle` only imports
   **PKCS#8**, so the DER needs the PKCS#8 wrapper prepended before import.
2. **Installation token** — `POST /app/installations/<id>/access_tokens` with
   that JWT returns a `ghs_…` token valid one hour. Use it as
   `Authorization: Bearer` for repo work, and as the git password over HTTPS:
   `https://x-access-token:<ghs_…>@github.com/0x63616c/world-wide-webb.git`.
3. **Commit identity**, so GitHub attributes commits to the bot:
   `www-software-factory-bot[bot] <<ID>+www-software-factory-bot[bot]@users.noreply.github.com>`
   where `<ID>` is `gh api '/users/www-software-factory-bot%5Bbot%5D' --jq .id`.

⚠️ **Pushes authored by a GitHub App do not trigger `on: push` workflows** — a
deliberate loop guard. CI on `main` is this repo's deploy path, so a bot push
will **not** deploy. Either push with a user token or add a `workflow_dispatch`
fallback. This is the thing most likely to surprise you.

## Vault keys

Declared once in `packages/platform/src/index.ts` (`secretCatalog.githubBot`);
`infra/src/secrets-map.ts` derives from it.

| Vault key | Source |
|---|---|
| `GITHUB_BOT_APP__APP_ID` | conversion `.id` |
| `GITHUB_BOT_APP__CLIENT_ID` | `.client_id` |
| `GITHUB_BOT_APP__CLIENT_SECRET` | `.client_secret` |
| `GITHUB_BOT_APP__PRIVATE_KEY_PEM` | `.pem`, base64 encoded |
| `GITHUB_BOT_APP__WEBHOOK_SECRET` | `.webhook_secret` |
| `GITHUB_BOT_APP__INSTALLATION_ID` | `GET /app/installations` after install |

## Rotating the credentials

Everything minted during an unattended run should be treated as burned. All of
this is in the App settings UI:

1. **Private keys** → *Generate a private key* (downloads a `.pem`), then delete
   the old key.
2. **Client secrets** → *Generate a new client secret*, delete the old one.
3. **Webhook** → *Change* the secret to a fresh random value.
4. Run `scripts/rotate-github-bot.sh` and paste the two values when prompted.
   It reads the `.pem` off disk (newest `www-software-factory-bot*.pem` in
   `~/Downloads`, or `--pem <path>`) rather than asking you to paste a multi-line
   key, base64s it, and writes everything into SOPS. Prompts are silent and
   nothing is echoed. Press Enter to skip any credential you are not rotating —
   rotating only the webhook secret is fine.
5. Commit the re-encrypted `secrets/vault.yaml`, push, merge. The deploy rolls
   the k8s Secret.

⚠️ **Rotating the webhook secret opens a gap.** The public webhook relay and
its control-center API consumer both verify against the old secret until the
deploy lands, so deliveries in that window get a 401 — and GitHub does **not**
retry them automatically. Afterwards, open the App's *Advanced → Recent
Deliveries* and hit **Redeliver** on anything that failed. Replaying is safe:
`incoming_webhook` is keyed on the delivery id, so a redelivery cannot duplicate
a row.

The private key and client secret have no such window — nothing in the cluster
reads them yet.

`scripts/save-github-bot.sh` remains the bulk path, for when every credential is
being written at once from a manifest-conversion JSON (i.e. a fresh App).

App id and installation id are **not** secrets and never rotate.

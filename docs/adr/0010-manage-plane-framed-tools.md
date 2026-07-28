# manage: one framed shell for every tool we operate

`manage.worldwidewebb.co` is a two-column web app — a grouped sidebar of the tools we operate on
the left, the selected tool live in a same-page `<iframe>` on the right. It replaces the bookmark
folder: Control Center, Home Assistant, Plex, Grafana, Temporal, pgAdmin, Storybook, Cloudflare,
Cloudflare Zero Trust, Pulumi, Tailscale, UniFi, Synology and GitHub in one place, one keystroke
apart, each keeping its state while you switch away and back.

It ships as another control-center *service* (`apps/manage/`), declared in
`controlCenterProductManifest()` exactly like `storybook`, so its tunnel route and Access app fall
out of the existing exposure machinery rather than being wired by hand.

## The one hard problem: frame-deny

Every interesting tool refuses to be framed. Grafana ships `allow_embedding=false`; pgAdmin
defaults to `X_FRAME_OPTIONS=SAMEORIGIN`; UniFi answers `x-frame-options: SAMEORIGIN` (verified
live against `192.168.0.1`); Synology DSM sends the same plus a `content-security-policy`
(verified against `192.168.0.218:5001`); GitHub sends `x-frame-options: deny`. Neither appliance
exposes a supported toggle.

That header is not a server-side check. It is an instruction to the *browser*, honoured
voluntarily. Every design below is a different answer to "who deletes it, and for whom".

## Rejected: a reverse proxy under manage

The obvious shape — manage proxies each tool at `manage.worldwidewebb.co/t/<tool>/` and strips the
header on the way through — dies on sub-path support. Grafana (`serve_from_sub_path`), Temporal UI
(`PUBLIC_PATH`) and pgAdmin (`SCRIPT_NAME`) relocate fine, but Home Assistant emits `/`-rooted URLs
and ignores the path component of `external_url` (home-assistant/core#21113, still open), and DSM
and UniFi do the same. Serving those three would mean rewriting HTML and JavaScript in flight —
a body-rewriting MITM in front of the tools we depend on to debug outages.

The host-per-tool variant (`manage-grafana.worldwidewebb.co`, each upstream at `/`) avoids the
rewriting but buys a proxy service, its own session store, cookies scoped across the zone, and a
DNS record per tool — to solve a problem the browser can solve locally. It also makes manage
security-critical: it would hold a live session for every tool behind one gate we wrote ourselves.

## Rejected: Cloudflare response-header transform rules

Cloudflare can delete `x-frame-options` from responses at the edge, declaratively, next to the
Access apps. Zero code. But it deletes the header **for everyone** — `unifi.worldwidewebb.co`
becomes framable by any site on the internet, and clickjacking our gateway admin UI stops being
hypothetical. It also cannot help for `github.com`, `dash.cloudflare.com`, `app.pulumi.com` or any
other host outside our zone, which is half the sidebar.

## Rejected: an Electron shell

A native webview loads each tool as a *top-level* document, so frame-deny never applies and nothing
needs stripping. Genuinely clean, and the reason Wavebox, Ferdium and Rambox are all Electron. Two
costs sank it: the app becomes unreachable from a phone (the web version is not), and this repo has
no build-sign-distribute path — everything else here merges to `main` and deploys. Tauri was
considered and dropped separately: its multi-webview-per-window support is still behind an
`unstable` flag with open positioning, resize and blank-render bugs (tauri#10131, #10420, #10011),
and a sidebar shell is nothing but multiple webviews in one window.

## Decision: a local MV3 extension strips the header, in our browser only

`apps/manage/extension/` is a Manifest V3 extension using `declarativeNetRequest` with
`action.type: "modifyHeaders"` to remove `x-frame-options` and `content-security-policy`, under two
deliberate constraints:

- `"resourceTypes": ["sub_frame"]` — the rule fires only when the site is loaded *inside a frame*.
  Browsing to github.com normally is untouched and keeps every protection.
- `requestDomains` is an explicit allowlist generated from the tool registry. Never `<all_urls>`;
  a wildcard would strip headers across the entire browsing session.

The loosening therefore lives on one machine, scoped to frames, scoped to hosts we named — rather
than at the edge for the whole internet. It covers third-party hosts (`github.com`,
`dash.cloudflare.com`) that no zone-level rule could reach.

GitHub is a pane, not a launcher, because a direct iframe keeps the origin as `github.com`: the RP
ID matches and passkeys work, provided the embedder delegates the capability via
`allow="publickey-credentials-get; publickey-credentials-create"`. (This is only true for the
*direct* iframe. Under the rejected proxy design the origin becomes ours and WebAuthn fails by
construction — a proxy is indistinguishable from a phishing site to an authenticator.)

The allowlist is **generated from the registry**, not hand-maintained, following ADR-0002's
committed-codegen rule. The realistic failure here is adding a tool and forgetting the allowlist,
producing a pane that silently fails months later; codegen turns that into a build error.

## Degradation is a feature, not a fallback

The extension sets a marker on manage's own origin via a content script. The app reads it at boot
and knows which mode it is in: frame everything, or render launcher cards. There is no timeout
heuristic and no blank white pane — the two modes are both designed states. That is what keeps the
app fully usable on a phone, where no extension exists and every tool degrades to a labelled
button that opens its own Access-gated host.

## Consequences

- Two hosts gain tunnel routes and Access apps: `unifi.worldwidewebb.co` and
  `dsm.worldwidewebb.co`. Header stripping does not make a LAN IP routable, and an iframe cannot
  click through a self-signed certificate warning, so both need `noTLSVerify` origins — an
  extension to the ingress model in `infra/cloudflare/src/routes.ts`, which today expresses only
  `http://` origin strings.
- manage has **no authentication of its own**: no login, no session store, no database. Cloudflare
  Access is the gate, as for every other private host. It holds no credentials and no data — a list
  of links and a set of iframes — so a second gate in front of it would protect nothing while being
  the only stateful thing in the app.
- Panes lazy-mount on first open and are never evicted for the session, so switching preserves
  scroll position, open dashboards and half-typed SQL. Background tools keep live websockets; a
  long-mounted pane can outlive its Access session, which the per-pane reload button answers.
- Chrome or Chromium in practice. Safari's third-party cookie policy blocks framed sessions
  regardless of headers.
- Not open source. It is a curated shell for our tools, and the registry is a checked-in list, not
  a plugin API.

## As built (#292)

Shipped as designed. Four things worth recording because they are not derivable from the decision
above:

- **No Storybook row.** The design listed 14 tools; 13 shipped. The `control-center-storybook`
  workload was deleted in Track B and its tunnel route pruned, so a `storybook.worldwidewebb.co`
  pane would 502 forever. Storybook is a local-dev tool now.
- **The palette moved to `packages/theme`.** manage renders in the same black theme as the control
  center, and the only honest way to do that across two apps is one file both `@import`. Copying the
  `:root` block would have forked it.
- **The rule generator lives in `apps/manage/src/extension-rules.ts`, not `scripts/`.** It belongs
  beside the registry it renders from, and `scripts/` resolves as CommonJS under Playwright's
  loader, which the frame-unlock spec has to import through.
- **The accent bar on the active sidebar row is the one intentional deviation from the prototype.**
  The prototype's bar is drawn 10px to the left of its row, inside the scroll container's clip rect,
  so it never actually paints. manage widens the scroll box by exactly that 10px and pays it back as
  padding.

`unifi.worldwidewebb.co` and `dsm.worldwidewebb.co` exist as predicted, and needed the ingress-model
extension the decision anticipated (`DesiredOriginRequest`, rendered only for the rules that declare
it so every pre-existing rule stays byte-identical to live).

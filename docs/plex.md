# Plex Media Server

Plex runs as a workload in the `control-center` namespace on the `home-server`
Talos node. It serves the Synology media share to the Apple TV. The spec lives
in `infra/src/services.ts` (the `plex` workload + the `plex-config` claim); it
deploys via the normal push-to-`main` → CI `pulumi up` path on the
`home-server` stack.

## Shape

- **Image**: `plexinc/pms-docker:1.43.2.10687-563d026ea` (public, multi-arch).
  No GHCR pull secret, no digest pin, same as the other third-party image
  (cloudflared).
- **Config volume**: `plex-config` PVC (10Gi) on the node SSD, mounted at
  `/config`. Plex's SQLite databases live here and **must not** go on NFS
  (SQLite over NFS corrupts).
- **Media volume**: the Synology NFS export `/volume1/Homelab`, subPath `media`,
  mounted **read-only** at `/data` — the same share the worker's media ingest uses.
- **GPU**: `nvidia.com/gpu: 1` on the `nvidia` RuntimeClass, so hardware
  transcode uses the node's RTX 3060. The Deployment carries
  `pulumi.com/skipAwait` so a cold apply doesn't race the device plugin
  advertising GPU capacity.
- **Exposure**: a MetalLB `LoadBalancer` on `32400`, pinned to
  **`192.168.0.4`** (`LAN_SERVICE_IPS` in `infra/src/metallb.ts`), so the Apple
  TV on `192.168.0.0/24` reaches Plex at **`http://192.168.0.4:32400`**.
  `ADVERTISE_IP` is derived from that same constant.
  - The pin matters twice over: the MetalLB pool is `192.168.0.3-192.168.0.4`
    and shared with the `api` Service, and `ADVERTISE_IP` hardcodes the
    address. Unpinned, the two Services take whatever is free at create time
    and can swap on a recreate.
  - **The node IP is not a Plex address.** Nothing listens on `192.168.0.5:32400`;
    only the LoadBalancer answers. `ADVERTISE_IP` pointed at the node IP until
    2026-07-28, which advertised a refused connection to every client.

## Reachability check

From any LAN device:

```sh
curl -s http://192.168.0.4:32400/identity
```

A healthy server returns `MediaContainer` XML with a `machineIdentifier`. The
`claimed` attribute on that element is `0` until the one-time claim below.

## One-time manual claim (REQUIRED)

The server deploys **unclaimed** — no `PLEX_CLAIM` token is baked in, because
plex.tv/claim tokens expire ~4 minutes after issue so none can be pre-stored.
Claim it once, either way:

### Option A — browser on the LAN

1. From a device on `192.168.0.0/24`, open <http://192.168.0.4:32400/web>. An
   unclaimed server is reachable without auth only from the local network.
2. Sign in with the Plex account and complete the setup wizard; this claims the
   server to that account.

### Option B — claim token (headless)

1. On any machine signed into the target Plex account, open
   <https://plex.tv/claim> and copy the `claim-…` token (valid 4 min).
2. Inject it and let the entrypoint claim, then remove it:
   ```sh
   kubectl -n control-center set env deploy/plex PLEX_CLAIM=claim-XXXXXXXX
   kubectl -n control-center rollout status deploy/plex
   # once claimed (verify with /identity), clear it so it isn't reused:
   kubectl -n control-center set env deploy/plex PLEX_CLAIM-
   ```
   Note: this env override is imperative and will be reverted on the next
   `pulumi up`. That's fine — claim state persists in the `plex-config` PVC, so
   the server stays claimed regardless of the env var.

## Add the media library

After claiming, in **Settings → Libraries → Add Library**:

1. Pick the library type (Movies / TV Shows / Other Videos).
2. **Browse for media folder** → `/data` (the NFS `media/` share, read-only).
   Today it holds `dog-tv/` (DJ sets) and `youtube/`; `booth-photos/` and
   `wake-photos/` are stills, not video libraries.
3. Save. Plex scans and populates as content lands in the share.

## Apple TV

Two separate sign-ins, both required, in this order:

1. Claim the server and add the library above. A claimed-but-empty server shows
   nothing on the client.
2. Sign into the Plex app on the Apple TV with the **same** Plex account. The
   tvOS app has no anonymous local-server mode.

The `tv` feature (`features/tv/`) can select "Plex" as an Apple TV source via
Home Assistant, but it only launches the app — it does not talk to the Plex
API, and it can't sign in.

## Notes

- Config/metadata survive pod restarts and re-deploys via the `plex-config`
  PVC. Deleting that PVC resets the server to unclaimed + empty.
- `apps/manage` links to `app.plex.tv/desktop` — that's Plex's hosted web
  client, not this server's UI.

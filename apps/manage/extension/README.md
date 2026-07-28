# manage — frame unlock extension

Local, unpacked, one machine. It exists because the tools manage frames send
`x-frame-options` / CSP `frame-ancestors` and cannot be reverse-proxied under a
sub-path (Home Assistant, DSM and UniFi all emit `/`-rooted URLs). See
`docs/adr/0010-manage-plane-framed-tools.md`.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this directory (`apps/manage/extension/`)
3. Reload manage. The sidebar footer should read `extension active`.

## `manifest.json` and `rules.gen.json` are GENERATED

Do not hand-edit them. They are rendered from `apps/manage/src/registry.ts` by
`apps/manage/src/extension-rules.ts`:

```
bun run apps:gen     # regenerate
bun run apps:check   # fails on drift
```

Add a tool to the registry and the allowlist follows. That is the point — a
hand-maintained allowlist rots silently, and the failure mode is a blank pane
with nothing in any log.

## Scope

Two properties are the entire security argument for doing this locally instead
of stripping headers at the Cloudflare edge, and both are enforced by the
emitter:

- `resourceTypes: ["sub_frame"]` — framed documents only, never top-level
  navigation.
- `requestDomains` is the enumerated host list, never a wildcard.

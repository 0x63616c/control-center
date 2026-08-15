# Publishing to TestFlight (iOS)

Text Your Ex is a Vite + React web app wrapped in a **Capacitor** iOS shell. The
native app bundles the built web assets offline and talks to a hosted backend.

## Layout

- `capacitor.config.ts` - appId `co.worldwidewebb.textyourex`, `webDir: web/dist`.
- `ios/` - Capacitor-generated Xcode project (`ios/App/App.xcodeproj`, scheme `App`).
- `Fastfile` / `Gemfile` - fastlane lanes for signing + TestFlight upload.
- `.github/workflows/release-ios.yml` - CI: tag `vX.Y.Z` → build → TestFlight.

## The API base (important)

The web client calls `/api` (relative, same-origin) on the web. The bundled iOS
app has no same-origin server, so it must point at an absolute backend via the
build-time env `VITE_API_BASE` (see `web/src/api.ts`).

- **Web build:** leave `VITE_API_BASE` unset → relative `/api`.
- **iOS build:** set `VITE_API_BASE` to the hosted API, e.g.
  `https://api.textyourex.app`.

There is no hosted backend yet. Before the first real TestFlight build, set the
GitHub Actions **repository variable** `VITE_API_BASE` (Settings → Secrets and
variables → Actions → Variables) to the deployed API URL. CI threads it into the
web build automatically.

## Local loop

```
bun run ios:sync   # build web + copy into the iOS project
bun run ios:open   # open in Xcode
```

## Shipping

One-time signing setup is handled by the `publish-setup` skill (mints certs into
1Password, syncs them to GitHub secrets). Once that's done:

```
git tag v0.1.0 && git push --tags
```

CI builds, signs, and uploads to TestFlight. No further manual steps.

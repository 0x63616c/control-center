# Publishing Don’t Text Your Ex to TestFlight

Don’t Text Your Ex is a Vite + React application wrapped in a Capacitor iOS
shell. The native bundle contains the frontend and talks to the production API
over the public internet.

## Identity and production origin

- Display name: **Don’t Text Your Ex**
- Preserved bundle ID: `co.worldwidewebb.textyourex`
- Xcode project: `ios/App/App.xcodeproj`
- Scheme: `App`
- Production origin: `https://dont-text-your-ex.worldwidewebb.co`
- API route: `https://dont-text-your-ex.worldwidewebb.co/api/*`

The native `ASAuthorizationAppleIDProvider` flow produces an identity token
whose audience is the bundle ID. The API verifies that audience and Apple’s
issuer/signature. This native flow does not use a web Service ID or redirect
URL; any future browser-based Apple flow would require those separately.

## Local verification

From `apps/dont-text-your-ex`:

```sh
VITE_API_BASE=https://dont-text-your-ex.worldwidewebb.co bun run build
VITE_API_BASE=https://dont-text-your-ex.worldwidewebb.co bunx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

This proves the TypeScript bundle, Capacitor synchronization, and Swift bridge
compile together. It does not prove signing, the App ID capability, an upload,
or a real Sign in with Apple exchange.

## Signing and upload

`.github/workflows/dont-text-your-ex-ios.yml` builds and uploads on relevant
release changes pushed to `main` and on explicit manual dispatch. The workflow:

1. obtains the existing App Store Connect and match credentials from the
   encrypted repository vault;
2. builds the frontend with the fixed production origin;
3. synchronizes Capacitor;
4. checks the bundle ID, display name, entitlements, and Xcode signing wiring;
5. signs with the shared match repository;
6. verifies the Sign in with Apple entitlement in both the signed app and the
   provisioning profile before uploading.

Routine builds use match in read-only mode. After changing an App ID capability,
manually dispatch the workflow once with `regenerate_profile=true`; subsequent
builds should return to the read-only default.

## External TestFlight

The Fastfile provides two repository-controlled pieces:

```sh
bundle exec fastlane ios setup_external_testflight
```

This idempotently creates the external `Friends` group and requests a public
link. It changes App Store Connect state and therefore requires live release
credentials.

Then manually dispatch **Don’t Text Your Ex iOS** with
`distribute_external=true`. The release waits for processing, associates the
build with `Friends`, submits Beta App Review when required, and notifies the
external testers. An external-distribution error remains a failed release even
if the binary itself uploaded successfully.

Apple may require Beta App Review before it exposes the build or public link.
Completion therefore requires live evidence from App Store Connect plus a clean
installation and sign-in by an Apple ID that is not on the development team.

## Production acceptance evidence

Do not mark the iOS restoration complete until all of the following are
observed:

- App ID `co.worldwidewebb.textyourex` has Sign in with Apple enabled.
- The current distribution profile carries
  `com.apple.developer.applesignin = Default`.
- A newly uploaded build is processed and available in TestFlight.
- The signed app installs and launches on a physical iPhone.
- Sign in with Apple reaches the production `/api/auth/apple` endpoint.
- The resulting account/session persists in production Postgres.
- The primary application flows work over cellular or another external network.
- The `Friends` external group has the build and a non-team Apple ID can install
  it, either by invite or the public link.

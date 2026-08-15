# Don’t Text Your Ex — Restoration and Deployment Plan

## 1. Recover the correct version

- Restore `products/text-your-ex` from commit `486a0ebbc`.
- Use this as the authoritative version because it is the final `world-wide-webb` implementation before deletion.
- Do **not** use the older standalone `text-your-ex` repository.
- Move the restored application into:

```text
apps/dont-text-your-ex
```

## 2. Rename the application cleanly

Use the following naming conventions:

- User-facing app name: **Don’t Text Your Ex**
- Repository/app slug: `dont-text-your-ex`
- Kubernetes namespace: `dont-text-your-ex`
- Public hostname: `dont-text-your-ex.worldwidewebb.co`
- Preserve the existing Apple bundle ID: `co.worldwidewebb.textyourex`

Update old `text-your-ex` and `tye` references where they refer to application or infrastructure naming, without unnecessarily changing persistent Apple identity.

## 3. Adapt it to the current `world-wide-webb` repository

Do not restore the old infrastructure implementation wholesale.

Instead:

- Update workspace/package paths.
- Update imports and build configuration.
- Update Docker build paths.
- Update CI/CD references.
- Update scripts that still expect `products/text-your-ex`.
- Replace obsolete infrastructure patterns with the current `world-wide-webb` equivalents.
- Keep the application entirely inside the monorepo.

Target structure:

```text
world-wide-webb/
├── apps/
│   └── dont-text-your-ex/
│       ├── frontend/
│       ├── api/
│       ├── ios/
│       ├── migrations/
│       ├── e2e/
│       └── ...
└── infra/
```

## 4. Bring up the backend on the home server

Create a dedicated Kubernetes namespace:

```text
dont-text-your-ex
```

Deploy and configure:

- CNPG Postgres cluster.
- Persistent storage.
- Database backups.
- Required secrets.
- API deployment.
- API service.
- Health/readiness checks.

Then:

- Run all database migrations.
- Verify the API can connect to Postgres.
- Verify data persists through pod restarts.
- Verify secrets are provided through the current homelab mechanism rather than hardcoded configuration.

## 5. Deploy the frontend

Build and deploy the frontend into the same `dont-text-your-ex` namespace.

Use a single public hostname:

```text
https://dont-text-your-ex.worldwidewebb.co
```

Route:

```text
/          → frontend
/api/*     → API
```

Avoid exposing a separate public API hostname unless there is a concrete technical reason to do so.

## 6. Expose it over the public internet

Integrate the application with the current `world-wide-webb` Cloudflare and home-server routing.

Configure and verify:

- DNS.
- TLS certificates.
- Cloudflare routing/tunnel configuration.
- Kubernetes ingress/HTTP routing.
- Frontend routing.
- `/api` routing.

Verification must be performed against the real public hostname, not only through cluster-local access or `kubectl port-forward`.

Prove that:

```text
https://dont-text-your-ex.worldwidewebb.co
```

is reachable from outside the home network and that API requests successfully reach the home-server deployment.

## 7. Restore Sign in with Apple

Recover and verify the existing Sign in with Apple implementation, including:

- Native Swift/Capacitor bridge.
- Apple entitlements.
- App ID capabilities.
- Sign in with Apple configuration.
- Backend Apple token validation.
- Redirect/origin configuration where applicable.
- Authentication/session persistence in Postgres.

Test the complete flow:

```text
iPhone
  ↓
Sign in with Apple
  ↓
Don’t Text Your Ex API
  ↓
Postgres
  ↓
authenticated session/account
```

Do not assume that because it previously worked it still works. Verify the complete production flow.

## 8. Restore the iOS/TestFlight build

Update the iOS application so its displayed name is:

**Don’t Text Your Ex**

Keep the existing bundle identity unless verification shows that this is impossible.

Restore/update:

- Capacitor configuration.
- Native iOS project.
- Signing configuration.
- Entitlements.
- Fastlane/release automation.
- GitHub Actions TestFlight workflow.
- Production API/frontend configuration.

Build the app and upload a new version to the existing App Store Connect application.

Verify the TestFlight build:

- Installs successfully.
- Launches successfully.
- Talks to the new homelab production environment.
- Signs in with Apple successfully.
- Can use the application's primary functionality.

## 9. Make TestFlight available to friends

Configure external TestFlight distribution rather than relying only on internal App Store Connect testers.

Set up:

- External TestFlight testing group.
- Required tester/build configuration.
- Beta App Review if Apple requires it.
- Public TestFlight link if appropriate.

Verify using an Apple ID that is not part of the development team.

The intended result is that a friend can:

```text
open TestFlight link
→ install Don’t Text Your Ex
→ launch app
→ Sign in with Apple
→ use the app over the public internet
```

## 10. Perform complete end-to-end verification

Before considering the restoration complete, verify the system from a clean user perspective.

Test:

- Fresh TestFlight installation.
- Launch over cellular/public internet.
- Public hostname availability.
- Sign in with Apple.
- Authentication state.
- API requests.
- Database reads/writes.
- Core Don’t Text Your Ex functionality.
- Pod/container restarts.
- Data persistence.
- Database backups.
- Frontend and API health checks.
- CI/CD deployment.
- A subsequent deployment without manual recovery steps.

The finished architecture should look approximately like:

```text
TestFlight iPhone App
         │
         ▼
https://dont-text-your-ex.worldwidewebb.co
         │
         ├── /        → frontend
         │
         └── /api/*   → API
                          │
                          ▼
                 Kubernetes namespace
                  dont-text-your-ex
                          │
                ┌─────────┴─────────┐
                │                   │
               API            CNPG Postgres
                                    │
                              persistent data
                               + backups
```

## Definition of done

The project is complete when:

- `apps/dont-text-your-ex` contains the restored modern application.
- It is deployed to the home server in the `dont-text-your-ex` namespace.
- `https://dont-text-your-ex.worldwidewebb.co` works over the public internet.
- Sign in with Apple works end-to-end.
- Data is stored correctly in Postgres.
- A new TestFlight build is published.
- Friends can install it through TestFlight.
- A fresh external user can install, authenticate, and use the application successfully.
- Deployments, persistence, backups, and CI have all been verified rather than merely configured.

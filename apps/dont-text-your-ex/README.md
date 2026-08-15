# Don’t Text Your Ex

> A shared guilt jar for friends trying not to text their exes.

You and your friends know who shouldn't be texting whom. Make a pact, throw your slip-ups
into a shared **jar**, and watch the guilt money pile up. Every time someone caves and texts
their ex, it gets logged. The tally grows. Your friends find out. Shame, but make it a leaderboard.

No real money moves (the "Settle up" button is intentionally inert), and detection is honor-system:
you log it yourself or a friend reports you.

![onboarding](docs/design-reference/project/shots/onboarding.png)

## Stack

| Layer | Tech |
|---|---|
| Web | React 18 + TypeScript + Vite, iPhone-framed web app + iOS Capacitor shell |
| API | Bun + Hono, Postgres (CNPG on the production Talos cluster, Docker for local dev) |
| Auth | Real "Sign in with Apple" (iOS native) + bearer-token sessions |
| Tests | Vitest (API contract tests) + Playwright (E2E, requires Postgres) |
| Deploy | Two images: `Dockerfile.api` (Bun/Hono) + `Dockerfile.frontend` (nginx static) |

Money is stored as integer cents everywhere; the data model is Stripe-ready so real payments can
drop in later without a schema rewrite.

## Quick start (local dev with Tilt)

```bash
bun install
tilt up   # starts Docker Postgres (:5432) + API (:8787) + Vite dev server (:5173)
```

Open <http://localhost:5173>. Login is real "Sign in with Apple", which only works inside the
native iOS app (the Apple sheet can't run in a desktop browser). For local browser dev, mint a
session against the non-production `/auth/dev` seam and drop the token into the page:

```bash
curl -s localhost:8787/api/auth/dev -d '{"as":"calum"}' -H 'content-type: application/json'
# → { "token": "...", ... }   then in the browser console:
#   localStorage.setItem("tye_token", "<token>"); location.reload()
```

`/auth/dev` (and `/test/reset`, used by e2e) return 404 in production.

Demo invite code: **`XEX24K`** (The Group Chat).

## Scripts

| Command | What it does |
|---|---|
| `tilt up` | Full local stack (Postgres + API + Vite) |
| `bun run seed` | Explicitly seed demo data (dev only, no-op in production) |
| `bun run seed:reset` | Truncate + explicitly reseed (dev/e2e only) |
| `bun run build` | Build the web app to `apps/frontend/dist` |
| `bun run test:e2e` | Playwright E2E suite (requires DATABASE_URL) |
| `bun run ios:sync` | Build web + sync to Capacitor iOS |
| `bun run ios:open` | Open Xcode |
| `bun run ios:sim` | Live-reload simulator |

## Features

- **Jars** - named accountability groups with a rule, a per-slip cost, members and a running pot.
- **Slips** - self-log "I texted my ex" with an amount, optional private ex label, and a note.
- **Clean streak** - "days since I last texted my ex," opt-in to share per jar.
- **Reports** - flag a friend with text and/or screenshot evidence, optionally anonymously.
  Camera originals up to 25 MiB are decoded and normalized in the app to a server-safe JPEG; the
  accused gets to own it (logs the slip) or deny it.
- **Wall of shame** - per-jar leaderboard sorted by tally, with streaks shown for sharers.
- **Invites** - share an invite code / link from any jar; join by code with a preview first.
- **Activity feed** - slips, reports, joins, and milestones ("the jar just cracked $100").
- **Profile** - edit name/avatar and per-jar share-streak toggles. Photo avatars use a movable,
  zoomable circular crop and save a 512×512 JPEG. Emoji and color choices stay eight-across on
  iPhone 16 Pro/Pro Max, with a balanced four-by-two fallback on narrower screens.

## Architecture

```
apps/
  api/
    src/
      db/
        migrations/   SQL files run in order on startup (_tye_migrations tracks applied)
        index.ts      pg Pool + buildDatabaseUrl() (DATABASE_URL wins, else POSTGRES_PASSWORD_FILE)
        migrate.ts    migration runner
      store.ts        all business logic (async, pool.query, positional $1/$2 params)
      api.ts          Hono routes (auth, me, jars, slips, reports, activity)
      auth.ts         bearer-token middleware
      env.ts          buildDatabaseUrl() (k8s ESO pattern + DATABASE_URL override)
      seed.ts         explicit demo/e2e seed data; guarded off in production
      index.ts        entry: runMigrations + ensureSeed + buildApp()
      server.ts       CORS allow-list (production host, localhost:*, capacitor://)
  frontend/           React + TS app (iPhone frame, 16 screens)
    src/
      api.ts          typed client (VITE_API_BASE baked at Docker build time)
  e2e/                Playwright specs (require DATABASE_URL, TYE_RESET=1 for clean run)
ios/                  Capacitor iOS kiosk shell
docs/                 product spec + design handoff (design-reference/)
```

The design is preserved under `docs/design-reference/` and the product spec under `docs/superpowers/specs/`.

## Production deployment

Two images are built by CI on push to main:

| Workload | Dockerfile | Port |
|---|---|---|
| API | `Dockerfile.api` | `8787` |
| Frontend | `Dockerfile.frontend` | `80` |

The API image sets `APP_ENV=production` (seed guard). The frontend and API share one public
origin, so browser requests use relative `/api/*` paths.

The production target is `https://dont-text-your-ex.worldwidewebb.co` in the
`dont-text-your-ex` Kubernetes namespace.

### Production acceptance checklist

Do not mark these complete until they have been verified against the current production cluster:

- [ ] Pulumi applied the CNPG cluster, API, and frontend workloads.
- [ ] API and frontend pods are healthy in `dont-text-your-ex`.
- [ ] `https://dont-text-your-ex.worldwidewebb.co/api/health` returns `{"ok":true}`.
- [ ] Native Sign in with Apple creates and resumes a production account.
- [ ] Jar creation, slip logging, and report flows work end to end.
- [ ] A database backup completed and its artifact was verified.
- [ ] A TestFlight build installs and uses the production host.
- [ ] Production boot does not seed demo users.

## Not in v1

Real payments, payouts, committee voting on denied reports, push notifications, and on-device
contacts integration are out of scope. Authentication is real "Sign in with Apple" on iOS; there
is no phone/OTP or web-browser login path.

**iOS Sign in with Apple capability:** the app ships the `com.apple.developer.applesignin`
entitlement (`ios/App/App/App.entitlements`). The App ID's "Sign in with Apple" capability is
enabled and the provisioning profile regenerated by the `setup_ios` fastlane lane (run
`fastlane/` `setup-app.sh` once); without it the native button fails to authorize on device.

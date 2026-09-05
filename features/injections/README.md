# Injection tracker

`tile_injections` is a PIN-session-sensitive Control Center App beside Weight.
The existing 1366×1024 panel shell, tRPC, Postgres migrations, and media volume own
its runtime. No separate backend or weight store is introduced.

## Records and calculations

- A course stores medication, timezone, configurable half-life, display defaults,
  stage schedule and notes. Weeks are seven calendar dates from its start date.
- Planned events are derived from stage ranges, weekdays and local wall time.
  Actual injections are independent timestamped events with an optional explicit
  link to a planned event. An unlinked plan is never automatically called missed.
- A vial freezes concentration and syringe scale after its first recorded draw.
  Volume is `units / unitsPerMl`; dose is volume × concentration. Editing a draw
  immediately recalculates the timeline, weekly totals and remaining volume.
- Course/vial row locks serialize capacity checks. Injection removal is a
  tombstone. Vial retirement, discard date and course completion are independent.
- The estimate sums `doseMg × 0.5 ** (elapsedDays / halfLifeDays)` for each past
  actual injection. Charts sample six-hour intervals and both sides of every
  exact event timestamp. The estimate is an amount, not plasma concentration.
  Semaglutide defaults to seven days; other medication names clear this default.
  Source: [FDA semaglutide labeling, section 12.3](https://www.accessdata.fda.gov/drugsatfda_docs/label/2025/215256s024lbl.pdf).
- `weight.timeline` returns canonical included, non-deleted readings with manual
  weight overrides applied. No copied measurements are stored. Course statistics
  begin at the first included reading on/after course start and label that basis.
- Check-ins store a sparse, configurable 0–4 field map and optional daily/weight
  note. Injection and course notes remain attached to their owning records.
- Progress JPEGs use the existing media volume under `progress-photos/`; metadata
  lives in Postgres. Camera access occurs only while capture is open. Pose guides
  and optional reference ghost are display-only, never burned into saved photos.
  Capture is reviewed before upload; failed uploads preserve the local capture.
  The viewer supports same-pose side-by-side, reveal slider and opacity overlay.

## Scenarios and privacy

The supplied 2024 and 2026 schedules can be added as explicit `scenario` courses.
They have no actual injection or invented weight records. Their July 5 / September
4 start dates are illustrative calendar anchors, not historical claims. The
comparison assumes every planned injection and labels that assumption. A real
course requires a user-entered start date and actual logs.

The feature follows the accepted client-only PIN boundary (ADR-0004), the same
API access boundary as Weight. It is not guest-exposed. Image reads validate the
record and use `private, no-store`; removed images no longer resolve through the
route. Photo bytes remain on the existing backed-up media volume. Logs contain
record IDs and sizes, never journal notes, image bytes or dose values.

## Verification

- `bun run test features/injections/model.test.ts features/weight/api.test.ts features/weight/service.test.ts`
- `bun run --cwd apps/web test -- --project storybook features/injections/web/Tracker.stories.tsx`
- `bun run typecheck`, `bun run apps:check`, normal Biome/Knip push gates.
- Opt-in Postgres integration: migrate a disposable local database named
  `injection_tracker`, then set `INJECTION_TEST_DATABASE_URL` to its localhost
  connection URL and run `bun run test injection-tracker-integration.test.ts`.
  This test does not use the application's normal DATABASE_URL and checks real
  persistence, concurrent overdraw rejection, edits, check-in upserts and deletes.

The existing push-to-main deployment publishes web/API/worker images. The iPad
shell loads `https://app.worldwidewebb.co`, so this feature requires no native
binary update. Actual camera framing still depends on physical iPad position;
there is no automatic body recognition or dosing recommendation engine.

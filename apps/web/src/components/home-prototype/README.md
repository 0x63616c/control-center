# Soft white home — design prototype

Question: can the clock, bedroom and living-room lamp groups, AC, fan, Sonos, current weather, and hourly forecast share one calm, non-scrolling 1366 × 1024 screen?

This single direction follows the user's supplied white widget reference. It lives only in Storybook; the production board and device integrations are unchanged. Initial values were read from the production API on September 6, 2026 at 18:54 UTC. The clock runs in America/Los_Angeles. Subsequent interactions stay in React state. Auto's 70–75°F range is an exploratory selection, not an observed device setting. The weather is a dated snapshot, not a live forecast.

The bedroom shortcut represents the strip and two bedside lamps specified by the user. Living room represents the other house lamps. Ceiling fixtures are excluded. The proposed grouping still needs entity-level wiring during implementation. Sonos volume is explicitly the Desk coordinator volume; grouping actions are simulated.

Run from `apps/web`: `bun run storybook -- --port 16006 --no-open`.

Open `/iframe.html?id=prototypes-bento-home--white&viewMode=story` at 1366 × 1024. The first rendered design is captured in `output/bento-home/soft-white.png` in this worktree.

Validation: web TypeScript check and Biome pass. Playwright verified exact screen dimensions, no document overflow, no clipped cards, no browser errors, independent lamp toggles, all-off, fan toggle, temperature increments, disabled setpoint controls while off, Auto range selection, Sonos grouping selection, and volume changes. Physical touch ergonomics and production integration remain outside this design prototype.

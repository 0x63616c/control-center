import { TeslaTileStatus, TeslaTileView } from "@features/tesla/web";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { defineTileMeta } from "./__stories__/factory";

// Storybook stories for TeslaTileView covering all visual states.
// Play functions use storybook/test matchers (browser env); vitest component tests
// live in __tests__/TeslaTileView.stories.test.tsx via composeStories.

const meta = {
  ...defineTileMeta("TeslaTileView", TeslaTileView),
  parameters: {
    layout: "padded",
    // Stories are visual previews at board dimensions , not integration tests.
    viewport: { defaultViewport: "board" },
  },
} satisfies Meta<typeof TeslaTileView>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Story: Loading (Skeleton) ─────────────────────────────────────────────────

export const Loading: Story = {
  args: { status: TeslaTileStatus.Loading },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Skeleton state: tile + title stay visible so the tile is identifiable; only data is shimmered.
    const tile = canvasElement.querySelector(".tile");
    expect(tile).not.toBeNull();
    expect(canvas.getByText("Tesla")).toBeInTheDocument();
    expect(canvas.queryByText(/\d+%/)).not.toBeInTheDocument();
  },
};

// ── Story: Offline (#42) , car fully off or unreachable, no last-seen known ──

export const ErrorState: Story = {
  name: "Offline · unknown last-seen",
  args: { status: TeslaTileStatus.Error, lastSeenAt: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tile = canvasElement.querySelector(".tile");
    expect(tile).not.toBeNull();
    expect(canvas.getByText("Tesla")).toBeInTheDocument();
    expect(canvas.getAllByText("Offline").length).toBeGreaterThan(0);
    // No fabricated age when we've never had a successful poll this session.
    expect(canvas.getByText("Last online unknown")).toBeInTheDocument();
  },
};

// ── Story: Offline with a known last-seen time ───────────────────────────────

export const OfflineWithLastSeen: Story = {
  name: "Offline · last online 5hrs ago",
  args: {
    status: TeslaTileStatus.Error,
    lastSeenAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getAllByText("Offline").length).toBeGreaterThan(0);
    expect(canvas.getByText("Last online 5hrs ago")).toBeInTheDocument();
  },
};

// ── Story: stale-but-populated , the poll is failing but a last-known snapshot
// is still shown (data-first precedence, www-355t.13); flagged rather than
// silently read as live (#42). ────────────────────────────────────────────────

export const StalePolling: Story = {
  name: "Populated · currently offline (stale snapshot)",
  args: {
    status: TeslaTileStatus.Populated,
    locked: true,
    charging: false,
    rate: 0,
    pct: 64,
    range: 192,
    odo: "12,345 mi",
    climate: 66,
    lat: 34.0537,
    lon: -118.2428,
    place: "Home",
    stale: true,
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText(/Offline · synced 2hrs ago/)).toBeInTheDocument();
    // Last-known values still render (data-first), dimmed like the Asleep case.
    expect(canvas.getByText("64%")).toBeInTheDocument();
    expect(canvasElement.querySelector("[data-asleep]")).not.toBeNull();
  },
};

// ── Story: Populated , locked, not charging ───────────────────────────────────

export const Populated: Story = {
  args: {
    status: TeslaTileStatus.Populated,
    locked: true,
    charging: false,
    rate: 0,
    pct: 80,
    range: 240,
    odo: "12,345 mi",
    climate: 72,
    lat: 34.0537,
    lon: -118.2428,
    place: "Home",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Tesla")).toBeInTheDocument();
    expect(canvas.getByText("Locked")).toBeInTheDocument();
    expect(canvas.getByText("Idle")).toBeInTheDocument();
    expect(canvas.getByText("80%")).toBeInTheDocument();
    // Idle: range is muted gray, charge bar is gray (no green glow). Assert the
    // inline style declaration (carries the var() token) rather than toHaveStyle,
    // which compares COMPUTED style , a real browser resolves var() to rgb so the
    // token never matches. The inline declaration reads back the token in both envs.
    const range = canvas.getByText("240 mi");
    expect((range as HTMLElement).style.color).toBe("var(--ink-2)");
    const fill = canvasElement.querySelector("[data-charge-fill]");
    expect(fill).not.toBeNull();
    expect(fill).toHaveAttribute("data-charging", "false");
    expect(canvas.getByText("12,345 mi")).toBeInTheDocument();
    expect(canvas.getByText("72°F")).toBeInTheDocument();
  },
};

// ── Story: Populated , unlocked, charging ────────────────────────────────────

export const Charging: Story = {
  args: {
    status: TeslaTileStatus.Populated,
    locked: false,
    charging: true,
    rate: 25,
    pct: 55,
    range: 165,
    odo: "12,345 mi",
    climate: 68,
    lat: 34.0537,
    lon: -118.2428,
    place: "Home",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Tesla")).toBeInTheDocument();
    expect(canvas.getByText("Unlocked")).toBeInTheDocument();
    // Charging pill renders rate inline as "Charging · +25 mi/hr"
    expect(canvas.getByText(/Charging/)).toBeInTheDocument();
    expect(canvas.getByText(/\+25 mi\/hr/)).toBeInTheDocument();
    expect(canvas.queryByText("Idle")).not.toBeInTheDocument();
    expect(canvas.getByText("55%")).toBeInTheDocument();
    // Charging: range is green accent, charge bar is the green gradient. Assert the
    // inline style declaration (the var() token), not toHaveStyle's computed value
    // which a real browser resolves to rgb. Holds in both jsdom and chromium.
    const range = canvas.getByText("165 mi");
    expect((range as HTMLElement).style.color).toBe("var(--acc)");
    const fill = canvasElement.querySelector("[data-charge-fill]");
    expect(fill).not.toBeNull();
    expect(fill).toHaveAttribute("data-charging", "true");
    expect(canvas.getByText("68°F")).toBeInTheDocument();
  },
};

// ── Story: Asleep , stale last-known snapshot ────────────────────────────────

export const Asleep: Story = {
  args: {
    status: TeslaTileStatus.Populated,
    locked: true,
    charging: false,
    rate: 0,
    pct: 64,
    range: 192,
    odo: "12,345 mi",
    climate: 66,
    lat: 34.0537,
    lon: -118.2428,
    place: "Home",
    asleep: true,
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Asleep pill replaces Idle/Charging and carries the snapshot age.
    expect(canvas.getByText(/Asleep · 2hrs/)).toBeInTheDocument();
    expect(canvas.queryByText("Idle")).not.toBeInTheDocument();
    expect(canvas.queryByText(/Charging/)).not.toBeInTheDocument();
    // Last-known values still render, dimmed: percent + range muted, bar gray.
    expect(canvas.getByText("64%")).toBeInTheDocument();
    const range = canvas.getByText("192 mi");
    expect((range as HTMLElement).style.color).toBe("var(--ink-2)");
    const fill = canvasElement.querySelector("[data-charge-fill]");
    expect(fill).toHaveAttribute("data-charging", "false");
    // Stale data must not look fresh , whole data area is dimmed.
    expect(canvasElement.querySelector("[data-asleep]")).not.toBeNull();
  },
};

// ── Story: Populated , no GPS location (null lat/lon) ────────────────────────

export const NoLocation: Story = {
  name: "Populated , no GPS",
  args: {
    status: TeslaTileStatus.Populated,
    locked: true,
    charging: false,
    rate: 0,
    pct: 91,
    range: 273,
    odo: "10,001 mi",
    climate: 70,
    lat: null,
    lon: null,
    place: "Location unavailable",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Tile still renders fully with null coordinates; map defaults to home center
    expect(canvas.getByText("Tesla")).toBeInTheDocument();
    expect(canvas.getByText("Locked")).toBeInTheDocument();
    expect(canvas.getByText("91%")).toBeInTheDocument();
    expect(canvas.getByText("Location unavailable")).toBeInTheDocument();
  },
};

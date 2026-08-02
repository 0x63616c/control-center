import { describe, expect, it } from "vitest";
import deploysManifest from "./manifest";
import { formatAgo, formatElapsed, STALE_AFTER_MS, staleForOf, toModalCommits } from "./web";

const NOW = Date.parse("2026-07-18T12:00:00Z");

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

// The tile helper contract: everything the container derives from the wire
// status is pure and testable without mounting trpc.

describe("formatAgo / formatElapsed", () => {
  it("formats compact ages across unit boundaries", () => {
    expect(formatAgo(iso(42_000), NOW)).toBe("42s");
    expect(formatAgo(iso(14 * 60_000), NOW)).toBe("14m");
    expect(formatAgo(iso(3 * 3_600_000), NOW)).toBe("3h");
    expect(formatAgo(iso(2 * 86_400_000), NOW)).toBe("2d");
  });

  it("formats a run timer as seconds then m+s", () => {
    expect(formatElapsed(iso(42_000), NOW)).toBe("42s");
    expect(formatElapsed(iso(2 * 60_000 + 14_000), NOW)).toBe("2m14s");
  });

  it("clamps a slightly-future timestamp to zero instead of going negative", () => {
    expect(formatAgo(iso(-2_000), NOW)).toBe("0s");
  });
});

function statusFixture(overrides: Record<string, unknown> = {}) {
  return {
    configured: true,
    lastPolledAtUtc: iso(8_000),
    consecutiveFailures: 0,
    deployedSha: "45d404effaaaabbbbcccc",
    deployedAtUtc: iso(14 * 60_000),
    mainHeadSha: "45d404effaaaabbbbcccc",
    commitsBehind: 0,
    run: null,
    failure: null,
    commits: [
      {
        sha: "45d404effaaaabbbbcccc",
        message: "feat: thing",
        htmlUrl: "https://github.com/0x63616c/world-wide-webb/actions/runs/1",
        committedAtUtc: iso(14 * 60_000),
        state: "deployed" as const,
        changedFileCount: 3,
        additions: 120,
        deletions: 8,
      },
    ],
    ...overrides,
  };
}

describe("staleForOf", () => {
  it("is null while polls are fresh and passing", () => {
    expect(staleForOf(statusFixture(), NOW)).toBeNull();
  });

  it("reports the age once the last poll is too old", () => {
    const status = statusFixture({ lastPolledAtUtc: iso(STALE_AFTER_MS + 60_000) });
    expect(staleForOf(status, NOW)).toBe("6m");
  });

  it("reports stale on a failure streak even when the last attempt was recent", () => {
    // The expired-PAT case: polls keep happening, all failing.
    const status = statusFixture({ consecutiveFailures: 3 });
    expect(staleForOf(status, NOW)).toBe("8s");
  });
});

describe("toModalCommits", () => {
  it("shortens shas, formats ages, and defaults a missing diffstat to zeros", () => {
    const status = statusFixture({
      commits: [
        {
          sha: "abcdef0123456789",
          message: "fix: x",
          htmlUrl: "https://github.com/0x63616c/world-wide-webb/actions/runs/1",
          committedAtUtc: iso(60_000),
          state: "failed" as const,
          changedFileCount: null,
          additions: null,
          deletions: null,
        },
      ],
    });
    expect(toModalCommits(status, NOW)).toEqual([
      {
        sha: "#abcdef0",
        message: "fix: x",
        when: "1m",
        state: "failed",
        htmlUrl: "https://github.com/0x63616c/world-wide-webb/actions/runs/1",
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      },
    ]);
  });
});

describe("App manifest", () => {
  it("declares tile_deploys at 34,24 4x3 (label matches the TileHeader title)", () => {
    const entry = deploysManifest.tiles.find((tile) => tile.id === "tile_deploys");
    expect(entry).toMatchObject({
      label: "Deploys",
      worldCol: 34,
      worldRow: 24,
      cols: 4,
      rows: 3,
    });
  });
});

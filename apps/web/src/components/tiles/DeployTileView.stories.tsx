import { type DeployCommit, DeployTileView } from "@features/deploys/web";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { createElement } from "react";
import { tilePixelSize } from "@/lib/grid-constants";
import { defineTileMeta } from "./__stories__/factory";

// This story uses an explicit footprint rather than importing the generated web
// aggregate and its complete Tile component graph.
const TILE_COLS = 4;
const TILE_ROWS = 3;

const TileSizeDecorator: Decorator = (Story) => {
  const { width, height } = tilePixelSize(TILE_COLS, TILE_ROWS);
  return createElement(
    "div",
    {
      className: "e-root",
      style: { width, height, display: "flex", flexDirection: "column", background: "var(--bg)" },
    },
    createElement(Story),
  );
};

// Title and tags are written literally, NOT spread from defineTileMeta: the CSF
// indexer only reads statically-analyzable fields, so a factory spread silently
// yields a path-derived title and drops the autodocs tag (the same hazard
// factory.ts documents for modal metas). argTypes still come from the factory.
const meta = {
  title: "Tiles/DeployTileView",
  component: DeployTileView,
  tags: ["autodocs"],
  argTypes: defineTileMeta("DeployTileView", DeployTileView).argTypes,
  parameters: { layout: "padded" },
  decorators: [TileSizeDecorator],
} satisfies Meta<typeof DeployTileView>;

export default meta;
type Story = StoryObj<typeof meta>;

// Real commits from this repo , no invented history.
const COMMITS: DeployCommit[] = [
  {
    sha: "#ea8aadd",
    message: "docs: design for GitHub/deploy status tile",
    when: "14m",
    state: "deployed",
  },
  {
    sha: "#6d5d276",
    message: "chore(ci): refresh coverage + loc badges",
    when: "1h",
    state: "skipped",
  },
  {
    sha: "#676314c",
    message: "fix(infra): recreate NFS PVs on capacity change",
    when: "3h",
    state: "deployed",
  },
];

const BASE = {
  status: "populated",
  deployedSha: "#ea8aadd",
  deployedWhen: "14m ago",
  commitsBehind: 0,
  run: null,
  failure: null,
  commits: COMMITS,
  staleFor: null,
} as const;

export const UpToDate: Story = {
  args: { ...BASE },
};

export const Behind: Story = {
  args: {
    ...BASE,
    deployedSha: "#676314c",
    deployedWhen: "3h ago",
    commitsBehind: 2,
    commits: [
      { ...COMMITS[0], state: "deployed" } as DeployCommit,
      COMMITS[1] as DeployCommit,
      { ...COMMITS[2], state: "deployed" } as DeployCommit,
    ],
  },
};

export const Deploying: Story = {
  args: {
    ...BASE,
    deployedSha: "#676314c",
    deployedWhen: "3h ago",
    run: { jobName: "build-web", stepName: "docker buildx", elapsed: "2m14s" },
    commits: [{ ...COMMITS[0], state: "building" } as DeployCommit, ...COMMITS.slice(1)],
  },
};

export const Failed: Story = {
  args: {
    ...BASE,
    deployedSha: "#676314c",
    deployedWhen: "3h ago",
    failure: { jobName: "deploy", stepName: "pulumi up" },
    commits: [{ ...COMMITS[0], state: "failed" } as DeployCommit, ...COMMITS.slice(1)],
  },
};

export const Stale: Story = {
  args: { ...BASE, staleFor: "42m" },
};

export const Unconfigured: Story = {
  args: { ...BASE, unconfigured: true },
};

export const Loading: Story = {
  args: { status: "loading" },
};

// Snapshot of the repo's ACTUAL state at 2026-07-18 15:52Z, pulled via
// `gh run list` + `git log origin/main`: a CI run in flight on the revert
// commit, last successful deploy 89e8ff3 30m earlier, and everything between
// either superseded (cancelled by a newer push) or [skip ci]. This is what the
// tile would have shown on the wall at that moment.
export const LiveSnapshot: Story = {
  args: {
    status: "populated",
    deployedSha: "#89e8ff3",
    deployedWhen: "30m ago",
    commitsBehind: 3,
    run: { jobName: "build-web", stepName: "docker buildx", elapsed: "9m12s" },
    failure: null,
    staleFor: null,
    commits: [
      {
        sha: "#ff26b8b",
        message: 'Revert "ci: add a dispatchable apply for the cloudflare edge stack"',
        when: "9m",
        state: "building",
      },
      {
        sha: "#1147ca3",
        message: "ci: add a dispatchable apply for the cloudflare edge stack",
        when: "14m",
        state: "skipped",
      },
      {
        sha: "#9b2b8c7",
        message: "fix(control-center/web): dim wake tap really is swallowed now",
        when: "15m",
        state: "skipped",
      },
      {
        sha: "#ddbbaa9",
        message: "chore(ci/www-afz): refresh coverage + loc badges [skip ci]",
        when: "22m",
        state: "skipped",
      },
      {
        sha: "#89e8ff3",
        message: "feat(control-center/web): logs viewer age column + auto-loading history",
        when: "30m",
        state: "deployed",
      },
      {
        sha: "#ee83592",
        message: "fix(control-center): apply review findings on session correlation",
        when: "35m",
        state: "skipped",
      },
    ],
  },
};

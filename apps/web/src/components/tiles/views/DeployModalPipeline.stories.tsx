/**
 * Stories for DeployModalPipeline , the Deploys tile detail page body.
 * Grouped under "Modals/Deploy" , the component is a bare page body now
 * (hosted by TileDetailHost in the app), so stories mount it inside a plain
 * page-sized container matching the host's content region. Fixture data is
 * the repo's REAL state at 2026-07-18 15:52Z (gh run list + git log/show ,
 * shas and diffstats are genuine), so the prototype shows exactly
 * what the wall would have.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { modalDocsParameters, pageHostDecorator } from "../__stories__/factory";
import { type DeployModalCommit, DeployModalPipeline } from "./DeployModalPipeline";

// ─── fixtures ─────────────────────────────────────────────────────────────────

const COMMITS: DeployModalCommit[] = [
  {
    sha: "#ff26b8b",
    message: 'Revert "ci: add a dispatchable apply for the cloudflare edge stack"',
    when: "9m",
    state: "building",
    htmlUrl: "https://github.com/0x63616c/world-wide-webb/actions/runs/5520252180",
    filesChanged: 1,
    additions: 0,
    deletions: 75,
  },
  {
    sha: "#1147ca3",
    message: "ci: add a dispatchable apply for the cloudflare edge stack",
    when: "14m",
    state: "skipped",
    htmlUrl: "https://github.com/0x63616c/world-wide-webb/actions/runs/6878438754",
    filesChanged: 1,
    additions: 75,
    deletions: 0,
  },
  {
    sha: "#9b2b8c7",
    message: "fix(control-center/web): dim wake tap really is swallowed now",
    when: "15m",
    state: "skipped",
    htmlUrl: "https://github.com/0x63616c/world-wide-webb/actions/runs/9989500815",
    filesChanged: 4,
    additions: 78,
    deletions: 16,
  },
  {
    sha: "#ddbbaa9",
    message: "chore(ci/www-afz): refresh coverage + loc badges [skip ci]",
    when: "22m",
    state: "skipped",
    htmlUrl: "https://github.com/0x63616c/world-wide-webb/actions/runs/5693366908",
    filesChanged: 4,
    additions: 4,
    deletions: 4,
  },
  {
    sha: "#89e8ff3",
    message: "feat(control-center/web): logs viewer age column + auto-loading history",
    when: "30m",
    state: "deployed",
    htmlUrl: "https://github.com/0x63616c/world-wide-webb/actions/runs/5024714280",
    filesChanged: 1,
    additions: 86,
    deletions: 28,
  },
  {
    sha: "#ee83592",
    message: "fix(control-center): apply review findings on session correlation",
    when: "35m",
    state: "skipped",
    htmlUrl: "https://github.com/0x63616c/world-wide-webb/actions/runs/6101098034",
    filesChanged: 8,
    additions: 1618,
    deletions: 7,
  },
  {
    sha: "#a3ffbc3",
    message: "feat(control-center/web): sessions view in the wake photo viewer",
    when: "41m",
    state: "skipped",
    htmlUrl: "https://github.com/0x63616c/world-wide-webb/actions/runs/9952737185",
    filesChanged: 9,
    additions: 623,
    deletions: 7,
  },
  {
    sha: "#08ee564",
    message: "feat(control-center): correlate wake photos with interaction sessions",
    when: "45m",
    state: "deployed",
    htmlUrl: "https://github.com/0x63616c/world-wide-webb/actions/runs/2179109673",
    filesChanged: 22,
    additions: 3071,
    deletions: 75,
  },
];

const BASE = {
  deployedSha: "#89e8ff3",
  deployedWhen: "30m ago",
  run: null,
  failure: null,
  commits: COMMITS,
  staleFor: null,
};

// Realistic pulumi failure tail , shape mirrors an actual `pulumi up` error.
const LOG_TAIL = `error: update failed

  kubernetes:apps/v1:Deployment control-center/api:
    the Deployment "api" is invalid: spec.template.spec.containers[0].image:
    Invalid value: "ghcr.io/0x63616c/wwwapi@sha256:": invalid reference format

  wwwinfra:imageDigests validation: expected 12 entries, got 11 (missing: api)

Resources: 1 failed, 47 unchanged
Duration: 41s`;

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/Deploy/Pipeline",
  component: DeployModalPipeline,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: BASE,
} satisfies Meta<typeof DeployModalPipeline>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── stories ──────────────────────────────────────────────────────────────────

/** The repo's actual state at capture time: revert building, 89e8ff3 live. */
export const Deploying: Story = {
  args: {
    run: {
      jobName: "build-web",
      stepName: "docker buildx",
      elapsed: "9m12s",
      htmlUrl: "https://github.com/0x63616c/world-wide-webb/actions/runs/5520252180",
    },
  },
};

/** Idle and current , the common case. */
export const Idle: Story = {
  args: {
    commits: COMMITS.map((c) => (c.state === "building" ? { ...c, state: "deployed" } : c)),
    deployedSha: "#ff26b8b",
    deployedWhen: "2m ago",
  },
};

/** Deploy failed , log tail promoted above history. */
export const Failed: Story = {
  args: {
    failure: {
      jobName: "deploy",
      stepName: "pulumi up",
      logTail: LOG_TAIL,
      htmlUrl: "https://github.com/0x63616c/world-wide-webb/actions/runs/5520252180",
    },
    commits: COMMITS.map((c) => (c.state === "building" ? { ...c, state: "failed" } : c)),
  },
};

/** Polling has been failing , the stale banner rides the status strip. */
export const Stale: Story = {
  args: {
    staleFor: "42m",
    commits: COMMITS.map((c) => (c.state === "building" ? { ...c, state: "deployed" } : c)),
    deployedSha: "#ff26b8b",
    deployedWhen: "44m ago",
  },
};

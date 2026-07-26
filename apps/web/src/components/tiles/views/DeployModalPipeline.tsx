/**
 * DeployModalPipeline , deploy/pipeline detail page body for the Deploys tile.
 *
 * WHY this layout: the tile face answers "what is live and is anything
 * happening" with two stats and a 6-row feed; this page answers the follow-up
 * questions. A status strip mirrors the tile's deployed/pipeline pair so
 * context carries over. When a run failed, the log tail is promoted directly
 * under the strip , the error text is the single most useful thing on a
 * failure, so it outranks history. Below, the commit history gains what the
 * tile row had no room for: per-commit diffstat and an explicit per-commit
 * deploy state chip (deployed / building / failed / no deploy). Every commit row
 * and the pipeline stat open that run on github.com in the in-app browser , the
 * panel shows the summary, GitHub owns the full log.
 *
 * PURE view: all data arrives via props , no trpc/hooks. Composes trivially in
 * Storybook and component tests. Bare page body (no <Modal>) , hosted by
 * TileDetailHost, which supplies the page shell, header, and scrolling.
 */

import type { DeployCommit, DeployFailure, DeployRun } from "@features/deploys/web";
import { CommitState } from "@features/deploys/web";
import { Pill, PillTone, Stat } from "@/components/ui";
import { openExternalUrl } from "@/lib/external-browser";

// ─── types ────────────────────────────────────────────────────────────────────

/** A tile commit enriched with the detail only the modal shows. */
export interface DeployModalCommit extends DeployCommit {
  filesChanged: number;
  additions: number;
  deletions: number;
  /** GitHub Actions run page for this commit; opened in the in-app browser. */
  htmlUrl: string;
}

export interface DeployModalPipelineProps {
  deployedSha: string;
  deployedWhen: string;
  /** htmlUrl is the run's GitHub page , the tile face has no room to link out. */
  run: (DeployRun & { htmlUrl: string }) | null;
  /** Failure detail; logTail is the stored last-4KB of the failed step's log. */
  failure: (DeployFailure & { logTail: string; htmlUrl: string }) | null;
  commits: DeployModalCommit[];
  staleFor: string | null;
}

// ─── internals ────────────────────────────────────────────────────────────────

const FAIL_RED = "#f4635f";

/** Strips the UA button chrome so a <button> can carry a plain row/stat layout. */
const RESET_BUTTON = {
  background: "none",
  border: "none",
  font: "inherit",
  color: "inherit",
  cursor: "pointer",
} as const;

const STATE_LABEL: Record<CommitState, string> = {
  deployed: "deployed",
  building: "building",
  failed: "failed",
  skipped: "no deploy",
};

function stateChip(state: CommitState) {
  if (state === CommitState.Building) return <Pill tone={PillTone.Amber}>building</Pill>;
  if (state === CommitState.Failed) return <Pill style={{ color: FAIL_RED }}>failed</Pill>;
  if (state === CommitState.Deployed) return <Pill tone={PillTone.On}>deployed</Pill>;
  return <Pill>{STATE_LABEL[state]}</Pill>;
}

/**
 * Makes the pipeline stat tappable when there is a run to open, and a plain
 * wrapper when there is not , an idle pipeline has no GitHub page to go to.
 */
function PipelineStatLink({ url, children }: { url: string | null; children: React.ReactNode }) {
  if (!url) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={() => {
        void openExternalUrl(url);
      }}
      style={{ ...RESET_BUTTON, padding: 0, textAlign: "left" }}
    >
      {children}
    </button>
  );
}

function CommitDetailRow({ commit }: { commit: DeployModalCommit }) {
  return (
    <button
      type="button"
      onClick={() => {
        void openExternalUrl(commit.htmlUrl);
      }}
      style={{
        ...RESET_BUTTON,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 0",
        borderBottom: "1px solid var(--hair)",
        width: "100%",
        textAlign: "left",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            color: commit.state === CommitState.Failed ? FAIL_RED : "var(--ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {commit.message}
        </div>
        <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 3 }}>
          {`${commit.sha} · ${commit.when} ago`}
        </div>
      </div>
      <span className="mono" style={{ fontSize: 12, flex: "0 0 auto", color: "var(--ink-3)" }}>
        {`${commit.filesChanged}f `}
        <span style={{ color: "var(--teal)" }}>{`+${commit.additions}`}</span>{" "}
        <span style={{ color: "var(--ink-2)" }}>{`-${commit.deletions}`}</span>
      </span>
      <span style={{ flex: "0 0 auto" }}>{stateChip(commit.state)}</span>
    </button>
  );
}

// ─── component ────────────────────────────────────────────────────────────────

export function DeployModalPipeline({
  deployedSha,
  deployedWhen,
  run,
  failure,
  commits,
  staleFor,
}: DeployModalPipelineProps) {
  // Only a live or failed run has a page worth opening , when the pipeline is
  // idle the stat reads "idle" and stays inert.
  const pipelineUrl = failure?.htmlUrl ?? run?.htmlUrl ?? null;
  return (
    <div style={{ maxWidth: 920, margin: "0 auto" }}>
      {/* status strip , mirrors the tile face so context carries over */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 40 }}>
        <Stat label="deployed" value={deployedSha} accent sub={`${deployedWhen} · home-server`} />
        <PipelineStatLink url={pipelineUrl}>
          <Stat
            label="pipeline"
            value={
              failure ? (
                <span style={{ color: FAIL_RED }}>fail</span>
              ) : run ? (
                <span style={{ color: "var(--amber)" }}>{run.elapsed}</span>
              ) : (
                "idle"
              )
            }
            muted={!run && !failure}
            sub={
              failure
                ? `${failure.jobName} › ${failure.stepName}`
                : run
                  ? `${run.jobName} › ${run.stepName}`
                  : "no runs active"
            }
          />
        </PipelineStatLink>
        {staleFor && (
          <div style={{ marginLeft: "auto" }}>
            <Pill tone={PillTone.Amber}>{`data stale ${staleFor}`}</Pill>
          </div>
        )}
      </div>

      {/* failure log tail , the most useful thing on a failure, so it outranks history */}
      {failure && (
        <div
          className="mono"
          style={{
            marginTop: 16,
            background: "var(--nest)",
            border: "1px solid var(--hair-2)",
            borderRadius: 12,
            padding: "12px 14px",
            fontSize: 12,
            lineHeight: 1.6,
            color: FAIL_RED,
            whiteSpace: "pre-wrap",
            maxHeight: 220,
            overflow: "hidden",
          }}
        >
          {failure.logTail}
        </div>
      )}

      {/* commit history with the detail the tile has no room for */}
      <div className="cap" style={{ marginTop: 22, marginBottom: 2 }}>
        recent commits · main
      </div>
      <div>
        {commits.map((c) => (
          <CommitDetailRow key={c.sha} commit={c} />
        ))}
      </div>
    </div>
  );
}

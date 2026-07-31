import type { BuildStatusState } from "@/features/build-status/useBuildStatus";

// Presentational only , no query hook here, so Storybook and unit tests can
// exercise every state (loading/error/ready) without a network or a mock.
export function BuildStatus({ state }: { state: BuildStatusState }) {
  switch (state.kind) {
    case "loading":
      return <p data-testid="build-status">Loading build info…</p>;
    case "error":
      return (
        <p data-testid="build-status" role="alert">
          Could not reach the API: {state.message}
        </p>
      );
    case "ready":
      return <p data-testid="build-status">API build {state.version}</p>;
  }
}

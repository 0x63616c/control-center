import { useConsole } from "@/features/console/useConsole";

// The one header bar, on every page: the title links home, and the factory's
// Running/Paused state sits on the right. It reads the same console query the
// console page polls, so react-query serves one shared cache entry.
export function AppHeader() {
  const state = useConsole();
  const snapshot = state.kind === "ready" || state.kind === "refetch-error" ? state.snapshot : null;
  return (
    <header className="console-header">
      <h1>
        <a className="app-title" href="#/">
          The Software Factory
        </a>
      </h1>
      <span className="spacer" />
      {snapshot && (
        <span className={snapshot.factory.paused ? "pill pill-blocked" : "pill pill-done"}>
          {snapshot.factory.paused ? "Paused" : "Running"}
        </span>
      )}
    </header>
  );
}

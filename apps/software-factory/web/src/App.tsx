import { BuildStatus } from "@/features/build-status/BuildStatus";
import { useBuildStatus } from "@/features/build-status/useBuildStatus";

export function App() {
  const buildStatus = useBuildStatus();

  return (
    <main>
      <h1>Software Factory</h1>
      <BuildStatus state={buildStatus} />
    </main>
  );
}

import { useCallback, useMemo, useState } from "react";
import { type PaneState, Sidebar } from "@/components/Sidebar";
import { ToolBar } from "@/components/ToolBar";
import { ToolPane } from "@/components/ToolPane";
import { extensionVersion as readExtensionVersion } from "@/lib/extension";
import { TOOLS } from "@/registry";

const FIRST_TOOL = TOOLS[0];

export function App({
  // Injected in tests and stories; production reads the DOM flag the extension's
  // content script stamps on <html> at document_start.
  extVersion = readExtensionVersion(),
  initialToolId = FIRST_TOOL.id,
}: {
  extVersion?: string | null;
  initialToolId?: string;
} = {}) {
  const [activeId, setActiveId] = useState(initialToolId);
  // Insertion order = the order panes were first opened. A tool leaves this set
  // only on a full page reload: panes are never evicted (ADR-0010 — the whole
  // point is that an open tool stays where you left it).
  const [opened, setOpened] = useState<readonly string[]>([initialToolId]);
  const [loaded, setLoaded] = useState<readonly string[]>([]);
  const [reloadKeys, setReloadKeys] = useState<Readonly<Record<string, number>>>({});

  const hasExtension = extVersion !== null;
  const active = useMemo(
    () => TOOLS.find((tool) => tool.id === activeId) ?? FIRST_TOOL,
    [activeId],
  );

  const select = useCallback((id: string) => {
    setActiveId(id);
    setOpened((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const reload = useCallback(() => {
    setLoaded((prev) => prev.filter((id) => id !== active.id));
    setReloadKeys((prev) => ({ ...prev, [active.id]: (prev[active.id] ?? 0) + 1 }));
  }, [active.id]);

  // Reported per row in the sidebar and readable from the DOM, so the post-deploy
  // smoke test can assert "this pane rendered" instead of squinting at a
  // screenshot.
  const paneStates: Record<string, PaneState> = {};
  for (const tool of TOOLS) {
    paneStates[tool.id] =
      tool.needsExtension && !hasExtension
        ? "blocked"
        : loaded.includes(tool.id)
          ? "loaded"
          : "idle";
  }

  return (
    <div className="app">
      <Sidebar
        activeId={active.id}
        onSelect={select}
        paneStates={paneStates}
        extensionVersion={extVersion}
      />
      <main className="main">
        <ToolBar tool={active} onReload={reload} />
        <div className="stage">
          {opened.map((id) => {
            const tool = TOOLS.find((candidate) => candidate.id === id);
            if (!tool) return null;
            return (
              <ToolPane
                key={tool.id}
                tool={tool}
                active={tool.id === active.id}
                reloadKey={reloadKeys[tool.id] ?? 0}
                hasExtension={hasExtension}
                onLoad={() =>
                  setLoaded((prev) => (prev.includes(tool.id) ? prev : [...prev, tool.id]))
                }
              />
            );
          })}
        </div>
      </main>
    </div>
  );
}

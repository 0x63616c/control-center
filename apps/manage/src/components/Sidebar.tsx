import { LogoMark } from "@/components/LogoMark";
import { TOOL_GROUPS, type Tool, toolsInGroup } from "@/registry";

/**
 * What the status dot next to a row reports. It is about the PANE, not about
 * the remote service: manage does not health-check anything, and a dot that
 * claimed to would be lying the moment a tool went down without telling us.
 *
 * - `idle`   never opened this session
 * - `loaded` the pane's iframe fired `load`
 * - `blocked` the extension is absent and this tool needs it
 */
export type PaneState = "idle" | "loaded" | "blocked";

const DOT_CLASS: Record<PaneState, string> = {
  idle: "idle",
  loaded: "ok",
  blocked: "warn",
};

export function Sidebar({
  activeId,
  onSelect,
  paneStates,
  extensionVersion,
}: {
  activeId: string;
  onSelect: (id: string) => void;
  paneStates: Readonly<Record<string, PaneState>>;
  extensionVersion: string | null;
}) {
  return (
    <aside className="side">
      <div className="brand">
        <div className="mark" aria-hidden="true">
          M
        </div>
        <h1>manage</h1>
      </div>

      <nav className="scroll" aria-label="Tools">
        {TOOL_GROUPS.map((group) => (
          <div className="group" key={group}>
            <h2>{group}</h2>
            {toolsInGroup(group).map((tool) => (
              <SidebarRow
                key={tool.id}
                tool={tool}
                active={tool.id === activeId}
                state={paneStates[tool.id] ?? "idle"}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="foot">
        <div
          className={`dot ${extensionVersion ? "ok" : "warn"}`}
          style={{ margin: 0 }}
          aria-hidden="true"
        />
        <div className="who" data-testid="extension-status">
          {extensionVersion ? "extension active" : "extension missing"}
        </div>
        <a
          className="out"
          href="https://github.com/0x63616c/world-wide-webb/blob/main/apps/manage/extension/README.md"
          target="_blank"
          rel="noreferrer"
        >
          Docs
        </a>
      </div>
    </aside>
  );
}

function SidebarRow({
  tool,
  active,
  state,
  onSelect,
}: {
  tool: Tool;
  active: boolean;
  state: PaneState;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={`item${active ? " on" : ""}`}
      data-tool={tool.id}
      data-pane-state={state}
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(tool.id)}
    >
      <LogoMark color={tool.color} mark={tool.mark} />
      <div className="label">{tool.label}</div>
      <div className={`dot ${DOT_CLASS[state]}`} aria-hidden="true" />
    </button>
  );
}

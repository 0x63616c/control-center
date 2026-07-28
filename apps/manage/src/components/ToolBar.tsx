import type { Tool } from "@/registry";

/** The strip above the stage: which tool, its URL, reload, pop out. */
export function ToolBar({ tool, onReload }: { tool: Tool; onReload: () => void }) {
  return (
    <div className="bar">
      <span className="t">{tool.label}</span>
      <span className="url">{tool.url}</span>
      <span className="sp" />
      {/* A pane can outlive its Cloudflare Access session, and the frame gives
          no signal when it does — reload is the operator's one lever. */}
      <button type="button" className="btn" onClick={onReload}>
        reload
      </button>
      <a className="btn" href={tool.url} target="_blank" rel="noreferrer">
        open ↗
      </a>
    </div>
  );
}

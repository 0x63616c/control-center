import { LogoMark } from "@/components/LogoMark";
import type { Tool } from "@/registry";

/**
 * Shown in place of a pane when the frame-unlock extension is not installed.
 *
 * Deliberately not a generic error state: it names the one thing that fixes it
 * and gives a way to reach the tool meanwhile. An operator who lands here on a
 * fresh machine should not have to go and find out why the pane is blank.
 */
export function LauncherCard({ tool }: { tool: Tool }) {
  return (
    <div className="launcher" data-testid="launcher-card">
      <LogoMark color={tool.color} mark={tool.mark} className="big" />
      <h3>{tool.label} needs the frame-unlock extension</h3>
      <p>
        {tool.label} sends a frame-deny header, so a browser without the local <code>manage</code>{" "}
        extension refuses to render it here. Load <code>apps/manage/extension/</code> as an unpacked
        extension, then reload manage.
      </p>
      <a className="cta" href={tool.url} target="_blank" rel="noreferrer">
        open in new tab ↗
      </a>
    </div>
  );
}

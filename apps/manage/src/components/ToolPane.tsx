import { LauncherCard } from "@/components/LauncherCard";
import type { Tool } from "@/registry";

/**
 * One mounted tool. Rendered once per tool the operator has opened this session
 * and then never unmounted — `hidden` is what makes an inactive pane invisible,
 * so switching away and back preserves scroll position, an open Grafana range,
 * a half-written SQL query.
 *
 * `reloadKey` remounts the iframe (and only the iframe) when the operator hits
 * reload: setting `src` on a live frame would push a history entry into the
 * embedded tool instead of restarting it.
 */
export function ToolPane({
  tool,
  active,
  reloadKey,
  hasExtension,
  onLoad,
}: {
  tool: Tool;
  active: boolean;
  reloadKey: number;
  hasExtension: boolean;
  onLoad: () => void;
}) {
  const blocked = tool.needsExtension && !hasExtension;

  return (
    <div className="pane" hidden={!active} data-pane={tool.id}>
      {blocked ? (
        <LauncherCard tool={tool} />
      ) : (
        <iframe
          key={reloadKey}
          title={tool.label}
          src={tool.url}
          onLoad={onLoad}
          // Delegates WebAuthn into the frame. Without it GitHub's passkey login
          // fails inside a pane even though the origin is still github.com.
          allow="publickey-credentials-get; publickey-credentials-create; clipboard-write"
        />
      )}
    </div>
  );
}

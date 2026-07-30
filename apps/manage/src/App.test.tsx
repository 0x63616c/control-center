import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "@/App";
import { EXTENSION_FLAG, extensionVersion, hasExtension } from "@/lib/extension";
import { TOOLS } from "@/registry";

const framable = TOOLS.find((tool) => !tool.needsExtension);
const needsExt = TOOLS.find((tool) => tool.needsExtension);
if (!framable || !needsExt) throw new Error("registry must have one of each kind for this test");

function paneFrame(id: string): HTMLIFrameElement | null {
  return document.querySelector(`[data-pane="${id}"] iframe`);
}

describe("extension detection", () => {
  beforeEach(() => {
    delete document.documentElement.dataset[EXTENSION_FLAG];
  });

  it("reads the flag the content script stamps on <html>", () => {
    expect(hasExtension()).toBe(false);
    expect(extensionVersion()).toBeNull();
    document.documentElement.dataset[EXTENSION_FLAG] = "1.0.0";
    expect(hasExtension()).toBe(true);
    expect(extensionVersion()).toBe("1.0.0");
  });
});

describe("App", () => {
  it("renders the Manage brand heading", () => {
    render(<App extVersion="1.0.0" />);
    expect(screen.getByRole("heading", { level: 1, name: "Manage" })).toBeInTheDocument();
  });

  it("links to the extension documentation from the footer", () => {
    render(<App extVersion="1.0.0" />);
    const link = screen.getByRole("link", { name: "Docs" });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/0x63616c/world-wide-webb/blob/main/apps/manage/extension/README.md",
    );
  });

  it("renders every tool as a sidebar row", () => {
    render(<App extVersion="1.0.0" />);
    for (const tool of TOOLS) {
      expect(screen.getByRole("button", { name: new RegExp(tool.label) })).toBeInTheDocument();
    }
  });

  it("mounts only the opened tools, and keeps them mounted once opened", async () => {
    const user = userEvent.setup();
    render(<App extVersion="1.0.0" initialToolId={framable.id} />);

    expect(paneFrame(framable.id)).toBeInTheDocument();
    expect(paneFrame(needsExt.id)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: new RegExp(needsExt.label) }));
    expect(paneFrame(needsExt.id)).toBeInTheDocument();

    // Switching back must NOT unmount the pane we just left — that is the whole
    // reason panes are hidden rather than torn down.
    await user.click(screen.getByRole("button", { name: new RegExp(framable.label) }));
    const hidden = document.querySelector(`[data-pane="${needsExt.id}"]`);
    expect(hidden).toBeInTheDocument();
    expect(hidden).toHaveAttribute("hidden");
    expect(paneFrame(needsExt.id)).toBeInTheDocument();
  });

  it("frames a tool that needs the extension when the extension is present", () => {
    render(<App extVersion="1.0.0" initialToolId={needsExt.id} />);
    expect(paneFrame(needsExt.id)).toHaveAttribute("src", needsExt.url);
    expect(screen.queryByTestId("launcher-card")).not.toBeInTheDocument();
  });

  it("shows a launcher card instead of a blank frame when the extension is absent", () => {
    render(<App extVersion={null} initialToolId={needsExt.id} />);
    expect(paneFrame(needsExt.id)).not.toBeInTheDocument();
    expect(screen.getByTestId("launcher-card")).toBeInTheDocument();
    expect(screen.getByText("extension missing")).toBeInTheDocument();
  });

  it("still frames a tool we control when the extension is absent", () => {
    render(<App extVersion={null} initialToolId={framable.id} />);
    expect(paneFrame(framable.id)).toHaveAttribute("src", framable.url);
    expect(screen.queryByTestId("launcher-card")).not.toBeInTheDocument();
  });

  it("delegates WebAuthn into the frame so passkey logins work in a pane", () => {
    render(<App extVersion="1.0.0" initialToolId={framable.id} />);
    expect(paneFrame(framable.id)?.getAttribute("allow")).toContain("publickey-credentials-get");
  });

  it("reports pane state on the row, without pretending to health-check anything", () => {
    render(<App extVersion={null} initialToolId={framable.id} />);
    expect(screen.getByRole("button", { name: new RegExp(needsExt.label) })).toHaveAttribute(
      "data-pane-state",
      "blocked",
    );
    expect(screen.getByRole("button", { name: new RegExp(framable.label) })).toHaveAttribute(
      "data-pane-state",
      "idle",
    );
  });

  it("remounts the frame on reload rather than re-navigating it", async () => {
    const user = userEvent.setup();
    render(<App extVersion="1.0.0" initialToolId={framable.id} />);
    const before = paneFrame(framable.id);
    await user.click(screen.getByRole("button", { name: "reload" }));
    // A new element: setting src on a live frame would push a history entry
    // into the embedded tool instead of restarting it.
    expect(paneFrame(framable.id)).not.toBe(before);
  });
});

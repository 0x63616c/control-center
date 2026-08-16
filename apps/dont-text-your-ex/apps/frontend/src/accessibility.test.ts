import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EvidenceShot, EvidenceViewer, Toggle } from "./bits";
import { AvatarEditor } from "./screens/common";
import { TopBar } from "./ui";

describe("shared accessibility contracts", () => {
  it("renders a named switch with its checked state and a 44px touch target", () => {
    const html = renderToStaticMarkup(
      createElement(Toggle, { label: "Share streak for Friends", on: true, onChange: () => {} }),
    );

    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="Share streak for Friends"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("height:44px");
  });

  it("renders a named 44px back control", () => {
    const html = renderToStaticMarkup(
      createElement(TopBar, { title: "Details", onBack: () => {} }),
    );

    expect(html).toContain('aria-label="Back"');
    expect(html).toContain("width:44px");
    expect(html).toContain("height:44px");
  });

  it("renders the evidence viewer as a labelled modal with a named close control", () => {
    const html = renderToStaticMarkup(
      createElement(EvidenceViewer, {
        images: [{ mimeType: "image/png", dataUrl: "data:image/png;base64,AA==" }],
        index: 0,
        onClose: () => {},
        onIndex: () => {},
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Supporting screenshot viewer"');
    expect(html).toContain('aria-label="Close attachment viewer"');
  });

  it("does not expose an inert attachment thumbnail as an actionable viewer control", () => {
    const html = renderToStaticMarkup(
      createElement(EvidenceShot, {
        image: {
          mimeType: "image/png",
          dataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        },
      }),
    );

    expect(html).toContain('alt="Accountability check attachment"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("View supporting screenshot");
  });

  it("names visual avatar choices and exposes their selected state", () => {
    const html = renderToStaticMarkup(
      createElement(AvatarEditor, {
        draft: { name: "Calum", color: "#FF375F", emoji: null, photo: null },
        setDraft: () => {},
      }),
    );

    expect(html).toContain('aria-label="Use profile color 1"');
    expect(html).toContain('aria-label="Use initials avatar"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("width:44px");
  });
});

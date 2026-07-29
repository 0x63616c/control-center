/**
 * The Change PIN row and the surface it opens (#298).
 *
 * What matters here is the CONTAINER change: the flow is not on screen until
 * you ask for it, a successful change confirms itself and then leaves on its
 * own (rather than landing on a "PIN changed / Change again" dead end you have
 * to dismiss), and a mismatch keeps you in the flow instead of committing
 * anything. The stage machine's own rules , verify
 * against the live PIN, mismatch restarts the new/confirm pair, write only on a
 * matching confirm , moved across unchanged, so they are pinned too.
 *
 * The surface portals into document.body, so every query past the row uses
 * `screen` rather than the render result's container.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { resetSettings, setPinCode } from "../../lib/settings";
import { SecurityPage } from "../settings-page/pages/SecurityPage";

afterEach(() => {
  cleanup();
  act(() => resetSettings());
});

/** Tap digits on the pad. The pad's layout moves per stage, so keys are found
 *  by their accessible name, never by position. */
async function tap(user: ReturnType<typeof userEvent.setup>, digits: string) {
  for (const d of digits) {
    await user.click(screen.getByRole("button", { name: d }));
  }
}

function openFlow() {
  const user = userEvent.setup();
  render(<SecurityPage />);
  return user;
}

describe("SecurityPage change-PIN row", () => {
  it("shows a row and no flow until it is tapped", async () => {
    const user = openFlow();
    expect(screen.getByText("Change PIN")).toBeTruthy();
    expect(screen.queryByText("Enter current PIN")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Change PIN" }));
    expect(screen.getByText("Enter current PIN")).toBeTruthy();
  });

  it("confirms on the surface, then dismisses itself and echoes on the row", async () => {
    const user = openFlow();
    await user.click(screen.getByRole("button", { name: "Change PIN" }));

    await tap(user, "000000"); // current PIN (default)
    expect(screen.getByText("Enter new PIN")).toBeTruthy();
    await tap(user, "123456"); // new
    expect(screen.getByText("Confirm new PIN")).toBeTruthy();
    await tap(user, "123456"); // confirm , matches

    // The confirmation lands where the person is already looking, instead of
    // appearing in the row after the surface they were watching vanished.
    expect(screen.getByText("PIN changed")).toBeTruthy();
    expect(screen.getByText("Synced to all panels.")).toBeTruthy();
    // Still not a dead end: nothing to dismiss, and no way back into the flow.
    expect(screen.queryByRole("button", { name: "Change again" })).toBeNull();

    // It leaves on its own.
    await waitFor(() => expect(screen.queryByText("PIN changed")).toBeNull(), { timeout: 3000 });
    expect(screen.queryByText("Confirm new PIN")).toBeNull();
    // The row keeps a quieter echo for anyone who looked away as it went.
    expect(screen.getByText("Changed")).toBeTruthy();
  });

  it("restarts the new/confirm pair on a mismatch without saving", async () => {
    const user = openFlow();
    await user.click(screen.getByRole("button", { name: "Change PIN" }));

    await tap(user, "000000");
    await tap(user, "123456");
    await tap(user, "654321"); // confirm , does NOT match

    // Back at stage two (not stage one: you already proved the current PIN),
    // still on the surface, with nothing committed.
    expect(screen.getByText("Enter new PIN")).toBeTruthy();
    expect(screen.getByText("PINs didn't match, start over")).toBeTruthy();
    expect(screen.queryByText("Changed")).toBeNull();

    // Nothing was saved: the ORIGINAL PIN still gets past stage one on a reopen.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Change PIN" }));
    await tap(user, "000000");
    expect(screen.getByText("Enter new PIN")).toBeTruthy();
  });

  it("rejects a wrong current PIN and stays on stage one", async () => {
    setPinCode("135790");
    const user = openFlow();
    await user.click(screen.getByRole("button", { name: "Change PIN" }));

    await tap(user, "111111");
    expect(screen.getByText("Wrong PIN, try again")).toBeTruthy();
    expect(screen.getByText("Enter current PIN")).toBeTruthy();

    await tap(user, "135790");
    expect(screen.getByText("Enter new PIN")).toBeTruthy();
  });

  it("reopens at stage one after being cancelled mid-flow", async () => {
    const user = openFlow();
    await user.click(screen.getByRole("button", { name: "Change PIN" }));
    await tap(user, "000000");
    expect(screen.getByText("Enter new PIN")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Enter new PIN")).toBeNull();

    // A half-finished change must not resume where it left off , the current
    // PIN has to be proved again.
    await user.click(screen.getByRole("button", { name: "Change PIN" }));
    expect(screen.getByText("Enter current PIN")).toBeTruthy();
  });
});

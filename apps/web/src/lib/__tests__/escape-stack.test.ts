/**
 * One Escape closes one surface , the topmost.
 *
 * The bug this module exists for (#298) was not in any single overlay: each
 * attached a correct `window` keydown listener, and window listeners do not
 * nest, so a PIN dialog over Settings closed both on one press. These tests
 * pin the arbitration itself, because no component test can see a defect that
 * only exists between two components.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { pushEscapeHandler } from "../escape-stack";

const disposers: Array<() => void> = [];

function open(onEscape: () => void) {
  const dispose = pushEscapeHandler(onEscape);
  disposers.push(dispose);
  return dispose;
}

function pressEscape() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe("escape stack", () => {
  it("closes only the surface opened last", () => {
    const settings = vi.fn();
    const dialog = vi.fn();
    open(settings);
    open(dialog);

    pressEscape();

    expect(dialog).toHaveBeenCalledTimes(1);
    expect(settings).not.toHaveBeenCalled();
  });

  it("hands Escape back to the surface underneath once the top one closes", () => {
    const settings = vi.fn();
    const dialog = vi.fn();
    open(settings);
    const closeDialog = open(dialog);

    closeDialog();
    pressEscape();

    expect(settings).toHaveBeenCalledTimes(1);
    expect(dialog).not.toHaveBeenCalled();
  });

  it("ignores keys that are not Escape", () => {
    const dialog = vi.fn();
    open(dialog);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1" }));

    expect(dialog).not.toHaveBeenCalled();
  });

  it("does nothing once every surface has closed", () => {
    const dialog = vi.fn();
    open(dialog)();

    pressEscape();

    expect(dialog).not.toHaveBeenCalled();
  });

  it("evicts only its own registration when a disposer runs twice", () => {
    // A double cleanup is ordinary in React (StrictMode, a fast unmount/remount
    // pair). If the second run popped whatever was on top instead, it would
    // silently disarm a surface that is still open.
    const settings = vi.fn();
    const dialog = vi.fn();
    open(settings);
    const closeDialog = open(dialog);

    closeDialog();
    closeDialog();
    pressEscape();

    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("keeps the surfaces apart when the same handler opens twice", () => {
    // Two surfaces can share one close handler (a shell rendered twice). The
    // stack must still hold two entries, so the first Escape closes one.
    const shared = vi.fn();
    const closeFirst = open(shared);
    open(shared);

    closeFirst();
    pressEscape();

    expect(shared).toHaveBeenCalledTimes(1);
  });
});

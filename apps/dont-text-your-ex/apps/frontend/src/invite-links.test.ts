import { describe, expect, it, vi } from "vitest";
import {
  canonicalInviteUrl,
  installNativeInviteLinkListeners,
  inviteCodeFromPath,
  inviteCodeFromUniversalLink,
} from "./invite-links";

describe("invite links", () => {
  it("builds the canonical production link", () => {
    expect(canonicalInviteUrl("xex24k")).toBe(
      "https://dont-text-your-ex.worldwidewebb.co/j/XEX24K",
    );
  });

  it("parses a valid invite from a web route", () => {
    expect(inviteCodeFromPath("/j/xex24k")).toBe("XEX24K");
    expect(inviteCodeFromPath("/j/XEX24K/")).toBe("XEX24K");
  });

  it("rejects malformed web invite routes", () => {
    expect(inviteCodeFromPath("/j/short")).toBeNull();
    expect(inviteCodeFromPath("/j/XEX24K/more")).toBeNull();
    expect(inviteCodeFromPath("/not-an-invite/XEX24K")).toBeNull();
    expect(inviteCodeFromPath("/j/%GGGGG")).toBeNull();
  });

  it("accepts only the production universal-link origin", () => {
    expect(inviteCodeFromUniversalLink("https://dont-text-your-ex.worldwidewebb.co/j/xex24k")).toBe(
      "XEX24K",
    );
    expect(inviteCodeFromUniversalLink("https://evil.example/j/XEX24K")).toBeNull();
    expect(
      inviteCodeFromUniversalLink("http://dont-text-your-ex.worldwidewebb.co/j/XEX24K"),
    ).toBeNull();
    expect(inviteCodeFromUniversalLink("not a url")).toBeNull();
  });

  it("removes a delayed native listener after disposal and ignores late launch URLs", async () => {
    let resolveListener: ((handle: { remove: () => Promise<void> }) => void) | undefined;
    let resolveLaunch: ((launch: { url: string }) => void) | undefined;
    const remove = vi.fn(async () => undefined);
    const onInvite = vi.fn();
    const nativeApp = {
      getLaunchUrl: () =>
        new Promise<{ url: string }>((resolve) => {
          resolveLaunch = resolve;
        }),
      addListener: () =>
        new Promise<{ remove: () => Promise<void> }>((resolve) => {
          resolveListener = resolve;
        }),
    };

    const dispose = installNativeInviteLinkListeners(nativeApp, onInvite);
    dispose();
    resolveLaunch?.({ url: "https://dont-text-your-ex.worldwidewebb.co/j/XEX24K" });
    resolveListener?.({ remove });
    await Promise.resolve();
    await Promise.resolve();

    expect(onInvite).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
  });
});

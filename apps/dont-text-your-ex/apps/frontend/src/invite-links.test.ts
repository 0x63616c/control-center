import { describe, expect, it } from "vitest";
import {
  canonicalInviteUrl,
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
});

import { describe, expect, test } from "vitest";
import { evaluateTextContent, MAX_CONTENT_SAFETY_INPUT_CODE_UNITS } from "../content-safety.ts";

describe("evaluateTextContent", () => {
  test("allows supportive relationship and wellbeing language", () => {
    expect(
      evaluateTextContent(
        "I'm glad you're here. Please talk to a therapist or someone you trust if you feel unsafe.",
      ),
    ).toEqual({ allowed: true });
  });

  test.each([
    "nigger",
    "faggot",
    "kike",
    "chink",
    "spic",
    "tranny",
    "cunt",
    "retard",
  ])("rejects the severe slur %s without returning the submitted text", (text) => {
    expect(evaluateTextContent(`You are a ${text}`)).toEqual({
      allowed: false,
      reason: "severe_slur",
    });
  });

  test.each([
    "ＮＩＧＧＥＲ",
    "n\u200Bi\u0307g\u200Dg3r",
    "f.a.g.g.0.t",
    "c\u00A0u\u2002n\u202Ft",
    "tr@nnу",
  ])("rejects Unicode, separator, format-character, and leet evasion: %s", (text) => {
    expect(evaluateTextContent(text)).toEqual({ allowed: false, reason: "severe_slur" });
  });

  test.each([
    "I will rape you",
    "I'm going to sexually assault you",
    "You deserve to be raped",
    "i wіll r@pe y0u",
    "i\u200Bwill\u200Brape\u200Byou",
    "I will force myself on you",
  ])("rejects an explicit sexual threat without echoing it: %s", (text) => {
    expect(evaluateTextContent(text)).toEqual({ allowed: false, reason: "sexual_threat" });
  });

  test.each([
    "Kill yourself",
    "kill\u200Byourself",
    "K\u200BY\u200DS",
    "g0 dіe",
    "You should commit suicide",
    "You should cut yourself",
  ])("rejects targeted self-harm abuse without echoing it: %s", (text) => {
    expect(evaluateTextContent(text)).toEqual({
      allowed: false,
      reason: "targeted_self_harm",
    });
  });

  test("rejects oversized input before content analysis", () => {
    expect(evaluateTextContent("x".repeat(MAX_CONTENT_SAFETY_INPUT_CODE_UNITS + 1))).toEqual({
      allowed: false,
      reason: "input_too_large",
    });
  });

  test.each([
    "",
    " \t\n ",
    "\u0000\u0007\u200B\u2060",
  ])("rejects empty or control-only input with a machine reason", (text) => {
    expect(evaluateTextContent(text)).toEqual({
      allowed: false,
      reason: "invalid_content",
    });
  });

  test.each([
    "Scunthorpe is a place name.",
    "That classic relationship book helped me.",
    "A therapist can help after a breakup.",
    "We discussed grape varieties and sexual assault survivor support.",
    "Please don't kill yourself; call someone you trust right now.",
    "Sometimes I feel like I want to die, and I need help.",
  ])("allows the false-positive and supportive corpus: %s", (text) => {
    expect(evaluateTextContent(text)).toEqual({ allowed: true });
  });
});

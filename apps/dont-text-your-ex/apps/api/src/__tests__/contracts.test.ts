import { describe, expect, it } from "vitest";
import {
  CreateJarRequestSchema,
  CreateReportRequestSchema,
  EvidenceThreadSchema,
  JarIdSchema,
  JoinJarRequestSchema,
  LogSlipRequestSchema,
  ReportIdSchema,
  ResolveReportRequestSchema,
  ShareStreakRequestSchema,
  UpdateMeRequestSchema,
  UserIdSchema,
} from "../../../../contracts";
import { parseEvidenceThreadJson, serializeEvidenceThreadJson } from "../persistence";

describe("request schemas", () => {
  it.each([
    ["profile patch", UpdateMeRequestSchema, { exes: "not-an-array" }],
    ["jar creation", CreateJarRequestSchema, { name: "", defaultCents: -1 }],
    ["jar join", JoinJarRequestSchema, { code: 42 }],
    ["streak sharing", ShareStreakRequestSchema, { value: "yes" }],
    ["slip logging", LogSlipRequestSchema, { amountCents: Number.NaN }],
    ["report creation", CreateReportRequestSchema, { accusedId: "jar_wrong" }],
    ["report resolution", ResolveReportRequestSchema, { action: "delete" }],
  ])("rejects invalid %s JSON", (_name, schema, raw) => {
    expect(schema.safeParse(raw).success).toBe(false);
  });
});

describe("domain id parsers", () => {
  it("does not allow user, jar, and report ids to cross domains", () => {
    expect(UserIdSchema.safeParse("usr_123").success).toBe(true);
    expect(JarIdSchema.safeParse("usr_123").success).toBe(false);
    expect(ReportIdSchema.safeParse("jar_123").success).toBe(false);
  });
});

describe("persisted report evidence", () => {
  it("rejects malformed thread JSON after deserialization", () => {
    expect(
      EvidenceThreadSchema.safeParse({
        to: "Alex",
        time: "2:14 AM",
        bubbles: [{ me: "yes", text: "u up?" }],
      }).success,
    ).toBe(false);
  });

  it("parses valid persisted JSON and rejects corrupt persisted JSON", () => {
    const thread = {
      to: "Alex",
      time: "2:14 AM",
      bubbles: [{ me: true, text: "u up?" }],
    };

    expect(parseEvidenceThreadJson(serializeEvidenceThreadJson(thread))).toEqual(thread);
    expect(() => parseEvidenceThreadJson('{"to":"Alex","bubbles":[]}')).toThrow(
      "invalid persisted report evidence",
    );
  });
});

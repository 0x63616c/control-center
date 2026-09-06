import { describe, expect, it } from "vitest";
import { AbuseReportIdSchema, UserIdSchema } from "../../../../contracts";
import { createModerationNarrativeCipher, parseModerationNarrativeKeyring } from "../moderation";
import {
  executeModerationAdminCommand,
  type ModerationAdminStore,
  PostgresModerationAdminStore,
} from "../moderation-admin";

function fakeStore(): ModerationAdminStore {
  return {
    listQueue: async () => [],
    show: async () => {
      throw new Error("unexpected show");
    },
    transition: async () => {
      throw new Error("unexpected transition");
    },
  };
}

describe("moderation operator narrative access", () => {
  it("opens a versioned AES-GCM narrative only with the report ID AAD", () => {
    const cipher = createModerationNarrativeCipher(
      parseModerationNarrativeKeyring({
        activeKeyId: "test-v2",
        keys: { "test-v2": Buffer.alloc(32, 73).toString("base64") },
      }),
    );
    const sealed = cipher.seal("private operator evidence", "abr_report_a");

    expect(cipher.open(sealed, "abr_report_a")).toBe("private operator evidence");
    expect(() => cipher.open(sealed, "abr_report_b")).toThrow();
  });

  it("requires an explicit production acknowledgement before every command", async () => {
    await expect(
      executeModerationAdminCommand({
        argv: ["list"],
        productionRuntime: true,
        store: fakeStore(),
      }),
    ).rejects.toMatchObject({ code: "production_acknowledgement_required" });
  });

  it("refuses to run outside the production pod runtime", async () => {
    await expect(
      executeModerationAdminCommand({
        argv: ["--acknowledge-production", "list"],
        productionRuntime: false,
        store: fakeStore(),
      }),
    ).rejects.toMatchObject({ code: "private_production_runtime_required" });
  });

  it("returns a machine-readable queue without narratives", async () => {
    const store = fakeStore();
    const reportId = AbuseReportIdSchema.parse(`abr_${"b".repeat(32)}`);
    store.listQueue = async () => [
      {
        reportId,
        targetUserId: UserIdSchema.parse("usr_target"),
        status: "submitted",
        hasNarrative: true,
        referencedJarId: null,
        referencedGameplayReportId: null,
        createdAt: 10,
        updatedAt: 10,
      },
    ];

    const output = await executeModerationAdminCommand({
      argv: ["list", "--acknowledge-production"],
      productionRuntime: true,
      store,
    });

    expect(output).toEqual({ ok: true, command: "list", reports: await store.listQueue() });
    expect(JSON.stringify(output)).not.toContain("private operator evidence");
    expect(JSON.stringify(output)).not.toContain('narrative"');
  });

  it("decrypts one report only for an explicit show command", async () => {
    const store = fakeStore();
    const reportId = AbuseReportIdSchema.parse(`abr_${"c".repeat(32)}`);
    store.show = async (requestedId) => ({
      reportId: requestedId,
      reporterUserId: UserIdSchema.parse("usr_reporter"),
      targetUserId: UserIdSchema.parse("usr_target"),
      status: "reviewing",
      narrative: "explicitly requested narrative",
      referencedJarId: null,
      referencedGameplayReportId: null,
      createdAt: 1,
      updatedAt: 2,
      auditEvents: [],
    });

    await expect(
      executeModerationAdminCommand({
        argv: ["show", reportId, "--acknowledge-production"],
        productionRuntime: true,
        store,
      }),
    ).resolves.toEqual({
      ok: true,
      command: "show",
      report: await store.show(reportId),
    });
  });

  it("returns a machine-readable idempotent transition receipt", async () => {
    const store = fakeStore();
    const reportId = AbuseReportIdSchema.parse(`abr_${"d".repeat(32)}`);
    store.transition = async (requestedId, status) => ({
      reportId: requestedId,
      status,
      changed: false,
    });

    await expect(
      executeModerationAdminCommand({
        argv: ["transition", reportId, "resolved", "--acknowledge-production"],
        productionRuntime: true,
        store,
      }),
    ).resolves.toEqual({
      ok: true,
      command: "transition",
      reportId,
      status: "resolved",
      changed: false,
    });
  });

  it.each([
    ["show", ["show", "abr_not_valid", "--acknowledge-production"]],
    [
      "transition",
      ["transition", `abr_${"A".repeat(32)}`, "reviewing", "--acknowledge-production"],
    ],
  ])("rejects an invalid report ID for %s through the shared schema", async (_command, argv) => {
    await expect(
      executeModerationAdminCommand({
        argv,
        productionRuntime: true,
        store: fakeStore(),
      }),
    ).rejects.toMatchObject({ code: "invalid_report_id" });
  });

  it("rejects malformed PostgreSQL rows at the adapter boundary", async () => {
    const database = {
      connect: async () => ({
        query: async () => ({
          rows: [
            {
              id: "not-an-abuse-report-id",
              target_user_id: null,
              status: "submitted",
              has_narrative: false,
              referenced_jar_id: null,
              referenced_gameplay_report_id: null,
              created_at: 1,
              updated_at: 1,
            },
          ],
        }),
        release: () => undefined,
      }),
    };
    const cipher = createModerationNarrativeCipher(
      parseModerationNarrativeKeyring({
        activeKeyId: "test-v1",
        keys: { "test-v1": Buffer.alloc(32, 13).toString("base64") },
      }),
    );

    await expect(new PostgresModerationAdminStore(database, cipher).listQueue()).rejects.toThrow(
      "invalid AbuseReportId",
    );
  });
});

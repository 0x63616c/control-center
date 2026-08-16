import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  condition: vi.fn(async () => false),
  load: vi.fn(async () => ({ kind: "superseded" as const })),
  request: vi.fn(async () => ({ kind: "reminded" as const })),
  handlers: new Map<string, (input: never) => void>(),
}));

vi.mock("@temporalio/workflow", () => ({
  condition: mocks.condition,
  defineQuery: (name: string) => name,
  defineSignal: (name: string) => name,
  proxyActivities: () => ({
    loadInviteLifecycle: mocks.load,
    requestInviteReminder: mocks.request,
  }),
  setHandler: vi.fn((name: string, handler: (input: never) => void) => {
    mocks.handlers.set(name, handler);
  }),
}));

import {
  InviteLifecycleWorkflow,
  inviteJarClosedSignal,
  inviteReminderDelay,
  inviteStateQuery,
  inviteSupersededSignal,
} from "./invite-workflow";

const input = {
  schemaVersion: 1 as const,
  inviteVersionId: "inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as never,
};

beforeEach(() => {
  mocks.condition.mockReset().mockResolvedValue(false);
  mocks.load.mockReset().mockResolvedValue({ kind: "superseded" });
  mocks.request.mockReset().mockResolvedValue({ kind: "reminded" });
  mocks.handlers.clear();
});

describe("InviteLifecycleWorkflow", () => {
  it("locks the compatibility registry signal and query names", () => {
    expect(inviteSupersededSignal).toBe("superseded");
    expect(inviteJarClosedSignal).toBe("jarClosed");
    expect(inviteStateQuery).toBe("inviteState");
  });

  it("waits until 24 hours before expiry and requests one authoritative reminder", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    mocks.load.mockResolvedValue({
      kind: "eligible",
      expiresAt: 3 * 24 * 60 * 60 * 1000 + 1_000,
    } as never);

    await expect(InviteLifecycleWorkflow(input)).resolves.toBe("reminded");
    expect(mocks.condition).toHaveBeenCalledWith(expect.any(Function), 2 * 24 * 60 * 60 * 1000);
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledWith({ inviteVersionId: input.inviteVersionId });
  });

  it("requests immediately when zero to 24 hours remain", async () => {
    expect(inviteReminderDelay(1_000, 1_001)).toBe(0);
    mocks.load.mockResolvedValue({ kind: "eligible", expiresAt: 1_001 } as never);

    await expect(InviteLifecycleWorkflow(input)).resolves.toBe("reminded");
    expect(mocks.condition).toHaveBeenCalledWith(expect.any(Function), 0);
  });

  it("wakes early only for a matching, monotonic version signal", async () => {
    const predicateResults: boolean[] = [];
    mocks.load.mockResolvedValue({
      kind: "eligible",
      expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
    } as never);
    mocks.condition.mockImplementation((async (predicate: () => boolean) => {
      const signal = mocks.handlers.get("superseded");
      signal?.({
        schemaVersion: 1,
        inviteVersionId: "inv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        expectedAggregateVersion: 2,
      } as never);
      predicateResults.push(predicate());
      signal?.({ ...input, expectedAggregateVersion: 2 } as never);
      predicateResults.push(predicate());
      return true;
    }) as never);
    mocks.request.mockResolvedValue({ kind: "superseded" } as never);

    await expect(InviteLifecycleWorkflow(input)).resolves.toBe("superseded");
    expect(predicateResults).toEqual([false, true]);
  });

  it.each([
    "superseded",
    "closed",
    "expired",
  ] as const)("exits as %s without requesting a reminder", async (kind) => {
    mocks.load.mockResolvedValue({ kind } as never);

    await expect(InviteLifecycleWorkflow(input)).resolves.toBe(kind);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("rejects unknown schemas and malformed version ids", async () => {
    await expect(InviteLifecycleWorkflow({ ...input, schemaVersion: 2 } as never)).rejects.toThrow(
      "unsupported invite lifecycle workflow schema",
    );
    await expect(
      InviteLifecycleWorkflow({ ...input, inviteVersionId: "invite-code-secret" } as never),
    ).rejects.toThrow();
    expect(mocks.load).not.toHaveBeenCalled();
  });
});

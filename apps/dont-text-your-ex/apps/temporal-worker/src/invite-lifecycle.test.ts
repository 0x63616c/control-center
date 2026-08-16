import { describe, expect, it, vi } from "vitest";
import { InviteVersionIdSchema } from "../../api/src/domain-events";
import {
  createInviteLifecycleActivities,
  type InviteLifecycleStore,
  PostgresInviteLifecycleStore,
} from "./invite-lifecycle";

const inviteVersionId = InviteVersionIdSchema.parse("inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

describe("invite lifecycle activities", () => {
  it("classifies the current open version without loading an invite code", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: "jar_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          created_by: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          invite_expires_at: "2000",
          closed_at: null,
        },
      ],
    }));
    const store = new PostgresInviteLifecycleStore(
      { query } as never,
      { run: vi.fn() } as never,
      () => 1000,
    );

    await expect(store.load(inviteVersionId)).resolves.toEqual({
      kind: "eligible",
      expiresAt: 2000,
    });
    expect(query).toHaveBeenCalledWith(expect.not.stringContaining("invite_code"), [
      inviteVersionId,
    ]);
  });

  it("passes only the opaque version id through the activity boundary", async () => {
    const load = vi.fn(async () => ({ kind: "eligible" as const, expiresAt: 123 }));
    const requestReminder = vi.fn(async () => ({ kind: "reminded" as const }));
    const activities = createInviteLifecycleActivities({ load, requestReminder });

    await expect(activities.loadInviteLifecycle({ inviteVersionId })).resolves.toEqual({
      kind: "eligible",
      expiresAt: 123,
    });
    await expect(activities.requestInviteReminder({ inviteVersionId })).resolves.toEqual({
      kind: "reminded",
    });
    expect(load).toHaveBeenCalledWith(inviteVersionId);
    expect(requestReminder).toHaveBeenCalledWith(inviteVersionId);
  });

  it.each([
    "superseded",
    "closed",
    "expired",
  ] as const)("preserves the authoritative %s terminal state", async (kind) => {
    const store: InviteLifecycleStore = {
      load: vi.fn(async () => ({ kind })),
      requestReminder: vi.fn(async () => ({ kind })),
    };
    const activities = createInviteLifecycleActivities(store);

    await expect(activities.requestInviteReminder({ inviteVersionId })).resolves.toEqual({ kind });
  });
});

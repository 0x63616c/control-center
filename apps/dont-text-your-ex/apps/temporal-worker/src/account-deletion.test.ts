import { describe, expect, it, vi } from "vitest";
import { AccountDeletionIdSchema } from "../../../contracts";
import { createAccountDeletionActivities } from "./account-deletion";

const deletionRequestId = AccountDeletionIdSchema.parse("del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

describe("account deletion activities", () => {
  it("erases locally before exchanging and revoking a fresh Apple credential", async () => {
    const store = {
      eraseLocally: vi.fn(async () => undefined),
      loadRefreshToken: vi.fn(async () => null),
      loadAuthorizationCode: vi.fn(async () => "fresh-code"),
      saveRefreshToken: vi.fn(async () => undefined),
      markTerminal: vi.fn(async () => undefined),
    };
    const apple = {
      exchangeAuthorizationCode: vi.fn(async () => ({ refreshToken: "refresh-token" })),
      revokeRefreshToken: vi.fn(async () => undefined),
    };
    const activities = createAccountDeletionActivities({ store, apple });

    await expect(activities.eraseAccountLocally({ deletionRequestId })).resolves.toEqual({
      erased: true,
    });
    await expect(activities.revokeAppleCredential({ deletionRequestId })).resolves.toEqual({
      outcome: "revoked",
    });
    expect(store.saveRefreshToken).toHaveBeenCalledWith(deletionRequestId, "refresh-token");
    expect(apple.revokeRefreshToken).toHaveBeenCalledWith("refresh-token");
  });

  it("reuses the durable refresh token after a failed revocation attempt", async () => {
    const store = {
      eraseLocally: vi.fn(),
      loadRefreshToken: vi.fn(async () => "saved-refresh"),
      loadAuthorizationCode: vi.fn(),
      saveRefreshToken: vi.fn(),
      markTerminal: vi.fn(async () => undefined),
    };
    const apple = {
      exchangeAuthorizationCode: vi.fn(),
      revokeRefreshToken: vi.fn(async () => undefined),
    };
    const activities = createAccountDeletionActivities({ store, apple });

    await expect(activities.revokeAppleCredential({ deletionRequestId })).resolves.toEqual({
      outcome: "revoked",
    });
    expect(store.loadAuthorizationCode).not.toHaveBeenCalled();
    expect(apple.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(apple.revokeRefreshToken).toHaveBeenCalledWith("saved-refresh");
  });

  it("requires manual Apple action when no revocation credential exists and destroys secrets at terminal state", async () => {
    const store = {
      eraseLocally: vi.fn(),
      loadRefreshToken: vi.fn(async () => null),
      loadAuthorizationCode: vi.fn(async () => null),
      saveRefreshToken: vi.fn(),
      markTerminal: vi.fn(async () => undefined),
    };
    const activities = createAccountDeletionActivities({
      store,
      apple: { exchangeAuthorizationCode: vi.fn(), revokeRefreshToken: vi.fn() },
    });

    await expect(activities.revokeAppleCredential({ deletionRequestId })).resolves.toEqual({
      outcome: "manual_action_required",
    });
    await expect(
      activities.finishAccountDeletion({ deletionRequestId, state: "manual_action_required" }),
    ).resolves.toEqual({ state: "manual_action_required" });
    expect(store.markTerminal).toHaveBeenCalledWith(deletionRequestId, "manual_action_required");
  });
});

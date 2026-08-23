import type { AccountDeletionId } from "../../../contracts";
import type { PostgresAccountDeletionStore } from "../../api/src/account-deletion";

export interface AppleRevocationGateway {
  exchangeAuthorizationCode(authorizationCode: string): Promise<{ refreshToken: string }>;
  revokeRefreshToken(refreshToken: string): Promise<void>;
}

export type AccountDeletionActivityStore = Pick<
  PostgresAccountDeletionStore,
  | "eraseLocally"
  | "loadAuthorizationCode"
  | "loadRefreshToken"
  | "saveRefreshToken"
  | "markTerminal"
>;

export type AccountDeletionActivities = ReturnType<typeof createAccountDeletionActivities>;

export function createAccountDeletionActivities(dependencies: {
  readonly store: AccountDeletionActivityStore;
  readonly apple: AppleRevocationGateway;
}) {
  return {
    async eraseAccountLocally(input: { readonly deletionRequestId: AccountDeletionId }) {
      await dependencies.store.eraseLocally(input.deletionRequestId);
      return { erased: true as const };
    },

    async revokeAppleCredential(input: { readonly deletionRequestId: AccountDeletionId }) {
      let refreshToken = await dependencies.store.loadRefreshToken(input.deletionRequestId);
      if (!refreshToken) {
        const authorizationCode = await dependencies.store.loadAuthorizationCode(
          input.deletionRequestId,
        );
        if (!authorizationCode) return { outcome: "manual_action_required" as const };
        const exchanged = await dependencies.apple.exchangeAuthorizationCode(authorizationCode);
        refreshToken = exchanged.refreshToken;
        await dependencies.store.saveRefreshToken(input.deletionRequestId, refreshToken);
      }
      await dependencies.apple.revokeRefreshToken(refreshToken);
      return { outcome: "revoked" as const };
    },

    async finishAccountDeletion(input: {
      readonly deletionRequestId: AccountDeletionId;
      readonly state: "complete" | "manual_action_required";
    }) {
      await dependencies.store.markTerminal(input.deletionRequestId, input.state);
      return { state: input.state };
    },
  };
}

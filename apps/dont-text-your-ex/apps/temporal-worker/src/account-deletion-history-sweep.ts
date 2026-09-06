import { proxyActivities } from "@temporalio/workflow";
import type { AccountDeletionActivities } from "./account-deletion";

const SETTLE_DELAY_MS = 5 * 60 * 1000;

export interface AccountDeletionHistorySweepInput {
  readonly schemaVersion: 1;
}

const { sweepAccountDeletionHistories, purgeExpiredAccountDeletionRecords } = proxyActivities<
  Pick<
    AccountDeletionActivities,
    "sweepAccountDeletionHistories" | "purgeExpiredAccountDeletionRecords"
  >
>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 20,
  },
});

export async function AccountDeletionHistorySweepWorkflow(
  input: AccountDeletionHistorySweepInput,
): Promise<{ deleted: number; purged: number }> {
  if (input.schemaVersion !== 1) throw new Error("unsupported account deletion sweep schema");
  const histories = await sweepAccountDeletionHistories({
    terminalBefore: Date.now() - SETTLE_DELAY_MS,
    limit: 100,
  });
  const records = await purgeExpiredAccountDeletionRecords({
    expiredBefore: Date.now(),
    limit: 100,
  });
  return { deleted: histories.deleted, purged: records.deleted };
}

import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import {
  type NotificationDeliveryWorkflowInput,
  NotificationDeliveryWorkflowInputSchema,
  type NotificationId,
  type ReportAccountabilitySignal,
  ReportAccountabilitySignalSchema,
  type ReportAccountabilityWorkflowInput,
  ReportAccountabilityWorkflowInputSchema,
  type RescueIntervention,
  type RescueInterventionWorkflowInput,
  RescueInterventionWorkflowInputSchema,
  type RescueSignalInput,
  RescueSignalInputSchema,
} from "../../../contracts";
import type { DomainEvent } from "../../api/src/domain-events";
import type { DtyeActivities } from "./activities";
import { HEALTH_CHECK_PERIOD_MS, healthCheckSleepMs } from "./pacing";
import type {
  ReportAccountabilityActivities,
  ReportAccountabilityProgress,
  ReportAccountabilityTerminalState,
} from "./report-accountability";
import { nextPagingDecision } from "./workflow-paging";

export { AccountDeletionHistorySweepWorkflow } from "./account-deletion-history-sweep";
export { AccountDeletionWorkflow } from "./account-deletion-workflow";
export { InviteLifecycleWorkflow } from "./invite-workflow";

export interface DtyeHealthCheckWorkflowInput {
  readonly schemaVersion: 1;
}
export interface DtyeHealthCheckWorkflowOutput {
  readonly status: "healthy";
  readonly checks: number;
}

const { DtyeHealthCheckActivity } = proxyActivities<
  Pick<DtyeActivities, "DtyeHealthCheckActivity">
>({
  startToCloseTimeout: "5 seconds",
  retry: { maximumAttempts: 2 },
});

const notificationActivities = proxyActivities<
  Pick<DtyeActivities, "prepareNotification" | "deliverNotification" | "suppressNotification">
>({
  startToCloseTimeout: "20 seconds",
  retry: { maximumAttempts: 2 },
});

const rescueActivities = proxyActivities<
  Pick<DtyeActivities, "loadRescue" | "advanceRescueAtDeadline" | "eraseRescueForAccountDeletion">
>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 10,
  },
});

export async function DtyeHealthCheckWorkflow(
  input: DtyeHealthCheckWorkflowInput,
): Promise<DtyeHealthCheckWorkflowOutput> {
  if (input.schemaVersion !== 1) throw new Error("unsupported health workflow schema");
  const iterations = 5;
  const startedAtMs = Date.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const waitMs = healthCheckSleepMs(
      iteration,
      Date.now() - startedAtMs,
      iterations,
      HEALTH_CHECK_PERIOD_MS,
    );
    if (waitMs > 0) await sleep(waitMs);
    await DtyeHealthCheckActivity({ iteration });
  }
  return { status: "healthy", checks: iterations };
}

const { OutboxDispatchActivity } = proxyActivities<Pick<DtyeActivities, "OutboxDispatchActivity">>({
  startToCloseTimeout: "25 seconds",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 10,
  },
});

const { SessionMaintenanceActivity } = proxyActivities<
  Pick<DtyeActivities, "SessionMaintenanceActivity">
>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 10,
  },
});

const { StreakMilestoneSweepActivity } = proxyActivities<
  Pick<DtyeActivities, "StreakMilestoneSweepActivity">
>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 10,
  },
});

export interface OutboxDispatchRecoveryWorkflowInput {
  readonly schemaVersion: 1;
  readonly eventIds?: readonly DomainEvent["id"][];
  readonly totals?: Readonly<{ accepted: number; retried: number; failed: number }>;
  readonly runs?: number;
}

export async function OutboxDispatchRecoveryWorkflow(
  input: OutboxDispatchRecoveryWorkflowInput,
): Promise<{ accepted: number; retried: number; failed: number; runs: number }> {
  if (input.schemaVersion !== 1) throw new Error("unsupported outbox recovery workflow schema");
  let pageCount = 0;
  let totals = input.totals ?? { accepted: 0, retried: 0, failed: 0 };
  while (true) {
    const page = await OutboxDispatchActivity({ eventIds: input.eventIds, limit: 1 });
    pageCount += 1;
    totals = {
      accepted: totals.accepted + page.accepted,
      retried: totals.retried + page.retried,
      failed: totals.failed + page.failed,
    };
    const decision = nextPagingDecision({ pageSize: 1, pageCount, processed: page.claimed });
    if (decision === "complete") return { ...totals, runs: (input.runs ?? 0) + 1 };
    if (decision === "continue_as_new") {
      return continueAsNew<typeof OutboxDispatchRecoveryWorkflow>({
        ...input,
        totals,
        runs: (input.runs ?? 0) + 1,
      });
    }
  }
}

export interface SessionMaintenanceWorkflowInput {
  readonly schemaVersion: 1;
  readonly deleted?: number;
  readonly runs?: number;
  /** Stable cutoff carried through continue-as-new so a run cannot chase new expirations. */
  readonly purgeBefore?: number;
}

export async function SessionMaintenanceWorkflow(
  input: SessionMaintenanceWorkflowInput,
): Promise<{ deleted: number; runs: number }> {
  if (input.schemaVersion !== 1) {
    throw new Error("unsupported session maintenance workflow schema");
  }
  let pageCount = 0;
  let deleted = input.deleted ?? 0;
  const purgeBefore = input.purgeBefore ?? Date.now();
  while (true) {
    const page = await SessionMaintenanceActivity({ now: purgeBefore, limit: 500 });
    pageCount += 1;
    deleted += page.deleted;
    const decision = nextPagingDecision({ pageSize: 500, pageCount, processed: page.deleted });
    if (decision === "complete") return { deleted, runs: (input.runs ?? 0) + 1 };
    if (decision === "continue_as_new") {
      return continueAsNew<typeof SessionMaintenanceWorkflow>({
        schemaVersion: 1,
        deleted,
        runs: (input.runs ?? 0) + 1,
        purgeBefore,
      });
    }
  }
}

export interface StreakMilestoneSweepWorkflowInput {
  readonly schemaVersion: 1;
  readonly cutoff?: number;
  readonly cursor?: string;
  readonly totals?: Readonly<{
    candidates: number;
    achievements: number;
    notifications: number;
    sharedActivities: number;
  }>;
  readonly runs?: number;
}

export interface StreakMilestoneSweepWorkflowOutput {
  readonly candidates: number;
  readonly achievements: number;
  readonly notifications: number;
  readonly sharedActivities: number;
  readonly runs: number;
}

export async function StreakMilestoneSweepWorkflow(
  input: StreakMilestoneSweepWorkflowInput,
): Promise<StreakMilestoneSweepWorkflowOutput> {
  if (input.schemaVersion !== 1) throw new Error("unsupported streak sweep workflow schema");
  const cutoff = input.cutoff ?? Date.now();
  let cursor = input.cursor;
  let pages = 0;
  let totals = input.totals ?? {
    candidates: 0,
    achievements: 0,
    notifications: 0,
    sharedActivities: 0,
  };
  while (true) {
    const page = await StreakMilestoneSweepActivity({
      cutoff,
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    pages += 1;
    totals = {
      candidates: totals.candidates + page.candidates,
      achievements: totals.achievements + page.achievements,
      notifications: totals.notifications + page.notifications,
      sharedActivities: totals.sharedActivities + page.sharedActivities,
    };
    if (!page.hasMore) return { ...totals, runs: (input.runs ?? 0) + 1 };
    if (!page.nextCursor) throw new Error("streak sweep page omitted its continuation cursor");
    cursor = page.nextCursor;
    if (pages >= 20) {
      return continueAsNew<typeof StreakMilestoneSweepWorkflow>({
        schemaVersion: 1,
        cutoff,
        cursor,
        totals,
        runs: (input.runs ?? 0) + 1,
      });
    }
  }
}

export interface NotificationDeliveryWorkflowOutput {
  readonly notificationId: string;
  readonly deliveryCount: number;
  readonly outcomes: readonly NotificationDeliveryTerminalState[];
}

export type NotificationDeliveryTerminalState = "delivered" | "suppressed" | "permanent_failure";
export const accountDeletedSignal =
  defineSignal<
    [
      {
        readonly schemaVersion: 1;
        readonly notificationId: NotificationId;
        readonly expectedAggregateVersion: number;
      },
    ]
  >("accountDeleted");
export const deliveryStateQuery = defineQuery<NotificationDeliveryTerminalState | "delivering">(
  "deliveryState",
);

export async function NotificationDeliveryWorkflow(
  input: NotificationDeliveryWorkflowInput,
): Promise<NotificationDeliveryWorkflowOutput> {
  const parsed = NotificationDeliveryWorkflowInputSchema.parse(input);
  let accountDeleted = false;
  let accountDeletionVersion = 0;
  let workflowState: NotificationDeliveryTerminalState | "delivering" = "delivering";
  setHandler(accountDeletedSignal, (signal) => {
    if (
      signal.schemaVersion !== 1 ||
      signal.notificationId !== parsed.notificationId ||
      !Number.isSafeInteger(signal.expectedAggregateVersion) ||
      signal.expectedAggregateVersion <= accountDeletionVersion
    ) {
      return;
    }
    accountDeletionVersion = signal.expectedAggregateVersion;
    accountDeleted = true;
  });
  setHandler(deliveryStateQuery, () => workflowState);
  const prepared = await notificationActivities.prepareNotification({
    notificationId: parsed.notificationId,
  });
  const outcomes = await Promise.all(
    prepared.deliveryIds.map(async (deliveryId): Promise<NotificationDeliveryTerminalState> => {
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        if (accountDeleted) return "suppressed";
        const outcome = await notificationActivities.deliverNotification({
          deliveryId,
          finalAttempt: attempt === 8,
        });
        if (outcome.kind === "accepted") return "delivered";
        if (outcome.kind === "already_terminal") return outcome.state;
        if (outcome.kind !== "retry") return "permanent_failure";
        await condition(
          () => accountDeleted,
          Math.max(outcome.retryAfterMs, Math.min(15_000 * 2 ** (attempt - 1), 900_000)),
        );
      }
      return "permanent_failure";
    }),
  );
  if (accountDeleted) {
    await notificationActivities.suppressNotification({ notificationId: parsed.notificationId });
  }
  workflowState = outcomes.includes("delivered")
    ? "delivered"
    : outcomes.includes("permanent_failure")
      ? "permanent_failure"
      : "suppressed";
  return {
    notificationId: parsed.notificationId,
    deliveryCount: prepared.deliveryIds.length,
    outcomes,
  };
}

const reportActivities = proxyActivities<ReportAccountabilityActivities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 10,
  },
});

export const reportOwnedSignal = defineSignal<[ReportAccountabilitySignal]>("owned");
export const reportDeniedSignal = defineSignal<[ReportAccountabilitySignal]>("denied");
export const reportJarClosedSignal = defineSignal<[ReportAccountabilitySignal]>("jarClosed");
export const reportMemberDepartedSignal =
  defineSignal<[ReportAccountabilitySignal]>("memberDeparted");
export const reportAccountDeletedSignal =
  defineSignal<[ReportAccountabilitySignal]>("accountDeleted");
export const accountabilityStateQuery = defineQuery<
  ReportAccountabilityTerminalState | "loading" | "pending"
>("accountabilityState");

export interface ReportAccountabilityWorkflowOutput {
  readonly schemaVersion: 1;
  readonly reportId: ReportAccountabilityWorkflowInput["reportId"];
  readonly aggregateVersion: number;
  readonly state: ReportAccountabilityTerminalState;
}

const DAY_MS = 86_400_000;

function isTerminal(
  progress: ReportAccountabilityProgress,
): progress is Extract<ReportAccountabilityProgress, { state: ReportAccountabilityTerminalState }> {
  return progress.state !== "pending";
}

export async function ReportAccountabilityWorkflow(
  input: ReportAccountabilityWorkflowInput,
): Promise<ReportAccountabilityWorkflowOutput> {
  const parsed = ReportAccountabilityWorkflowInputSchema.parse(input);
  let state: ReportAccountabilityTerminalState | "loading" | "pending" = "loading";
  const signals: ReportAccountabilitySignal[] = [];
  const receiveSignal = (raw: ReportAccountabilitySignal) => {
    const signal = ReportAccountabilitySignalSchema.safeParse(raw);
    if (signal.success && signal.data.reportId === parsed.reportId) signals.push(signal.data);
  };
  for (const signal of [
    reportOwnedSignal,
    reportDeniedSignal,
    reportJarClosedSignal,
    reportMemberDepartedSignal,
    reportAccountDeletedSignal,
  ]) {
    setHandler(signal, receiveSignal);
  }
  setHandler(accountabilityStateQuery, () => state);

  let progress = await reportActivities.ReportAccountabilityActivity({
    reportId: parsed.reportId,
    action: "inspect",
  });
  state = progress.state;

  const terminalOutput = (
    terminal: Extract<ReportAccountabilityProgress, { state: ReportAccountabilityTerminalState }>,
  ): ReportAccountabilityWorkflowOutput => ({
    schemaVersion: 1,
    reportId: parsed.reportId,
    aggregateVersion: terminal.aggregateVersion,
    state: terminal.state,
  });
  if (isTerminal(progress)) return terminalOutput(progress);
  const createdAt = progress.createdAt;

  const reconcileSignals = async (): Promise<ReportAccountabilityWorkflowOutput | null> => {
    while (signals.length > 0) {
      const signal = signals.shift();
      if (!signal) break;
      progress = await reportActivities.ReportAccountabilityActivity({
        reportId: parsed.reportId,
        action: "inspect",
        expectedAggregateVersion: signal.expectedAggregateVersion,
      });
      state = progress.state;
      if (isTerminal(progress)) return terminalOutput(progress);
    }
    return null;
  };

  const waitUntil = async (
    deadline: number,
  ): Promise<ReportAccountabilityWorkflowOutput | null> => {
    while (Date.now() < deadline) {
      const signaled = await condition(() => signals.length > 0, deadline - Date.now());
      if (!signaled) break;
      const terminal = await reconcileSignals();
      if (terminal) return terminal;
    }
    return reconcileSignals();
  };

  if (Date.now() < createdAt + DAY_MS) {
    progress = await reportActivities.ReportAccountabilityActivity({
      reportId: parsed.reportId,
      action: "remind_immediate",
    });
    state = progress.state;
    if (isTerminal(progress)) return terminalOutput(progress);
  }

  for (const reminder of [
    { deadline: createdAt + DAY_MS, action: "remind_24h" as const },
    { deadline: createdAt + 3 * DAY_MS, action: "remind_72h" as const },
  ]) {
    if (Date.now() >= reminder.deadline) continue;
    const terminal = await waitUntil(reminder.deadline);
    if (terminal) return terminal;
    progress = await reportActivities.ReportAccountabilityActivity({
      reportId: parsed.reportId,
      action: reminder.action,
    });
    state = progress.state;
    if (isTerminal(progress)) return terminalOutput(progress);
  }

  const terminal = await waitUntil(createdAt + 7 * DAY_MS);
  if (terminal) return terminal;
  progress = await reportActivities.ReportAccountabilityActivity({
    reportId: parsed.reportId,
    action: "expire",
  });
  state = progress.state;
  if (!isTerminal(progress)) throw new Error("report expiry did not reach a terminal state");
  return terminalOutput(progress);
}

export type RescueWorkflowState = RescueIntervention["status"] | "account_deleted" | "loading";
export interface UrgeRescueWorkflowOutput {
  readonly interventionId: RescueInterventionWorkflowInput["interventionId"];
  readonly status: Exclude<RescueWorkflowState, "loading">;
}

export const safeRescueSignal = defineSignal<[RescueSignalInput]>("safe");
export const slippedRescueSignal = defineSignal<[RescueSignalInput]>("slipped");
export const extendRescueSignal = defineSignal<[RescueSignalInput]>("extend");
export const rescueAccountDeletedSignal = defineSignal<[RescueSignalInput]>("accountDeleted");
export const rescueStateQuery = defineQuery<RescueWorkflowState>("rescueState");

export async function UrgeRescueWorkflow(
  input: RescueInterventionWorkflowInput,
): Promise<UrgeRescueWorkflowOutput> {
  const parsed = RescueInterventionWorkflowInputSchema.parse(input);
  let workflowState: RescueWorkflowState = "loading";
  let wakeRevision = 0;
  let accountDeleted = false;

  const wakeForMatchingIntervention = (signalInput: RescueSignalInput) => {
    const signal = RescueSignalInputSchema.parse(signalInput);
    if (signal.interventionId === parsed.interventionId) wakeRevision += 1;
  };
  setHandler(safeRescueSignal, wakeForMatchingIntervention);
  setHandler(slippedRescueSignal, wakeForMatchingIntervention);
  setHandler(extendRescueSignal, wakeForMatchingIntervention);
  setHandler(rescueAccountDeletedSignal, (signalInput) => {
    const signal = RescueSignalInputSchema.parse(signalInput);
    if (signal.interventionId !== parsed.interventionId) return;
    accountDeleted = true;
    wakeRevision += 1;
  });
  setHandler(rescueStateQuery, () => workflowState);

  while (true) {
    if (accountDeleted) {
      await rescueActivities.eraseRescueForAccountDeletion({
        interventionId: parsed.interventionId,
      });
      workflowState = "account_deleted";
      return { interventionId: parsed.interventionId, status: workflowState };
    }

    const intervention = await rescueActivities.loadRescue({
      interventionId: parsed.interventionId,
    });
    if (!intervention) {
      workflowState = "account_deleted";
      return { interventionId: parsed.interventionId, status: workflowState };
    }
    workflowState = intervention.status;
    if (
      intervention.status === "safe" ||
      intervention.status === "slipped" ||
      intervention.status === "abandoned"
    ) {
      return { interventionId: parsed.interventionId, status: intervention.status };
    }

    const observedWakeRevision = wakeRevision;
    const deadlineAt =
      intervention.status === "active" ? intervention.deadlineAt : intervention.responseDeadlineAt;
    const woke = await condition(
      () => accountDeleted || wakeRevision !== observedWakeRevision,
      Math.max(0, deadlineAt - Date.now()),
    );
    if (woke) continue;

    const advanced = await rescueActivities.advanceRescueAtDeadline({
      interventionId: parsed.interventionId,
      expectedAggregateVersion: intervention.aggregateVersion,
    });
    if (advanced) workflowState = advanced.status;
  }
}

import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import { type InviteVersionId, InviteVersionIdSchema } from "../../api/src/domain-events";
import type { InviteLifecycleActivities } from "./invite-lifecycle";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface InviteLifecycleWorkflowInput {
  readonly schemaVersion: 1;
  readonly inviteVersionId: InviteVersionId;
}

export type InviteLifecycleTerminalState = "reminded" | "superseded" | "closed" | "expired";

interface InviteLifecycleSignalInput extends InviteLifecycleWorkflowInput {
  readonly expectedAggregateVersion: number;
}

export const inviteSupersededSignal = defineSignal<[InviteLifecycleSignalInput]>("superseded");
export const inviteJarClosedSignal = defineSignal<[InviteLifecycleSignalInput]>("jarClosed");
export const inviteStateQuery = defineQuery<InviteLifecycleTerminalState | "waiting">(
  "inviteState",
);

const activities = proxyActivities<InviteLifecycleActivities>({
  startToCloseTimeout: "20 seconds",
  retry: { maximumAttempts: 5 },
});

export function inviteReminderDelay(now: number, expiresAt: number): number {
  return Math.max(0, expiresAt - DAY_MS - now);
}

export async function InviteLifecycleWorkflow(
  input: InviteLifecycleWorkflowInput,
): Promise<InviteLifecycleTerminalState> {
  if (input.schemaVersion !== 1) throw new Error("unsupported invite lifecycle workflow schema");
  const inviteVersionId = InviteVersionIdSchema.parse(input.inviteVersionId);
  let signalVersion = 0;
  let state: InviteLifecycleTerminalState | "waiting" = "waiting";
  const acceptSignal = (signal: InviteLifecycleSignalInput): void => {
    if (
      signal.schemaVersion !== 1 ||
      signal.inviteVersionId !== inviteVersionId ||
      !Number.isSafeInteger(signal.expectedAggregateVersion) ||
      signal.expectedAggregateVersion <= signalVersion
    ) {
      return;
    }
    signalVersion = signal.expectedAggregateVersion;
  };
  setHandler(inviteSupersededSignal, acceptSignal);
  setHandler(inviteJarClosedSignal, acceptSignal);
  setHandler(inviteStateQuery, () => state);

  const initial = await activities.loadInviteLifecycle({ inviteVersionId });
  if (initial.kind !== "eligible") {
    state = initial.kind;
    return state;
  }

  await condition(() => signalVersion > 0, inviteReminderDelay(Date.now(), initial.expiresAt));
  const authoritative = await activities.requestInviteReminder({ inviteVersionId });
  if (authoritative.kind === "eligible") {
    throw new Error("invite reminder activity returned a non-terminal state");
  }
  state = authoritative.kind;
  return state;
}

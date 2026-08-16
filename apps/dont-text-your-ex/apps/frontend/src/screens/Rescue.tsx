import { useCallback, useEffect, useRef, useState } from "react";
import { api, isApiErrorStatus } from "../api";
import type { AppCtx, RouteFor } from "../appctx";
import { T } from "../theme";
import type { JarSummaryDTO, RescueInterventionDTO } from "../types";
import { Btn, Screen, TopBar } from "../ui";
import { ErrorState, LoadingState, MutationError } from "./fetched-state";

export type RescueServices = Pick<
  typeof api,
  "currentRescue" | "startRescue" | "rescueCommand" | "jars"
>;

type RescueLoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly intervention: RescueInterventionDTO | null }
  | { readonly status: "offline" }
  | { readonly status: "unavailable" };

type RescueMutationState =
  | { readonly status: "idle" }
  | { readonly status: "submitting"; readonly action: "start" | "safe" | "slipped" | "extend" }
  | { readonly status: "failed"; readonly action: "start" | "safe" | "slipped" | "extend" }
  | { readonly status: "unavailable" };

type JarChoiceState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly jars: readonly JarSummaryDTO[] }
  | { readonly status: "error" };

const systemNow = () => Date.now();

function assertNever(value: never): never {
  throw new Error(`Unexpected rescue state: ${JSON.stringify(value)}`);
}

function secondsRemaining(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1_000));
}

function countdownLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function TerminalCard({ intervention }: { intervention: RescueInterventionDTO }) {
  let title: string;
  let detail: string;
  switch (intervention.status) {
    case "safe":
      title = "You made it through.";
      detail = "That win stays private.";
      break;
    case "slipped":
      title = "You’re not alone.";
      detail = "Choose a jar below to open the normal slip confirmation.";
      break;
    case "abandoned":
      title = "This rescue ended.";
      detail = "Nothing was sent, shared, or charged. You can start again when you need it.";
      break;
    case "active":
    case "check_in_due":
      throw new Error("TerminalCard requires a terminal intervention");
    default:
      return assertNever(intervention);
  }
  return (
    <div
      role="status"
      style={{
        border: `1px solid ${T.hair}`,
        borderRadius: 24,
        background: T.surface,
        padding: 22,
        textAlign: "center",
      }}
    >
      <h2 style={{ margin: "0 0 8px", fontFamily: T.disp, fontSize: 25 }}>{title}</h2>
      <p style={{ margin: 0, color: T.sec, lineHeight: 1.5 }}>{detail}</p>
    </div>
  );
}

function JarChoices({
  state,
  onChoose,
  onRetry,
}: {
  state: JarChoiceState;
  onChoose: (jar: JarSummaryDTO) => void;
  onRetry: () => void;
}) {
  if (state.status === "loading") return <LoadingState>Loading your jars…</LoadingState>;
  if (state.status === "error") {
    return (
      <ErrorState label="Your jars couldn’t be loaded. No slip was created." onRetry={onRetry} />
    );
  }
  if (state.jars.length === 0) {
    return (
      <p role="status" style={{ color: T.sec, textAlign: "center", lineHeight: 1.5 }}>
        You don’t have a jar to log this in. No slip was created.
      </p>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
      {state.jars.map((jar) => (
        <Btn key={jar.id} kind="dark" onClick={() => onChoose(jar)}>
          Continue to {jar.name}
        </Btn>
      ))}
    </div>
  );
}

export function Rescue({
  ctx,
  services = api,
  now = systemNow,
}: {
  ctx: AppCtx<RouteFor<"rescue">>;
  services?: RescueServices;
  now?: () => number;
}) {
  const [load, setLoad] = useState<RescueLoadState>({ status: "loading" });
  const [mutation, setMutation] = useState<RescueMutationState>({ status: "idle" });
  const [clock, setClock] = useState(now);
  const [jarChoices, setJarChoices] = useState<JarChoiceState>({ status: "loading" });
  const submitting = useRef(false);
  const lastDeadlineRefreshAt = useRef(0);

  const fetchCurrent = useCallback(async () => {
    setLoad({ status: "loading" });
    try {
      const intervention = await services.currentRescue();
      setLoad({ status: "ready", intervention });
    } catch (error) {
      setLoad({ status: isApiErrorStatus(error, 503) ? "unavailable" : "offline" });
    }
  }, [services]);

  useEffect(() => {
    void fetchCurrent();
  }, [fetchCurrent]);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(now()), 1_000);
    return () => window.clearInterval(interval);
  }, [now]);

  const intervention = load.status === "ready" ? load.intervention : null;
  const loadJars = useCallback(async () => {
    setJarChoices({ status: "loading" });
    try {
      setJarChoices({ status: "loaded", jars: await services.jars() });
    } catch {
      setJarChoices({ status: "error" });
    }
  }, [services]);

  useEffect(() => {
    if (intervention?.status === "slipped") void loadJars();
  }, [intervention?.status, loadJars]);

  useEffect(() => {
    if (intervention?.status !== "active" && intervention?.status !== "check_in_due") return;
    const deadline =
      intervention.status === "check_in_due"
        ? intervention.responseDeadlineAt
        : intervention.deadlineAt;
    if (clock < deadline || clock - lastDeadlineRefreshAt.current < 5_000) return;
    lastDeadlineRefreshAt.current = clock;
    services.currentRescue().then(
      (next) => setLoad({ status: "ready", intervention: next }),
      () => undefined,
    );
  }, [clock, intervention, services]);

  const submit = async (action: "start" | "safe" | "slipped" | "extend") => {
    if (submitting.current) return;
    if (action !== "start" && !intervention) return;
    submitting.current = true;
    setMutation({ status: "submitting", action });
    try {
      let next: RescueInterventionDTO;
      if (action === "start") {
        next = await services.startRescue();
      } else {
        if (!intervention) return;
        next = await services.rescueCommand(intervention.id, action);
      }
      setLoad({ status: "ready", intervention: next });
      setMutation({ status: "idle" });
    } catch (error) {
      if (action !== "start" && isApiErrorStatus(error, 409)) {
        const current = await services.currentRescue().catch(() => intervention);
        setLoad({ status: "ready", intervention: current });
        setMutation({ status: "idle" });
        return;
      }
      setMutation(
        isApiErrorStatus(error, 503) ? { status: "unavailable" } : { status: "failed", action },
      );
    } finally {
      submitting.current = false;
    }
  };

  const retryMutation = () => {
    if (mutation.status !== "failed") return;
    void submit(mutation.action);
  };

  const topBar = <TopBar title="Don’t Send It" onBack={() => ctx.back()} />;

  if (load.status === "loading") {
    return (
      <Screen>
        {topBar}
        <LoadingState>Checking for an active rescue…</LoadingState>
      </Screen>
    );
  }
  if (load.status === "offline" || load.status === "unavailable") {
    return (
      <Screen>
        {topBar}
        <ErrorState
          label={
            load.status === "unavailable"
              ? "Rescue is temporarily unavailable. Nothing was started."
              : "You appear to be offline. Reconnect to start or resume safely."
          }
          onRetry={() => void fetchCurrent()}
        />
      </Screen>
    );
  }

  if (!intervention) {
    const starting = mutation.status === "submitting" && mutation.action === "start";
    return (
      <Screen>
        {topBar}
        <div style={{ paddingTop: 54, textAlign: "center" }}>
          <div aria-hidden style={{ fontSize: 58, marginBottom: 16 }}>
            ✋
          </div>
          <h1 style={{ margin: "0 0 12px", fontFamily: T.disp, fontSize: 34 }}>
            Put the phone down.
          </h1>
          <p style={{ margin: "0 auto 30px", maxWidth: 310, color: T.sec, lineHeight: 1.55 }}>
            Start a private ten-minute cooldown. There’s no draft, no contact, and nobody else is
            notified.
          </p>
          <Btn disabled={starting} onClick={() => void submit("start")}>
            {starting ? "Starting rescue…" : "Start 10-minute rescue"}
          </Btn>
          {mutation.status === "failed" && (
            <>
              <MutationError>Rescue couldn’t start. Nothing was sent.</MutationError>
              <Btn kind="dark" onClick={retryMutation}>
                Retry starting rescue
              </Btn>
            </>
          )}
          {mutation.status === "unavailable" && (
            <MutationError>Rescue is temporarily unavailable. Nothing was started.</MutationError>
          )}
        </div>
      </Screen>
    );
  }

  if (
    intervention.status === "safe" ||
    intervention.status === "slipped" ||
    intervention.status === "abandoned"
  ) {
    return (
      <Screen>
        {topBar}
        <div style={{ paddingTop: 42 }}>
          <TerminalCard intervention={intervention} />
          {intervention.status === "slipped" && (
            <JarChoices
              state={jarChoices}
              onChoose={(jar) => ctx.nav({ name: "logSlip", jarId: jar.id })}
              onRetry={() => void loadJars()}
            />
          )}
          <div style={{ marginTop: 18 }}>
            <Btn
              kind="dark"
              disabled={mutation.status === "submitting"}
              onClick={() => void submit("start")}
            >
              {mutation.status === "submitting" ? "Starting rescue…" : "Start another rescue"}
            </Btn>
          </div>
          {mutation.status === "failed" && (
            <>
              <MutationError>Rescue couldn’t start. Nothing was sent.</MutationError>
              <Btn kind="dark" onClick={retryMutation}>
                Retry starting rescue
              </Btn>
            </>
          )}
          {mutation.status === "unavailable" && (
            <MutationError>Rescue is temporarily unavailable. Nothing was started.</MutationError>
          )}
        </div>
      </Screen>
    );
  }

  const deadline =
    intervention.status === "check_in_due"
      ? intervention.responseDeadlineAt
      : intervention.deadlineAt;
  const seconds = secondsRemaining(deadline, clock);
  const canExtend = intervention.extensionCount < 2;
  const activeMutation = mutation.status === "submitting";

  return (
    <Screen>
      {topBar}
      <div style={{ paddingTop: 32, textAlign: "center" }}>
        <div style={{ color: T.sec, fontSize: 14, fontWeight: 700 }}>
          {intervention.status === "check_in_due" ? "CHECK IN NOW" : "PHONE-DOWN TIME"}
        </div>
        <div
          role="timer"
          aria-label={`${seconds} seconds remaining`}
          style={{
            margin: "12px 0 8px",
            color: intervention.status === "check_in_due" ? T.red : T.gold,
            fontFamily: T.disp,
            fontSize: 76,
            fontWeight: 800,
            letterSpacing: "-0.05em",
          }}
        >
          {countdownLabel(seconds)}
        </div>
        <p style={{ margin: "0 0 28px", color: T.sec, lineHeight: 1.5 }}>
          {intervention.status === "check_in_due"
            ? "Tell us how it went before this response window closes."
            : "You can leave this screen. The cooldown keeps running on the server."}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          <Btn disabled={activeMutation} onClick={() => void submit("safe")}>
            {mutation.status === "submitting" && mutation.action === "safe"
              ? "Saving…"
              : "I’m safe. I didn’t send it."}
          </Btn>
          <Btn kind="red" disabled={activeMutation} onClick={() => void submit("slipped")}>
            {mutation.status === "submitting" && mutation.action === "slipped"
              ? "Saving…"
              : "I slipped"}
          </Btn>
          {canExtend && (
            <Btn kind="dark" disabled={activeMutation} onClick={() => void submit("extend")}>
              {mutation.status === "submitting" && mutation.action === "extend"
                ? "Extending…"
                : `Give me 10 more minutes (${2 - intervention.extensionCount} left)`}
            </Btn>
          )}
        </div>
        {mutation.status === "failed" && (
          <>
            <MutationError>
              That update didn’t reach the server. Your current rescue is unchanged.
            </MutationError>
            <Btn kind="dark" onClick={retryMutation}>
              Retry update
            </Btn>
          </>
        )}
        {mutation.status === "unavailable" && (
          <MutationError>
            Rescue is temporarily unavailable. Your saved timer is still safe.
          </MutationError>
        )}
        <p style={{ color: T.ter, fontSize: 12.5, marginTop: 20 }}>
          Extended {intervention.extensionCount} of 2 times
        </p>
      </div>
    </Screen>
  );
}

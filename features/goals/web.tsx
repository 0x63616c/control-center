import { useState } from "react";
import { Tile, TileHeader, TileStatus } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { useTileQuery } from "@/lib/useTileQuery";

export type GoalDashboard = {
  endDay: string;
  days: string[];
  vacations: { id: string; startDay: string; endDay: string }[];
  goals: Array<{
    id: string;
    title: string;
    encouragement: string | null;
    kind: "simple" | "measured" | "reflective";
    target: number | null;
    reflectivePrompts: string[] | null;
    status: "active" | "paused" | "archived";
    schedule: {
      kind: "daily" | "weekdays" | "weekly";
      weekdays: number[] | null;
      weeklyTarget: number | null;
    } | null;
    weeklyDone: number;
    weekTarget: number | null;
    streak: { count: number; unit: "day" | "week" };
    weeklyConsistency: { expected: number; fulfilled: number; rate: number | null };
    monthlyConsistency: { expected: number; fulfilled: number; rate: number | null };
    days: Array<{
      day: string;
      vacation: boolean;
      scheduled: boolean;
      complete: boolean;
      checkin: {
        state: "complete" | "partial" | "not_today";
        value: number | null;
        reflection: string | null;
      } | null;
    }>;
  }>;
};

function Bubble({ day }: { day: GoalDashboard["goals"][number]["days"][number] }) {
  const color = day.complete
    ? "var(--acc)"
    : day.checkin?.state === "partial"
      ? "var(--acc-2)"
      : day.vacation
        ? "var(--hair-2)"
        : "transparent";
  return (
    <span
      title={day.day}
      style={{
        width: 14,
        height: 14,
        borderRadius: 99,
        boxSizing: "border-box",
        border: `1px solid ${day.vacation ? "var(--hair-2)" : day.scheduled ? "var(--hair-3)" : "var(--hair)"}`,
        background: color,
        opacity: day.checkin?.state === "not_today" ? 0.45 : 1,
      }}
    />
  );
}

export function GoalsRhythmCard({
  goal,
  compact = false,
  onCheckIn,
}: {
  goal: GoalDashboard["goals"][number];
  compact?: boolean;
  onCheckIn?: (input: {
    state: "complete" | "partial" | "not_today";
    value?: number;
    reflection?: string;
  }) => void;
}) {
  const latest = goal.days.at(-1);
  const canAct = onCheckIn && goal.status === "active" && !latest?.vacation;
  const [value, setValue] = useState(String(goal.target ?? 1));
  const [reflection, setReflection] = useState("");
  return (
    <article
      style={{
        background: "var(--nest)",
        border: "1px solid var(--hair)",
        borderRadius: 16,
        padding: compact ? 12 : 18,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <strong style={{ fontSize: compact ? 14 : 18, letterSpacing: "-0.02em" }}>
          {goal.title}
        </strong>
        <span style={{ marginLeft: "auto", color: "var(--ink-2)", fontSize: 12 }}>
          {latest?.vacation
            ? "intentional rest"
            : `${goal.streak.count} ${goal.streak.unit} rhythm`}
        </span>
      </div>
      {!compact && goal.encouragement && (
        <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 14 }}>{goal.encouragement}</p>
      )}
      <div style={{ display: "flex", gap: compact ? 5 : 8, alignItems: "center" }}>
        {goal.days.map((day) => (
          <Bubble key={day.day} day={day} />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "var(--ink-2)",
          fontSize: 12,
        }}
      >
        {goal.weekTarget
          ? `${goal.weeklyDone} of ${goal.weekTarget} this week`
          : goal.schedule?.kind === "weekdays"
            ? "selected days"
            : "daily rhythm"}
        {goal.kind === "measured" && (
          <span style={{ marginLeft: "auto" }}>target {goal.target}</span>
        )}
      </div>
      {canAct && goal.kind === "simple" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
          <button
            type="button"
            onClick={() => onCheckIn({ state: "complete" })}
            style={actionStyle(true)}
          >
            Done
          </button>
          <button
            type="button"
            onClick={() => onCheckIn({ state: "partial" })}
            style={actionStyle(false)}
          >
            A little
          </button>
          <button
            type="button"
            onClick={() => onCheckIn({ state: "not_today" })}
            style={actionStyle(false)}
          >
            Not today
          </button>
        </div>
      )}
      {canAct && goal.kind === "measured" && (
        <div style={{ display: "flex", gap: 6 }}>
          <input
            aria-label={`${goal.title} amount`}
            type="number"
            min="0"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            style={{
              width: 76,
              border: "1px solid var(--hair-2)",
              borderRadius: 9,
              background: "var(--bg)",
              color: "var(--ink)",
              padding: "0 8px",
            }}
          />
          <button
            type="button"
            onClick={() => onCheckIn({ state: "complete", value: Number(value) || 0 })}
            style={actionStyle(true)}
          >
            Log progress
          </button>
          <button
            type="button"
            onClick={() => onCheckIn({ state: "not_today" })}
            style={actionStyle(false)}
          >
            Not today
          </button>
        </div>
      )}
      {canAct && goal.kind === "reflective" && (
        <div style={{ display: "flex", gap: 6 }}>
          <input
            aria-label={`${goal.title} reflection`}
            value={reflection}
            onChange={(event) => setReflection(event.target.value)}
            placeholder="Write a line…"
            style={{
              flex: 1,
              minWidth: 0,
              border: "1px solid var(--hair-2)",
              borderRadius: 9,
              background: "var(--bg)",
              color: "var(--ink)",
              padding: "0 8px",
            }}
          />
          <button
            type="button"
            disabled={!reflection.trim()}
            onClick={() => {
              onCheckIn({ state: "complete", reflection: reflection.trim() });
              setReflection("");
            }}
            style={actionStyle(true)}
          >
            Keep it
          </button>
        </div>
      )}
    </article>
  );
}

function actionStyle(primary: boolean) {
  return {
    border: primary ? "1px solid var(--acc)" : "1px solid var(--hair-2)",
    borderRadius: 9,
    background: primary ? "var(--acc)" : "transparent",
    color: primary ? "var(--bg)" : "var(--ink)",
    font: "600 12px var(--ui)",
    padding: "8px 6px",
    cursor: "pointer",
  } as const;
}

export function GoalsTileView({
  status,
  dashboard,
  onCheckIn,
}: {
  status: TileStatus;
  dashboard?: GoalDashboard;
  onCheckIn?: (goalId: string, input: { state: "complete" | "partial" | "not_today"; value?: number; reflection?: string }) => void;
}) {
  return (
    <Tile padding={18}>
      <TileHeader
        icon="sparkles"
        title="Goals"
        right={
          <span style={{ color: "var(--ink-2)", fontSize: 12 }}>{dashboard?.endDay ?? ""}</span>
        }
      />
      {status !== TileStatus.Populated || !dashboard ? (
        <div style={{ flex: 1, borderRadius: 14, background: "var(--nest)" }} />
      ) : dashboard.goals.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: "grid",
            placeItems: "center",
            textAlign: "center",
            color: "var(--ink-2)",
            fontSize: 14,
          }}
        >
          Start with one small promise to yourself.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, overflow: "hidden" }}>
          {dashboard.goals.slice(0, 4).map((goal) => (
            <GoalsRhythmCard key={goal.id} goal={goal} compact onCheckIn={onCheckIn ? (input) => onCheckIn(goal.id, input) : undefined} />
          ))}
        </div>
      )}
    </Tile>
  );
}

export function GoalsTile() {
  const query = useTileQuery(trpc.goals.dashboard.useQuery());
  const utils = trpc.useUtils();
  const checkIn = trpc.goals.checkIn.useMutation({ onSuccess: () => void utils.goals.dashboard.invalidate() });
  return <GoalsTileView status={query.status} dashboard={query.data} onCheckIn={(goalId, input) => { if (query.data) checkIn.mutate({ goalId, day: query.data.endDay, ...input }); }} />;
}

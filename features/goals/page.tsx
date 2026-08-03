import { useState } from "react";
import type { DetailVariant, TileDetailPageEntry } from "@/components/tiles/detail/types";
import { Button } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { shiftGoalDay } from "./time";
import { type GoalDashboard, GoalsRhythmCard } from "./web";

function GoalPage({ mode }: { mode: "today" | "history" | "manage" }) {
  const [endDay, setEndDay] = useState<string | undefined>();
  const query = trpc.goals.dashboard.useQuery(
    mode === "history" && endDay
      ? { endDay, days: 7, includeArchived: true }
      : { days: mode === "history" ? 7 : 7, includeArchived: mode === "manage" },
  );
  const utils = trpc.useUtils();
  const checkIn = trpc.goals.checkIn.useMutation({
    onSuccess: () => void utils.goals.dashboard.invalidate(),
  });
  const setStatus = trpc.goals.setStatus.useMutation({
    onSuccess: () => void utils.goals.dashboard.invalidate(),
  });
  const addVacation = trpc.goals.addVacation.useMutation({
    onSuccess: () => void utils.goals.dashboard.invalidate(),
  });
  const data = query.data as GoalDashboard | undefined;
  const activeDay = data?.endDay ?? "";
  const [vacationStart, setVacationStart] = useState("");
  const [vacationEnd, setVacationEnd] = useState("");
  if (!data) return <div style={{ color: "var(--ink-2)" }}>Loading your rhythm…</div>;
  return (
    <section
      style={{ maxWidth: 980, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}
    >
      {mode === "history" && (
        <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
          View day{" "}
          <input
            type="date"
            value={endDay ?? data.endDay}
            onChange={(event) => setEndDay(event.target.value)}
            style={inputStyle}
          />
        </label>
      )}
      {mode === "manage" && (
        <>
          <GoalCreateForm
            day={activeDay}
            onCreated={() => void utils.goals.dashboard.invalidate()}
          />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (vacationStart && vacationEnd)
                addVacation.mutate({ startDay: vacationStart, endDay: vacationEnd });
            }}
            style={panelStyle}
          >
            <strong>Intentional rest</strong>
            <span style={{ color: "var(--ink-2)", fontSize: 14 }}>
              Vacation pauses expectations and streaks. Your real check-ins stay visible.
            </span>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                required
                type="date"
                value={vacationStart}
                onChange={(event) => setVacationStart(event.target.value)}
                style={inputStyle}
              />
              <input
                required
                type="date"
                value={vacationEnd}
                onChange={(event) => setVacationEnd(event.target.value)}
                style={inputStyle}
              />
              <Button loading={addVacation.isPending} style={{ width: 150 }}>
                Save rest
              </Button>
            </div>
          </form>
        </>
      )}
      {data.goals.length === 0 && mode !== "manage" ? (
        <div style={panelStyle}>There are no active goals yet. Add the first one in Manage.</div>
      ) : (
        data.goals.map((goal) => (
          <div key={goal.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <GoalsRhythmCard
              goal={goal}
              onCheckIn={
                mode === "manage"
                  ? undefined
                  : (input) => checkIn.mutate({ goalId: goal.id, day: activeDay, ...input })
              }
            />
            {mode === "manage" && goal.status !== "archived" && (
              <Button
                variant="ghost"
                type="button"
                onClick={() => setStatus.mutate({ id: goal.id, status: "archived" })}
                style={{ width: 130, height: 34 }}
              >
                Archive goal
              </Button>
            )}
            {mode === "manage" && (
              <GoalEditor
                goal={goal}
                day={shiftGoalDay(activeDay, 1)}
                onSaved={() => void utils.goals.dashboard.invalidate()}
              />
            )}
          </div>
        ))
      )}
    </section>
  );
}

function GoalCreateForm({ day, onCreated }: { day: string; onCreated: () => void }) {
  const create = trpc.goals.create.useMutation({ onSuccess: onCreated });
  const [kind, setKind] = useState<"simple" | "measured" | "reflective">("simple");
  const [scheduleKind, setScheduleKind] = useState<"daily" | "weekdays" | "weekly">("daily");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const title = String(form.get("title") ?? "");
        const schedule =
          scheduleKind === "weekly"
            ? { kind: "weekly" as const, weeklyTarget: Number(form.get("weeklyTarget")) || 3 }
            : scheduleKind === "weekdays"
              ? { kind: "weekdays" as const, weekdays: [1, 2, 3, 4, 5] }
              : { kind: "daily" as const };
        create.mutate({
          title,
          encouragement: String(form.get("encouragement") ?? "") || null,
          kind,
          target: kind === "measured" ? Number(form.get("target")) : null,
          reflectivePrompts: null,
          schedule,
          effectiveFrom: day,
        });
        event.currentTarget.reset();
      }}
      style={panelStyle}
    >
      <strong>Add a goal</strong>
      <input name="title" required placeholder="Write every day" style={inputStyle} />
      <input
        name="encouragement"
        placeholder="A gentle reminder, if you want one"
        style={inputStyle}
      />
      <div style={{ display: "flex", gap: 8 }}>
        {(["simple", "measured", "reflective"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setKind(option)}
            style={actionTab(kind === option)}
          >
            {option}
          </button>
        ))}
      </div>
      {kind === "measured" && (
        <input name="target" type="number" min="1" defaultValue="1" style={inputStyle} />
      )}
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
        Schedule{" "}
        <select
          value={scheduleKind}
          onChange={(event) => setScheduleKind(event.target.value as typeof scheduleKind)}
          style={inputStyle}
        >
          <option value="daily">Every day</option>
          <option value="weekdays">Weekdays</option>
          <option value="weekly">Times per week</option>
        </select>
      </label>
      {scheduleKind === "weekly" && (
        <input
          name="weeklyTarget"
          type="number"
          min="1"
          max="7"
          defaultValue="3"
          style={inputStyle}
        />
      )}
      <Button loading={create.isPending} style={{ width: 150 }}>
        Add goal
      </Button>
    </form>
  );
}

function GoalEditor({
  goal,
  day,
  onSaved,
}: {
  goal: GoalDashboard["goals"][number];
  day: string;
  onSaved: () => void;
}) {
  const update = trpc.goals.update.useMutation({ onSuccess: onSaved });
  const [scheduleKind, setScheduleKind] = useState(goal.schedule?.kind ?? "daily");
  return (
    <details style={{ ...panelStyle, padding: 14 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>Edit goal and schedule</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const schedule =
            scheduleKind === "weekly"
              ? { kind: "weekly" as const, weeklyTarget: Number(form.get("weeklyTarget")) || 3 }
              : scheduleKind === "weekdays"
                ? { kind: "weekdays" as const, weekdays: [1, 2, 3, 4, 5] }
                : { kind: "daily" as const };
          update.mutate({
            id: goal.id,
            title: String(form.get("title")),
            encouragement: String(form.get("encouragement")) || null,
            kind: goal.kind,
            target: goal.target,
            reflectivePrompts: goal.reflectivePrompts,
            schedule,
            effectiveFrom: day,
          });
        }}
        style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}
      >
        <input name="title" defaultValue={goal.title} required style={inputStyle} />
        <input name="encouragement" defaultValue={goal.encouragement ?? ""} style={inputStyle} />
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
          Schedule{" "}
          <select
            value={scheduleKind}
            onChange={(event) => setScheduleKind(event.target.value as typeof scheduleKind)}
            style={inputStyle}
          >
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Times per week</option>
          </select>
        </label>
        {scheduleKind === "weekly" && (
          <input
            name="weeklyTarget"
            type="number"
            min="1"
            max="7"
            defaultValue={goal.schedule?.weeklyTarget ?? 3}
            style={inputStyle}
          />
        )}
        <Button loading={update.isPending} style={{ width: 140 }}>
          Save changes
        </Button>
      </form>
    </details>
  );
}

const panelStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 18,
  border: "1px solid var(--hair)",
  background: "var(--nest)",
  borderRadius: 16,
} as const;
const inputStyle = {
  minHeight: 40,
  borderRadius: 9,
  border: "1px solid var(--hair-2)",
  background: "var(--bg)",
  color: "var(--ink)",
  padding: "0 10px",
  font: "14px var(--ui)",
} as const;
function actionTab(active: boolean) {
  return {
    border: `1px solid ${active ? "var(--acc)" : "var(--hair-2)"}`,
    borderRadius: 9,
    background: active ? "var(--acc)" : "transparent",
    color: active ? "var(--bg)" : "var(--ink)",
    padding: "8px 12px",
    font: "600 13px var(--ui)",
    cursor: "pointer",
  } as const;
}

function useVariants(): { variants: DetailVariant[]; loading: boolean } {
  return {
    loading: false,
    variants: [
      { slug: "today", label: "Today", render: () => <GoalPage mode="today" /> },
      { slug: "history", label: "History", render: () => <GoalPage mode="history" /> },
      { slug: "manage", label: "Manage", render: () => <GoalPage mode="manage" /> },
    ],
  };
}

export const goalsDetail: TileDetailPageEntry = {
  kind: "page",
  tileId: "tile_goals",
  title: "Goals",
  defaultSlug: "today",
  useVariants,
};

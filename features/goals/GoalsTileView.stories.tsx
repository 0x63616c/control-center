import type { Meta, StoryObj } from "@storybook/react-vite";
import { TileStatus } from "@/components/ui";
import { type GoalDashboard, GoalsTileView } from "./web";

const storyDays = [
  "2026-07-28",
  "2026-07-29",
  "2026-07-30",
  "2026-07-31",
  "2026-08-01",
  "2026-08-02",
  "2026-08-03",
] as const;

const dashboard: GoalDashboard = {
  endDay: "2026-08-03",
  days: [...storyDays],
  vacations: [],
  goals: [
    {
      id: "goal_story_write",
      title: "Write every day",
      encouragement: "A few honest words count.",
      kind: "simple",
      target: null,
      reflectivePrompts: null,
      status: "active",
      schedule: { kind: "daily", weekdays: null, weeklyTarget: null },
      weeklyDone: 5,
      weekTarget: null,
      streak: { count: 5, unit: "day" },
      days: ["complete", "complete", "partial", "complete", "complete", "complete", "complete"].map(
        (state, index) => ({
          day: storyDays[index] ?? "2026-08-03",
          vacation: false,
          scheduled: true,
          complete: state === "complete",
          checkin: { state: state as "complete" | "partial", value: null, reflection: null },
        }),
      ),
    },
    {
      id: "goal_story_zero",
      title: "Spend more time with Zero",
      encouragement: null,
      kind: "simple",
      target: null,
      reflectivePrompts: null,
      status: "active",
      schedule: { kind: "weekly", weekdays: null, weeklyTarget: 3 },
      weeklyDone: 2,
      weekTarget: 3,
      streak: { count: 2, unit: "week" },
      days: ["complete", "partial", "open", "complete", "open", "open", "open"].map(
        (state, index) => ({
          day: storyDays[index] ?? "2026-08-03",
          vacation: false,
          scheduled: false,
          complete: state === "complete",
          checkin:
            state === "open"
              ? null
              : { state: state as "complete" | "partial", value: null, reflection: null },
        }),
      ),
    },
  ],
};

const meta = {
  title: "Goals/Tile",
  component: GoalsTileView,
  tags: ["autodocs"],
  args: { status: TileStatus.Populated, dashboard },
  decorators: [
    (Story) => (
      <div style={{ width: 320, height: 440 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GoalsTileView>;
export default meta;
export const RhythmBoard: StoryObj<typeof meta> = {};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { DAY, plannedInjections, type RecordSet, scenario, type Weight } from "../model";
import { TrackerView } from "../page";
import { PhotoGuides } from "./Photos";
import { Calendar, ScenarioComparison } from "./Timeline";

// Isolated Storybook examples, never seeded into actual injection or weight history.
const course = {
  ...scenario("2026", "2026-09-04", "America/Los_Angeles"),
  id: "icr_story",
  name: "Semaglutide · UI validation example",
  status: "active" as const,
  notes: "Storybook example only — these records are not personal history.",
};
const plan = plannedInjections(course);
const now = Date.parse("2026-10-02T19:00:00Z");
const example: RecordSet = {
  course,
  vials: [
    {
      id: "ivl_story",
      courseId: course.id,
      label: "Vial 1",
      volume: 2,
      concentration: 5,
      syringeScale: 100,
      receivedDate: "2026-09-03",
      openedDate: "2026-09-04",
      discardDate: "2026-11-27",
      retired: false,
    },
  ],
  injections: plan.slice(0, 4).map((p, i) => ({
    id: `inj_story${i}`,
    courseId: course.id,
    vialId: "ivl_story",
    at: p.at,
    units: p.units,
    notes: i === 3 ? "Evening injection logged." : "",
    plannedAt: p.at,
  })),
  checkIns: [
    {
      id: "ici_story",
      courseId: course.id,
      date: "2026-10-02",
      values: { Appetite: 1, Energy: 3, Nausea: 0 },
      notes: "A comfortable day. Went for a walk after lunch.",
      weightId: null,
    },
  ],
  photos: [],
};
const weights: Weight[] = Array.from({ length: 14 }, (_, i) => ({
  id: `weight_story${i}`,
  at: new Date(Date.parse("2026-09-04T16:00:00Z") + i * 2 * DAY).toISOString(),
  kg: 74 - i * 0.18 + (i % 3) * 0.07,
}));
const meta = {
  title: "Pages/InjectionTracker",
  tags: ["autodocs"],
  component: TrackerView,
  parameters: { layout: "fullscreen", boardWrapper: false },
  decorators: [
    (Story) => (
      <div className="e-root" style={{ background: "var(--bg)", minHeight: "100vh", padding: 24 }}>
        <div className="ij">
          <Story />
        </div>
      </div>
    ),
  ],
  args: { data: example, weights, now, onAction: fn() },
} satisfies Meta<typeof TrackerView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Timeline: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Your progress" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Log dose", exact: true })).toBeVisible();
    await expect(canvas.getByText("Estimated in your body now")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "12 weeks each side", exact: true }));
    await expect(canvas.getByRole("slider", { name: "Selected timeline date" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "4 weeks each side", exact: true }));
  },
};
export const CalendarView: Story = {
  render: () => {
    const [selected, setSelected] = useState(now);
    return <Calendar data={example} weights={weights} selected={selected} onSelect={setSelected} />;
  },
};
export const PrescribedComparison: Story = {
  render: () => <ScenarioComparison timezone="America/Los_Angeles" />,
};
export const GuidedPhotoAlignment: Story = {
  render: () => (
    <section className="ij-card">
      <span className="ij-eyebrow">PROGRESS PHOTOS · CAMERA GUIDE PREVIEW</span>
      <h1>Same place. Same framing.</h1>
      <p className="ij-muted">
        Align your head, center line and feet. Your reference photo appears as a faint ghost after
        the first capture.
      </p>
      <div
        className="ij-camera"
        style={{ height: 650, background: "linear-gradient(160deg,#30373a,#15191c)" }}
      >
        <PhotoGuides pose="front" />
      </div>
      <p className="ij-muted">
        Front · 10-second countdown · guides are never included in the saved photo.
      </p>
    </section>
  ),
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { scenario } from "../model";
import { InjectionTileView } from "../web";

const meta = {
  title: "Tiles/InjectionTracker",
  component: InjectionTileView,
  tags: ["autodocs"],
} satisfies Meta<typeof InjectionTileView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Active: Story = {
  args: {
    now: Date.parse("2026-09-11T19:00:00Z"),
    data: {
      course: {
        ...scenario("2026", "2026-09-04", "America/Los_Angeles"),
        id: "icr_story",
        name: "Storybook example",
        status: "active",
      },
      vials: [
        {
          id: "ivl_story",
          courseId: "icr_story",
          label: "Vial 1",
          volume: 2,
          concentration: 5,
          syringeScale: 100,
          receivedDate: null,
          openedDate: "2026-09-04",
          discardDate: null,
          retired: false,
        },
      ],
      injections: [
        {
          id: "inj_story",
          courseId: "icr_story",
          vialId: "ivl_story",
          at: "2026-09-05T03:00:00Z",
          units: 3,
          notes: "",
          plannedAt: null,
        },
      ],
      checkIns: [],
      photos: [],
    },
    weight: { kg: 74, change: -1.2 },
  },
};

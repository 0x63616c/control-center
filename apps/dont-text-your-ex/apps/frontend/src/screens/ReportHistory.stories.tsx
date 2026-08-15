import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { MeSchema, ReportSchema, UserSchema } from "../../../../contracts";
import type { AppCtx, RouteFor } from "../appctx";
import {
  ReportDetail,
  type ReportDetailServices,
  ReportHistory,
  type ReportHistoryServices,
} from "./ReportHistory";

const me = MeSchema.parse({
  id: "usr_historyme",
  name: "Alex",
  color: "#5E5CE6",
  emoji: null,
  photo: null,
  exes: [],
  phone: null,
});
const accused = UserSchema.parse({
  id: me.id,
  name: me.name,
  color: me.color,
  emoji: me.emoji,
  photo: me.photo,
  exes: me.exes,
});
const resolved = ReportSchema.parse({
  id: "rpt_history",
  jarId: "jar_history",
  jarName: "The Group Chat",
  accuser: null,
  accused,
  note: "The screenshot survived the reload.",
  anonymous: true,
  amountCents: 500,
  status: "owned",
  ago: "2 hours",
  evidence: [
    {
      id: "evi_history",
      kind: "image",
      mimeType: "image/png",
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    },
  ],
});
const navigate = fn();

function context<Name extends RouteFor<"reportHistory" | "reportDetail">["name"]>(
  route: RouteFor<Name>,
): AppCtx<RouteFor<Name>> {
  return {
    me,
    setMe: fn(),
    route,
    nav: navigate,
    back: fn(),
    tab: fn(),
    signIn: fn(),
    signOut: fn(),
    sessionExpired: false,
    fireBurst: fn(),
    hasPendingReport: false,
    refreshPending: fn(),
  };
}

const meta = {
  title: "Don't Text Your Ex/Flows/Report history",
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "centered" },
  decorators: [
    (Story) => (
      <div style={{ width: 390, height: 844, overflow: "auto", background: "#000" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const ResolvedList: Story = {
  render: () => {
    const ctx = context({ name: "reportHistory" });
    const services: ReportHistoryServices = { reportHistory: fn(async () => [resolved]) };
    return <ReportHistory ctx={ctx} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    navigate.mockClear();
    await expect(await canvas.findByText("Owned")).toBeVisible();
    await expect(canvas.getByText("The screenshot survived the reload.")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /Alex · The Group Chat/ }));
    await expect(navigate).toHaveBeenCalledWith({
      name: "reportDetail",
      reportId: resolved.id,
    });
  },
};

export const AnonymousResolvedDetail: Story = {
  render: () => {
    const ctx = context({ name: "reportDetail", reportId: resolved.id });
    const services: ReportDetailServices = { report: fn(async () => resolved) };
    return <ReportDetail ctx={ctx} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Someone in the jar reported Alex")).toBeVisible();
    await expect(canvas.queryByText("History Reporter")).not.toBeInTheDocument();
    const evidence = canvas.getByRole("button", { name: "View report attachment" });
    await userEvent.click(evidence);
    await expect(canvas.getByRole("dialog", { name: "Report attachment viewer" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
    await expect(evidence).toHaveFocus();
  },
};

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
const denied = ReportSchema.parse({
  ...resolved,
  id: "rpt_deniedhistory",
  note: "Denied, but still part of the jar history.",
  status: "denied",
  evidence: [],
});
const expired = ReportSchema.parse({
  ...resolved,
  id: "rpt_expiredhistory",
  note: "No response arrived before the accountability window closed.",
  status: "expired",
  evidence: [],
});
const navigate = fn();

function never<T>(): Promise<T> {
  return new Promise(() => {});
}

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
    deleteAccount: fn(),
    sessionExpired: false,
    fireBurst: fn(),
    hasPendingReport: false,
    refreshPending: fn(),
  };
}

const meta = {
  title: "Don't Text Your Ex/Flows/Check history",
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
    const services: ReportHistoryServices = {
      reportHistory: fn(async () => [resolved, denied, expired]),
    };
    return <ReportHistory ctx={ctx} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    navigate.mockClear();
    await expect(await canvas.findByText("Accepted")).toBeVisible();
    await expect(canvas.getByText("Denied")).toBeVisible();
    await expect(canvas.getByText("Expired")).toBeVisible();
    await expect(canvas.getByText("The screenshot survived the reload.")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /Alex · The Group Chat.*Accepted/ }));
    await expect(navigate).toHaveBeenCalledWith({
      name: "reportDetail",
      reportId: resolved.id,
    });
  },
};

export const HistoryLoading: Story = {
  render: () => (
    <ReportHistory
      ctx={context({ name: "reportHistory" })}
      services={{
        reportHistory: fn(() =>
          never<Awaited<ReturnType<ReportHistoryServices["reportHistory"]>>>(),
        ),
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("status")).toHaveTextContent("Loading check history");
    await expect(canvas.queryByText("No resolved checks yet.")).not.toBeInTheDocument();
  },
};

export const HistoryEmpty: Story = {
  render: () => (
    <ReportHistory
      ctx={context({ name: "reportHistory" })}
      services={{ reportHistory: fn(async () => []) }}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText("No resolved checks yet.")).toBeVisible();
  },
};

export const HistoryErrorAndRetry: Story = {
  render: () => {
    let attempts = 0;
    return (
      <ReportHistory
        ctx={context({ name: "reportHistory" })}
        services={{
          reportHistory: fn(async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("offline");
            return [resolved];
          }),
        }}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Check history couldn’t be loaded.",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(await canvas.findByText("Accepted")).toBeVisible();
  },
};

export const HiddenSenderResolvedDetail: Story = {
  render: () => {
    const ctx = context({ name: "reportDetail", reportId: resolved.id });
    const services: ReportDetailServices = { report: fn(async () => resolved) };
    return <ReportDetail ctx={ctx} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Someone in the jar sent a check to Alex")).toBeVisible();
    await expect(canvas.queryByText("History Reporter")).not.toBeInTheDocument();
    const evidence = canvas.getByRole("button", { name: "View supporting screenshot" });
    await userEvent.click(evidence);
    await expect(
      canvas.getByRole("dialog", { name: "Supporting screenshot viewer" }),
    ).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
    await expect(evidence).toHaveFocus();
  },
};

export const DetailLoading: Story = {
  render: () => (
    <ReportDetail
      ctx={context({ name: "reportDetail", reportId: resolved.id })}
      services={{
        report: fn(() => never<Awaited<ReturnType<ReportDetailServices["report"]>>>()),
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("status")).toHaveTextContent("Loading check");
    await expect(canvas.queryByText("5 pts")).not.toBeInTheDocument();
  },
};

export const DetailErrorAndRetry: Story = {
  render: () => {
    let attempts = 0;
    return (
      <ReportDetail
        ctx={context({ name: "reportDetail", reportId: resolved.id })}
        services={{
          report: fn(async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("offline");
            return resolved;
          }),
        }}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "This check couldn’t be loaded.",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(await canvas.findByText("Someone in the jar sent a check to Alex")).toBeVisible();
  },
};

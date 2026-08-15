import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { JarDetailSchema, MeSchema, ReportSchema, UserSchema } from "../../../../contracts";
import type { AppCtx, RouteFor } from "../appctx";
import { type ActivityServices, ActivityTab } from "./ActivityTab";
import { ConfirmDeny, type ConfirmDenyServices } from "./ConfirmDeny";
import { Home, type HomeServices } from "./Home";
import { JarDetail, type JarDetailServices } from "./JarDetail";
import { Settle, type SettleServices } from "./Settle";

const me = MeSchema.parse({
  id: "usr_fetchqa",
  name: "Alex",
  color: "#5E5CE6",
  emoji: null,
  photo: null,
  exes: [],
  phone: null,
});

const meUser = UserSchema.parse({
  id: me.id,
  name: me.name,
  color: me.color,
  emoji: me.emoji,
  photo: me.photo,
  exes: me.exes,
});

const jar = JarDetailSchema.parse({
  id: "jar_fetchqa",
  name: "Recovery jar",
  rule: "No contact.",
  defaultCents: 500,
  inviteCode: "RETRY1",
  jarTotalCents: 500,
  members: [{ user: meUser, role: "owner", tallyCents: 500, daysClean: 2, shareStreak: true }],
  activity: [],
});

const report = ReportSchema.parse({
  id: "rpt_fetchqa",
  jarId: jar.id,
  jarName: jar.name,
  accuser: meUser,
  accused: meUser,
  note: "The receipts",
  anonymous: false,
  amountCents: 500,
  status: "pending",
  ago: "now",
  evidence: [],
});

function context<
  Name extends RouteFor<"home" | "activity" | "jar" | "settle" | "confirmDeny">["name"],
>(route: RouteFor<Name>): AppCtx<RouteFor<Name>> {
  return {
    me,
    setMe: fn(),
    route,
    nav: fn(),
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
  title: "Don't Text Your Ex/Flows/Fetched screen recovery",
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

export const HomeErrorRetryAndEmpty: Story = {
  render: () => {
    let attempts = 0;
    const services: HomeServices = {
      jars: fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return [];
      }),
      jar: fn(async () => jar),
    };
    return <Home ctx={context({ name: "home" })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Your jars couldn’t be loaded.",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(await canvas.findByText(/No jars yet/)).toBeInTheDocument();
  },
};

export const ActivityErrorRetryAndEmpty: Story = {
  render: () => {
    let attempts = 0;
    const services: ActivityServices = {
      activity: fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return [];
      }),
      pendingReports: fn(async () => []),
    };
    return <ActivityTab ctx={context({ name: "activity" })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Activity couldn’t be loaded.",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(await canvas.findByText(/No carnage yet/)).toBeInTheDocument();
  },
};

export const JarDetailErrorAndRetry: Story = {
  render: () => {
    const services: JarDetailServices = {
      jar: fn(async () => Promise.reject(new Error("offline"))),
    };
    return <JarDetail ctx={context({ name: "jar", jarId: jar.id })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "This jar couldn’t be loaded.",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "This jar couldn’t be loaded.",
    );
  },
};

export const SettleErrorAndRetry: Story = {
  render: () => {
    const services: SettleServices = { jar: fn(async () => Promise.reject(new Error("offline"))) };
    return <Settle ctx={context({ name: "settle", jarId: jar.id })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Your balance couldn’t be loaded.",
    );
    await expect(canvas.queryByText("$0.00")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Your balance couldn’t be loaded.",
    );
  },
};

export const ConfirmDenyErrorRetryAndEmpty: Story = {
  render: () => {
    let attempts = 0;
    const services: ConfirmDenyServices = {
      pendingReports: fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return [];
      }),
      resolveReport: fn(async () => report),
    };
    return (
      <ConfirmDeny
        ctx={context({ name: "confirmDeny", reportId: report.id })}
        services={services}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "This report couldn’t be loaded.",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(await canvas.findByText(/Nothing pending/)).toBeInTheDocument();
  },
};

export const ConfirmDenyMutationFailure: Story = {
  render: () => {
    const services: ConfirmDenyServices = {
      pendingReports: fn(async () => [report]),
      resolveReport: fn(async () => Promise.reject(new Error("offline"))),
    };
    return (
      <ConfirmDeny
        ctx={context({ name: "confirmDeny", reportId: report.id })}
        services={services}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /I did it/ }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("couldn’t be updated");
    await expect(canvas.getByRole("button", { name: /I did it/ })).toBeEnabled();
  },
};

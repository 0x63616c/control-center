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

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

export const HomeLoading: Story = {
  render: () => (
    <Home
      ctx={context({ name: "home" })}
      services={{
        jars: fn(() => never<Awaited<ReturnType<HomeServices["jars"]>>>()),
        jar: fn(() => never<Awaited<ReturnType<HomeServices["jar"]>>>()),
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent("Loading your jars");
  },
};

export const ActivityLoading: Story = {
  render: () => (
    <ActivityTab
      ctx={context({ name: "activity" })}
      services={{
        activity: fn(() => never<Awaited<ReturnType<ActivityServices["activity"]>>>()),
        pendingReports: fn(() => never<Awaited<ReturnType<ActivityServices["pendingReports"]>>>()),
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent("Loading activity");
  },
};

export const JarDetailLoading: Story = {
  render: () => (
    <JarDetail
      ctx={context({ name: "jar", jarId: jar.id })}
      services={{ jar: fn(() => never<Awaited<ReturnType<JarDetailServices["jar"]>>>()) }}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent("Loading jar");
  },
};

export const SettleLoading: Story = {
  render: () => (
    <Settle
      ctx={context({ name: "settle", jarId: jar.id })}
      services={{ jar: fn(() => never<Awaited<ReturnType<SettleServices["jar"]>>>()) }}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "Loading your balance",
    );
    await expect(within(canvasElement).queryByText("$0.00")).not.toBeInTheDocument();
  },
};

export const ConfirmDenyLoading: Story = {
  render: () => (
    <ConfirmDeny
      ctx={context({ name: "confirmDeny", reportId: report.id })}
      services={{
        pendingReports: fn(() =>
          never<Awaited<ReturnType<ConfirmDenyServices["pendingReports"]>>>(),
        ),
        resolveReport: fn(async () => report),
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent("Loading report");
    await expect(within(canvasElement).queryByText(/Nothing pending/)).not.toBeInTheDocument();
  },
};

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
    const failures = ["401", "403", "500", "offline"];
    let attempts = 0;
    const services: JarDetailServices = {
      jar: fn(async () => {
        const failure = failures[attempts];
        attempts += 1;
        if (failure) throw new Error(failure);
        return jar;
      }),
    };
    return <JarDetail ctx={context({ name: "jar", jarId: jar.id })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "This jar couldn’t be loaded.",
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
      if (attempt < 3) {
        await expect(await canvas.findByRole("alert")).toHaveTextContent(
          "This jar couldn’t be loaded.",
        );
      }
    }
    await expect(await canvas.findByText("Recovery jar")).toBeInTheDocument();
  },
};

export const SettleErrorAndRetry: Story = {
  render: () => {
    let attempts = 0;
    const services: SettleServices = {
      jar: fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return jar;
      }),
    };
    return <Settle ctx={context({ name: "settle", jarId: jar.id })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Your balance couldn’t be loaded.",
    );
    await expect(canvas.queryByText("$0.00")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(await canvas.findByText("$5.00")).toBeInTheDocument();
  },
};

export const SettleGenuineNotMemberEmpty: Story = {
  render: () => {
    const unavailable = JarDetailSchema.parse({
      ...jar,
      members: [
        {
          ...jar.members[0],
          user: { ...meUser, id: "usr_someoneelse", name: "Someone else" },
        },
      ],
    });
    return (
      <Settle
        ctx={context({ name: "settle", jarId: jar.id })}
        services={{ jar: fn(async () => unavailable) }}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "You aren’t a member of this jar.",
    );
    await expect(canvas.queryByText("$0.00")).not.toBeInTheDocument();
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
    await userEvent.click(await canvas.findByRole("button", { name: /Own it/ }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("couldn’t be updated");
    await expect(canvas.getByRole("button", { name: /Own it/ })).toBeEnabled();
  },
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { page } from "@vitest/browser/context";
import { expect, fn, waitFor, within } from "storybook/test";
import {
  ActivitySchema,
  JarDetailSchema,
  JarPreviewSchema,
  JarSummarySchema,
  MeSchema,
  ReportSchema,
  UserSchema,
} from "../../../../contracts";
import type { AppCtx, RouteFor } from "../appctx";
import { AboutTally as AboutTallyScreen } from "./AboutTally";
import { ActivityTab } from "./ActivityTab";
import { SetupProfile } from "./Auth";
import { ConfirmDeny as ConfirmDenyScreen } from "./ConfirmDeny";
import { Create } from "./Create";
import { Home as HomeScreen } from "./Home";
import { Invite as InviteScreen } from "./Invite";
import { JarDetail as JarDetailScreen } from "./JarDetail";
import { Join as JoinScreen } from "./Join";
import { LogSlip as LogSlipScreen } from "./LogSlip";
import { Onboarding as OnboardingScreen } from "./Onboarding";
import { Profile as ProfileScreen } from "./Profile";
import { ReportHistory as ReportHistoryScreen } from "./ReportHistory";
import { ReportMember as ReportMemberScreen } from "./ReportMember";

const alex = MeSchema.parse({
  id: "usr_p02alex",
  name: "Alex",
  color: "#5E5CE6",
  emoji: "🌱",
  photo: null,
  exes: ["Taylor"],
  phone: null,
});
const alexUser = UserSchema.parse({
  id: alex.id,
  name: alex.name,
  color: alex.color,
  emoji: alex.emoji,
  photo: alex.photo,
});
const sam = UserSchema.parse({
  id: "usr_p02sam",
  name: "Sam",
  color: "#FF375F",
  emoji: "🤝",
  photo: null,
});

const slip = ActivitySchema.parse({
  id: "act_p02slip",
  jarId: "jar_p02reset",
  jarName: "Recovery jar",
  reportId: null,
  type: "slip",
  user: alexUser,
  by: null,
  anonymous: false,
  amountCents: 500,
  exLabel: "Taylor",
  note: "Starting again today.",
  text: null,
  ago: "2 hours",
});
const milestone = ActivitySchema.parse({
  id: "act_p02milestone",
  jarId: "jar_p02reset",
  jarName: "Recovery jar",
  reportId: null,
  type: "milestone",
  user: null,
  by: null,
  anonymous: false,
  amountCents: null,
  note: null,
  text: "One week of supporting each other.",
  ago: "1 day",
});

const jar = JarDetailSchema.parse({
  id: "jar_p02reset",
  name: "Recovery jar",
  rule: "No contact. We’ve got each other.",
  defaultCents: 500,
  inviteCode: "RESET1",
  inviteExpiresAt: 2_524_608_000_000,
  jarTotalCents: 1500,
  members: [
    {
      user: alexUser,
      role: "owner",
      tallyCents: 500,
      daysClean: 4,
      shareStreak: true,
    },
    {
      user: sam,
      role: "member",
      tallyCents: 1000,
      daysClean: 2,
      shareStreak: true,
    },
  ],
  activity: [slip, milestone],
});
const summary = JarSummarySchema.parse({
  id: jar.id,
  name: jar.name,
  rule: jar.rule,
  defaultCents: jar.defaultCents,
  memberIds: jar.members.map((member) => member.user.id),
  memberCount: jar.members.length,
  jarTotalCents: jar.jarTotalCents,
  myTallyCents: 500,
  myDaysClean: 4,
  myShareStreak: true,
});
const preview = JarPreviewSchema.parse({
  id: jar.id,
  name: jar.name,
  rule: jar.rule,
  defaultCents: jar.defaultCents,
  members: jar.members.map((member) => member.user),
  memberCount: jar.members.length,
});
const pending = ReportSchema.parse({
  id: "rpt_p02pending",
  jarId: jar.id,
  jarName: jar.name,
  accuser: null,
  accused: alexUser,
  note: "I saw a message come through. Please review when you’re ready.",
  anonymous: true,
  amountCents: 500,
  status: "pending",
  ago: "10 minutes",
  evidence: [],
});
const accepted = ReportSchema.parse({
  ...pending,
  id: "rpt_p02accepted",
  accuser: sam,
  anonymous: false,
  note: "Shared context, reviewed together.",
  status: "owned",
  ago: "2 hours",
});
const denied = ReportSchema.parse({
  ...accepted,
  id: "rpt_p02denied",
  note: "Closed without changing the tally.",
  status: "denied",
  ago: "1 day",
});

type P02Route = RouteFor<
  | "setup"
  | "onboarding"
  | "create"
  | "home"
  | "invite"
  | "join"
  | "jar"
  | "activity"
  | "logSlip"
  | "aboutTally"
  | "report"
  | "confirmDeny"
  | "reportHistory"
  | "profile"
>;

function context<Route extends P02Route>(
  route: Route,
  me: typeof alex | null = alex,
): AppCtx<Route> {
  return {
    me,
    setMe: fn(),
    route,
    nav: fn(),
    back: fn(),
    tab: fn(),
    signIn: fn(),
    signOut: fn(async () => undefined),
    deleteAccount: fn(async () => undefined),
    sessionExpired: false,
    fireBurst: fn(),
    hasPendingReport: false,
    refreshPending: fn(),
  };
}

const meta = {
  title: "Don't Text Your Ex/P02/Changed screens",
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "centered" },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 390,
          height: 844,
          overflow: "auto",
          background: "#000",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

async function capture(screen: string): Promise<void> {
  if (import.meta.env.VITE_DTYE_P02_CAPTURE !== "1") return;
  await page.screenshot({
    path: `../../../../../../docs/evidence/dont-text-your-ex/p02/changed-screens/${screen}.png`,
  });
}

export const Auth: Story = {
  render: () => <SetupProfile ctx={context({ name: "setup" })} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Make it yours" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Start your reset →" })).toBeEnabled();
    await capture("auth-setup-profile");
  },
};

export const Onboarding: Story = {
  render: () => <OnboardingScreen ctx={context({ name: "onboarding" }, null)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/does not read your messages/)).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Sign in with Apple" })).toBeEnabled();
    await capture("onboarding");
  },
};

export const CreateJar: Story = {
  render: () => (
    <Create ctx={context({ name: "create" })} services={{ createJar: fn(async () => summary) }} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/No real money is charged/)).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Create jar & invite friends" }),
    ).toBeDisabled();
    await capture("create-jar");
  },
};

export const Home: Story = {
  render: () => (
    <HomeScreen
      ctx={context({ name: "home" })}
      services={{ jars: fn(async () => [summary]), jar: fn(async () => jar) }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Recovery jar")).toBeVisible();
    await expect(canvas.getByTestId("total-tally")).toHaveTextContent("5 pts");
    await expect(canvas.getByText(/No real money is charged/)).toBeVisible();
    await capture("home");
  },
};

export const Invite: Story = {
  render: () => (
    <InviteScreen
      ctx={context({ name: "invite", jarId: jar.id, fresh: true })}
      services={{ jar: fn(async () => jar), rotateInvite: fn(async () => jar) }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("RESET1")).toBeVisible();
    await expect(canvas.getByText(/invite the friends who’ll have your back/)).toBeVisible();
    await capture("invite");
  },
};

export const Join: Story = {
  render: () => (
    <JoinScreen
      ctx={context({ name: "join", code: jar.inviteCode ?? undefined })}
      services={{
        jarByCode: fn(async () => preview),
        joinJar: fn(async () => ({ jarId: jar.id })),
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Join this jar" })).toBeEnabled();
    await expect(canvas.getByText(/activity with these members/)).toBeVisible();
    await capture("join");
  },
};

export const JarDetail: Story = {
  render: () => (
    <JarDetailScreen
      ctx={context({ name: "jar", jarId: jar.id })}
      services={{
        jar: fn(async () => jar),
        closeJar: fn(async () => jar),
        leaveJar: fn(async () => ({ ok: true as const })),
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("PROGRESS BOARD")).toBeVisible();
    await waitFor(() => expect(canvas.getByTestId("jar-total-tally")).toHaveTextContent("15 pts"));
    await expect(canvas.getByText(/No real money is charged/)).toBeVisible();
    await capture("jar-detail");
  },
};

export const Activity: Story = {
  render: () => (
    <ActivityTab
      ctx={context({ name: "activity" })}
      services={{
        activity: fn(async () => [slip, milestone]),
        pendingReports: fn(async () => [pending]),
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("You have an accountability check")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "View check history" })).toBeEnabled();
    await capture("activity");
  },
};

export const LogSlip: Story = {
  render: () => (
    <LogSlipScreen
      ctx={context({ name: "logSlip", jarId: jar.id })}
      services={{ jar: fn(async () => jar), logSlip: fn(async () => jar) }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", {
        name: "Add 5 pts to my virtual tally",
      }),
    ).toBeEnabled();
    await expect(canvas.getByText(/optional — visible to jar members/)).toBeVisible();
    await capture("log-slip");
  },
};

export const AboutTally: Story = {
  render: () => (
    <AboutTallyScreen
      ctx={context({ name: "aboutTally", jarId: jar.id })}
      services={{ jar: fn(async () => jar) }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("YOUR VIRTUAL TALLY")).toBeVisible();
    await expect(canvas.getByText(/No real money is charged/)).toBeVisible();
    await capture("about-tally");
  },
};

export const ReportMember: Story = {
  render: () => (
    <ReportMemberScreen
      ctx={context({ name: "report", jarId: jar.id })}
      services={{
        jar: fn(async () => jar),
        createReport: fn(async () => pending),
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Sam" })).toBeEnabled();
    await expect(canvas.getByText("Hide my name from jar members")).toBeVisible();
    await expect(canvas.getByText(/retain who sent it for safety/)).toBeVisible();
    await capture("accountability-check");
  },
};

export const ConfirmDeny: Story = {
  render: () => (
    <ConfirmDenyScreen
      ctx={context({ name: "confirmDeny", reportId: pending.id })}
      services={{
        pendingReports: fn(async () => [pending]),
        resolveReport: fn(async () => pending),
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/sent you an accountability check/)).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Accept and add 5 pts" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Deny this check" })).toBeEnabled();
    await capture("confirm-deny");
  },
};

export const ReportHistory: Story = {
  render: () => (
    <ReportHistoryScreen
      ctx={context({ name: "reportHistory" })}
      services={{ reportHistory: fn(async () => [accepted, denied]) }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Accepted")).toBeVisible();
    await expect(canvas.getByText("Denied")).toBeVisible();
    await capture("check-history");
  },
};

export const Profile: Story = {
  render: () => (
    <ProfileScreen
      ctx={context({ name: "profile" })}
      services={{
        jars: fn(async () => [summary]),
        setShareStreak: fn(async () => ({ ok: true as const })),
        getNativeAppInfo: fn(async () => null),
        isNativePlatform: fn(() => false),
        createAppleSignInAttempt: fn(),
        authorizeAppleSignIn: fn(),
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/days no-contact/)).toBeVisible();
    await expect(canvas.getByText(/No real money is charged/)).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Sign out" })).toBeEnabled();
    await capture("profile");
  },
};

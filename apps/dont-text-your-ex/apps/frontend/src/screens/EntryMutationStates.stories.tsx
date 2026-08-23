import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  JarDetailSchema,
  JarPreviewSchema,
  JarSummarySchema,
  MeSchema,
  UserSchema,
} from "../../../../contracts";
import type { AppCtx, RouteFor } from "../appctx";
import { Create, type CreateServices } from "./Create";
import { Invite, type InviteServices } from "./Invite";
import { Join, type JoinServices } from "./Join";
import { LogSlip, type LogSlipServices } from "./LogSlip";

const me = MeSchema.parse({
  id: "usr_entryqa",
  name: "Alex",
  color: "#5E5CE6",
  emoji: null,
  photo: null,
  exes: ["Taylor"],
  phone: null,
});
const meUser = UserSchema.parse({
  id: me.id,
  name: me.name,
  color: me.color,
  emoji: me.emoji,
  photo: me.photo,
});
const jar = JarDetailSchema.parse({
  id: "jar_entryqa",
  name: "Recovery jar",
  rule: "No contact.",
  defaultCents: 500,
  inviteCode: "TRY123",
  inviteExpiresAt: Date.now() + 7 * 86_400_000,
  jarTotalCents: 500,
  members: [{ user: meUser, role: "owner", tallyCents: 500, daysClean: 4, shareStreak: true }],
  activity: [],
});
const summary = JarSummarySchema.parse({
  id: jar.id,
  name: jar.name,
  rule: jar.rule,
  defaultCents: jar.defaultCents,
  memberIds: [me.id],
  memberCount: 1,
  jarTotalCents: 0,
  myTallyCents: 0,
  myDaysClean: -1,
  myShareStreak: false,
});
const preview = JarPreviewSchema.parse({
  id: jar.id,
  name: jar.name,
  rule: jar.rule,
  defaultCents: jar.defaultCents,
  members: [meUser],
  memberCount: 1,
});

function context<Name extends RouteFor<"create" | "invite" | "join" | "logSlip">["name"]>(
  route: RouteFor<Name>,
): AppCtx<RouteFor<Name>> {
  return {
    me,
    setMe: fn(),
    route,
    nav: fn(),
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
  title: "Don't Text Your Ex/Flows/Entry and mutation recovery",
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

export const CreateOfflineRetryAndDuplicateGuard: Story = {
  render: () => {
    let attempts = 0;
    const services: CreateServices = {
      createJar: fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error("offline");
        }
        return summary;
      }),
    };
    return <Create ctx={context({ name: "create" })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByPlaceholderText("“The Group Chat”"), "Retry jar");
    const submit = canvas.getByRole("button", { name: "Create jar & invite friends" });
    await userEvent.dblClick(submit);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("couldn’t be created");
    await userEvent.click(canvas.getByRole("button", { name: "Retry creating jar" }));
    await expect(canvas.getByRole("button", { name: "Creating jar…" })).toBeDisabled();
  },
};

export const InviteFetchErrorAndRetry: Story = {
  render: () => {
    let attempts = 0;
    const services: InviteServices = {
      jar: fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return jar;
      }),
      rotateInvite: fn(async () => jar),
    };
    return <Invite ctx={context({ name: "invite", jarId: jar.id })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("couldn’t be loaded");
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(await canvas.findByText("TRY123")).toBeInTheDocument();
  },
};

export const InviteLoading: Story = {
  render: () => {
    const services: InviteServices = {
      jar: fn(() => new Promise<never>(() => {})),
      rotateInvite: fn(async () => jar),
    };
    return <Invite ctx={context({ name: "invite", jarId: jar.id })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent("Loading invite…");
    await expect(canvas.queryByText("TRY123")).not.toBeInTheDocument();
  },
};

export const InviteMissingExpiryCannotBeShared: Story = {
  render: () => {
    const unverifiable = JarDetailSchema.parse({
      ...jar,
      inviteExpiresAt: null,
    });
    const services: InviteServices = {
      jar: fn(async () => unverifiable),
      rotateInvite: fn(async () => jar),
    };
    return <Invite ctx={context({ name: "invite", jarId: jar.id })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Expiry unavailable")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Share invite" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Done" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Replace invite" })).toBeEnabled();
    await expect(canvas.getByText(/can’t be verified/)).toBeInTheDocument();
  },
};

export const InviteOwnerReplacesExpiredLinkAfterRetry: Story = {
  render: () => {
    let attempts = 0;
    const expired = JarDetailSchema.parse({
      ...jar,
      inviteExpiresAt: Date.now() - 1,
    });
    const services: InviteServices = {
      jar: fn(async () => expired),
      rotateInvite: fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return JarDetailSchema.parse({
          ...jar,
          inviteCode: "NEW123",
          inviteExpiresAt: Date.now() + 7 * 86_400_000,
        });
      }),
    };
    return <Invite ctx={context({ name: "invite", jarId: jar.id })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("TRY123")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Share invite" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: "Replace invite" }));
    await expect(canvas.getByRole("alert")).toHaveTextContent("stop working immediately");
    await userEvent.click(canvas.getByRole("button", { name: "Replace invite now" }));
    await expect(await canvas.findByText(/current code still works/)).toBeInTheDocument();
    await expect(canvas.getByText("TRY123")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Retry replacing invite" }));
    await expect(await canvas.findByText("NEW123")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Share invite" })).toBeEnabled();
  },
};

export const InviteMemberCanShareButCannotReplace: Story = {
  render: () => {
    const memberJar = JarDetailSchema.parse({
      ...jar,
      members: [{ ...jar.members[0], role: "member" }],
    });
    const services: InviteServices = {
      jar: fn(async () => memberJar),
      rotateInvite: fn(async () => memberJar),
    };
    return <Invite ctx={context({ name: "invite", jarId: jar.id })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Share invite" })).toBeEnabled();
    await expect(canvas.queryByRole("button", { name: "Replace invite" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("status")).toHaveTextContent("Expires");
    await userEvent.click(canvas.getByRole("button", { name: /TRY123.*Tap to copy code/ }));
    await expect(canvas.getByText("Copied to clipboard")).toBeInTheDocument();
  },
};

export const JoinValidationPreviewAndSubmitRetry: Story = {
  render: () => {
    let previewAttempts = 0;
    let joinAttempts = 0;
    const services: JoinServices = {
      jarByCode: fn(async () => {
        previewAttempts += 1;
        if (previewAttempts === 1) throw new Error("offline");
        return preview;
      }),
      joinJar: fn(async () => {
        joinAttempts += 1;
        if (joinAttempts === 1) throw new Error("offline");
        return { jarId: jar.id };
      }),
    };
    return <Join ctx={context({ name: "join" })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText(/try XEX24K/i)).not.toBeInTheDocument();
    const input = canvas.getByPlaceholderText("Invite code");
    await userEvent.type(input, "BAD!");
    await userEvent.click(canvas.getByRole("button", { name: "Preview jar" }));
    await expect(canvas.getByRole("alert")).toHaveTextContent("full six-letter");
    await userEvent.clear(input);
    await userEvent.type(input, "TRY123");
    await userEvent.click(canvas.getByRole("button", { name: "Preview jar" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("couldn’t be loaded");
    await userEvent.click(canvas.getByRole("button", { name: "Retry invite" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Join this jar" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("couldn’t be joined");
    await userEvent.click(canvas.getByRole("button", { name: "Retry joining jar" }));
  },
};

export const LogSlipFetchAndSubmitRetry: Story = {
  render: () => {
    let fetchAttempts = 0;
    let submitAttempts = 0;
    const services: LogSlipServices = {
      jar: fn(async () => {
        fetchAttempts += 1;
        if (fetchAttempts === 1) throw new Error("offline");
        return jar;
      }),
      logSlip: fn(async () => {
        submitAttempts += 1;
        if (submitAttempts === 1) throw new Error("offline");
        return jar;
      }),
    };
    return <LogSlip ctx={context({ name: "logSlip", jarId: jar.id })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("couldn’t be loaded");
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await userEvent.click(
      await canvas.findByRole("button", { name: /Add .* pts to my virtual tally/ }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Confirm and reset streak" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("wasn’t logged");
    await userEvent.click(canvas.getByRole("button", { name: "Retry logging slip" }));
  },
};

export const LogSlipForm: Story = {
  render: () => {
    const services: LogSlipServices = {
      jar: fn(async () => jar),
      logSlip: fn(async () => jar),
    };
    return <LogSlip ctx={context({ name: "logSlip", jarId: jar.id })} services={services} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: /Add .* pts to my virtual tally/ }),
    ).toBeEnabled();
  },
};

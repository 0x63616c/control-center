import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { JarDetailSchema, MeSchema, ReportSchema, UserSchema } from "../../../../contracts";
import type { AppCtx, RouteFor } from "../appctx";
import { ReportMember, type ReportServices } from "./ReportMember";

const me = MeSchema.parse({
  id: "usr_storyme",
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
});

const accused = UserSchema.parse({
  id: "usr_storyaccused",
  name: "Sam",
  color: "#FF375F",
  emoji: "🙈",
  photo: null,
});

const former = UserSchema.parse({
  id: "usr_storyformer",
  name: "Former Member",
  color: "#8E8E93",
  emoji: null,
  photo: null,
});

const jar = JarDetailSchema.parse({
  id: "jar_story",
  name: "The Group Chat",
  rule: "No contact means no contact.",
  defaultCents: 500,
  inviteCode: "STORY1",
  jarTotalCents: 1500,
  members: [
    { user: meUser, role: "owner", tallyCents: 500, daysClean: 3, shareStreak: true },
    { user: accused, role: "member", tallyCents: 1000, daysClean: 1, shareStreak: true },
  ],
  activity: [],
});

const submittedReport = ReportSchema.parse({
  id: "rpt_story",
  jarId: jar.id,
  jarName: jar.name,
  accuser: meUser,
  accused,
  note: "Saw the reply land in real time.",
  anonymous: true,
  amountCents: jar.defaultCents,
  status: "pending",
  ago: "now",
  evidence: [],
});

const createReport = fn(async () => submittedReport);
const services: ReportServices = {
  jar: fn(async () => jar),
  createReport,
};

const ctx: AppCtx<RouteFor<"report">> = {
  me,
  setMe: fn(),
  route: { name: "report", jarId: jar.id },
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

const meta = {
  title: "Don't Text Your Ex/Flows/Accountability check",
  component: ReportMember,
  tags: ["autodocs"],
  parameters: { boardWrapper: false, layout: "centered" },
  decorators: [
    (Story) => (
      <div style={{ width: 390, height: 844, overflow: "auto", background: "#000" }}>
        <Story />
      </div>
    ),
  ],
  args: { ctx, services },
} satisfies Meta<typeof ReportMember>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoteOnlySubmission: Story = {
  play: async ({ canvasElement }) => {
    createReport.mockClear();
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Add screenshots" })).toBeEnabled();
    await expect(canvas.queryByText("Camera roll")).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: accused.name }));
    await userEvent.type(
      canvas.getByPlaceholderText("“I saw a message come through…”"),
      submittedReport.note ?? "",
    );
    await userEvent.click(within(canvas.getByTestId("anon-row")).getByRole("switch"));
    await userEvent.click(canvas.getByRole("button", { name: "Send check anonymously" }));

    await expect(await canvas.findByText("Check sent")).toBeInTheDocument();
    await expect(services.createReport).toHaveBeenCalledWith(jar.id, {
      accusedId: accused.id,
      note: submittedReport.note,
      anonymous: true,
      amountCents: jar.defaultCents,
      evidence: [],
    });
  },
};

export const ImageOnlySubmission: Story = {
  play: async ({ canvasElement }) => {
    createReport.mockClear();
    const canvas = within(canvasElement);
    const payload =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
    const screenshot = new File([bytes], "receipt.png", { type: "image/png" });

    await userEvent.upload(canvas.getByTestId("evidence-input"), screenshot);
    await expect(
      await canvas.findByRole("img", { name: "Accountability check attachment" }),
    ).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: accused.name }));
    await userEvent.click(canvas.getByRole("button", { name: "Send accountability check" }));

    await expect(await canvas.findByText("Check sent")).toBeInTheDocument();
    await expect(createReport).toHaveBeenCalledWith(jar.id, {
      accusedId: accused.id,
      note: undefined,
      anonymous: false,
      amountCents: jar.defaultCents,
      evidence: [{ mimeType: "image/png", dataUrl: `data:image/png;base64,${payload}` }],
    });
  },
};

export const FetchAndSubmitFailureRetryWithoutFalseSuccess: Story = {
  render: () => {
    let fetchAttempts = 0;
    let submitAttempts = 0;
    const jarWithFormerMember = JarDetailSchema.parse({
      ...jar,
      members: [
        ...jar.members,
        { user: former, role: "member", tallyCents: 0, shareStreak: false, active: false },
      ],
    });
    const retryServices: ReportServices = {
      jar: fn(async () => {
        fetchAttempts += 1;
        if (fetchAttempts === 1) throw new Error("offline");
        return jarWithFormerMember;
      }),
      createReport: fn(async () => {
        submitAttempts += 1;
        if (submitAttempts === 1) throw new Error("server unavailable");
        await new Promise((resolve) => setTimeout(resolve, 50));
        return submittedReport;
      }),
    };
    return <ReportMember ctx={ctx} services={retryServices} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("couldn’t be loaded");
    await expect(canvas.queryByText("Check sent")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(canvas.queryByRole("button", { name: former.name })).not.toBeInTheDocument();
    await userEvent.type(
      await canvas.findByPlaceholderText("“I saw a message come through…”"),
      "Visible failure proof",
    );
    const payload =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const screenshot = new File(
      [Uint8Array.from(atob(payload), (character) => character.charCodeAt(0))],
      "retry-receipt.png",
      { type: "image/png" },
    );
    await userEvent.upload(canvas.getByTestId("evidence-input"), screenshot);
    await userEvent.click(within(canvas.getByTestId("anon-row")).getByRole("switch"));
    await userEvent.click(canvas.getByRole("button", { name: "Send check anonymously" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("wasn’t sent");
    await expect(canvas.queryByText("Check sent")).not.toBeInTheDocument();
    await expect(canvas.getByPlaceholderText("“I saw a message come through…”")).toHaveValue(
      "Visible failure proof",
    );
    await expect(
      canvas.getByRole("img", { name: "Accountability check attachment" }),
    ).toBeVisible();
    await expect(within(canvas.getByTestId("anon-row")).getByRole("switch")).toBeChecked();
    await userEvent.click(canvas.getByRole("button", { name: "Retry sending check" }));
    await expect(canvas.getByPlaceholderText("“I saw a message come through…”")).toBeDisabled();
    await expect(within(canvas.getByTestId("anon-row")).getByRole("switch")).toBeDisabled();
    await expect(canvas.getByRole("button", { name: accused.name })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Remove attachment 1" })).toBeDisabled();
    await expect(canvas.queryByText("Check sent")).not.toBeInTheDocument();
    await expect(await canvas.findByText("Check sent")).toBeInTheDocument();
    await expect(canvas.getByText(/name is hidden from jar members/)).toBeVisible();
  },
};

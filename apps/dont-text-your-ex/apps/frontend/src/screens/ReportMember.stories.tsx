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
  exes: me.exes,
});

const accused = UserSchema.parse({
  id: "usr_storyaccused",
  name: "Sam",
  color: "#FF375F",
  emoji: "🙈",
  photo: null,
  exes: [],
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
  sessionExpired: false,
  fireBurst: fn(),
  hasPendingReport: false,
  refreshPending: fn(),
};

const meta = {
  title: "Don't Text Your Ex/Flows/Report member",
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
      canvas.getByPlaceholderText("“replied to her story in 4 seconds flat…”"),
      submittedReport.note ?? "",
    );
    await userEvent.click(within(canvas.getByTestId("anon-row")).getByRole("button"));
    await userEvent.click(canvas.getByRole("button", { name: "Send it anonymously" }));

    await expect(await canvas.findByText("Snitched.")).toBeInTheDocument();
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
    await expect(await canvas.findByRole("img", { name: "Report attachment" })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: accused.name }));
    await userEvent.click(canvas.getByRole("button", { name: "Send the report" }));

    await expect(await canvas.findByText("Snitched.")).toBeInTheDocument();
    await expect(createReport).toHaveBeenCalledWith(jar.id, {
      accusedId: accused.id,
      note: undefined,
      anonymous: false,
      amountCents: jar.defaultCents,
      evidence: [{ mimeType: "image/png", dataUrl: `data:image/png;base64,${payload}` }],
    });
  },
};

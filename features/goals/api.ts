import { defineApi } from "@app-kit";
import { getSettings, publicProcedure, router } from "@app-kit/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { db } from "./db";
import {
  addVacation,
  createGoal,
  dashboard,
  deleteGoal,
  deleteVacation,
  saveCheckin,
  setGoalStatus,
  updateGoal,
} from "./service";

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD goal-day");
const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily") }),
  z.object({
    kind: z.literal("weekdays"),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1),
  }),
  z.object({ kind: z.literal("weekly"), weeklyTarget: z.number().int().min(1).max(7) }),
]);
const goalInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    encouragement: z.string().trim().max(240).nullable().optional(),
    kind: z.enum(["simple", "measured", "reflective"]),
    target: z.number().int().positive().nullable().optional(),
    reflectivePrompts: z.array(z.string().trim().min(1).max(120)).max(8).nullable().optional(),
    schedule: scheduleSchema,
    effectiveFrom: daySchema,
  })
  .superRefine((value, ctx) => {
    if (value.kind === "measured" && !value.target)
      ctx.addIssue({ code: "custom", path: ["target"], message: "measured goals need a target" });
  });

const goalsRouter = router({
  dashboard: publicProcedure
    .input(
      z
        .object({
          endDay: daySchema.optional(),
          days: z.number().int().min(1).max(93).optional(),
          includeArchived: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const settings = await getSettings(ctx.db);
      return dashboard(db, {
        now: new Date(),
        timeZone: settings.timeZone,
        cutoffHour: settings.goalDayCutoffHour,
        ...input,
      });
    }),
  create: publicProcedure
    .input(goalInput)
    .mutation(async ({ input }) => ({ id: await createGoal(db, input) })),
  update: publicProcedure
    .input(goalInput.and(z.object({ id: z.string().startsWith("goal_") })))
    .mutation(async ({ input }) => {
      const { id, ...fields } = input;
      if (!(await updateGoal(db, id, fields))) throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
      return { id };
    }),
  setStatus: publicProcedure
    .input(
      z.object({
        id: z.string().startsWith("goal_"),
        status: z.enum(["active", "paused", "archived"]),
      }),
    )
    .mutation(async ({ input }) => {
      if (!(await setGoalStatus(db, input.id, input.status))) throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
      return { id: input.id };
    }),
  delete: publicProcedure
    .input(z.object({ id: z.string().startsWith("goal_") }))
    .mutation(async ({ input }) => {
      if (!(await deleteGoal(db, input.id))) throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
      return input;
    }),
  checkIn: publicProcedure
    .input(
      z.object({
        goalId: z.string().startsWith("goal_"),
        day: daySchema,
        state: z.enum(["complete", "partial", "not_today"]),
        value: z.number().int().nonnegative().nullable().optional(),
        reflection: z.string().trim().max(1000).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await saveCheckin(db, input);
      return { goalId: input.goalId, day: input.day };
    }),
  addVacation: publicProcedure
    .input(
      z
        .object({ startDay: daySchema, endDay: daySchema })
        .refine((value) => value.startDay <= value.endDay, {
          message: "end must be on or after start",
          path: ["endDay"],
        }),
    )
    .mutation(async ({ input }) => {
      await addVacation(db, input.startDay, input.endDay);
      return { startDay: input.startDay, endDay: input.endDay };
    }),
  deleteVacation: publicProcedure
    .input(z.object({ id: z.string().startsWith("goal_vacation_") }))
    .mutation(async ({ input }) => {
      await deleteVacation(db, input.id);
      return input;
    }),
});

export const api = defineApi(router({ goals: goalsRouter }));

import { defineApi } from "@app-kit";
import { publicProcedure, router } from "@app-kit/server";
import { TRPCError } from "@trpc/server";
import { getLogger } from "@www/logger";
import { genId } from "@www/platform";
import { and, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db";
import { courseInput, DEFAULTS, dateInput, settingsInput, usedVolume } from "./model";
import {
  actualInjection,
  injectionCheckIn,
  injectionCourse,
  injectionPhoto,
  injectionSettings,
  injectionVial,
} from "./schema";

const idInput = z
  .string()
  .regex(/^[a-z]+_[a-zA-Z0-9-]+$/)
  .max(100);
const note = z.string().max(10000);
const positive = z.number().finite().positive().max(10000);
const vialInput = z.object({
  id: idInput.optional(),
  courseId: idInput,
  label: z.string().trim().min(1).max(100),
  volume: positive,
  concentration: positive,
  syringeScale: positive,
  receivedDate: dateInput.nullable(),
  openedDate: dateInput.nullable(),
  discardDate: dateInput.nullable(),
  retired: z.boolean(),
});
const injectionInput = z.object({
  id: idInput.optional(),
  courseId: idInput,
  vialId: idInput,
  at: z.iso.datetime({ offset: true }),
  units: positive,
  notes: note,
  plannedAt: z.iso.datetime({ offset: true }).nullable(),
});
const fail = (message: string): never => {
  throw new TRPCError({ code: "BAD_REQUEST", message });
};
async function courseExists(id: string) {
  const [row] = await db.select().from(injectionCourse).where(eq(injectionCourse.id, id));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
  return row;
}
export const api = defineApi(
  router({
    injections: router({
      list: publicProcedure.query(async () => {
        const [courses, settings] = await Promise.all([
          db.select().from(injectionCourse).orderBy(injectionCourse.createdAt),
          db.select().from(injectionSettings).where(eq(injectionSettings.id, "default")),
        ]);
        return {
          courses: courses.map((c) => ({ ...c.config, id: c.id })),
          settings: settings[0]?.config ?? DEFAULTS,
        };
      }),
      detail: publicProcedure.input(z.object({ courseId: idInput })).query(async ({ input }) => {
        const c = await courseExists(input.courseId);
        const [vials, injections, checkIns, photos] = await Promise.all([
          db.select().from(injectionVial).where(eq(injectionVial.courseId, c.id)),
          db
            .select()
            .from(actualInjection)
            .where(and(eq(actualInjection.courseId, c.id), isNull(actualInjection.deletedAt)))
            .orderBy(actualInjection.at),
          db.select().from(injectionCheckIn).where(eq(injectionCheckIn.courseId, c.id)),
          db
            .select()
            .from(injectionPhoto)
            .where(and(eq(injectionPhoto.courseId, c.id), isNull(injectionPhoto.deletedAt)))
            .orderBy(injectionPhoto.at),
        ]);
        return { course: { ...c.config, id: c.id }, vials, injections, checkIns, photos };
      }),
      saveCourse: publicProcedure
        .input(z.object({ id: idInput.optional(), config: courseInput }))
        .mutation(async ({ input }) => {
          const id = input.id ?? genId("icr");
          if (input.id) {
            await courseExists(id);
            await db
              .update(injectionCourse)
              .set({ config: input.config, updatedAt: new Date() })
              .where(eq(injectionCourse.id, id));
          } else
            await db.transaction(async (tx) => {
              await tx.insert(injectionCourse).values({ id, config: input.config });
              await tx.insert(injectionVial).values({
                id: genId("ivl"),
                courseId: id,
                label: "Vial 1",
                volume: input.config.vialVolume,
                concentration: input.config.concentration,
                syringeScale: input.config.syringeScale,
              });
            });
          getLogger().info({ id }, "injection course saved");
          return { id };
        }),
      saveSettings: publicProcedure.input(settingsInput).mutation(async ({ input }) => {
        await db
          .insert(injectionSettings)
          .values({ id: "default", config: input })
          .onConflictDoUpdate({ target: injectionSettings.id, set: { config: input } });
        return { ok: true };
      }),
      saveVial: publicProcedure.input(vialInput).mutation(async ({ input }) => {
        await courseExists(input.courseId);
        const id = input.id ?? genId("ivl");
        await db.transaction(async (tx) => {
          if (input.id) {
            const [old] = await tx
              .select()
              .from(injectionVial)
              .where(and(eq(injectionVial.id, id), eq(injectionVial.courseId, input.courseId)))
              .for("update");
            if (!old) fail("Vial not found");
            const draws = await tx
              .select()
              .from(actualInjection)
              .where(and(eq(actualInjection.vialId, id), isNull(actualInjection.deletedAt)));
            if (
              draws.length &&
              (old.concentration !== input.concentration || old.syringeScale !== input.syringeScale)
            )
              fail(
                "Concentration and syringe scale are fixed after an injection. Add a new vial for a different formulation.",
              );
            if (usedVolume({ ...input, id }, draws) > input.volume + 1e-9)
              fail("Vial volume is less than recorded usage");
            await tx
              .update(injectionVial)
              .set({ ...input, id })
              .where(eq(injectionVial.id, id));
          } else await tx.insert(injectionVial).values({ ...input, id });
        });
        return { id };
      }),
      saveInjection: publicProcedure.input(injectionInput).mutation(async ({ input }) => {
        const c = await courseExists(input.courseId);
        if (c.config.status === "scenario")
          fail("Scenarios contain planned events only. Create a real course to log injections.");
        if (Date.parse(input.at) > Date.now() + 60_000)
          fail("Actual injections cannot be in the future");
        const id = input.id ?? genId("inj");
        await db.transaction(async (tx) => {
          // Serialize all draws/edits in the course, then lock the vial shared with vial edits.
          await tx
            .select()
            .from(injectionCourse)
            .where(eq(injectionCourse.id, input.courseId))
            .for("update");
          if (input.id) {
            const [old] = await tx
              .select()
              .from(actualInjection)
              .where(
                and(
                  eq(actualInjection.id, id),
                  eq(actualInjection.courseId, input.courseId),
                  isNull(actualInjection.deletedAt),
                ),
              );
            if (!old) fail("Injection not found");
          }
          const [vial] = await tx
            .select()
            .from(injectionVial)
            .where(
              and(eq(injectionVial.id, input.vialId), eq(injectionVial.courseId, input.courseId)),
            )
            .for("update");
          if (!vial) fail("Vial does not belong to this course");
          const draws = await tx
            .select()
            .from(actualInjection)
            .where(
              and(
                eq(actualInjection.vialId, vial.id),
                isNull(actualInjection.deletedAt),
                ne(actualInjection.id, id),
              ),
            );
          if (usedVolume(vial, draws) + input.units / vial.syringeScale > vial.volume + 1e-9)
            fail("Recorded draws would exceed this vial's supplied volume");
          if (input.id)
            await tx
              .update(actualInjection)
              .set({ ...input, id, updatedAt: new Date() })
              .where(eq(actualInjection.id, id));
          else await tx.insert(actualInjection).values({ ...input, id });
        });
        getLogger().info({ id, courseId: input.courseId }, "injection saved");
        return { id };
      }),
      deleteInjection: publicProcedure
        .input(z.object({ id: idInput, courseId: idInput }))
        .mutation(async ({ input }) => {
          await db
            .update(actualInjection)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(
              and(eq(actualInjection.id, input.id), eq(actualInjection.courseId, input.courseId)),
            );
          getLogger().info({ id: input.id }, "injection removed");
          return { ok: true };
        }),
      saveCheckIn: publicProcedure
        .input(
          z.object({
            courseId: idInput,
            date: dateInput,
            values: z
              .record(z.string().min(1).max(40), z.number().int().min(0).max(4))
              .refine((v) => Object.keys(v).length <= 20),
            notes: note,
            weightId: z.string().max(100).nullable(),
          }),
        )
        .mutation(async ({ input }) => {
          await courseExists(input.courseId);
          await db
            .insert(injectionCheckIn)
            .values({ id: genId("ici"), ...input })
            .onConflictDoUpdate({
              target: [injectionCheckIn.courseId, injectionCheckIn.date],
              set: input,
            });
          return { ok: true };
        }),
      photoReference: publicProcedure
        .input(z.object({ id: idInput, courseId: idInput, reference: z.boolean() }))
        .mutation(async ({ input }) => {
          await db
            .update(injectionPhoto)
            .set({ reference: input.reference })
            .where(
              and(
                eq(injectionPhoto.id, input.id),
                eq(injectionPhoto.courseId, input.courseId),
                isNull(injectionPhoto.deletedAt),
              ),
            );
          return { ok: true };
        }),
      deletePhoto: publicProcedure
        .input(z.object({ id: idInput, courseId: idInput }))
        .mutation(async ({ input }) => {
          await db
            .update(injectionPhoto)
            .set({ deletedAt: new Date() })
            .where(
              and(eq(injectionPhoto.id, input.id), eq(injectionPhoto.courseId, input.courseId)),
            );
          return { ok: true };
        }),
    }),
  }),
);

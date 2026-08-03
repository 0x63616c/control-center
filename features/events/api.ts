/**
 * tRPC `events` facet (Track C fold), folded from
 * apps/api/src/trpc/routers/events.ts. The feature reaches the tRPC runtime
 * ONLY through `@app-kit/server` (the single sanctioned seam into apps/api's
 * trpc/init — never a direct apps/api import); its query bodies live in
 * ./service against this feature's own db.
 *
 * The two zod schemas (`EventSelectSchema` / `EventInputSchema`) are moved
 * verbatim from apps/api/src/db/zod-schemas.ts (that file was events-only)
 * and EXPORTED here: the moved test (./api.test.ts) imports
 * `EventSelectSchema` and calls `.parse()` on it directly.
 */
import { defineApi } from "@app-kit";
import { getSettings, publicProcedure, router } from "@app-kit/server";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { db } from "./db";
import { events } from "./schema";
import { createEvent, deleteEvent, listEvents, updateEvent } from "./service";

// events.list output: name + place from the table; date is serialised to an
// ISO string by the service layer (DB column is timestamptz); days is computed
// (calendar days until the event in America/Los_Angeles).
export const EventSelectSchema = createSelectSchema(events, {
  // Override: the service converts the DB Date to an ISO string before
  // returning so the router output carries a string, not a native Date.
  date: z.string(),
})
  // `id` is surfaced so the manage UI can target edit/delete on a specific row.
  .pick({ id: true, name: true, place: true, date: true })
  // `days` is signed: negative for an event already past (only the manage
  // surface asks for those), 0 for today.
  .extend({ days: z.number().int() });

// events.create / events.update input: the writable fields. `name` and `date`
// are required; `place` is the optional location/venue (defaults to "" when the
// user leaves it blank). `date` is an ISO-8601 string the service parses to a Date.
const EventInputSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  place: z.string().trim().default(""),
  date: z.string().datetime({ offset: true }),
});

const eventsRouter = router({
  list: publicProcedure
    // Past events are dropped unless includePast is set; only the manage surface
    // wants them (edit/delete of stale rows).
    .input(z.object({ includePast: z.boolean().optional() }).optional())
    .output(z.array(EventSelectSchema))
    .query(async ({ ctx, input }) => {
      const { timeZone } = await getSettings(ctx.db);
      return listEvents(db, { includePast: input?.includePast, timeZone });
    }),

  create: publicProcedure
    .input(EventInputSchema)
    .output(EventSelectSchema)
    .mutation(async ({ ctx, input }) => {
      const { timeZone } = await getSettings(ctx.db);
      return createEvent(db, input, new Date(), timeZone);
    }),

  update: publicProcedure
    .input(z.object({ id: z.number().int().positive() }).and(EventInputSchema))
    .output(EventSelectSchema)
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const { timeZone } = await getSettings(ctx.db);
      return updateEvent(db, id, fields, new Date(), timeZone);
    }),

  delete: publicProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .output(z.object({ id: z.number().int().positive() }))
    .mutation(({ input }) => deleteEvent(db, input.id)),
});

/**
 * The branded `api` facet. Its single top-level key `events` is the router
 * namespace the generated app router mounts. The codegen reads these keys off
 * `api._def.record`.
 */
export const api = defineApi(router({ events: eventsRouter }));

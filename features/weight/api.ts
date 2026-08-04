/**
 * tRPC `weight` facet (Track C, Wave 2 fold), folded from
 * apps/api/src/trpc/routers/weight.ts. The feature reaches the tRPC runtime
 * ONLY through `@app-kit/server` (the single sanctioned seam into apps/api's
 * trpc/init — never a direct apps/api import); its query/mutation bodies live
 * in ./service against this feature's own db.
 */
import { defineApi } from "@app-kit";
import { getSettings, publicProcedure, router } from "@app-kit/server";
import { TRPCError } from "@trpc/server";
import { getLogger } from "@www/logger";
import { z } from "zod";
import * as service from "./service";

export const weightRouter = router({
  // Daily-median series + window stats for the tile and Trend page. Null until
  // the first included reading exists (day-one skeleton).
  summary: publicProcedure
    .input(
      z.object({
        range: z.enum(["7d", "30d", "all"]),
        // Which series to plot. Defaults to weight so the tile — which never
        // sends one — keeps its existing contract.
        metric: service.metricInput.default("weight_kg"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { timeZone } = await getSettings(ctx.db);
      return service.getSummary(input.range, timeZone, input.metric);
    }),

  // One page of days, newest first, for the Readings page.
  days: publicProcedure
    .input(
      z.object({
        /** Exclusive: return days strictly older than this YYYY-MM-DD. */
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(90).default(14),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { timeZone } = await getSettings(ctx.db);
      return service.getDays(timeZone, input.cursor, input.limit);
    }),

  // Manual include/exclude toggle from the Readings page; overrides the
  // auto sanity-band flag in both directions.
  setExcluded: publicProcedure
    .input(z.object({ id: z.string(), excluded: z.boolean() }))
    .mutation(async ({ input }) => {
      await service.setExcluded(input.id, input.excluded);
      return { ok: true } as const;
    }),

  // Tombstone, never a hard DELETE: ingest re-inserts any row it can still see
  // in the HA sensor's current state (weight-service.ts, apps/api).
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const deleted = await service.deleteReading(input.id);
    if (!deleted) {
      throw new TRPCError({ code: "NOT_FOUND", message: "weight measurement not found" });
    }
    getLogger().info({ id: input.id }, "weight measurement deleted");
    return { ok: true } as const;
  }),
});

/**
 * The branded `api` facet. Its single top-level key `weight` is the router
 * namespace the generated app router mounts. The codegen reads these keys off
 * `api._def.record`.
 */
export const api = defineApi(router({ weight: weightRouter }));

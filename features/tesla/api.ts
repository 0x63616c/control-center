/**
 * tRPC `tesla` facet (Track C, Wave 2). The Tesla tile's live vehicle state plus
 * lock/charge/preconditioning mutations. Reaches the tRPC runtime ONLY through
 * @app-kit/server and Home Assistant ONLY through the feature's own service ,
 * never apps/api. Codegen collects the top-level key `tesla` off
 * `api._def.record`.
 */
import { defineApi } from "@app-kit";
import { publicProcedure, router } from "@app-kit/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getTeslaData, setTeslaCharging, setTeslaLock, setTeslaPreconditioning } from "./service";

const teslaOutputSchema = z.object({
  name: z.string(),
  nick: z.string(),
  locked: z.boolean(),
  place: z.string(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  charging: z.boolean(),
  chargingState: z.string(),
  preconditioning: z.boolean(),
  rate: z.number(),
  pct: z.number(),
  range: z.number(),
  odo: z.string(),
  climate: z.number(),
});

function unavailable(err: unknown, fallback: string): TRPCError {
  return new TRPCError({
    code: "SERVICE_UNAVAILABLE",
    message: err instanceof Error ? err.message : fallback,
    cause: err,
  });
}

const teslaRouter = router({
  get: publicProcedure
    .input(z.object({}).optional())
    .output(teslaOutputSchema)
    .query(async () => {
      try {
        return await getTeslaData();
      } catch (e) {
        throw unavailable(e, "Tesla data unavailable");
      }
    }),

  /** Lock or unlock the car (lock.<prefix>_lock). */
  setLock: publicProcedure
    .input(z.object({ locked: z.boolean().describe("Desired lock state") }))
    .mutation(async ({ input }) => {
      try {
        await setTeslaLock(input.locked);
      } catch (e) {
        throw unavailable(e, "Tesla lock command failed");
      }
    }),

  /** Start or stop a charge session (switch.<prefix>_charge). */
  setCharging: publicProcedure
    .input(z.object({ on: z.boolean().describe("true = start charge, false = stop") }))
    .mutation(async ({ input }) => {
      try {
        await setTeslaCharging(input.on);
      } catch (e) {
        throw unavailable(e, "Tesla charge command failed");
      }
    }),

  /** Toggle cabin preconditioning via the HVAC climate entity. */
  setPreconditioning: publicProcedure
    .input(z.object({ on: z.boolean().describe("true = precondition on, false = off") }))
    .mutation(async ({ input }) => {
      try {
        await setTeslaPreconditioning(input.on);
      } catch (e) {
        throw unavailable(e, "Tesla preconditioning command failed");
      }
    }),
});

/** The branded `api` facet — single top-level key `tesla`. */
export const api = defineApi(router({ tesla: teslaRouter }));

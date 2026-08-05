import { defineApi } from "@app-kit";
import { publicProcedure, router } from "@app-kit/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { launchOverridesSchema, sceneInputSchema } from "./contract";
import { db, deviceStateStore } from "./db";
import { ha, spotify } from "./deps";
import { launchScene, stopScene } from "./executor";
import type { SceneDefinition } from "./model";
import { createSceneRepository } from "./repository";
import { discoverSpeakers, getSceneResources } from "./resources";

const repository = createSceneRepository(db);

function asDefinition(row: Awaited<ReturnType<typeof repository.read>>): SceneDefinition | null {
  return row ? { ...row } : null;
}

const scenesRouter = router({
  list: publicProcedure.query(async () => (await repository.list()).map((row) => ({ ...row }))),

  resources: publicProcedure.query(() => getSceneResources(spotify)),

  create: publicProcedure.input(sceneInputSchema).mutation(async ({ input }) => {
    return repository.create(input);
  }),

  update: publicProcedure
    .input(sceneInputSchema.and(z.object({ id: z.string().startsWith("scene_") })))
    .mutation(async ({ input }) => {
      const { id, ...fields } = input;
      const updated = await repository.update(id, fields);
      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Scene not found" });
      return updated;
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().startsWith("scene_") }))
    .mutation(async ({ input }) => {
      if (!(await repository.delete(input.id))) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Scene not found" });
      }
      return input;
    }),

  launch: publicProcedure
    .input(
      z.object({
        id: z.string().startsWith("scene_"),
        overrides: launchOverridesSchema.default({}),
      }),
    )
    .mutation(async ({ input }) => {
      const scene = asDefinition(await repository.read(input.id));
      if (!scene) throw new TRPCError({ code: "NOT_FOUND", message: "Scene not found" });
      const current = await repository.currentRun();
      if (current) await stopScene(repository, current.id, current.resolved, spotify);
      return launchScene(repository, scene, input.overrides, {
        ha,
        spotify,
        deviceStateStore,
        discoverSpeakers,
      });
    }),

  current: publicProcedure.query(async () => {
    const run = await repository.currentRun();
    if (!run) return { run: null, playback: { status: "idle" as const } };
    try {
      const playback = await spotify.getNowPlaying();
      return {
        run,
        playback: playback
          ? { status: "ready" as const, value: playback }
          : { status: "idle" as const },
      };
    } catch (error) {
      return {
        run,
        playback: {
          status: "unavailable" as const,
          message: error instanceof Error ? error.message : "Spotify unavailable",
        },
      };
    }
  }),

  stop: publicProcedure
    .input(z.object({ runId: z.string().startsWith("scene_run_") }))
    .mutation(async ({ input }) => {
      const current = await repository.currentRun();
      if (!current || current.id !== input.runId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Running scene not found" });
      }
      return stopScene(repository, current.id, current.resolved, spotify);
    }),
});

export const api = defineApi(router({ scenes: scenesRouter }));

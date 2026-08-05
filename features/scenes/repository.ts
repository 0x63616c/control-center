import { genId } from "@www/platform";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  resolvedSceneExecutionSchema,
  type SceneInput,
  sceneActionSchema,
  sceneRunStatusSchema,
} from "./contract";
import {
  type ResolvedSceneExecution,
  type SceneDefinition,
  SceneRunStatus,
  type SceneRunStatus as SceneRunStatusValue,
} from "./model";
import { scene, sceneRun } from "./schema";

const sceneRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string(),
  actions: z.array(sceneActionSchema),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const sceneRunRowSchema = z.object({
  id: z.string(),
  sceneId: z.string().nullable(),
  sceneName: z.string(),
  status: sceneRunStatusSchema,
  resolved: resolvedSceneExecutionSchema.nullable(),
  error: z.string().nullable(),
  startedAt: z.date(),
  endedAt: z.date().nullable(),
});

type SceneRunRecord = z.infer<typeof sceneRunRowSchema>;

export interface SceneRepository {
  list(): Promise<SceneDefinition[]>;
  read(id: string): Promise<SceneDefinition | null>;
  create(input: SceneInput): Promise<SceneDefinition>;
  update(id: string, input: SceneInput): Promise<SceneDefinition | null>;
  delete(id: string): Promise<boolean>;
  startRun(sceneId: string, sceneName: string): Promise<SceneRunRecord>;
  finishRun(
    id: string,
    status: SceneRunStatusValue,
    resolved: ResolvedSceneExecution | null,
    error?: string,
  ): Promise<SceneRunRecord>;
  currentRun(): Promise<SceneRunRecord | null>;
}

export function createSceneRepository(database: typeof import("./db").db): SceneRepository {
  return {
    async list() {
      return (await database.select().from(scene).orderBy(desc(scene.updatedAt))).map((row) =>
        sceneRowSchema.parse(row),
      );
    },
    async read(id) {
      const rows = await database.select().from(scene).where(eq(scene.id, id)).limit(1);
      return rows[0] ? sceneRowSchema.parse(rows[0]) : null;
    },
    async create(input) {
      const now = new Date();
      const rows = await database
        .insert(scene)
        .values({
          id: genId("scene"),
          ...input,
          actions: [...input.actions],
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const created = rows[0];
      if (!created) throw new Error("scene insert did not return a row");
      return sceneRowSchema.parse(created);
    },
    async update(id, input) {
      const rows = await database
        .update(scene)
        .set({ ...input, actions: [...input.actions], updatedAt: new Date() })
        .where(eq(scene.id, id))
        .returning();
      return rows[0] ? sceneRowSchema.parse(rows[0]) : null;
    },
    async delete(id) {
      const rows = await database.delete(scene).where(eq(scene.id, id)).returning({ id: scene.id });
      return rows.length > 0;
    },
    async startRun(sceneId, sceneName) {
      const rows = await database
        .insert(sceneRun)
        .values({ id: genId("scene_run"), sceneId, sceneName, status: SceneRunStatus.Starting })
        .returning();
      const started = rows[0];
      if (!started) throw new Error("scene run insert did not return a row");
      return sceneRunRowSchema.parse(started);
    },
    async finishRun(id, status, resolved, error) {
      const rows = await database
        .update(sceneRun)
        .set({
          status,
          resolved,
          error: error ?? null,
          ...(status === SceneRunStatus.Running ? {} : { endedAt: new Date() }),
        })
        .where(eq(sceneRun.id, id))
        .returning();
      const finished = rows[0];
      if (!finished) throw new Error(`scene run ${id} was not found`);
      return sceneRunRowSchema.parse(finished);
    },
    async currentRun() {
      const rows = await database
        .select()
        .from(sceneRun)
        .where(eq(sceneRun.status, SceneRunStatus.Running))
        .orderBy(desc(sceneRun.startedAt))
        .limit(1);
      return rows[0] ? sceneRunRowSchema.parse(rows[0]) : null;
    },
  };
}

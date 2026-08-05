import { genId } from "@www/platform";
import { desc, eq } from "drizzle-orm";
import type { SceneInput } from "./contract";
import type { ResolvedSceneExecution, SceneRunStatus } from "./model";
import { scene, sceneRun } from "./schema";

export interface SceneRepository {
  list(): Promise<(typeof scene.$inferSelect)[]>;
  read(id: string): Promise<typeof scene.$inferSelect | null>;
  create(input: SceneInput): Promise<typeof scene.$inferSelect>;
  update(id: string, input: SceneInput): Promise<typeof scene.$inferSelect | null>;
  delete(id: string): Promise<boolean>;
  startRun(sceneId: string, sceneName: string): Promise<typeof sceneRun.$inferSelect>;
  finishRun(
    id: string,
    status: SceneRunStatus,
    resolved: ResolvedSceneExecution | null,
    error?: string,
  ): Promise<typeof sceneRun.$inferSelect>;
  currentRun(): Promise<typeof sceneRun.$inferSelect | null>;
}

export function createSceneRepository(database: typeof import("./db").db): SceneRepository {
  return {
    async list() {
      return database.select().from(scene).orderBy(desc(scene.updatedAt));
    },
    async read(id) {
      const rows = await database.select().from(scene).where(eq(scene.id, id)).limit(1);
      return rows[0] ?? null;
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
      return created;
    },
    async update(id, input) {
      const rows = await database
        .update(scene)
        .set({ ...input, actions: [...input.actions], updatedAt: new Date() })
        .where(eq(scene.id, id))
        .returning();
      return rows[0] ?? null;
    },
    async delete(id) {
      const rows = await database.delete(scene).where(eq(scene.id, id)).returning({ id: scene.id });
      return rows.length > 0;
    },
    async startRun(sceneId, sceneName) {
      const rows = await database
        .insert(sceneRun)
        .values({ id: genId("scene_run"), sceneId, sceneName, status: "starting" })
        .returning();
      const started = rows[0];
      if (!started) throw new Error("scene run insert did not return a row");
      return started;
    },
    async finishRun(id, status, resolved, error) {
      const rows = await database
        .update(sceneRun)
        .set({
          status,
          resolved,
          error: error ?? null,
          ...(status === "running" ? {} : { endedAt: new Date() }),
        })
        .where(eq(sceneRun.id, id))
        .returning();
      const finished = rows[0];
      if (!finished) throw new Error(`scene run ${id} was not found`);
      return finished;
    },
    async currentRun() {
      const rows = await database
        .select()
        .from(sceneRun)
        .where(eq(sceneRun.status, "running"))
        .orderBy(desc(sceneRun.startedAt))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}

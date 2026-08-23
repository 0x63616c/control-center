import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../../api/src/db/index";
import { runMigrations } from "../../api/src/db/migrate";
import { buildDatabaseUrl } from "../../api/src/env";
import { PostgresTemporalWorkflowFence } from "./workflow-dispatch-fence";

const HAS_DB = buildDatabaseUrl() !== undefined;

beforeAll(async () => {
  if (HAS_DB) await runMigrations();
});

beforeEach(async () => {
  if (!HAS_DB) return;
  await pool.query(`
    TRUNCATE deletion_restore_tombstone, account_deletion_cleanup_item,
             account_deletion_request, domain_event, users RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  if (HAS_DB) await pool.end();
});

describe.skipIf(!HAS_DB).sequential("Postgres Temporal workflow deletion fence", () => {
  it("suppresses a stale dispatch once its workflow is inventoried for deletion", async () => {
    await pool.query(`
      INSERT INTO users (id,name,auth_provider,created_at,deletion_requested_at)
      VALUES ('usr_fenced','Fenced','apple',1,2);
      INSERT INTO account_deletion_request (id,user_id,state,created_at,updated_at)
      VALUES ('del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','usr_fenced','accepted',2,2);
      INSERT INTO account_deletion_cleanup_item
        (deletion_request_id,workflow_id,state,updated_at)
      VALUES
        ('del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
         'notification/ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','pending',2);
    `);
    const fence = new PostgresTemporalWorkflowFence(pool);
    const temporalCall = vi.fn(async () => undefined);

    await expect(
      fence.dispatchUnlessSuppressed(
        "notification/ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        temporalCall,
      ),
    ).resolves.toBe(false);
    expect(temporalCall).not.toHaveBeenCalled();
  });

  it("orders a claimed dispatch before exclusive cleanup so neither can cross the fence", async () => {
    const fence = new PostgresTemporalWorkflowFence(pool);
    const order: string[] = [];
    let releaseDispatch: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let markDispatchEntered: (() => void) | undefined;
    const dispatchEntered = new Promise<void>((resolve) => {
      markDispatchEntered = resolve;
    });
    const workflowId = "report/rpt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const dispatch = fence.dispatchUnlessSuppressed(workflowId, async () => {
      order.push("dispatch-start");
      markDispatchEntered?.();
      await release;
      order.push("dispatch-finish");
    });
    await dispatchEntered;
    let cleanupSettled = false;
    const cleanup = fence
      .withCleanupFence(workflowId, async () => {
        order.push("cleanup");
      })
      .finally(() => {
        cleanupSettled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(cleanupSettled).toBe(false);
    releaseDispatch?.();
    await Promise.all([dispatch, cleanup]);
    expect(order).toEqual(["dispatch-start", "dispatch-finish", "cleanup"]);
  });
});

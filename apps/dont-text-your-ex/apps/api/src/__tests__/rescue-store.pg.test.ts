import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UserIdSchema } from "../../../../contracts";
import { runMigrations } from "../db/migrate";
import { PostgresRescueStore } from "../rescue-store";

const databaseUrl = process.env.DATABASE_URL;
const HAS_DB = databaseUrl !== undefined;
const pool = new Pool({ connectionString: databaseUrl });
let clock = 1_000;

const alice = UserIdSchema.parse("usr_rescuealice");
const bob = UserIdSchema.parse("usr_rescuebob");

beforeAll(async () => {
  if (!HAS_DB) return;
  await runMigrations();
});

beforeEach(async () => {
  if (!HAS_DB) return;
  clock = 1_000;
  await pool.query(
    "TRUNCATE notification_delivery,user_notification,rescue_interventions,domain_event,users RESTART IDENTITY CASCADE",
  );
  await pool.query("INSERT INTO users (id,name,created_at) VALUES ($1,'Alice',$3),($2,'Bob',$3)", [
    alice,
    bob,
    clock,
  ]);
});

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!HAS_DB)("Postgres rescue store", () => {
  it("transactionally coalesces concurrent starts into one active intervention and event", async () => {
    const store = new PostgresRescueStore(pool, () => clock);
    const [first, second] = await Promise.all([store.start(alice), store.start(alice)]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "active",
      startedAt: 1_000,
      deadlineAt: 601_000,
      extensionCount: 0,
      aggregateVersion: 1,
    });
    const counts = await pool.query<{ interventions: string; events: string }>(
      `SELECT (SELECT COUNT(*) FROM rescue_interventions)::text AS interventions,
              (SELECT COUNT(*) FROM domain_event WHERE event_type='rescue.started')::text AS events`,
    );
    expect(counts.rows[0]).toEqual({ interventions: "1", events: "1" });
  });

  it("keeps safe and slipped idempotent, authorized, and separate from slip charging", async () => {
    const store = new PostgresRescueStore(pool, () => clock);
    const active = await store.start(alice);
    const safe = await store.command({ userId: alice, interventionId: active.id, action: "safe" });
    const duplicate = await store.command({
      userId: alice,
      interventionId: active.id,
      action: "safe",
    });

    expect(safe).toEqual(duplicate);
    expect(safe).toMatchObject({ outcome: "applied", intervention: { status: "safe" } });
    await expect(
      store.command({ userId: bob, interventionId: active.id, action: "extend" }),
    ).resolves.toEqual({ outcome: "not_found" });
    const persisted = await pool.query<{ slips: string; safe_events: string }>(
      `SELECT (SELECT COUNT(*) FROM slips)::text AS slips,
              (SELECT COUNT(*) FROM domain_event WHERE event_type='rescue.safe')::text AS safe_events`,
    );
    expect(persisted.rows[0]).toEqual({ slips: "0", safe_events: "1" });

    const bobIntervention = await store.start(bob);
    await expect(
      store.command({ userId: bob, interventionId: bobIntervention.id, action: "slipped" }),
    ).resolves.toMatchObject({ outcome: "applied", intervention: { status: "slipped" } });
    const afterSlipped = await pool.query<{ slips: string; slipped_events: string }>(
      `SELECT (SELECT COUNT(*) FROM slips)::text AS slips,
              (SELECT COUNT(*) FROM domain_event WHERE event_type='rescue.slipped')::text AS slipped_events`,
    );
    expect(afterSlipped.rows[0]).toEqual({ slips: "0", slipped_events: "1" });
  });

  it("uses prior deadlines for two extensions and abandons immediately at thirty minutes", async () => {
    const store = new PostgresRescueStore(pool, () => clock);
    let intervention = await store.start(alice);

    clock = intervention.deadlineAt;
    const firstDue = await store.advanceAtDeadline({
      interventionId: intervention.id,
      expectedAggregateVersion: intervention.aggregateVersion,
    });
    if (!firstDue) throw new Error("first check-in missing");
    intervention = firstDue;
    expect(intervention).toMatchObject({
      status: "check_in_due",
      responseDeadlineAt: 901_000,
    });

    clock += 1;
    const firstExtension = await store.command({
      userId: alice,
      interventionId: intervention.id,
      action: "extend",
    });
    expect(firstExtension).toMatchObject({
      outcome: "applied",
      intervention: { status: "active", deadlineAt: 1_201_000, extensionCount: 1 },
    });
    if (firstExtension.outcome !== "applied") throw new Error("first extension missing");

    clock = firstExtension.intervention.deadlineAt;
    const secondDue = await store.advanceAtDeadline({
      interventionId: intervention.id,
      expectedAggregateVersion: firstExtension.intervention.aggregateVersion,
    });
    if (!secondDue) throw new Error("second check-in missing");
    intervention = secondDue;
    const secondExtension = await store.command({
      userId: alice,
      interventionId: intervention.id,
      action: "extend",
    });
    expect(secondExtension).toMatchObject({
      outcome: "applied",
      intervention: { status: "active", deadlineAt: 1_801_000, extensionCount: 2 },
    });
    if (secondExtension.outcome !== "applied") throw new Error("second extension missing");

    clock = secondExtension.intervention.deadlineAt;
    const abandoned = await store.advanceAtDeadline({
      interventionId: intervention.id,
      expectedAggregateVersion: secondExtension.intervention.aggregateVersion,
    });
    expect(abandoned).toMatchObject({ status: "abandoned", resolvedAt: 1_801_000 });
    await expect(
      store.command({ userId: alice, interventionId: intervention.id, action: "extend" }),
    ).resolves.toMatchObject({ outcome: "terminal", intervention: { status: "abandoned" } });
  });

  it("creates one private check-in notification and deletion erases the intervention", async () => {
    const store = new PostgresRescueStore(pool, () => clock);
    const active = await store.start(alice);
    clock = active.deadlineAt;
    const due = await store.advanceAtDeadline({
      interventionId: active.id,
      expectedAggregateVersion: active.aggregateVersion,
    });
    if (!due) throw new Error("check-in missing");
    await store.advanceAtDeadline({
      interventionId: active.id,
      expectedAggregateVersion: active.aggregateVersion,
    });
    expect(due.status).toBe("check_in_due");
    const notifications = await pool.query<{
      category: string;
      recipient_user_id: string;
      target_type: string;
      message_key: string;
    }>("SELECT category,recipient_user_id,target_type,message_key FROM user_notification");
    expect(notifications.rows).toEqual([
      {
        category: "rescue",
        recipient_user_id: alice,
        target_type: "profile",
        message_key: "rescue.check_in",
      },
    ]);

    await store.eraseForAccountDeletion(active.id);
    await expect(store.load(active.id)).resolves.toBeNull();
    const cancelled = await pool.query<{ cancelled_at: string | null }>(
      "SELECT cancelled_at FROM user_notification",
    );
    expect(Number(cancelled.rows[0]?.cancelled_at)).toBe(clock);
  });

  it("lets the deadline transition win commands at the response-window boundary", async () => {
    const store = new PostgresRescueStore(pool, () => clock);
    const active = await store.start(alice);
    clock = active.deadlineAt;
    const due = await store.advanceAtDeadline({
      interventionId: active.id,
      expectedAggregateVersion: active.aggregateVersion,
    });
    if (due?.status !== "check_in_due") throw new Error("check-in missing");

    clock = due.responseDeadlineAt;
    await expect(
      store.command({ userId: alice, interventionId: active.id, action: "safe" }),
    ).resolves.toMatchObject({ outcome: "ineligible", intervention: { status: "check_in_due" } });
    await expect(
      store.command({ userId: alice, interventionId: active.id, action: "extend" }),
    ).resolves.toMatchObject({ outcome: "ineligible", intervention: { status: "check_in_due" } });
    await expect(
      store.advanceAtDeadline({
        interventionId: active.id,
        expectedAggregateVersion: due.aggregateVersion,
      }),
    ).resolves.toMatchObject({ status: "abandoned" });
  });

  it("reconstructs a newly restarted intervention even within the same millisecond", async () => {
    const store = new PostgresRescueStore(pool, () => clock);
    const first = await store.start(alice);
    await store.command({ userId: alice, interventionId: first.id, action: "safe" });
    const restarted = await store.start(alice);

    expect(restarted.id).not.toBe(first.id);
    await expect(store.current(alice)).resolves.toEqual(restarted);
  });
});

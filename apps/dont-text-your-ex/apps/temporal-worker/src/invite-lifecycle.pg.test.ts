import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../api/src/db/index";
import { runMigrations } from "../../api/src/db/migrate";
import { InviteVersionIdSchema } from "../../api/src/domain-events";
import { DomainTransactionRunner } from "../../api/src/domain-transaction";
import { buildDatabaseUrl } from "../../api/src/env";
import * as productStore from "../../api/src/store";
import { PostgresInviteLifecycleStore } from "./invite-lifecycle";

const HAS_DB = buildDatabaseUrl() !== undefined;

describe.skipIf(!HAS_DB)("PostgresInviteLifecycleStore", () => {
  beforeAll(runMigrations);
  beforeEach(async () => {
    await pool.query(
      `TRUNCATE domain_event,jar_milestones,membership_tenures,report_evidence,reports,
         activity,slips,memberships,sessions,otps,user_exes,jars,users RESTART IDENTITY CASCADE`,
    );
  });
  afterAll(() => pool.end());

  it("creates one owner-only reminder and outbox event for the current version", async () => {
    const owner = await productStore.createUser({ name: "Invite Owner" });
    const jar = await productStore.createJar({ userId: owner.id, name: "Invite Jar" });
    const persisted = await pool.query<{ invite_version_id: string }>(
      "SELECT invite_version_id FROM jars WHERE id=$1",
      [jar.id],
    );
    const inviteVersionId = InviteVersionIdSchema.parse(persisted.rows[0]?.invite_version_id);
    const store = new PostgresInviteLifecycleStore(pool, new DomainTransactionRunner({ pool }));

    await expect(store.load(inviteVersionId)).resolves.toMatchObject({ kind: "eligible" });
    await expect(store.requestReminder(inviteVersionId)).resolves.toEqual({ kind: "reminded" });
    await expect(store.requestReminder(inviteVersionId)).resolves.toEqual({ kind: "reminded" });

    const notifications = await pool.query<{
      recipient_user_id: string;
      category: string;
      target_id: string;
    }>("SELECT recipient_user_id,category,target_id FROM user_notification");
    expect(notifications.rows).toEqual([
      { recipient_user_id: owner.id, category: "invite", target_id: jar.id },
    ]);
    const events = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM domain_event WHERE event_type='notification.requested'",
    );
    expect(events.rows).toEqual([{ event_type: "notification.requested" }]);
  });

  it("distinguishes rotation, closure, and exact expiry without reminding", async () => {
    const owner = await productStore.createUser({ name: "Lifecycle Owner" });
    const rotatedJar = await productStore.createJar({ userId: owner.id, name: "Rotated" });
    const rotatedVersion = InviteVersionIdSchema.parse(
      (
        await pool.query<{ invite_version_id: string }>(
          "SELECT invite_version_id FROM jars WHERE id=$1",
          [rotatedJar.id],
        )
      ).rows[0]?.invite_version_id,
    );
    await productStore.rotateInvite(rotatedJar.id, owner.id);

    const closedJar = await productStore.createJar({ userId: owner.id, name: "Closed" });
    const closedVersion = InviteVersionIdSchema.parse(
      (
        await pool.query<{ invite_version_id: string }>(
          "SELECT invite_version_id FROM jars WHERE id=$1",
          [closedJar.id],
        )
      ).rows[0]?.invite_version_id,
    );
    await productStore.closeJar(closedJar.id, owner.id);

    const expiredJar = await productStore.createJar({ userId: owner.id, name: "Expired" });
    const expiredVersion = InviteVersionIdSchema.parse(
      (
        await pool.query<{ invite_version_id: string }>(
          "UPDATE jars SET invite_expires_at=$1 WHERE id=$2 RETURNING invite_version_id",
          [10_000, expiredJar.id],
        )
      ).rows[0]?.invite_version_id,
    );
    const store = new PostgresInviteLifecycleStore(
      pool,
      new DomainTransactionRunner({ pool, clock: () => 10_000 }),
      () => 10_000,
    );

    await expect(store.requestReminder(rotatedVersion)).resolves.toEqual({ kind: "superseded" });
    await expect(store.requestReminder(closedVersion)).resolves.toEqual({ kind: "closed" });
    await expect(store.requestReminder(expiredVersion)).resolves.toEqual({ kind: "expired" });
    expect((await pool.query("SELECT 1 FROM user_notification")).rowCount).toBe(0);
  });
});

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate";
import { buildApp } from "../server";

const databaseUrl = process.env.DATABASE_URL;
const HAS_DB = databaseUrl !== undefined;
const pool = new Pool({ connectionString: databaseUrl });

beforeAll(async () => {
  if (HAS_DB) await runMigrations();
});

beforeEach(async () => {
  if (!HAS_DB) return;
  await pool.query(
    "TRUNCATE notification_delivery,user_notification,rescue_interventions,domain_event,sessions,users RESTART IDENTITY CASCADE",
  );
  await pool.query(
    `INSERT INTO users (id,name,created_at) VALUES ('usr_rescueapi','Rescue API',1),('usr_rescueother','Other',1);
     INSERT INTO sessions (token,user_id,created_at,expires_at,last_used_at)
       VALUES ('sess_rescueapi','usr_rescueapi',1,9999999999999,1),
              ('sess_rescueother','usr_rescueother',1,9999999999999,1)`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!HAS_DB)("rescue API", () => {
  const auth = { Authorization: "Bearer sess_rescueapi" };

  it("requires authentication and reconstructs the current server state", async () => {
    const app = buildApp();
    await expect(app.request("/api/rescue")).resolves.toMatchObject({ status: 401 });
    const empty = await app.request("/api/rescue", { headers: auth });
    expect(await empty.json()).toBeNull();

    const started = await app.request("/api/rescue", { method: "POST", headers: auth });
    expect(started.status).toBe(200);
    const intervention = (await started.json()) as { id: string };
    expect(intervention.id).toMatch(/^rsi_[a-f0-9]{32}$/);
    const duplicate = await app.request("/api/rescue", { method: "POST", headers: auth });
    expect(await duplicate.json()).toEqual(
      await (await app.request("/api/rescue", { headers: auth })).json(),
    );
  });

  it("authorizes commands by intervention owner and validates the command boundary", async () => {
    const app = buildApp();
    const started = await app.request("/api/rescue", { method: "POST", headers: auth });
    const intervention = (await started.json()) as { id: string };

    const forbidden = await app.request(`/api/rescue/${intervention.id}/command`, {
      method: "POST",
      headers: {
        ...auth,
        Authorization: "Bearer sess_rescueother",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "safe" }),
    });
    expect(forbidden.status).toBe(404);

    const invalid = await app.request(`/api/rescue/${intervention.id}/command`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "charge", messageDraft: "forbidden" }),
    });
    expect(invalid.status).toBe(400);

    const safe = await app.request(`/api/rescue/${intervention.id}/command`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "safe" }),
    });
    expect(safe.status).toBe(200);
    expect(await safe.json()).toMatchObject({ status: "safe" });
  });
});

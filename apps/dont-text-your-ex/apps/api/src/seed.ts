import { DAY, now, pool } from "./db/index";
import { runMigrations } from "./db/migrate";
import { id } from "./ids";

type ActivitySeed =
  | {
      jar: string;
      type: "slip";
      actor: string;
      amount: number;
      ex: string | null;
      note: string | null;
      anon: number;
      at: number;
    }
  | { jar: string; type: "milestone"; text: string; at: number }
  | {
      jar: string;
      type: "report";
      actor: string;
      target: string;
      note: string;
      anon: number;
      at: number;
    }
  | { jar: string; type: "join"; actor: string; at: number };

const MIN = 60_000;
const HOUR = 3_600_000;

// People matching the design seed. Calum is the demo "Apple sign-in" user.
const PEOPLE = [
  { id: "usr_calum", name: "Calum", color: "#5E5CE6", phone: "+15550000001", exes: ["Christie"] },
  {
    id: "usr_ali",
    name: "Ali",
    color: "#FF375F",
    phone: "+15550000002",
    exes: ["Mclovin", "Eddie"],
  },
  { id: "usr_giselle", name: "Giselle", color: "#30D158", phone: "+15550000003", exes: [] },
  { id: "usr_alyssa", name: "Alyssa", color: "#FF9F0A", phone: "+15550000004", exes: [] },
];

// streak_start_at from a "days clean" value (null = forever clean / never caved)
const streak = (daysClean: number | null) => (daysClean == null ? null : now() - daysClean * DAY);

const JARS = [
  {
    id: "jar_8af2e52a",
    name: "The Group Chat",
    rule: "Don't text your ex. We all know who. We mean it.",
    defaultCents: 500,
    code: "XEX24K",
    createdBy: "usr_ali",
    members: [
      { user: "usr_ali", role: "owner", tally: 6500, days: 0, share: 1 },
      { user: "usr_calum", role: "member", tally: 4000, days: 4, share: 1 },
      { user: "usr_giselle", role: "member", tally: 0, days: null, share: 1 },
      { user: "usr_alyssa", role: "member", tally: 0, days: 12, share: 0 },
    ],
  },
  {
    id: "jar_3c91d7b0",
    name: "Dry January (Failed)",
    rule: "New year, same bad decisions. $10 a pop.",
    defaultCents: 1000,
    code: "DRYJAN",
    createdBy: "usr_calum",
    members: [
      { user: "usr_calum", role: "owner", tally: 3000, days: 4, share: 1 },
      { user: "usr_ali", role: "member", tally: 2000, days: 0, share: 1 },
    ],
  },
];

const ACTIVITY: ActivitySeed[] = [
  {
    jar: "jar_8af2e52a",
    type: "slip",
    actor: "usr_ali",
    amount: 500,
    ex: "Eddie",
    note: "it was his birthday ok",
    anon: 0,
    at: 12 * MIN,
  },
  {
    jar: "jar_8af2e52a",
    type: "milestone",
    text: "The jar just cracked $100. Disgraceful.",
    at: 12 * MIN,
  },
  {
    jar: "jar_3c91d7b0",
    type: "slip",
    actor: "usr_calum",
    amount: 1000,
    ex: "Christie",
    note: null,
    anon: 0,
    at: 2 * HOUR,
  },
  {
    jar: "jar_8af2e52a",
    type: "report",
    actor: "usr_ali",
    target: "usr_giselle",
    note: 'saw the "u up" at 2am',
    anon: 0,
    at: 5 * HOUR,
  },
  {
    jar: "jar_8af2e52a",
    type: "slip",
    actor: "usr_calum",
    amount: 500,
    ex: "Christie",
    note: null,
    anon: 0,
    at: 1 * DAY,
  },
  { jar: "jar_8af2e52a", type: "join", actor: "usr_alyssa", at: 3 * DAY },
  {
    jar: "jar_8af2e52a",
    type: "slip",
    actor: "usr_ali",
    amount: 500,
    ex: "Mclovin",
    note: null,
    anon: 0,
    at: 4 * DAY,
  },
];

// Pending anonymous report aimed at Calum (drives the confirm/deny screen).
const PENDING = {
  id: "rpt_4d9a",
  jar: "jar_8af2e52a",
  accused: "usr_calum",
  accuser: "usr_giselle",
  anonymous: 1,
  amount: 500,
  at: 8 * MIN,
  note: "Christie posted a story and you replied in 4 seconds flat. We saw the screenshots. Pay up.",
  evidence: [
    {
      to: "Christie",
      time: "2:14 AM",
      bubbles: [
        { me: true, text: "u up?" },
        { me: false, text: "calum it is 2am" },
        { me: true, text: "i know. i just miss the way you-" },
      ],
    },
    {
      to: "Christie",
      time: "2:21 AM",
      bubbles: [
        { me: false, text: "we broke up for a reason" },
        { me: true, text: "name one" },
        { me: true, text: "exactly" },
      ],
    },
  ],
};

// Production never seeds. Local dev and tests can call seed() or ensureSeed() explicitly.
export async function ensureSeed(): Promise<void> {
  if (process.env.APP_ENV === "production") return; // production starts empty
  const { rows } = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM users");
  if (Number(rows[0].n) > 0) return;
  await seed();
}

export async function seed(): Promise<void> {
  const t = now();
  for (const p of PEOPLE) {
    await pool.query(
      "INSERT INTO users (id, name, color, emoji, photo, phone, auth_provider, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [p.id, p.name, p.color, null, null, p.phone, "phone", t],
    );
    for (const ex of p.exes) {
      await pool.query("INSERT INTO user_exes (id, user_id, label) VALUES ($1,$2,$3)", [
        id("exe"),
        p.id,
        ex,
      ]);
    }
  }
  for (const j of JARS) {
    await pool.query(
      "INSERT INTO jars (id, name, rule, default_cents, currency, created_by, invite_code, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [j.id, j.name, j.rule, j.defaultCents, "usd", j.createdBy, j.code, t],
    );
    for (const m of j.members) {
      await pool.query(
        "INSERT INTO memberships (id, jar_id, user_id, role, tally_cents, streak_start_at, share_streak, joined_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [id("mem"), j.id, m.user, m.role, m.tally, streak(m.days), m.share, t],
      );
    }
  }
  for (const a of ACTIVITY) {
    await pool.query(
      "INSERT INTO activity (id, jar_id, type, actor_id, target_id, text, amount_cents, ex_label, note, anonymous, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        id("act"),
        a.jar,
        a.type,
        "actor" in a ? a.actor : null,
        "target" in a ? a.target : null,
        "text" in a ? a.text : null,
        "amount" in a ? a.amount : null,
        "ex" in a ? a.ex : null,
        "note" in a ? a.note : null,
        "anon" in a ? a.anon : 0,
        now() - a.at,
      ],
    );
  }
  await pool.query(
    "INSERT INTO reports (id, jar_id, accuser_id, accused_id, note, is_anonymous, amount_cents, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      PENDING.id,
      PENDING.jar,
      PENDING.accuser,
      PENDING.accused,
      PENDING.note,
      PENDING.anonymous,
      PENDING.amount,
      "pending",
      now() - PENDING.at,
    ],
  );
  for (const ev of PENDING.evidence) {
    await pool.query(
      "INSERT INTO report_evidence (id, report_id, kind, payload, created_at) VALUES ($1,$2,$3,$4,$5)",
      [id("evi"), PENDING.id, "image", JSON.stringify(ev), now()],
    );
  }
}

// Truncate everything and reseed. Used by `bun run seed:reset`, by the server
// boot when TYE_RESET=1 (e2e clean slate), and by the non-production /test/reset
// seam for per-test isolation.
export async function resetAndSeed(): Promise<void> {
  await pool.query(`
    TRUNCATE report_evidence, reports, activity, slips, memberships,
             sessions, otps, user_exes, jars, users RESTART IDENTITY CASCADE
  `);
  await seed();
}

// `bun run seed` or `bun run seed:reset` - explicit local dev reset + seed
if (import.meta.main) {
  await runMigrations();
  if (process.env.TYE_RESET === "1") {
    await resetAndSeed();
  } else {
    await seed();
  }
  await pool.end();
}

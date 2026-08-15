import { DAY, now, pool } from "./db/index";
import { id, inviteCode } from "./ids";
import type {
  ActivityDTO,
  ActivityType,
  EvidenceThread,
  JarDetailDTO,
  JarSummaryDTO,
  MeDTO,
  MemberDTO,
  ReportDTO,
  UserDTO,
} from "./types";

// ─────────────────────────── time helpers ───────────────────────────
function daysClean(streakStartAt: number | null): number {
  if (streakStartAt == null) return -1; // never caved
  return Math.max(0, Math.floor((now() - streakStartAt) / DAY));
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((now() - ts) / 1000));
  if (s < 60) return `${s || 1}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// ─────────────────────────── row types ───────────────────────────
type UserRow = {
  id: string;
  name: string;
  color: string;
  emoji: string | null;
  photo: string | null;
  phone: string | null;
  apple_id: string | null;
  auth_provider: string;
  created_at: number;
};
type MembershipRow = {
  id: string;
  jar_id: string;
  user_id: string;
  role: string;
  tally_cents: number;
  streak_start_at: number | null;
  share_streak: number;
  joined_at: number;
};
type JarRow = {
  id: string;
  name: string;
  rule: string;
  default_cents: number;
  currency: string;
  created_by: string;
  invite_code: string;
  created_at: number;
};

const USER_COLORS = [
  "#FF375F",
  "#5E5CE6",
  "#30D158",
  "#FF9F0A",
  "#0A84FF",
  "#BF5AF2",
  "#FF6482",
  "#64D2FF",
] as const;

function randomUserColor(): string {
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)] ?? "#5E5CE6";
}

// ─────────────────────────── users / auth ───────────────────────────
async function exesFor(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ label: string }>(
    "SELECT label FROM user_exes WHERE user_id = $1 ORDER BY id",
    [userId],
  );
  return rows.map((r) => r.label);
}

async function serializeUser(u: UserRow): Promise<UserDTO> {
  return {
    id: u.id,
    name: u.name,
    color: u.color,
    emoji: u.emoji,
    photo: u.photo,
    exes: await exesFor(u.id),
  };
}

async function getUserRow(userId: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
  return rows[0] ?? null;
}

async function getUser(userId: string): Promise<UserDTO | null> {
  const u = await getUserRow(userId);
  return u ? serializeUser(u) : null;
}

export async function getMe(userId: string): Promise<MeDTO | null> {
  const u = await getUserRow(userId);
  if (!u) return null;
  return {
    ...(await serializeUser(u)),
    phone: u.phone,
  };
}

export async function createUser(opts: {
  name: string;
  color?: string;
  emoji?: string | null;
  photo?: string | null;
  phone?: string | null;
  appleId?: string | null;
  authProvider?: string;
  exes?: string[];
}): Promise<UserDTO> {
  const uid = id("usr");
  await pool.query(
    "INSERT INTO users (id, name, color, emoji, photo, phone, apple_id, auth_provider, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      uid,
      opts.name,
      opts.color ?? randomUserColor(),
      opts.emoji ?? null,
      opts.photo ?? null,
      opts.phone ?? null,
      opts.appleId ?? null,
      opts.authProvider ?? "demo",
      now(),
    ],
  );
  for (const label of opts.exes ?? []) {
    await pool.query("INSERT INTO user_exes (id, user_id, label) VALUES ($1,$2,$3)", [
      id("exe"),
      uid,
      label,
    ]);
  }
  return (await getUser(uid)) as UserDTO;
}

export async function updateUser(
  userId: string,
  patch: {
    color?: string;
    emoji?: string | null;
    photo?: string | null;
  },
): Promise<UserDTO | null> {
  const u = await getUserRow(userId);
  if (!u) return null;
  await pool.query("UPDATE users SET color=$1, emoji=$2, photo=$3 WHERE id=$4", [
    patch.color ?? u.color,
    patch.emoji === undefined ? u.emoji : patch.emoji,
    patch.photo === undefined ? u.photo : patch.photo,
    userId,
  ]);
  return getUser(userId);
}

export async function setExes(userId: string, exes: string[]): Promise<void> {
  await pool.query("DELETE FROM user_exes WHERE user_id=$1", [userId]);
  for (const label of exes) {
    await pool.query("INSERT INTO user_exes (id, user_id, label) VALUES ($1,$2,$3)", [
      id("exe"),
      userId,
      label,
    ]);
  }
}

// ─────────────────────────── sessions ───────────────────────────
export async function createSession(userId: string): Promise<string> {
  const token = id("sess", 24);
  await pool.query("INSERT INTO sessions (token, user_id, created_at) VALUES ($1,$2,$3)", [
    token,
    userId,
    now(),
  ]);
  return token;
}

export async function userIdForToken(token: string): Promise<string | null> {
  const { rows } = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM sessions WHERE token = $1",
    [token],
  );
  return rows[0]?.user_id ?? null;
}

export async function deleteSession(token: string): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE token=$1", [token]);
}

export async function findUserByPhone(phone: string): Promise<UserDTO | null> {
  const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE phone = $1", [phone]);
  const u = rows[0];
  return u ? serializeUser(u) : null;
}

export async function findUserByAppleId(appleId: string): Promise<UserDTO | null> {
  const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE apple_id = $1", [appleId]);
  const u = rows[0];
  return u ? serializeUser(u) : null;
}

// ─────────────────────────── memberships / jars ───────────────────────────
async function membershipRow(jarId: string, userId: string): Promise<MembershipRow | null> {
  const { rows } = await pool.query<MembershipRow>(
    "SELECT * FROM memberships WHERE jar_id=$1 AND user_id=$2",
    [jarId, userId],
  );
  return rows[0] ?? null;
}

export async function isMember(jarId: string, userId: string): Promise<boolean> {
  return !!(await membershipRow(jarId, userId));
}

async function jarRow(jarId: string): Promise<JarRow | null> {
  const { rows } = await pool.query<JarRow>("SELECT * FROM jars WHERE id=$1", [jarId]);
  return rows[0] ?? null;
}

async function jarRowByCode(code: string): Promise<JarRow | null> {
  const { rows } = await pool.query<JarRow>("SELECT * FROM jars WHERE invite_code=$1", [
    code.toUpperCase(),
  ]);
  return rows[0] ?? null;
}

async function membersOf(jarId: string): Promise<MembershipRow[]> {
  const { rows } = await pool.query<MembershipRow>("SELECT * FROM memberships WHERE jar_id=$1", [
    jarId,
  ]);
  return rows;
}

async function jarTotal(jarId: string): Promise<number> {
  const { rows } = await pool.query<{ t: string }>(
    "SELECT COALESCE(SUM(tally_cents),0)::text AS t FROM memberships WHERE jar_id=$1",
    [jarId],
  );
  return Number(rows[0]?.t ?? 0);
}

async function serializeMember(m: MembershipRow): Promise<MemberDTO> {
  return {
    user: (await getUser(m.user_id)) as UserDTO,
    role: m.role as "owner" | "member",
    tallyCents: m.tally_cents,
    daysClean: daysClean(m.streak_start_at),
    shareStreak: !!m.share_streak,
  };
}

export async function listJarsForUser(userId: string): Promise<JarSummaryDTO[]> {
  const { rows } = await pool.query<JarRow>(
    "SELECT j.* FROM jars j JOIN memberships m ON m.jar_id=j.id WHERE m.user_id=$1 ORDER BY j.created_at",
    [userId],
  );
  return Promise.all(
    rows.map(async (j) => {
      const members = await membersOf(j.id);
      const mine = members.find((m) => m.user_id === userId);
      return {
        id: j.id,
        name: j.name,
        rule: j.rule,
        defaultCents: j.default_cents,
        memberIds: members.map((m) => m.user_id),
        memberCount: members.length,
        jarTotalCents: members.reduce((s, m) => s + m.tally_cents, 0),
        myTallyCents: mine?.tally_cents ?? 0,
        myDaysClean: daysClean(mine?.streak_start_at ?? null),
        myShareStreak: !!mine?.share_streak,
      };
    }),
  );
}

export async function getJarDetail(jarId: string, _meId: string): Promise<JarDetailDTO | null> {
  const j = await jarRow(jarId);
  if (!j) return null;
  const rawMembers = await membersOf(jarId);
  const members = (await Promise.all(rawMembers.map(serializeMember))).sort(
    (a, b) => b.tallyCents - a.tallyCents,
  );
  return {
    id: j.id,
    name: j.name,
    rule: j.rule,
    defaultCents: j.default_cents,
    inviteCode: j.invite_code,
    jarTotalCents: await jarTotal(jarId),
    members,
    activity: await activityForJar(jarId, 8),
  };
}

export async function getJarPreviewByCode(code: string): Promise<{
  id: string;
  name: string;
  rule: string;
  defaultCents: number;
  memberIds: string[];
  memberCount: number;
} | null> {
  const j = await jarRowByCode(code);
  if (!j) return null;
  const members = await membersOf(j.id);
  return {
    id: j.id,
    name: j.name,
    rule: j.rule,
    defaultCents: j.default_cents,
    memberIds: members.map((m) => m.user_id),
    memberCount: members.length,
  };
}

export async function createJar(opts: {
  userId: string;
  name: string;
  rule?: string;
  defaultCents?: number;
}): Promise<JarSummaryDTO> {
  const jid = id("jar");
  let code = inviteCode();
  while (await jarRowByCode(code)) code = inviteCode();
  await pool.query(
    "INSERT INTO jars (id, name, rule, default_cents, currency, created_by, invite_code, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [jid, opts.name, opts.rule ?? "", opts.defaultCents ?? 500, "usd", opts.userId, code, now()],
  );
  await addMembership(jid, opts.userId, "owner");
  const jars = await listJarsForUser(opts.userId);
  return jars.find((j) => j.id === jid) as JarSummaryDTO;
}

async function addMembership(
  jarId: string,
  userId: string,
  role: "owner" | "member",
): Promise<void> {
  await pool.query(
    "INSERT INTO memberships (id, jar_id, user_id, role, tally_cents, streak_start_at, share_streak, joined_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (jar_id, user_id) DO NOTHING",
    [id("mem"), jarId, userId, role, 0, null, 1, now()],
  );
}

export async function joinJarByCode(
  userId: string,
  code: string,
): Promise<{ jarId: string } | null> {
  const j = await jarRowByCode(code);
  if (!j) return null;
  const already = await isMember(j.id, userId);
  await addMembership(j.id, userId, "member");
  if (!already) await logActivity({ jarId: j.id, type: "join", actorId: userId });
  return { jarId: j.id };
}

export async function setShareStreak(jarId: string, userId: string, val: boolean): Promise<void> {
  await pool.query("UPDATE memberships SET share_streak=$1 WHERE jar_id=$2 AND user_id=$3", [
    val ? 1 : 0,
    jarId,
    userId,
  ]);
}

// ─────────────────────────── slips ───────────────────────────
const MILESTONE_STEP = 5000; // $50

export async function logSlip(opts: {
  jarId: string;
  userId: string;
  amountCents: number;
  note?: string | null;
  exLabel?: string | null;
  source?: "self" | "report";
  reportedBy?: string | null;
}): Promise<void> {
  const j = await jarRow(opts.jarId);
  if (!j) throw new Error("jar not found");
  const before = await jarTotal(opts.jarId);

  await pool.query(
    "INSERT INTO slips (id, jar_id, user_id, amount_cents, note, ex_label, source, reported_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      id("slip"),
      opts.jarId,
      opts.userId,
      opts.amountCents,
      opts.note ?? null,
      opts.exLabel ?? null,
      opts.source ?? "self",
      opts.reportedBy ?? null,
      now(),
    ],
  );
  await pool.query(
    "UPDATE memberships SET tally_cents = tally_cents + $1, streak_start_at = $2 WHERE jar_id=$3 AND user_id=$4",
    [opts.amountCents, now(), opts.jarId, opts.userId],
  );

  await logActivity({
    jarId: opts.jarId,
    type: "slip",
    actorId: opts.userId,
    amountCents: opts.amountCents,
    exLabel: opts.exLabel ?? null,
    note: opts.note ?? null,
  });

  const after = before + opts.amountCents;
  for (
    let t = (Math.floor(before / MILESTONE_STEP) + 1) * MILESTONE_STEP;
    t <= after;
    t += MILESTONE_STEP
  ) {
    await logActivity({
      jarId: opts.jarId,
      type: "milestone",
      text: `The jar just cracked $${t / 100}. Disgraceful.`,
    });
  }
}

// ─────────────────────────── reports ───────────────────────────
export async function createReport(opts: {
  jarId: string;
  accuserId: string;
  accusedId: string;
  note?: string | null;
  anonymous: boolean;
  amountCents: number;
  evidence: EvidenceThread[];
}): Promise<ReportDTO> {
  const rid = id("rpt");
  await pool.query(
    "INSERT INTO reports (id, jar_id, accuser_id, accused_id, note, is_anonymous, amount_cents, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      rid,
      opts.jarId,
      opts.accuserId,
      opts.accusedId,
      opts.note ?? null,
      opts.anonymous ? 1 : 0,
      opts.amountCents,
      "pending",
      now(),
    ],
  );
  for (const thread of opts.evidence) {
    await pool.query(
      "INSERT INTO report_evidence (id, report_id, kind, payload, created_at) VALUES ($1,$2,$3,$4,$5)",
      [id("evi"), rid, "image", JSON.stringify(thread), now()],
    );
  }
  await logActivity({
    jarId: opts.jarId,
    type: "report",
    actorId: opts.accusedId,
    targetId: opts.accuserId,
    anonymous: opts.anonymous,
    note: opts.note ?? null,
  });
  return (await serializeReport(rid)) as ReportDTO;
}

type ReportRow = {
  id: string;
  jar_id: string;
  accuser_id: string;
  accused_id: string;
  note: string | null;
  is_anonymous: number;
  amount_cents: number;
  status: string;
  created_at: number;
  resolved_at: number | null;
};

async function reportRow(reportId: string): Promise<ReportRow | null> {
  const { rows } = await pool.query<ReportRow>("SELECT * FROM reports WHERE id=$1", [reportId]);
  return rows[0] ?? null;
}

async function serializeReport(reportId: string): Promise<ReportDTO | null> {
  const r = await reportRow(reportId);
  if (!r) return null;
  const j = await jarRow(r.jar_id);
  if (!j) return null;
  const { rows: evRows } = await pool.query<{ id: string; kind: string; payload: string }>(
    "SELECT id, kind, payload FROM report_evidence WHERE report_id=$1 ORDER BY created_at",
    [reportId],
  );
  const evidence = evRows.map((e) => ({
    id: e.id,
    kind: "image" as const,
    thread: JSON.parse(e.payload) as EvidenceThread,
  }));
  return {
    id: r.id,
    jarId: r.jar_id,
    jarName: j.name,
    accuser: r.is_anonymous ? null : await getUser(r.accuser_id),
    accused: (await getUser(r.accused_id)) as UserDTO,
    note: r.note,
    anonymous: !!r.is_anonymous,
    amountCents: r.amount_cents,
    status: r.status as "pending" | "owned" | "denied",
    ago: ago(r.created_at),
    evidence,
  };
}

export async function pendingReportsForUser(userId: string): Promise<ReportDTO[]> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM reports WHERE accused_id=$1 AND status='pending' ORDER BY created_at DESC",
    [userId],
  );
  const results = await Promise.all(rows.map((r) => serializeReport(r.id)));
  return results.filter((r): r is ReportDTO => r !== null);
}

export async function resolveReport(
  reportId: string,
  userId: string,
  action: "own" | "deny",
): Promise<ReportDTO | null> {
  const r = await reportRow(reportId);
  if (!r || r.accused_id !== userId || r.status !== "pending") return null;
  if (action === "own") {
    await logSlip({
      jarId: r.jar_id,
      userId: r.accused_id,
      amountCents: r.amount_cents,
      note: r.note,
      source: "report",
      reportedBy: r.accuser_id,
    });
    await pool.query("UPDATE reports SET status='owned', resolved_at=$1 WHERE id=$2", [
      now(),
      reportId,
    ]);
  } else {
    await pool.query("UPDATE reports SET status='denied', resolved_at=$1 WHERE id=$2", [
      now(),
      reportId,
    ]);
    await logActivity({ jarId: r.jar_id, type: "deny", actorId: r.accused_id });
  }
  return serializeReport(reportId);
}

// ─────────────────────────── activity ───────────────────────────
async function logActivity(opts: {
  jarId: string;
  type: ActivityType;
  actorId?: string | null;
  targetId?: string | null;
  text?: string | null;
  amountCents?: number | null;
  exLabel?: string | null;
  note?: string | null;
  anonymous?: boolean;
}): Promise<void> {
  await pool.query(
    "INSERT INTO activity (id, jar_id, type, actor_id, target_id, text, amount_cents, ex_label, note, anonymous, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      id("act"),
      opts.jarId,
      opts.type,
      opts.actorId ?? null,
      opts.targetId ?? null,
      opts.text ?? null,
      opts.amountCents ?? null,
      opts.exLabel ?? null,
      opts.note ?? null,
      opts.anonymous ? 1 : 0,
      now(),
    ],
  );
}

type ActivityRow = {
  id: string;
  jar_id: string;
  type: ActivityType;
  actor_id: string | null;
  target_id: string | null;
  text: string | null;
  amount_cents: number | null;
  ex_label: string | null;
  note: string | null;
  anonymous: number;
  created_at: number;
};

async function serializeActivity(a: ActivityRow): Promise<ActivityDTO> {
  const j = await jarRow(a.jar_id);
  return {
    id: a.id,
    jarId: a.jar_id,
    jarName: j?.name ?? "",
    type: a.type,
    user: a.actor_id ? await getUser(a.actor_id) : null,
    by: a.target_id ? await getUser(a.target_id) : null,
    anonymous: !!a.anonymous,
    amountCents: a.amount_cents,
    exLabel: a.ex_label,
    note: a.note,
    text: a.text,
    ago: ago(a.created_at),
  };
}

async function activityForJar(jarId: string, limit = 50): Promise<ActivityDTO[]> {
  const { rows } = await pool.query<ActivityRow>(
    "SELECT * FROM activity WHERE jar_id=$1 ORDER BY created_at DESC LIMIT $2",
    [jarId, limit],
  );
  return Promise.all(rows.map(serializeActivity));
}

export async function activityForUser(userId: string, limit = 50): Promise<ActivityDTO[]> {
  const { rows } = await pool.query<ActivityRow>(
    `SELECT a.* FROM activity a JOIN memberships m ON m.jar_id=a.jar_id
     WHERE m.user_id=$1 ORDER BY a.created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return Promise.all(rows.map(serializeActivity));
}

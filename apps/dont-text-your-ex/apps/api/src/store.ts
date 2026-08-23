import type { PoolClient } from "pg";
import { z } from "zod";
import {
  ActivitySchema,
  EvidenceIdSchema,
  type IanaTimeZone,
  type InviteCode,
  InviteCodeSchema,
  JarDetailSchema,
  type JarId,
  JarIdSchema,
  JarPreviewSchema,
  JarSummarySchema,
  MemberSchema,
  type ReportId,
  ReportIdSchema,
  ReportSchema,
  ReportStatusSchema,
  type SessionToken,
  SessionTokenSchema,
  type UserId,
  UserIdSchema,
  UserSchema,
} from "../../../contracts";
import {
  type AccountDeletionReceipt,
  accountMutationLockKey,
  createAccountDeletionCipher,
  PostgresAccountDeletionStore,
  parseAccountDeletionKeyring,
} from "./account-deletion";
import { DAY, now, pool } from "./db/index";
import {
  type InviteVersionId,
  InviteVersionIdSchema,
  JarMilestoneIdSchema,
  type MembershipTenureId,
  MembershipTenureIdSchema,
} from "./domain-events";
import { type DomainTransactionContext, DomainTransactionRunner } from "./domain-transaction";
import {
  accountDeletionKeyringSource,
  erasureJournalDirectory,
  restoreTombstoneHmacKeyringSource,
  restoreTombstoneSigningKeyringSource,
  temporalAddress,
} from "./env";
import { id, inviteCode } from "./ids";
import { parseEvidenceImageJson, serializeEvidenceImageJson } from "./persistence";
import {
  createFileRestoreTombstoneService,
  parseRestoreTombstoneKeyring,
} from "./restore-tombstone";
import { TemporalPostCommitNudge, temporalRecoveryWorkflowStarter } from "./temporal-nudge";
import type {
  ActivityDTO,
  ActivityType,
  EvidenceImageInput,
  JarDetailDTO,
  JarSummaryDTO,
  MeDTO,
  MemberDTO,
  ReportDTO,
  UserDTO,
} from "./types";

// ─────────────────────────── time helpers ───────────────────────────
function daysClean(streakStartAt: number | null): number {
  if (streakStartAt == null) return -1; // no recorded slip has started the streak clock
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
  id: UserId;
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
  jar_id: JarId;
  user_id: UserId;
  role: string;
  tally_cents: number;
  streak_start_at: number | null;
  share_streak: number;
  joined_at: number;
  left_at: number | null;
};
type JarRow = {
  id: JarId;
  name: string;
  rule: string;
  default_cents: number;
  currency: string;
  created_by: UserId | null;
  invite_code: InviteCode | null;
  invite_expires_at: string | null;
  invite_version_id: InviteVersionId;
  timezone: string;
  created_at: number;
  closed_at: string | null;
  closed_by: UserId | null;
};

type UserDbRow = Omit<UserRow, "id"> & { readonly id: string };
type MembershipDbRow = Omit<MembershipRow, "jar_id" | "user_id"> & {
  readonly jar_id: string;
  readonly user_id: string;
};
type JarDbRow = Omit<
  JarRow,
  "id" | "created_by" | "invite_code" | "invite_version_id" | "closed_by"
> & {
  readonly id: string;
  readonly created_by: string | null;
  readonly invite_code: string | null;
  readonly invite_version_id: string;
  readonly closed_by: string | null;
};

function parseUserRow(row: UserDbRow): UserRow {
  return { ...row, id: UserIdSchema.parse(row.id) };
}

function parseMembershipRow(row: MembershipDbRow): MembershipRow {
  return {
    ...row,
    jar_id: JarIdSchema.parse(row.jar_id),
    user_id: UserIdSchema.parse(row.user_id),
  };
}

function parseJarRow(row: JarDbRow): JarRow {
  return {
    ...row,
    id: JarIdSchema.parse(row.id),
    created_by: row.created_by == null ? null : UserIdSchema.parse(row.created_by),
    invite_code: row.invite_code == null ? null : InviteCodeSchema.parse(row.invite_code),
    invite_version_id: InviteVersionIdSchema.parse(row.invite_version_id),
    closed_by: row.closed_by == null ? null : UserIdSchema.parse(row.closed_by),
  };
}

type Queryable = Pick<PoolClient, "query">;

const configuredTemporalAddress = temporalAddress();
const domainTransactions = new DomainTransactionRunner({
  pool,
  clock: now,
  nudge:
    configuredTemporalAddress === undefined
      ? undefined
      : new TemporalPostCommitNudge(temporalRecoveryWorkflowStarter(configuredTemporalAddress)),
});
const accountDeletions = new PostgresAccountDeletionStore(
  pool,
  domainTransactions,
  now,
  createAccountDeletionCipher(parseAccountDeletionKeyring(accountDeletionKeyringSource())),
  createFileRestoreTombstoneService({
    directory: erasureJournalDirectory(),
    hmacKeys: parseRestoreTombstoneKeyring(restoreTombstoneHmacKeyringSource()),
    signingKeys: parseRestoreTombstoneKeyring(restoreTombstoneSigningKeyringSource()),
  }),
);

async function withTransaction<T>(
  operation: (client: PoolClient, emit: DomainTransactionContext["emit"]) => Promise<T>,
): Promise<T> {
  return domainTransactions.run(({ db, emit }) => operation(db, emit));
}

export class JarClosedError extends Error {
  constructor() {
    super("jar is closed");
  }
}

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
async function exesFor(userId: UserId): Promise<string[]> {
  const { rows } = await pool.query<{ label: string }>(
    "SELECT label FROM user_exes WHERE user_id = $1 ORDER BY id",
    [userId],
  );
  return rows.map((r) => r.label);
}

async function serializeUser(u: UserRow): Promise<UserDTO> {
  return UserSchema.parse({
    id: u.id,
    name: u.name,
    color: u.color,
    emoji: u.emoji,
    photo: u.photo,
  });
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

async function getUserRow(userId: UserId): Promise<UserRow | null> {
  const { rows } = await pool.query<UserDbRow>("SELECT * FROM users WHERE id = $1", [userId]);
  return rows[0] ? parseUserRow(rows[0]) : null;
}

async function getUser(userId: UserId): Promise<UserDTO | null> {
  const u = await getUserRow(userId);
  return u ? serializeUser(u) : null;
}

export async function getMe(userId: UserId): Promise<MeDTO | null> {
  const u = await getUserRow(userId);
  if (!u) return null;
  return {
    ...(await serializeUser(u)),
    exes: await exesFor(u.id),
    phone: u.phone,
  };
}

export async function updateUserTimeZone(userId: UserId, timezone: IanaTimeZone): Promise<void> {
  await pool.query("UPDATE users SET timezone=$1 WHERE id=$2 AND timezone IS DISTINCT FROM $1", [
    timezone,
    userId,
  ]);
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
  return requireValue(await getUser(uid), "created user could not be loaded");
}

export async function updateUser(
  userId: UserId,
  patch: {
    name?: string;
    color?: string;
    emoji?: string | null;
    photo?: string | null;
  },
): Promise<UserDTO | null> {
  const u = await getUserRow(userId);
  if (!u) return null;
  await pool.query("UPDATE users SET name=$1, color=$2, emoji=$3, photo=$4 WHERE id=$5", [
    patch.name ?? u.name,
    patch.color ?? u.color,
    patch.emoji === undefined ? u.emoji : patch.emoji,
    patch.photo === undefined ? u.photo : patch.photo,
    userId,
  ]);
  return getUser(userId);
}

export async function setExes(userId: UserId, exes: string[]): Promise<void> {
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
const SESSION_ABSOLUTE_LIFETIME_MS = 30 * DAY;

export async function createSession(userId: UserId): Promise<SessionToken> {
  const token = SessionTokenSchema.parse(id("sess", 24));
  const createdAt = now();
  const guarded = await withActiveAccountRequest(userId, () =>
    pool.query(
      `INSERT INTO sessions (token, user_id, created_at, expires_at, last_used_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [token, userId, createdAt, createdAt + SESSION_ABSOLUTE_LIFETIME_MS, createdAt],
    ),
  );
  if (!guarded.active) throw new Error("account is being deleted");
  return token;
}

export async function userIdForToken(token: SessionToken): Promise<UserId | null> {
  const checkedAt = now();
  const { rows } = await pool.query<{ user_id: string }>(
    "UPDATE sessions SET last_used_at=$2 WHERE token=$1 AND expires_at>$2 RETURNING user_id",
    [token, checkedAt],
  );
  const userId = rows[0]?.user_id;
  if (userId) return UserIdSchema.parse(userId);
  await pool.query("DELETE FROM sessions WHERE token=$1 AND expires_at<=$2", [token, checkedAt]);
  return null;
}

export async function deleteSession(token: SessionToken): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE token=$1", [token]);
}

export async function withActiveAccountRequest<T>(
  userId: UserId,
  operation: () => Promise<T>,
): Promise<{ readonly active: true; readonly value: T } | { readonly active: false }> {
  const client = await pool.connect();
  const lockKey = accountMutationLockKey(userId);
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock_shared(hashtextextended($1,0))", [lockKey]);
    locked = true;
    const active = await client.query(
      "SELECT 1 FROM users WHERE id=$1 AND deletion_requested_at IS NULL",
      [userId],
    );
    if (active.rowCount !== 1) return { active: false };
    return { active: true, value: await operation() };
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock_shared(hashtextextended($1,0))", [lockKey])
        .catch(() => undefined);
    }
    client.release();
  }
}

export function requestAccountDeletion(
  userId: UserId,
  appleCredential?: { readonly authorizationCode: string; readonly appleSubject: string },
): Promise<AccountDeletionReceipt> {
  return accountDeletions.request(appleCredential ? { userId, ...appleCredential } : { userId });
}

export async function appleSubjectForUser(userId: UserId): Promise<string | null> {
  const result = await pool.query<{ apple_id: string | null }>(
    "SELECT apple_id FROM users WHERE id=$1",
    [userId],
  );
  return result.rows[0]?.apple_id ?? null;
}

export async function findUserByPhone(phone: string): Promise<UserDTO | null> {
  const { rows } = await pool.query<UserDbRow>("SELECT * FROM users WHERE phone = $1", [phone]);
  const u = rows[0];
  return u ? serializeUser(parseUserRow(u)) : null;
}

export async function findUserByAppleId(appleId: string): Promise<UserDTO | null> {
  const { rows } = await pool.query<UserDbRow>("SELECT * FROM users WHERE apple_id = $1", [
    appleId,
  ]);
  const u = rows[0];
  return u ? serializeUser(parseUserRow(u)) : null;
}

// ─────────────────────────── memberships / jars ───────────────────────────
async function membershipRow(
  jarId: JarId,
  userId: UserId,
  db: Queryable = pool,
  lock = false,
): Promise<MembershipRow | null> {
  const { rows } = await db.query<MembershipDbRow>(
    `SELECT * FROM memberships WHERE jar_id=$1 AND user_id=$2 AND left_at IS NULL${lock ? " FOR UPDATE" : ""}`,
    [jarId, userId],
  );
  return rows[0] ? parseMembershipRow(rows[0]) : null;
}

async function isMemberIn(
  db: Queryable,
  jarId: JarId,
  userId: UserId,
  lock = false,
): Promise<boolean> {
  return !!(await membershipRow(jarId, userId, db, lock));
}

export async function isMember(jarId: JarId, userId: UserId): Promise<boolean> {
  return isMemberIn(pool, jarId, userId);
}

async function jarRow(jarId: JarId, db: Queryable = pool, lock = false): Promise<JarRow | null> {
  const { rows } = await db.query<JarDbRow>(
    `SELECT * FROM jars WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [jarId],
  );
  return rows[0] ? parseJarRow(rows[0]) : null;
}

async function jarRowByCode(
  code: InviteCode,
  db: Queryable = pool,
  lock = false,
): Promise<JarRow | null> {
  const { rows } = await db.query<JarDbRow>(
    `SELECT * FROM jars WHERE invite_code=$1 AND invite_expires_at>$2 AND closed_at IS NULL${lock ? " FOR UPDATE" : ""}`,
    [code, now()],
  );
  return rows[0] ? parseJarRow(rows[0]) : null;
}

async function inviteCodeExists(code: InviteCode, db: Queryable = pool): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM jars WHERE invite_code=$1", [code]);
  return (rowCount ?? 0) > 0;
}

async function freshInvite(
  db: Queryable = pool,
): Promise<{ code: InviteCode; expiresAt: number; versionId: InviteVersionId }> {
  let code = inviteCode();
  while (await inviteCodeExists(code, db)) code = inviteCode();
  return { code, expiresAt: now() + 7 * DAY, versionId: id("inv") };
}

async function assertJarOpen(jarId: JarId, db: Queryable = pool, lock = false): Promise<JarRow> {
  const jar = await jarRow(jarId, db, lock);
  if (!jar) throw new Error("jar not found");
  if (jar.closed_at != null) throw new JarClosedError();
  return jar;
}

async function closedByUser(jar: JarRow): Promise<UserDTO | null> {
  return jar.closed_by ? getUser(jar.closed_by) : null;
}

async function membersOf(jarId: JarId): Promise<MembershipRow[]> {
  const { rows } = await pool.query<MembershipDbRow>("SELECT * FROM memberships WHERE jar_id=$1", [
    jarId,
  ]);
  return rows.map(parseMembershipRow);
}

async function activeMembersOf(jarId: JarId): Promise<MembershipRow[]> {
  const { rows } = await pool.query<MembershipDbRow>(
    "SELECT * FROM memberships WHERE jar_id=$1 AND left_at IS NULL",
    [jarId],
  );
  return rows.map(parseMembershipRow);
}

async function jarTotal(jarId: JarId, db: Queryable = pool): Promise<number> {
  const { rows } = await db.query<{ t: string }>(
    "SELECT COALESCE(SUM(tally_cents),0)::text AS t FROM memberships WHERE jar_id=$1",
    [jarId],
  );
  return Number(rows[0]?.t ?? 0);
}

async function serializeMember(m: MembershipRow, viewerId: UserId): Promise<MemberDTO> {
  const shareStreak = !!m.share_streak;
  return MemberSchema.parse({
    user: requireValue(await getUser(m.user_id), "membership user could not be loaded"),
    role: m.role,
    tallyCents: m.tally_cents,
    active: m.left_at == null,
    ...(shareStreak || m.user_id === viewerId ? { daysClean: daysClean(m.streak_start_at) } : {}),
    shareStreak,
  });
}

export async function listJarsForUser(userId: UserId): Promise<JarSummaryDTO[]> {
  const { rows: dbRows } = await pool.query<JarDbRow>(
    "SELECT j.* FROM jars j JOIN memberships m ON m.jar_id=j.id WHERE m.user_id=$1 AND m.left_at IS NULL ORDER BY j.created_at",
    [userId],
  );
  const rows = dbRows.map(parseJarRow);
  return Promise.all(
    rows.map(async (j) => {
      const members = await membersOf(j.id);
      const activeMembers = members.filter((member) => member.left_at == null);
      const mine = members.find((m) => m.user_id === userId);
      return JarSummarySchema.parse({
        id: j.id,
        name: j.name,
        rule: j.rule,
        defaultCents: j.default_cents,
        memberIds: activeMembers.map((m) => m.user_id),
        memberCount: activeMembers.length,
        jarTotalCents: members.reduce((s, m) => s + m.tally_cents, 0),
        myTallyCents: mine?.tally_cents ?? 0,
        myDaysClean: daysClean(mine?.streak_start_at ?? null),
        myShareStreak: !!mine?.share_streak,
        closedAt: j.closed_at == null ? null : Number(j.closed_at),
        closedBy: await closedByUser(j),
      });
    }),
  );
}

export async function getJarDetail(jarId: JarId, meId: UserId): Promise<JarDetailDTO | null> {
  const j = await jarRow(jarId);
  if (!j) return null;
  const rawMembers = await membersOf(jarId);
  const members = (
    await Promise.all(rawMembers.map((member) => serializeMember(member, meId)))
  ).sort((a, b) => b.tallyCents - a.tallyCents);
  return JarDetailSchema.parse({
    id: j.id,
    name: j.name,
    rule: j.rule,
    defaultCents: j.default_cents,
    inviteCode: j.invite_code,
    inviteExpiresAt: j.invite_expires_at == null ? null : Number(j.invite_expires_at),
    jarTotalCents: await jarTotal(jarId),
    members,
    activity: await activityForJar(jarId, 8),
    closedAt: j.closed_at == null ? null : Number(j.closed_at),
    closedBy: await closedByUser(j),
  });
}

export async function getJarPreviewByCode(code: InviteCode): Promise<{
  id: JarId;
  name: string;
  rule: string;
  defaultCents: number;
  members: Array<Pick<UserDTO, "id" | "name" | "color" | "emoji" | "photo">>;
  memberCount: number;
} | null> {
  const j = await jarRowByCode(code);
  if (!j) return null;
  const members = await activeMembersOf(j.id);
  const users = await Promise.all(
    members.map(async (member) =>
      requireValue(await getUser(member.user_id), "preview member could not be loaded"),
    ),
  );
  return JarPreviewSchema.parse({
    id: j.id,
    name: j.name,
    rule: j.rule,
    defaultCents: j.default_cents,
    members: users.map(({ id, name, color, emoji, photo }) => ({ id, name, color, emoji, photo })),
    memberCount: members.length,
  });
}

export async function createJar(opts: {
  userId: UserId;
  name: string;
  rule?: string;
  defaultCents?: number;
}): Promise<JarSummaryDTO> {
  const jid = id("jar");
  await withTransaction(async (db, emit) => {
    const invite = await freshInvite(db);
    const timezoneResult = await db.query<{ timezone: string }>(
      "SELECT timezone FROM users WHERE id=$1",
      [opts.userId],
    );
    const timezone = requireValue(timezoneResult.rows[0]?.timezone, "jar owner timezone missing");
    await db.query(
      "INSERT INTO jars (id, name, rule, default_cents, currency, created_by, invite_code, invite_expires_at, invite_version_id, timezone, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        jid,
        opts.name,
        opts.rule ?? "",
        opts.defaultCents ?? 500,
        "usd",
        opts.userId,
        invite.code,
        invite.expiresAt,
        invite.versionId,
        timezone,
        now(),
      ],
    );
    await addMembership(jid, opts.userId, "owner", db, true);
    await emit({ type: "jar.created", aggregateId: jid, aggregateVersion: 1 });
    await emit({ type: "invite.issued", aggregateId: invite.versionId, aggregateVersion: 1 });
  });
  const jars = await listJarsForUser(opts.userId);
  return requireValue(
    jars.find((jar) => jar.id === jid),
    "created jar could not be loaded",
  );
}

async function addMembership(
  jarId: JarId,
  userId: UserId,
  role: "owner" | "member",
  db: Queryable = pool,
  createTenure = true,
): Promise<{ membershipId: string; tenureId: MembershipTenureId | null }> {
  const joinedAt = now();
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO memberships (id, jar_id, user_id, role, tally_cents, streak_start_at, share_streak, joined_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (jar_id, user_id) DO UPDATE SET left_at=NULL RETURNING id",
    [id("mem"), jarId, userId, role, 0, null, 0, joinedAt],
  );
  const membershipId = requireValue(rows[0]?.id, "membership could not be persisted");
  if (!createTenure) return { membershipId, tenureId: null };
  const tenureId = id("mtn");
  await db.query(
    "INSERT INTO membership_tenures (id, membership_id, joined_at) VALUES ($1,$2,$3)",
    [tenureId, membershipId, joinedAt],
  );
  return { membershipId, tenureId };
}

export async function joinJarByCode(
  userId: UserId,
  code: InviteCode,
): Promise<{ jarId: JarId } | null> {
  return withTransaction(async (db, emit) => {
    // Lock and revalidate the invite in the same transaction that admits the
    // member. A concurrent close/rotation must serialize before or after this
    // join; it can no longer invalidate the code and then have this join commit.
    const j = await jarRowByCode(code, db, true);
    if (!j) return null;
    const already = await isMemberIn(db, j.id, userId, true);
    const membership = await addMembership(j.id, userId, "member", db, !already);
    if (!already) {
      await logActivity({ jarId: j.id, type: "join", actorId: userId }, db);
      await emit({
        type: "membership.joined",
        aggregateId: requireValue(membership.tenureId, "joined membership tenure missing"),
        aggregateVersion: 1,
      });
    }
    return { jarId: j.id };
  });
}

export async function closeJar(
  jarId: JarId,
  userId: UserId,
): Promise<{ status: "closed" | "forbidden" | "not_member" | "not_found" }> {
  return withTransaction(async (db, emit) => {
    const jar = await jarRow(jarId, db, true);
    if (!jar) return { status: "not_found" };
    const membership = await membershipRow(jarId, userId, db, true);
    if (!membership) return { status: "not_member" };
    if (membership.role !== "owner") return { status: "forbidden" };
    if (jar.closed_at == null) {
      await db.query(
        "UPDATE jars SET closed_at=$1, closed_by=$2, invite_code=NULL, invite_expires_at=NULL WHERE id=$3 AND closed_at IS NULL",
        [now(), userId, jarId],
      );
      await emit({ type: "jar.closed", aggregateId: jarId, aggregateVersion: 2 });
      const pendingReports = await db.query<{ id: string; aggregate_version: string }>(
        "SELECT id,aggregate_version FROM reports WHERE jar_id=$1 AND status='pending' ORDER BY id",
        [jarId],
      );
      for (const report of pendingReports.rows) {
        await emit({
          type: "report.jar_closed",
          aggregateId: ReportIdSchema.parse(report.id),
          aggregateVersion: AggregateVersionSchema.parse(report.aggregate_version),
        });
      }
      await emit({
        type: "invite.superseded",
        aggregateId: jar.invite_version_id,
        aggregateVersion: 2,
      });
    }
    return { status: "closed" };
  });
}

export async function rotateInvite(
  jarId: JarId,
  userId: UserId,
): Promise<{ status: "rotated" | "forbidden" | "jar_closed" | "not_member" | "not_found" }> {
  return withTransaction(async (db, emit) => {
    const jar = await jarRow(jarId, db, true);
    if (!jar) return { status: "not_found" };
    const membership = await membershipRow(jarId, userId, db, true);
    if (!membership) return { status: "not_member" };
    if (membership.role !== "owner") return { status: "forbidden" };
    if (jar.closed_at != null) return { status: "jar_closed" };
    const invite = await freshInvite(db);
    await db.query(
      "UPDATE jars SET invite_code=$1, invite_expires_at=$2, invite_version_id=$3 WHERE id=$4 AND closed_at IS NULL",
      [invite.code, invite.expiresAt, invite.versionId, jarId],
    );
    await emit({
      type: "invite.superseded",
      aggregateId: jar.invite_version_id,
      aggregateVersion: 2,
    });
    await emit({ type: "invite.issued", aggregateId: invite.versionId, aggregateVersion: 1 });
    return { status: "rotated" };
  });
}

export async function leaveJar(
  jarId: JarId,
  userId: UserId,
): Promise<{
  status: "left" | "owner_must_close" | "not_member" | "not_found" | "jar_closed";
}> {
  return withTransaction(async (db, emit) => {
    const jar = await jarRow(jarId, db, true);
    if (!jar) return { status: "not_found" };
    if (jar.closed_at != null) return { status: "jar_closed" };
    const membership = await membershipRow(jarId, userId, db, true);
    if (!membership) return { status: "not_member" };
    if (membership.role === "owner") return { status: "owner_must_close" };
    const leftAt = now();
    await db.query(
      "UPDATE memberships SET left_at=$1 WHERE jar_id=$2 AND user_id=$3 AND left_at IS NULL",
      [leftAt, jarId, userId],
    );
    const tenureResult = await db.query<{ id: string }>(
      "UPDATE membership_tenures SET left_at=$1 WHERE membership_id=$2 AND left_at IS NULL RETURNING id",
      [leftAt, membership.id],
    );
    await emit({
      type: "membership.left",
      aggregateId: MembershipTenureIdSchema.parse(
        requireValue(tenureResult.rows[0]?.id, "active membership tenure missing"),
      ),
      aggregateVersion: 2,
    });
    const pendingReports = await db.query<{ id: string; aggregate_version: string }>(
      `SELECT id,aggregate_version FROM reports
       WHERE jar_id=$1 AND accused_id=$2 AND status='pending' ORDER BY id`,
      [jarId, userId],
    );
    for (const report of pendingReports.rows) {
      await emit({
        type: "report.member_departed",
        aggregateId: ReportIdSchema.parse(report.id),
        aggregateVersion: AggregateVersionSchema.parse(report.aggregate_version),
      });
    }
    return { status: "left" };
  });
}

export async function setShareStreak(jarId: JarId, userId: UserId, val: boolean): Promise<void> {
  await assertJarOpen(jarId);
  if (!(await isMember(jarId, userId))) throw new Error("not a jar member");
  await pool.query("UPDATE memberships SET share_streak=$1 WHERE jar_id=$2 AND user_id=$3", [
    val ? 1 : 0,
    jarId,
    userId,
  ]);
}

// ─────────────────────────── slips ───────────────────────────
const MILESTONE_STEP = 5000; // 50 virtual points

export async function logSlip(opts: {
  jarId: JarId;
  userId: UserId;
  amountCents: number;
  note?: string | null;
  exLabel?: string | null;
  source?: "self" | "report";
  reportedBy?: UserId | null;
  reportId?: ReportId | null;
}): Promise<void> {
  await withTransaction((client, emit) => logSlipInTransaction(client, emit, opts));
}

async function logSlipInTransaction(
  db: Queryable,
  emit: DomainTransactionContext["emit"],
  opts: {
    jarId: JarId;
    userId: UserId;
    amountCents: number;
    note?: string | null;
    exLabel?: string | null;
    source?: "self" | "report";
    reportedBy?: UserId | null;
    reportId?: ReportId | null;
  },
): Promise<void> {
  await assertJarOpen(opts.jarId, db, true);
  if (!(await isMemberIn(db, opts.jarId, opts.userId, true))) {
    throw new Error("not a jar member");
  }
  const before = await jarTotal(opts.jarId, db);
  const slipId = id("slip");

  await db.query(
    "INSERT INTO slips (id, jar_id, user_id, amount_cents, note, ex_label, source, reported_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      slipId,
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
  await emit({ type: "slip.logged", aggregateId: slipId, aggregateVersion: 1 });
  await db.query(
    "UPDATE memberships SET tally_cents = tally_cents + $1, streak_start_at = $2 WHERE jar_id=$3 AND user_id=$4",
    [opts.amountCents, now(), opts.jarId, opts.userId],
  );

  await logActivity(
    {
      jarId: opts.jarId,
      type: "slip",
      actorId: opts.userId,
      amountCents: opts.amountCents,
      note: opts.note ?? null,
      reportId: opts.reportId ?? null,
    },
    db,
  );

  const after = before + opts.amountCents;
  for (
    let t = (Math.floor(before / MILESTONE_STEP) + 1) * MILESTONE_STEP;
    t <= after;
    t += MILESTONE_STEP
  ) {
    const milestoneId = id("jms");
    const milestone = await db.query<{ id: string }>(
      "INSERT INTO jar_milestones (id, jar_id, threshold_cents, reached_at) VALUES ($1,$2,$3,$4) ON CONFLICT (jar_id, threshold_cents) DO NOTHING RETURNING id",
      [milestoneId, opts.jarId, t, now()],
    );
    if (milestone.rows[0]) {
      await emit({
        type: "jar.milestone_crossed",
        aggregateId: JarMilestoneIdSchema.parse(milestone.rows[0].id),
        aggregateVersion: 1,
      });
    }
    await logActivity(
      {
        jarId: opts.jarId,
        type: "milestone",
        text: `The jar reached ${t / 100} virtual points. Keep supporting each other.`,
      },
      db,
    );
  }
}

// ─────────────────────────── reports ───────────────────────────
export async function createReport(opts: {
  jarId: JarId;
  accuserId: UserId;
  accusedId: UserId;
  note?: string | null;
  anonymous: boolean;
  amountCents: number;
  evidence: EvidenceImageInput[];
}): Promise<ReportDTO> {
  const rid = id("rpt");
  await withTransaction(async (db, emit) => {
    await assertJarOpen(opts.jarId, db, true);
    if (
      !(await isMemberIn(db, opts.jarId, opts.accuserId, true)) ||
      !(await isMemberIn(db, opts.jarId, opts.accusedId, true))
    ) {
      throw new Error("not a jar member");
    }
    await db.query(
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
    for (const image of opts.evidence) {
      await db.query(
        "INSERT INTO report_evidence (id, report_id, kind, payload, created_at) VALUES ($1,$2,$3,$4,$5)",
        [id("evi"), rid, "image", serializeEvidenceImageJson(image), now()],
      );
    }
    await logActivity(
      {
        jarId: opts.jarId,
        type: "report",
        actorId: opts.accusedId,
        targetId: opts.accuserId,
        anonymous: opts.anonymous,
        note: opts.note ?? null,
        reportId: rid,
      },
      db,
    );
    await emit({ type: "report.created", aggregateId: rid, aggregateVersion: 1 });
  });
  return requireValue(await serializeReport(rid), "created report could not be loaded");
}

type ReportRow = {
  id: ReportId;
  jar_id: JarId;
  accuser_id: UserId;
  accused_id: UserId;
  note: string | null;
  is_anonymous: number;
  amount_cents: number;
  status: ReportDTO["status"];
  created_at: number;
  resolved_at: number | null;
  aggregate_version: number;
};

type ReportDbRow = Omit<
  ReportRow,
  "id" | "jar_id" | "accuser_id" | "accused_id" | "aggregate_version" | "status"
> & {
  readonly id: string;
  readonly jar_id: string;
  readonly accuser_id: string;
  readonly accused_id: string;
  readonly aggregate_version: string;
  readonly status: string;
};

const AggregateVersionSchema = z.coerce.number().int().positive();

function parseReportRow(row: ReportDbRow): ReportRow {
  return {
    ...row,
    id: ReportIdSchema.parse(row.id),
    jar_id: JarIdSchema.parse(row.jar_id),
    accuser_id: UserIdSchema.parse(row.accuser_id),
    accused_id: UserIdSchema.parse(row.accused_id),
    aggregate_version: AggregateVersionSchema.parse(row.aggregate_version),
    status: ReportStatusSchema.parse(row.status),
  };
}

async function reportRow(
  reportId: ReportId,
  db: Queryable = pool,
  lock = false,
): Promise<ReportRow | null> {
  const { rows } = await db.query<ReportDbRow>(
    `SELECT * FROM reports WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [reportId],
  );
  return rows[0] ? parseReportRow(rows[0]) : null;
}

async function serializeReport(reportId: ReportId): Promise<ReportDTO | null> {
  const r = await reportRow(reportId);
  if (!r) return null;
  const j = await jarRow(r.jar_id);
  if (!j) return null;
  const { rows: evRows } = await pool.query<{ id: string; kind: string; payload: string }>(
    "SELECT id, kind, payload FROM report_evidence WHERE report_id=$1 ORDER BY created_at",
    [reportId],
  );
  const evidence = evRows.map((e) => ({
    id: EvidenceIdSchema.parse(e.id),
    kind: "image" as const,
    ...parseEvidenceImageJson(e.payload),
  }));
  return ReportSchema.parse({
    id: r.id,
    jarId: r.jar_id,
    jarName: j.name,
    accuser: r.is_anonymous ? null : await getUser(r.accuser_id),
    accused: requireValue(await getUser(r.accused_id), "report accused user could not be loaded"),
    note: r.note,
    anonymous: !!r.is_anonymous,
    amountCents: r.amount_cents,
    status: ReportStatusSchema.parse(r.status),
    ago: ago(r.created_at),
    evidence,
  });
}

export async function pendingReportsForUser(userId: UserId): Promise<ReportDTO[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT r.id FROM reports r
     JOIN memberships m ON m.jar_id=r.jar_id AND m.user_id=r.accused_id
     JOIN jars j ON j.id=r.jar_id
     WHERE r.accused_id=$1 AND r.status='pending' AND m.left_at IS NULL AND j.closed_at IS NULL
     ORDER BY r.created_at DESC`,
    [userId],
  );
  const results = await Promise.all(rows.map((r) => serializeReport(ReportIdSchema.parse(r.id))));
  return results.filter((r): r is ReportDTO => r !== null);
}

export async function reportHistoryForUser(userId: UserId): Promise<ReportDTO[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT r.id FROM reports r
     JOIN memberships m ON m.jar_id=r.jar_id
     WHERE m.user_id=$1 AND m.left_at IS NULL AND r.status<>'pending'
     ORDER BY COALESCE(r.resolved_at, r.created_at) DESC`,
    [userId],
  );
  const results = await Promise.all(
    rows.map((row) => serializeReport(ReportIdSchema.parse(row.id))),
  );
  return results.filter((report): report is ReportDTO => report !== null);
}

export async function reportForUser(reportId: ReportId, userId: UserId): Promise<ReportDTO | null> {
  const report = await reportRow(reportId);
  if (!report || !(await isMember(report.jar_id, userId))) return null;
  return serializeReport(reportId);
}

export async function resolveReport(
  reportId: ReportId,
  userId: UserId,
  action: "own" | "deny",
): Promise<ReportDTO | null> {
  const resolved = await withTransaction(async (db, emit) => {
    const r = await reportRow(reportId, db, true);
    if (!r || r.accused_id !== userId || r.status !== "pending") return false;
    await assertJarOpen(r.jar_id, db, true);
    if (!(await isMemberIn(db, r.jar_id, userId, true))) return false;
    if (action === "own") {
      await logSlipInTransaction(db, emit, {
        jarId: r.jar_id,
        userId: r.accused_id,
        amountCents: r.amount_cents,
        note: r.note,
        source: "report",
        reportedBy: r.accuser_id,
        reportId,
      });
      await db.query(
        "UPDATE reports SET status='owned', resolved_at=$1, aggregate_version=aggregate_version+1 WHERE id=$2",
        [now(), reportId],
      );
      await emit({ type: "report.owned", aggregateId: reportId, aggregateVersion: 2 });
    } else {
      await db.query(
        "UPDATE reports SET status='denied', resolved_at=$1, aggregate_version=aggregate_version+1 WHERE id=$2",
        [now(), reportId],
      );
      await logActivity(
        {
          jarId: r.jar_id,
          type: "deny",
          actorId: r.accused_id,
          reportId,
        },
        db,
      );
      await emit({ type: "report.denied", aggregateId: reportId, aggregateVersion: 2 });
    }
    return true;
  });
  if (!resolved) return null;
  return serializeReport(reportId);
}

// ─────────────────────────── activity ───────────────────────────
async function logActivity(
  opts: {
    jarId: JarId;
    type: ActivityType;
    actorId?: UserId | null;
    targetId?: UserId | null;
    text?: string | null;
    amountCents?: number | null;
    note?: string | null;
    anonymous?: boolean;
    reportId?: ReportId | null;
  },
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    "INSERT INTO activity (id, jar_id, type, actor_id, target_id, text, amount_cents, ex_label, note, anonymous, report_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [
      id("act"),
      opts.jarId,
      opts.type,
      opts.actorId ?? null,
      opts.targetId ?? null,
      opts.text ?? null,
      opts.amountCents ?? null,
      null,
      opts.note ?? null,
      opts.anonymous ? 1 : 0,
      opts.reportId ?? null,
      now(),
    ],
  );
}

type ActivityRow = {
  id: string;
  jar_id: JarId;
  type: ActivityType;
  actor_id: UserId | null;
  target_id: UserId | null;
  text: string | null;
  amount_cents: number | null;
  ex_label: string | null;
  note: string | null;
  anonymous: number;
  report_id: ReportId | null;
  created_at: number;
};

type ActivityDbRow = Omit<ActivityRow, "jar_id" | "actor_id" | "target_id" | "report_id"> & {
  readonly jar_id: string;
  readonly actor_id: string | null;
  readonly target_id: string | null;
  readonly report_id: string | null;
};

function parseActivityRow(row: ActivityDbRow): ActivityRow {
  return {
    ...row,
    jar_id: JarIdSchema.parse(row.jar_id),
    actor_id: row.actor_id == null ? null : UserIdSchema.parse(row.actor_id),
    target_id: row.target_id == null ? null : UserIdSchema.parse(row.target_id),
    report_id: row.report_id == null ? null : ReportIdSchema.parse(row.report_id),
  };
}

async function serializeActivity(a: ActivityRow): Promise<ActivityDTO> {
  const j = await jarRow(a.jar_id);
  return ActivitySchema.parse({
    id: a.id,
    jarId: a.jar_id,
    jarName: j?.name ?? "",
    reportId: a.report_id,
    type: a.type,
    user: a.actor_id ? await getUser(a.actor_id) : null,
    by: a.anonymous || !a.target_id ? null : await getUser(a.target_id),
    anonymous: !!a.anonymous,
    amountCents: a.amount_cents,
    note: a.note,
    text: a.text,
    ago: ago(a.created_at),
  });
}

async function activityForJar(jarId: JarId, limit = 50): Promise<ActivityDTO[]> {
  const { rows } = await pool.query<ActivityDbRow>(
    "SELECT * FROM activity WHERE jar_id=$1 ORDER BY created_at DESC LIMIT $2",
    [jarId, limit],
  );
  return Promise.all(rows.map(parseActivityRow).map(serializeActivity));
}

export async function activityForUser(userId: UserId, limit = 50): Promise<ActivityDTO[]> {
  const { rows } = await pool.query<ActivityDbRow>(
    `SELECT a.* FROM activity a JOIN memberships m ON m.jar_id=a.jar_id
     WHERE m.user_id=$1 AND m.left_at IS NULL ORDER BY a.created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return Promise.all(rows.map(parseActivityRow).map(serializeActivity));
}

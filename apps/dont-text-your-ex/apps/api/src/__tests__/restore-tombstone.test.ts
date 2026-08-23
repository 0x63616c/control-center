import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountDeletionIdSchema, UserIdSchema } from "../../../../contracts";
import {
  createFileRestoreTombstoneService,
  loadFileRestoreTombstones,
  parseRestoreTombstoneKeyring,
  restoreUserHmac,
  verifyRestoreTombstoneRecord,
} from "../restore-tombstone";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("restore tombstone journal", () => {
  it("durably stages and atomically publishes a signed pseudonymous deletion intent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dtye-tombstone-"));
    temporaryDirectories.push(directory);
    const hmacKeys = parseRestoreTombstoneKeyring({
      activeKeyId: "hmac-v1",
      keys: { "hmac-v1": Buffer.alloc(32, 21).toString("base64") },
    });
    const signingKeys = parseRestoreTombstoneKeyring({
      activeKeyId: "sign-v1",
      keys: { "sign-v1": Buffer.alloc(32, 22).toString("base64") },
    });
    const service = createFileRestoreTombstoneService({ directory, hmacKeys, signingKeys });
    const deletionRequestId = AccountDeletionIdSchema.parse("del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const userId = UserIdSchema.parse("usr_privatepersonidentifier");

    const record = service.prepare({ deletionRequestId, userId, createdAt: 1_000 });
    await service.stageIntent(record);

    const intent = await readFile(join(directory, `${deletionRequestId}.intent`), "utf8");
    expect(intent).not.toContain(userId);
    await expect(loadFileRestoreTombstones({ directory, signingKeys })).resolves.toEqual([record]);

    await service.publish(record);

    const serialized = await readFile(join(directory, `${deletionRequestId}.json`), "utf8");
    expect(serialized).not.toContain(userId);
    expect(verifyRestoreTombstoneRecord(JSON.parse(serialized), signingKeys)).toEqual(record);
    expect(await readdir(directory)).toEqual([`${deletionRequestId}.json`]);
    expect(record.expiresAt).toBe(1_000 + 31 * 24 * 60 * 60 * 1000);
  });

  it("replaces the pending record with a signed completion record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dtye-tombstone-"));
    temporaryDirectories.push(directory);
    const keys = parseRestoreTombstoneKeyring({
      activeKeyId: "v1",
      keys: { v1: Buffer.alloc(32, 23).toString("base64") },
    });
    const service = createFileRestoreTombstoneService({
      directory,
      hmacKeys: keys,
      signingKeys: keys,
    });
    const pending = service.prepare({
      deletionRequestId: AccountDeletionIdSchema.parse("del_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      userId: UserIdSchema.parse("usr_private"),
      createdAt: 1_000,
    });
    await service.publish(pending);

    const complete = service.complete(pending, 2_000);
    await service.publish(complete);

    expect(
      JSON.parse(await readFile(join(directory, `${pending.deletionRequestId}.json`), "utf8")),
    ).toMatchObject({ completedAt: 2_000, signature: complete.signature });
  });

  it("removes its temporary file when atomic publication fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dtye-tombstone-"));
    temporaryDirectories.push(directory);
    const keys = parseRestoreTombstoneKeyring({
      activeKeyId: "v1",
      keys: { v1: Buffer.alloc(32, 24).toString("base64") },
    });
    const service = createFileRestoreTombstoneService({
      directory,
      hmacKeys: keys,
      signingKeys: keys,
    });
    const record = service.prepare({
      deletionRequestId: AccountDeletionIdSchema.parse("del_cccccccccccccccccccccccccccccccc"),
      userId: UserIdSchema.parse("usr_private"),
      createdAt: 1_000,
    });
    await mkdir(join(directory, `${record.deletionRequestId}.json`));

    await expect(service.publish(record)).rejects.toThrow();
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("loads only verified records and fails closed on journal tampering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dtye-tombstone-"));
    temporaryDirectories.push(directory);
    const keys = parseRestoreTombstoneKeyring({
      activeKeyId: "v1",
      keys: { v1: Buffer.alloc(32, 25).toString("base64") },
    });
    const service = createFileRestoreTombstoneService({
      directory,
      hmacKeys: keys,
      signingKeys: keys,
    });
    const record = service.prepare({
      deletionRequestId: AccountDeletionIdSchema.parse("del_dddddddddddddddddddddddddddddddd"),
      userId: UserIdSchema.parse("usr_private"),
      createdAt: 1_000,
    });
    await service.publish(record);
    await expect(loadFileRestoreTombstones({ directory, signingKeys: keys })).resolves.toEqual([
      record,
    ]);

    const path = join(directory, `${record.deletionRequestId}.json`);
    await writeFile(path, `${JSON.stringify({ ...record, completedAt: 2_000 })}\n`, "utf8");
    await expect(loadFileRestoreTombstones({ directory, signingKeys: keys })).rejects.toThrow(
      "restore tombstone signature is invalid",
    );
  });

  it("discards a staged intent after a normal transaction rollback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dtye-tombstone-"));
    temporaryDirectories.push(directory);
    const keys = parseRestoreTombstoneKeyring({
      activeKeyId: "v1",
      keys: { v1: Buffer.alloc(32, 27).toString("base64") },
    });
    const service = createFileRestoreTombstoneService({
      directory,
      hmacKeys: keys,
      signingKeys: keys,
    });
    const record = service.prepare({
      deletionRequestId: AccountDeletionIdSchema.parse("del_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
      userId: UserIdSchema.parse("usr_private"),
      createdAt: 1_000,
    });

    await service.stageIntent(record);
    await service.discardIntent(record);

    await expect(loadFileRestoreTombstones({ directory, signingKeys: keys })).resolves.toEqual([]);
  });

  it("rejects an unavailable HMAC key version", () => {
    const keys = parseRestoreTombstoneKeyring({
      activeKeyId: "v1",
      keys: { v1: Buffer.alloc(32, 26).toString("base64") },
    });
    expect(() => restoreUserHmac(UserIdSchema.parse("usr_private"), keys, "retired")).toThrow(
      "restore tombstone HMAC key is missing",
    );
  });
});

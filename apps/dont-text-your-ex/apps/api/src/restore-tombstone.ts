import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type AccountDeletionId, AccountDeletionIdSchema, type UserId } from "../../../contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

const encodedKeySchema = z.string().transform((value, context) => {
  const key = Buffer.from(value, "base64");
  if (key.length < 32) {
    context.addIssue({
      code: "custom",
      message: "restore tombstone keys must be at least 32 bytes",
    });
    return z.NEVER;
  }
  return key;
});
const keyringSchema = z
  .object({
    activeKeyId: z.string().min(1),
    keys: z.record(z.string().min(1), encodedKeySchema),
  })
  .strict();

export type RestoreTombstoneKeyring = Readonly<{
  activeKeyId: string;
  keys: Readonly<Record<string, Buffer>>;
}>;

const unsignedRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    deletionRequestId: AccountDeletionIdSchema,
    userHmac: z.string().regex(/^[a-f0-9]{64}$/),
    hmacKeyVersion: z.string().min(1),
    completedAt: z.number().int().nonnegative().nullable(),
    expiresAt: z.number().int().positive(),
    signatureVersion: z.literal(1),
    signatureKeyVersion: z.string().min(1),
  })
  .strict();
export const RestoreTombstoneRecordSchema = unsignedRecordSchema
  .extend({ signature: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

type UnsignedRestoreTombstoneRecord = z.infer<typeof unsignedRecordSchema>;
export type RestoreTombstoneRecord = z.infer<typeof RestoreTombstoneRecordSchema>;

export interface RestoreTombstoneService {
  prepare(input: {
    deletionRequestId: AccountDeletionId;
    userId: UserId;
    createdAt: number;
  }): RestoreTombstoneRecord;
  complete(record: RestoreTombstoneRecord, completedAt: number): RestoreTombstoneRecord;
  stageIntent(record: RestoreTombstoneRecord): Promise<void>;
  publish(record: RestoreTombstoneRecord): Promise<void>;
  discardIntent(record: RestoreTombstoneRecord): Promise<void>;
  remove(record: RestoreTombstoneRecord): Promise<void>;
}

export function parseRestoreTombstoneKeyring(input: unknown): RestoreTombstoneKeyring {
  const parsed = keyringSchema.parse(input);
  if (!parsed.keys[parsed.activeKeyId]) throw new Error("active restore tombstone key is missing");
  return parsed;
}

function unsigned(record: RestoreTombstoneRecord): UnsignedRestoreTombstoneRecord {
  const { signature: _signature, ...value } = record;
  return value;
}

function sign(
  value: UnsignedRestoreTombstoneRecord,
  signingKeys: RestoreTombstoneKeyring,
): RestoreTombstoneRecord {
  const key = signingKeys.keys[value.signatureKeyVersion];
  if (!key) throw new Error("restore tombstone signing key is missing");
  return {
    ...value,
    signature: createHmac("sha256", key).update(JSON.stringify(value)).digest("hex"),
  };
}

export function verifyRestoreTombstoneRecord(
  input: unknown,
  signingKeys: RestoreTombstoneKeyring,
): RestoreTombstoneRecord {
  const record = RestoreTombstoneRecordSchema.parse(input);
  const expected = sign(unsigned(record), signingKeys).signature;
  if (!timingSafeEqual(Buffer.from(record.signature, "hex"), Buffer.from(expected, "hex"))) {
    throw new Error("restore tombstone signature is invalid");
  }
  return record;
}

export function restoreUserHmac(
  userId: UserId,
  hmacKeys: RestoreTombstoneKeyring,
  keyVersion: string,
): string {
  const key = hmacKeys.keys[keyVersion];
  if (!key) throw new Error("restore tombstone HMAC key is missing");
  return createHmac("sha256", key).update(userId).digest("hex");
}

export async function loadFileRestoreTombstones(input: {
  readonly directory: string;
  readonly signingKeys: RestoreTombstoneKeyring;
}): Promise<readonly RestoreTombstoneRecord[]> {
  const names = await readdir(input.directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const records: RestoreTombstoneRecord[] = [];
  for (const name of names
    .filter((value) => /^del_[A-Za-z0-9]+\.(json|intent)$/.test(value))
    .sort()) {
    const serialized = await readFile(join(input.directory, name), "utf8");
    const record = verifyRestoreTombstoneRecord(JSON.parse(serialized), input.signingKeys);
    if (
      ![`${record.deletionRequestId}.json`, `${record.deletionRequestId}.intent`].includes(name)
    ) {
      throw new Error("restore tombstone filename does not match its deletion request");
    }
    records.push(record);
  }
  return records;
}

export function createFileRestoreTombstoneService(input: {
  readonly directory: string;
  readonly hmacKeys: RestoreTombstoneKeyring;
  readonly signingKeys: RestoreTombstoneKeyring;
}): RestoreTombstoneService {
  const signed = (value: Omit<UnsignedRestoreTombstoneRecord, "signatureKeyVersion">) =>
    sign({ ...value, signatureKeyVersion: input.signingKeys.activeKeyId }, input.signingKeys);
  const pathFor = (record: RestoreTombstoneRecord, extension: ".json" | ".intent") =>
    join(input.directory, `${record.deletionRequestId}${extension}`);
  const syncDirectory = async () => {
    const handle = await open(input.directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  const writeAtomic = async (record: RestoreTombstoneRecord, destination: string) => {
    await mkdir(input.directory, { recursive: true, mode: 0o700 });
    const temporary = join(input.directory, `.${record.deletionRequestId}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
      await syncDirectory();
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  };
  const removeIfPresent = async (path: string) => {
    const removed = await unlink(path)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
    if (removed) await syncDirectory();
  };
  return {
    prepare({ deletionRequestId, userId, createdAt }) {
      return signed({
        schemaVersion: 1,
        deletionRequestId,
        userHmac: restoreUserHmac(userId, input.hmacKeys, input.hmacKeys.activeKeyId),
        hmacKeyVersion: input.hmacKeys.activeKeyId,
        completedAt: null,
        expiresAt: createdAt + 31 * DAY_MS,
        signatureVersion: 1,
      });
    },
    complete(record, completedAt) {
      return signed({
        ...unsigned(record),
        completedAt,
        expiresAt: completedAt + 31 * DAY_MS,
      });
    },
    async stageIntent(record) {
      const checked = verifyRestoreTombstoneRecord(record, input.signingKeys);
      await writeAtomic(checked, pathFor(checked, ".intent"));
    },
    async publish(record) {
      const checked = verifyRestoreTombstoneRecord(record, input.signingKeys);
      await writeAtomic(checked, pathFor(checked, ".json"));
      await removeIfPresent(pathFor(checked, ".intent"));
    },
    async discardIntent(record) {
      const checked = verifyRestoreTombstoneRecord(record, input.signingKeys);
      await removeIfPresent(pathFor(checked, ".intent"));
    },
    async remove(record) {
      const checked = verifyRestoreTombstoneRecord(record, input.signingKeys);
      await removeIfPresent(pathFor(checked, ".json"));
      await removeIfPresent(pathFor(checked, ".intent"));
    },
  };
}

import { readFile } from "node:fs/promises";
import { pool } from "./db/index";
import { runMigrations } from "./db/migrate";
import { DomainTransactionRunner } from "./domain-transaction";
import { isolatedRestoreReplayConfig } from "./env";
import { replayRestoreTombstones } from "./restore-replay";
import { loadFileRestoreTombstones, parseRestoreTombstoneKeyring } from "./restore-tombstone";

async function readKeyring(path: string) {
  return parseRestoreTombstoneKeyring(JSON.parse(await readFile(path, "utf8")));
}

async function main(): Promise<void> {
  const config = isolatedRestoreReplayConfig();
  const hmacKeys = await readKeyring(config.hmacKeyringFile);
  const signingKeys = await readKeyring(config.signingKeyringFile);

  await runMigrations();
  const records = await loadFileRestoreTombstones({
    directory: config.journalDirectory,
    signingKeys,
  });
  const result = await replayRestoreTombstones({
    pool,
    transactions: new DomainTransactionRunner({ pool }),
    records,
    hmacKeys,
    now: Date.now(),
  });
  process.stdout.write(`${JSON.stringify({ status: "passed", ...result })}\n`);
}

try {
  await main();
} finally {
  await pool.end();
}

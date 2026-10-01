import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";

const input = JSON.parse(await Bun.stdin.text()) as {
  database: string;
  readyPath: string;
  releaseStartPath: string;
  releasedPath: string;
  releaseDelayMs: number;
};
const database = new Database(input.database, { strict: true });
try {
  database.exec("CREATE TABLE initializer_control (id TEXT PRIMARY KEY)");
  database.exec("BEGIN IMMEDIATE");
  database.query("INSERT INTO initializer_control VALUES (?)").run("initializer");
  writeFileSync(input.readyPath, "ready");
  const deadline = Date.now() + 10_000;
  while (!existsSync(input.releaseStartPath)) {
    if (Date.now() > deadline) throw new Error("Initializer release was not requested");
    await Bun.sleep(5);
  }
  await Bun.sleep(input.releaseDelayMs);
  database.exec("COMMIT");
  writeFileSync(input.releasedPath, "released");
} finally {
  if (database.inTransaction) database.exec("ROLLBACK");
  database.close();
}

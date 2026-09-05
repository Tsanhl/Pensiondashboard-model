import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const usersDir = path.join(dataDir, "users");
const dbPath = process.env.PENSIONS_DB_PATH || path.join(dataDir, "pensions-dashboard.sqlite");
const demoUsers = ["alex-morgan", "empty-demo"];

if (!dataDir.startsWith(`${root}${path.sep}`)) {
  throw new Error("Refusing to reset a path outside the project directory.");
}

await mkdir(dataDir, { recursive: true });

for (const userId of demoUsers) {
  const userDir = path.join(usersDir, userId);
  if (userDir.startsWith(`${usersDir}${path.sep}`)) {
    await rm(userDir, { recursive: true, force: true });
  }
}

if (existsSync(dbPath)) {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    if (tables.has("user_records")) {
      const remove = db.prepare("DELETE FROM user_records WHERE user_id = ?");
      for (const userId of demoUsers) remove.run(userId);
    }
  } finally {
    db.close();
  }
}

console.log("Demo profile data reset. Approved corpus records were left in place. Restart the server to regenerate the sample portfolio.");

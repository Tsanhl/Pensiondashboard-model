import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");

if (!dataDir.startsWith(`${root}${path.sep}`)) {
  throw new Error("Refusing to reset a path outside the project directory.");
}

await rm(dataDir, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

console.log("Local demo data reset. Restart the server to regenerate clean sample data.");

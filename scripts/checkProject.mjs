import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const roots = ["app.js", "server.js", "server", "scripts", "test", "tools"];
const files = [];
function visit(path) {
  if (!path || path.includes("node_modules")) return;
  if (/\.(?:js|mjs)$/.test(path)) { files.push(path); return; }
  for (const entry of readdirSync(path, { withFileTypes:true })) {
    const next = join(path, entry.name);
    if (entry.isDirectory()) visit(next);
    else if (/\.(?:js|mjs)$/.test(next)) files.push(next);
  }
}
for (const root of roots) visit(root);
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio:"inherit" });
console.log(`Syntax checked ${files.length} JavaScript files.`);

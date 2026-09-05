import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export const now = () => new Date().toISOString();
export const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function fsyncDirectory(path) {
  const fd = openSync(path,"r");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

export function durableMkdir(path,{ mode = 0o700 } = {}) {
  const absolute = resolve(path);
  if (existsSync(absolute)) {
    if (!statSync(absolute).isDirectory()) throw new Error(`Directory path is occupied by a non-directory: ${absolute}`);
    fsyncDirectory(absolute);
    return absolute;
  }
  const missing = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!existsSync(cursor)) throw new Error(`No existing parent is available for directory creation: ${absolute}`);
  for (const directory of missing.reverse()) {
    try { mkdirSync(directory,{ mode }); }
    catch (error) { if (error?.code !== "EEXIST" || !statSync(directory).isDirectory()) throw error; }
    fsyncDirectory(directory);
    fsyncDirectory(dirname(directory));
  }
  return absolute;
}

export function durableUnlink(path) {
  if (!existsSync(path)) return false;
  rmSync(path,{ force:true });
  fsyncDirectory(dirname(path));
  return !existsSync(path);
}

export function atomicWrite(path, value) {
  durableMkdir(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const body = Buffer.isBuffer(value) ? value : typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  const fd = openSync(temporary,"wx",0o600);
  try { writeFileSync(fd,body); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

export function createExclusive(path, value,{ mode = 0o600 } = {}) {
  durableMkdir(dirname(path));
  const fd = openSync(path, "wx", mode);
  try { writeFileSync(fd, Buffer.isBuffer(value) ? value : typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  fsyncDirectory(dirname(path));
}

export function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path,"r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(descriptor,buffer,0,buffer.length,null);
      if (!bytes) break;
      hash.update(buffer.subarray(0,bytes));
    }
  } finally { closeSync(descriptor); }
  return hash.digest("hex");
}

export function fileRecord(root, path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`Required file is missing: ${path}`);
  if (lstatSync(absolute).isSymbolicLink()) throw new Error(`Required file must not be a symlink: ${path}`);
  const realRoot = realpathSync.native(resolve(root));
  const real = realpathSync.native(absolute);
  const rel = relative(realRoot, real);
  if (rel.startsWith("..") || resolve(realRoot, rel) !== real) throw new Error(`Required file leaves the project root: ${path}`);
  return { path: relative(root, absolute) || ".", bytes: statSync(absolute).size, sha256: sha256File(absolute) };
}

export function canonicalHash(value) {
  const ordered = (item) => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().map((key) => [key, ordered(item[key])]));
    return item;
  };
  return sha256Buffer(JSON.stringify(ordered(value)));
}

export function runId(prefix = "qualification") {
  return `${prefix}-${now().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

export function assert(condition, message, code = "WORKER_INVARIANT_FAILED") {
  if (!condition) throw Object.assign(new Error(message), { code });
}

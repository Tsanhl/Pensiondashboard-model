import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPostgresStorage, newId, postgresQuery, readDocumentUploads, writeDocumentUploads } from "../store/userDataStore.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LOCAL_ROOT = resolve(ROOT, process.env.OBJECT_STORAGE_DIR || "uploads/objects");
const TOKEN_TTL_MS = 10 * 60 * 1000;

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function safeObjectPath(key) {
  const target = resolve(LOCAL_ROOT, key);
  if (!target.startsWith(`${LOCAL_ROOT}/`)) throw Object.assign(new Error("Invalid object key"), { status: 400 });
  return target;
}

function objectMode() {
  return String(process.env.OBJECT_STORAGE_MODE || "local").toLowerCase();
}

export function signatureMatches(buffer, mimeType) {
  if (mimeType === "application/pdf") return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mimeType === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (mimeType === "image/jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (mimeType.startsWith("text/") || mimeType === "application/json") return !buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
  return false;
}

async function s3Client() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT || undefined,
    region: process.env.S3_REGION || "us-east-1",
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || "true").toLowerCase() === "true",
    credentials: process.env.S3_ACCESS_KEY_ID ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "" } : undefined
  });
}

async function saveUploadRecord(userId, record) {
  if (isPostgresStorage()) {
    await postgresQuery(
      `INSERT INTO document_uploads (id,user_id,filename,mime_type,size_bytes,checksum,object_key,status,upload_token_hash,expires_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       ON CONFLICT (id) DO UPDATE SET checksum=EXCLUDED.checksum,object_key=EXCLUDED.object_key,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at`,
      [record.id,userId,record.filename,record.mimeType,record.sizeBytes,record.checksum || null,record.objectKey,record.status,record.uploadTokenHash || null,record.expiresAt || null,record.updatedAt]
    );
    return;
  }
  const records = readDocumentUploads(userId);
  const index = records.findIndex((item) => item.id === record.id);
  if (index >= 0) records[index] = record;
  else records.unshift(record);
  writeDocumentUploads(userId, records);
}

export async function getUploadRecord(userId, id) {
  if (isPostgresStorage()) {
    const result = await postgresQuery(
      `SELECT id,user_id AS "userId",filename,mime_type AS "mimeType",size_bytes AS "sizeBytes",checksum,
              object_key AS "objectKey",status,upload_token_hash AS "uploadTokenHash",expires_at AS "expiresAt",
              created_at AS "createdAt",updated_at AS "updatedAt" FROM document_uploads WHERE id=$1 AND user_id=$2`, [id,userId]
    );
    return result.rows[0] || null;
  }
  return readDocumentUploads(userId).find((item) => item.id === id) || null;
}

export async function createUploadIntent(userId, input = {}, origin = "") {
  const filename = String(input.filename || "").trim().slice(0, 255);
  const mimeType = String(input.mime_type || input.mimeType || "application/octet-stream").toLowerCase();
  const sizeBytes = Number(input.size_bytes ?? input.sizeBytes);
  const max = Number(process.env.DOCUMENT_MAX_BYTES || 20 * 1024 * 1024);
  const allowed = new Set(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "text/csv", "application/json", "image/png", "image/jpeg"]);
  if (!filename || !Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > max) throw Object.assign(new Error(`Document size must be between 1 byte and ${max} bytes.`), { status: 400 });
  if (!allowed.has(mimeType)) throw Object.assign(new Error("Unsupported document type."), { status: 415 });
  const quota = Math.max(1, Number(process.env.DOCUMENT_UPLOAD_QUOTA || 100));
  const uploadCount = isPostgresStorage()
    ? Number((await postgresQuery("SELECT count(*)::int AS count FROM document_uploads WHERE user_id=$1 AND status <> 'deleted'", [userId])).rows[0]?.count || 0)
    : readDocumentUploads(userId).filter((item) => item.status !== "deleted").length;
  if (uploadCount >= quota) throw Object.assign(new Error("Document upload quota reached."), { status: 429 });
  const id = newId("upload");
  const token = randomBytes(32).toString("base64url");
  const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).replace(/[^a-zA-Z0-9.]/g, "") : "";
  const objectKey = `${userId}/${id}/original${extension}`;
  const now = new Date().toISOString();
  const record = { id,userId,filename,mimeType,sizeBytes,checksum:null,objectKey,status:"pending",uploadTokenHash:tokenHash(token),expiresAt:new Date(Date.now()+TOKEN_TTL_MS).toISOString(),createdAt:now,updatedAt:now };
  let uploadUrl = `${origin}/api/documents/uploads/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
  if (objectMode() === "s3") {
    const [{ PutObjectCommand }, { getSignedUrl }] = await Promise.all([import("@aws-sdk/client-s3"), import("@aws-sdk/s3-request-presigner")]);
    uploadUrl = await getSignedUrl(await s3Client(), new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey, ContentType: mimeType, ContentLength: sizeBytes, ServerSideEncryption:"AES256" }), { expiresIn: 600 });
  }
  await saveUploadRecord(userId, record);
  return { document_id:id, upload_url:uploadUrl, method:"PUT", headers:{ "Content-Type":mimeType, ...(objectMode() === "s3" ? { "x-amz-server-side-encryption":"AES256" } : {}) }, expires_at:record.expiresAt };
}

export async function acceptLocalUpload(userId, id, token, buffer, mimeType) {
  const record = await getUploadRecord(userId, id);
  if (!record || record.uploadTokenHash !== tokenHash(String(token || ""))) throw Object.assign(new Error("Invalid upload token."), { status: 403 });
  if (Date.parse(record.expiresAt) <= Date.now()) throw Object.assign(new Error("Upload token expired."), { status: 410 });
  if (buffer.length !== Number(record.sizeBytes)) throw Object.assign(new Error("Uploaded size does not match the upload intent."), { status: 400 });
  if (String(mimeType || "").split(";")[0].toLowerCase() !== record.mimeType) throw Object.assign(new Error("Uploaded MIME type does not match the upload intent."), { status: 400 });
  if (!signatureMatches(buffer, record.mimeType)) throw Object.assign(new Error("File signature does not match the declared MIME type."), { status: 415 });
  const target = safeObjectPath(record.objectKey);
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, buffer, { flag: "wx" });
  record.checksum = createHash("sha256").update(buffer).digest("hex");
  record.status = "uploaded";
  record.updatedAt = new Date().toISOString();
  await saveUploadRecord(userId, record);
  return record;
}

export async function readObject(record) {
  if (objectMode() === "s3") {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const result = await (await s3Client()).send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: record.objectKey }));
    return Buffer.from(await result.Body.transformToByteArray());
  }
  return readFile(safeObjectPath(record.objectKey));
}

export async function writeNormalizedText(userId, documentId, text) {
  const key = `${userId}/${documentId}/normalized.txt`;
  if (objectMode() === "s3") {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await s3Client()).send(new PutObjectCommand({ Bucket:process.env.S3_BUCKET, Key:key, Body:text, ContentType:"text/plain; charset=utf-8",ServerSideEncryption:"AES256" }));
  } else {
    const target = safeObjectPath(key);
    await mkdir(resolve(target, ".."), { recursive:true });
    await writeFile(target, text, "utf8");
  }
  return key;
}

export async function markUploadComplete(userId, record, patch = {}) {
  Object.assign(record, patch, { status:"active", updatedAt:new Date().toISOString(), uploadTokenHash:null });
  await saveUploadRecord(userId, record);
  return record;
}

export async function deleteUploadRecord(userId, id) {
  if (isPostgresStorage()) {
    const result = await postgresQuery("DELETE FROM document_uploads WHERE id=$1 AND user_id=$2", [id,userId]);
    return result.rowCount > 0;
  }
  const records = readDocumentUploads(userId);
  const next = records.filter((item) => item.id !== id);
  writeDocumentUploads(userId, next);
  return next.length !== records.length;
}

export async function deleteStoredObject(key) {
  if (!key) return;
  if (objectMode() === "s3") {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await s3Client()).send(new DeleteObjectCommand({ Bucket:process.env.S3_BUCKET, Key:key }));
  } else {
    try { await unlink(safeObjectPath(key)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export async function extractReadableText(buffer, mimeType) {
  if (mimeType === "application/pdf") {
    const module = await import("pdf-parse");
    const parsePdf = module.default || module;
    return String((await parsePdf(buffer)).text || "").trim();
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = await import("mammoth");
    return String((await mammoth.extractRawText({ buffer })).value || "").trim();
  }
  if (mimeType.startsWith("text/") || mimeType === "application/json") return buffer.toString("utf8").trim();
  if (mimeType.startsWith("image/") && process.env.OCR_SERVICE_URL) {
    const response = await fetch(String(process.env.OCR_SERVICE_URL).replace(/\/$/, "") + "/ocr", {
      method:"POST",headers:{ "Content-Type":mimeType },body:buffer,signal:AbortSignal.timeout(Number(process.env.OCR_TIMEOUT_MS || 120_000))
    });
    if (!response.ok) throw Object.assign(new Error(`OCR service returned ${response.status}.`), { status:502 });
    const payload = await response.json();
    if (!String(payload.text || "").trim()) throw Object.assign(new Error("OCR found no readable text."), { status:422 });
    return String(payload.text).trim();
  }
  throw Object.assign(new Error("OCR is required for this image. Configure OCR_SERVICE_URL before indexing it."), { status: 422 });
}

export async function scanDocumentBuffer(buffer, mimeType) {
  if (!process.env.MALWARE_SCAN_URL) {
    if (String(process.env.REQUIRE_MALWARE_SCAN || "false").toLowerCase() === "true") throw Object.assign(new Error("Document scanning service is required but unavailable."), { status:503 });
    return { clean:true,mode:"development-bypass" };
  }
  const response = await fetch(String(process.env.MALWARE_SCAN_URL).replace(/\/$/, "") + "/scan", {
    method:"POST",headers:{ "Content-Type":mimeType },body:buffer,signal:AbortSignal.timeout(Number(process.env.MALWARE_SCAN_TIMEOUT_MS || 60_000))
  });
  if (!response.ok) throw Object.assign(new Error(`Document scanning service returned ${response.status}.`), { status:502 });
  const result = await response.json();
  if (result.clean !== true) throw Object.assign(new Error("Document failed the security scan."), { status:422 });
  return result;
}

export function objectStorageStatus() {
  return { mode:objectMode(), encryptedRequired:true, bucket:objectMode() === "s3" ? process.env.S3_BUCKET || null : null };
}

export async function objectStorageReadiness({ requireS3 = false } = {}) {
  const mode = objectMode();
  if (requireS3 && mode !== "s3") return { ready:false,code:"OBJECT_STORAGE_S3_REQUIRED",mode };
  if (mode === "s3") {
    if (!String(process.env.S3_BUCKET || "").trim()) return { ready:false,code:"OBJECT_STORAGE_BUCKET_MISSING",mode };
    try {
      const { HeadBucketCommand } = await import("@aws-sdk/client-s3");
      await (await s3Client()).send(
        new HeadBucketCommand({ Bucket:process.env.S3_BUCKET }),
        { abortSignal:AbortSignal.timeout(Number(process.env.READINESS_DEPENDENCY_TIMEOUT_MS || 3_000)) }
      );
      return { ready:true,code:"OBJECT_STORAGE_READY",mode };
    } catch {
      return { ready:false,code:"OBJECT_STORAGE_UNAVAILABLE",mode };
    }
  }
  try {
    await mkdir(LOCAL_ROOT, { recursive:true });
    await access(LOCAL_ROOT, constants.R_OK | constants.W_OK);
    return { ready:true,code:"OBJECT_STORAGE_READY",mode };
  } catch {
    return { ready:false,code:"OBJECT_STORAGE_UNAVAILABLE",mode };
  }
}

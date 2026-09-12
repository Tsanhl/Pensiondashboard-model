import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.argv[2] || "approved-materials/review/private-source-manifest.template.json");
const manifest = JSON.parse(await readFile(path,"utf8"));
const records = Array.isArray(manifest.records) ? manifest.records : null;
if (!records) throw new Error("Manifest records must be an array.");
const allowed = new Set(["scheme_rules","provider_policy","statement_of_investment_principles","user_pension_document"]);
const required = ["id","user_id","source_type","title","issuer","jurisdiction","version","effective_date","checksum_sha256","object_key","approval_status"];
const ids = new Set();
for (const [index,record] of records.entries()) {
  for (const field of required) if (record[field] == null || String(record[field]).trim() === "") throw new Error(`Record ${index + 1} is missing ${field}.`);
  if (ids.has(record.id)) throw new Error(`Duplicate private document id: ${record.id}`);
  ids.add(record.id);
  if (record.user_id === "__public__") throw new Error(`${record.id} cannot use the public corpus owner.`);
  if (!allowed.has(record.source_type)) throw new Error(`${record.id} has an unsupported source_type.`);
  if (!/^[a-f0-9]{64}$/i.test(record.checksum_sha256)) throw new Error(`${record.id} has an invalid SHA-256 checksum.`);
  if (!Number.isFinite(Date.parse(record.effective_date))) throw new Error(`${record.id} has an invalid effective_date.`);
  if (record.expiry_date && Date.parse(record.expiry_date) <= Date.parse(record.effective_date)) throw new Error(`${record.id} expiry_date must be later than effective_date.`);
  if (!["pending_upload","quarantined","pending_review","active_private","superseded","deleted"].includes(record.approval_status)) throw new Error(`${record.id} has an unsupported approval_status.`);
  if (record.scope && record.scope !== "USER_DOCUMENTS") throw new Error(`${record.id} must use USER_DOCUMENTS scope.`);
}
console.log(JSON.stringify({ valid:true,path,records:records.length,publicRecords:0 },null,2));

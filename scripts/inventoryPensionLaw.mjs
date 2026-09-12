import { createHash } from "node:crypto";
import { readdir,readFile,stat,writeFile } from "node:fs/promises";
import { extname,join,relative,resolve } from "node:path";

const sourceRoot = resolve(process.argv[2] || "/Users/hltsang/Desktop/Law/Pensions Law");
const outputRoot = resolve("approved-materials","index");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes:true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function classify(path) {
  const value = path.toLowerCase();
  if (/\.ds_store$|\/\~\$/.test(value)) return ["system_file","excluded"];
  if (/pensions law summative|pensions law formative|receipt_|risk management checklist|oscola checklist/.test(value)) return ["personal_coursework","excluded_from_answer_corpus"];
  if (/06a092025-v2 plm handbook|29a092024-v1 plm whistlestop|plm.*handbook|seminar .*handbook|handout slides|questions.*\.docx/.test(value)) return ["course_material","excluded_pending_rights_review"];
  if (/regulations full version|\/regulations\/|\b(act|regulations|directive|tfeu|schedule)\b.*\.pdf$/.test(value)) return ["legislation_or_regulation","official_refresh_required"];
  if (/\/cases?\/|\bv\.?\s|judgment|\buksc\b|\bewhc\b|\bewca\b|\becj\b|\bcjeu\b/.test(value)) return ["case_law","metadata_and_rights_review"];
  if (/journals|david pollard|corporate insolvency pension rights|commentary|opinion/.test(value)) return ["secondary_commentary","licence_review_required"];
  if (/trust deed|financial statements|member guide|provider|scheme rules/.test(value)) return ["scheme_or_provider_document","private_context_only"];
  if (/summary|notes|principles|basics/.test(value)) return ["study_note","pending_legal_review"];
  return ["unclassified","manual_review_required"];
}

const rows = [];
for (const path of await walk(sourceRoot)) {
  const info = await stat(path);
  const buffer = await readFile(path);
  const [sourceType,status] = classify(path);
  rows.push({ id:createHash("sha256").update(path).digest("hex").slice(0, 20),relativePath:relative(sourceRoot,path),absolutePath:path,extension:extname(path).toLowerCase(),bytes:info.size,sha256:createHash("sha256").update(buffer).digest("hex"),sourceType,status });
}
rows.sort((left,right) => left.relativePath.localeCompare(right.relativePath));
await writeFile(resolve(outputRoot,"source-inventory.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
const byStatus = rows.reduce((result,row) => ({ ...result,[row.status]:(result[row.status] || 0) + 1 }), {});
const byType = rows.reduce((result,row) => ({ ...result,[row.sourceType]:(result[row.sourceType] || 0) + 1 }), {});
await writeFile(resolve(outputRoot,"source-inventory-summary.json"), `${JSON.stringify({ generatedAt:new Date().toISOString(),sourceRoot,total:rows.length,bytes:rows.reduce((sum,row) => sum + row.bytes,0),byStatus,byType }, null, 2)}\n`);
console.log(JSON.stringify({ total:rows.length,byStatus,byType }, null, 2));

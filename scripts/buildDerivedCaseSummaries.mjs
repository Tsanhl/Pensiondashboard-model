import { createHash } from "node:crypto";
import { mkdir,readFile,writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("approved-materials");
const output = resolve(root,"index","derived-case-summaries");
await mkdir(output,{ recursive:true });
const sources = JSON.parse(await readFile(resolve(root,"derived-case-summary-sources.json"),"utf8"));
const generatedAt = new Date().toISOString();
const version = Number(generatedAt.slice(0,10).replaceAll("-",""));

for (const source of sources) {
  const text = [
    `CASE: ${source.title}`,
    `OSCOLA: ${source.oscola_citation}`,
    "STATUS: Independently authored, source-bound case summary. It is not the judgment and is ranked below an active judgment.",
    "SOURCE CONTROL: The underlying seminar-folder law-report reproductions remain in legal/rights review and are not copied into the active corpus.",
    ...source.sections.flatMap((section)=>[`HEADING: ${section.heading}`,section.text]),
    `RELATED ACTIVE AUTHORITIES: ${source.related_active_authorities.join(", ")}`
  ].join("\n\n") + "\n";
  const textPath = resolve(output,`${source.id}.txt`);
  await writeFile(textPath,text);
  const textBuffer = Buffer.from(text);
  const metadata = {
    id:`summary-${source.id}`,title:source.title,authority:`${source.court} / curated source-bound summary`,
    jurisdiction:"England and Wales",canonical_location:null,version,generated_at:generatedAt,
    publication_date:source.judgment_date,effective_date:source.judgment_date,expiry_date:null,
    licence:"Original project summary; underlying reproduced law report is not redistributed",
    reviewer:"seminar-gap-source-reconciliation",approval_status:"approved_with_limitations",
    source_type:"case_law_summary",authority_rank:0.45,oscola_citation:source.oscola_citation,
    document_type:"case_law_summary",court:source.court,seminars:source.seminars,topics:source.topics,
    inventory_ids:source.inventory_ids,source_checksums:source.source_checksums,
    related_active_authorities:source.related_active_authorities,
    status_note:"Use only for the stated general proposition. Do not quote as a judgment, do not infer unstated facts, and prefer an active judgment or current legislation whenever available.",
    files:{ text:{ path:textPath,bytes:textBuffer.length,sha256:createHash("sha256").update(textBuffer).digest("hex") } }
  };
  await writeFile(resolve(output,`${source.id}-metadata.json`),`${JSON.stringify(metadata,null,2)}\n`);
  console.log(`${source.title}: ${Math.round(textBuffer.length/1024)} KB summary`);
}

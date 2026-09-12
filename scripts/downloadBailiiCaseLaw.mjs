import { createHash } from "node:crypto";
import { mkdir,readFile,rename,writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve("approved-materials");
const originals = resolve(root,"originals","bailii-case-law");
const index = resolve(root,"index","bailii-case-law");
await Promise.all([mkdir(originals,{ recursive:true }),mkdir(index,{ recursive:true })]);
const sources = JSON.parse(await readFile(resolve(root,"bailii-case-law-sources.json"),"utf8"));
const retrievedAt = new Date().toISOString();
const version = Number(retrievedAt.slice(0,10).replaceAll("-",""));

async function download(url,destination) {
  const response = await fetch(url,{ headers:{ "User-Agent":"PensionAssistantMaterialImporter/1.0 (+local legal RAG corpus)" },redirect:"follow" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1000) throw new Error(`${url} returned an unexpectedly small document`);
  const partial = `${destination}.partial`;
  await writeFile(partial,buffer);
  await rename(partial,destination);
  return { bytes:buffer.length,sha256:createHash("sha256").update(buffer).digest("hex") };
}

for (const source of sources) {
  const htmlPath = resolve(originals,`${source.id}.html`);
  const textPath = resolve(index,`${source.id}.txt`);
  process.stdout.write(`Downloading ${source.title}... `);
  const html = await download(source.url,htmlPath);
  const python = process.env.WORKSPACE_PYTHON || "python3";
  const normalized = spawnSync(python,[resolve("scripts","normalizeBailii.py"),htmlPath,textPath],{ encoding:"utf8" });
  if (normalized.status !== 0) throw new Error(`Could not normalize ${source.title}: ${normalized.stderr}`);
  const text = await readFile(textPath);
  if (text.length < 1000) throw new Error(`${source.title} produced too little normalized text`);
  const metadata = {
    id:`bailii-${source.id}`,title:source.title,authority:`${source.court} / BAILII`,
    jurisdiction:source.jurisdiction || "England and Wales",canonical_location:source.url,version,retrieved_at:retrievedAt,
    publication_date:source.judgment_date,effective_date:source.judgment_date,expiry_date:null,
    licence:"Crown copyright judgment reused under BAILII's stated UK judgment reproduction terms",
    licence_url:"https://www.bailii.org/bailii/copyright.html",reviewer:"official-source-reconciliation",
    approval_status:"approved",source_type:"case_law",authority_rank:0.85,oscola_citation:source.citation,
    document_type:"case_law",court:source.court,seminars:source.seminars,topics:source.topics,
    status_note:"Judgment text mirrored by BAILII. Preserve the Crown copyright acknowledgement and identify BAILII as the source. Apply only propositions supported by the judgment and check later treatment.",
    files:{ html:{ path:htmlPath,bytes:html.bytes,sha256:html.sha256 },text:{ path:textPath,bytes:text.length,sha256:createHash("sha256").update(text).digest("hex") } }
  };
  await writeFile(resolve(index,`${source.id}-metadata.json`),`${JSON.stringify(metadata,null,2)}\n`);
  console.log(`${Math.round(text.length/1024)} KB text`);
}

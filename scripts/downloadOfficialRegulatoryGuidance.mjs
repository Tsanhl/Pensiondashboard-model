import { createHash } from "node:crypto";
import { mkdir,readFile,rename,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pdfParse from "pdf-parse";

const root = resolve("approved-materials");
const originals = resolve(root,"originals","regulatory-guidance");
const index = resolve(root,"index","regulatory-guidance");
await Promise.all([mkdir(originals,{ recursive:true }),mkdir(index,{ recursive:true })]);
const allSources = JSON.parse(await readFile(resolve(root,"regulatory-guidance-sources.json"),"utf8"));
const requestedIds = new Set(String(process.env.MATERIAL_IDS || "").split(",").map((id)=>id.trim()).filter(Boolean));
const sources = requestedIds.size ? allSources.filter((source)=>requestedIds.has(source.id)) : allSources;
if (requestedIds.size && sources.length !== requestedIds.size) throw new Error("One or more MATERIAL_IDS did not match regulatory-guidance-sources.json");
const retrievedAt = new Date().toISOString();
const version = Number(retrievedAt.slice(0,10).replaceAll("-",""));

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g,"\n").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}

async function download(url,path) {
  const response = await fetch(url,{ headers:{ "User-Agent":"PensionAssistantMaterialImporter/1.0" },redirect:"follow" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1000) throw new Error(`${url} returned an unexpectedly small file`);
  const partial = `${path}.partial`;
  await writeFile(partial,buffer);
  await rename(partial,path);
  return buffer;
}

for (const source of sources) {
  process.stdout.write(`Downloading ${source.title}... `);
  const pdfPath = resolve(originals,`${source.id}.pdf`);
  const textPath = resolve(index,`${source.id}.txt`);
  const pdf = await download(source.pdf_url,pdfPath);
  const parsed = await pdfParse(pdf);
  const normalized = normalizeText(parsed.text);
  if (normalized.length < 5000) throw new Error(`Could not extract sufficient text from ${source.title}`);
  await writeFile(textPath,`${normalized}\n`);
  const text = await readFile(textPath);
  const metadata = {
    id:`official-${source.id}`,title:source.title,authority:source.authority,jurisdiction:source.jurisdiction,
    canonical_location:source.canonical_location,official_pdf_url:source.pdf_url,version,retrieved_at:retrievedAt,
    publication_date:source.publication_date,effective_date:source.effective_date,expiry_date:null,
    northern_ireland_effective_date:source.northern_ireland_effective_date || null,
    applies_to_valuations_from:source.applies_to_valuations_from || null,
    licence:"The Pensions Regulator reproduction terms",licence_url:"https://www.thepensionsregulator.gov.uk/en/website-policies/terms-and-conditions",
    reviewer:"official-source-import",approval_status:"approved",source_type:"regulatory_guidance",authority_rank:0.85,
    oscola_citation:source.title,document_type:"law",seminars:source.seminars,topics:source.topics,
    status_note:"Official regulator code, not legislation. Preserve the code's distinction between legal duties ('must') and regulator expectations or good practice ('should'/'expect'). Check the stated application and effective dates.",
    files:{ pdf:{ path:pdfPath,bytes:pdf.length,sha256:sha256(pdf) },text:{ path:textPath,bytes:text.length,sha256:sha256(text) } }
  };
  await writeFile(resolve(index,`${source.id}-metadata.json`),`${JSON.stringify(metadata,null,2)}\n`);
  console.log(`${Math.round(pdf.length/1024)} KB PDF, ${Math.round(text.length/1024)} KB text`);
}

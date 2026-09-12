import { createHash } from "node:crypto";
import { mkdir,readFile,rename,writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve("approved-materials");
const originals = resolve(root,"originals","secondary-legislation");
const index = resolve(root,"index","secondary-legislation");
await Promise.all([mkdir(originals,{ recursive:true }),mkdir(index,{ recursive:true })]);
const allSources = JSON.parse(await readFile(resolve(root,"secondary-legislation-sources.json"),"utf8"));
const requestedIds = new Set(String(process.env.MATERIAL_IDS || "").split(",").map((id)=>id.trim()).filter(Boolean));
const sources = requestedIds.size ? allSources.filter((source)=>requestedIds.has(source.id)) : allSources;
if (requestedIds.size && sources.length !== requestedIds.size) throw new Error("One or more MATERIAL_IDS did not match secondary-legislation-sources.json");
const retrievedAt = new Date().toISOString();
const version = Number(retrievedAt.slice(0,10).replaceAll("-",""));

async function download(url,destination) {
  const response = await fetch(url,{ headers:{ "User-Agent":"PensionAssistantMaterialImporter/1.0" },redirect:"follow" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 100) throw new Error(`${url} returned an unexpectedly small file`);
  const partial = `${destination}.partial`;
  await writeFile(partial,buffer);
  await rename(partial,destination);
  return { bytes:buffer.length,sha256:createHash("sha256").update(buffer).digest("hex") };
}

for (const source of sources) {
  const base = `https://www.legislation.gov.uk/uksi/${source.year}/${source.number}`;
  const pdfUrl = `${base}/pdfs/uksi_${source.year}${String(source.number).padStart(4,"0")}_en.pdf`;
  const xmlUrl = `${base}/data.xml`;
  const pdfPath = resolve(originals,`${source.id}-as-made.pdf`);
  const madeXmlUrl = `${base}/made/data.xml`;
  const madeXmlPath = resolve(originals,`${source.id}-as-made.xml`);
  const xmlPath = resolve(index,`${source.id}-current.xml`);
  const textPath = resolve(index,`${source.id}-current.txt`);
  process.stdout.write(`Downloading ${source.title}... `);
  const xml = await download(xmlUrl,xmlPath);
  let original;
  try {
    const pdf = await download(pdfUrl,pdfPath);
    original = { path:pdfPath,format:"pdf",url:pdfUrl,bytes:pdf.bytes,sha256:pdf.sha256 };
  } catch (error) {
    const madeXml = await download(madeXmlUrl,madeXmlPath);
    original = { path:madeXmlPath,format:"xml",url:madeXmlUrl,bytes:madeXml.bytes,sha256:madeXml.sha256,pdf_unavailable:error.message };
  }
  const python = process.env.WORKSPACE_PYTHON || "python3";
  const normalized = spawnSync(python,[resolve("scripts","normalizeLegislation.py"),xmlPath,textPath],{ encoding:"utf8" });
  if (normalized.status !== 0) throw new Error(`Could not normalize ${source.title}: ${normalized.stderr}`);
  const text = await readFile(textPath);
  const xmlText = await readFile(xmlPath,"utf8");
  const madeDate = xmlText.match(/<ukm:Mades+Date="([0-9-]+)"/)?.[1] || xmlText.match(/<ukm:EnactmentDate\s+Date="([0-9-]+)"/)?.[1] || `${source.year}-01-01`;
  const documentStatus = xmlText.match(/<ukm:DocumentStatus\s+Value="([^"]+)"/)?.[1] || "unknown";
  const snapshotValidFrom = xmlText.match(/<dct:valid>([0-9-]+)<\/dct:valid>/)?.[1] || null;
  const unappliedEffects = (xmlText.match(/<ukm:UnappliedEffect\b/g) || []).length;
  const metadata = {
    id:`official-${source.id}`,title:source.title,authority:"The National Archives / legislation.gov.uk",
    jurisdiction:source.jurisdiction || "Great Britain",canonical_location:base,original_pdf_url:pdfUrl,current_xml_url:xmlUrl,
    version,retrieved_at:retrievedAt,publication_date:madeDate,effective_date:retrievedAt.slice(0,10),expiry_date:null,
    licence:"Open Government Licence v3.0",reviewer:"official-source-import",approval_status:"approved",
    source_type:"secondary_legislation",authority_rank:1,oscola_citation:`${source.title}, SI ${source.year}/${source.number}`,
    document_type:"law",document_status:documentStatus,snapshot_valid_from:snapshotValidFrom,unapplied_effects:unappliedEffects,
    ni_mapping_status:source.ni_mapping_status || null,seminars:source.seminars,topics:source.topics,
    status_note:"Latest available legislation.gov.uk consolidated snapshot paired with the as-made PDF. Check provision-level commencement, amendments, transitional provisions and territorial extent before relying on a specific rule.",
    files:{ original,xml:{ path:xmlPath,bytes:xml.bytes,sha256:xml.sha256 },text:{ path:textPath,bytes:text.length,sha256:createHash("sha256").update(text).digest("hex") } }
  };
  await writeFile(resolve(index,`${source.id}-metadata.json`),`${JSON.stringify(metadata,null,2)}\n`);
  console.log(`${Math.round(original.bytes/1024)} KB ${original.format.toUpperCase()} original, ${Math.round(text.length/1024)} KB text`);
}

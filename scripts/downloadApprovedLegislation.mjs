import { createHash } from "node:crypto";
import { mkdir,readFile,rename,writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve("approved-materials");
const originals = resolve(root, "originals", "legislation");
const index = resolve(root, "index", "legislation");
await Promise.all([mkdir(originals, { recursive:true }),mkdir(index, { recursive:true })]);
const allSources = JSON.parse(await readFile(resolve(root,"legislation-sources.json"),"utf8"));
const requestedIds = new Set(String(process.env.MATERIAL_IDS || "").split(",").map((id)=>id.trim()).filter(Boolean));
const sources = requestedIds.size ? allSources.filter((source)=>requestedIds.has(source.id)) : allSources;
if (requestedIds.size && sources.length !== requestedIds.size) throw new Error("One or more MATERIAL_IDS did not match legislation-sources.json");
const retrievedAt = new Date().toISOString();
const version = Number(retrievedAt.slice(0, 10).replaceAll("-", ""));

async function download(url, destination) {
  const response = await fetch(url, { headers:{ "User-Agent":"PensionAssistantMaterialImporter/1.0" },redirect:"follow" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 100) throw new Error(`${url} returned an unexpectedly small file`);
  const partial = `${destination}.partial`;
  await writeFile(partial, buffer);
  await rename(partial, destination);
  return { bytes:buffer.length,sha256:createHash("sha256").update(buffer).digest("hex") };
}

for (const source of sources) {
  const legislationType = source.type || "ukpga";
  const pdfSeries = source.pdf_series || legislationType;
  const base = `https://www.legislation.gov.uk/${legislationType}/${source.year}/${source.chapter}`;
  const pdfUrl = `${base}/pdfs/${pdfSeries}_${source.year}${String(source.chapter).padStart(4, "0")}_en.pdf`;
  const xmlUrl = `${base}/data.xml`;
  const pdfPath = resolve(originals, `${source.id}-as-enacted.pdf`);
  const enactedXmlPath = resolve(originals, `${source.id}-as-enacted.xml`);
  const xmlPath = resolve(index, `${source.id}-current.xml`);
  const textPath = resolve(index, `${source.id}-current.txt`);
  process.stdout.write(`Downloading ${source.title}... `);
  const xml = await download(xmlUrl, xmlPath);
  let original;
  try {
    const pdf = await download(pdfUrl, pdfPath);
    original = { path:pdfPath,format:"pdf",url:pdfUrl,bytes:pdf.bytes,sha256:pdf.sha256 };
  } catch (error) {
    const enactedXmlUrl = `${base}/enacted/data.xml`;
    const madeXmlUrl = `${base}/made/data.xml`;
    let originalXml;
    let originalUrl = enactedXmlUrl;
    try {
      originalXml = await download(enactedXmlUrl, enactedXmlPath);
    } catch {
      originalUrl = madeXmlUrl;
      originalXml = await download(madeXmlUrl, enactedXmlPath);
    }
    original = { path:enactedXmlPath,format:"xml",url:originalUrl,bytes:originalXml.bytes,sha256:originalXml.sha256,pdf_unavailable:error.message };
  }
  const python = process.env.WORKSPACE_PYTHON || "python3";
  const normalized = spawnSync(python, [resolve("scripts","normalizeLegislation.py"),xmlPath,textPath], { encoding:"utf8" });
  if (normalized.status !== 0) throw new Error(`Could not normalize ${source.title}: ${normalized.stderr}`);
  const text = await readFile(textPath);
  const xmlText = await readFile(xmlPath, "utf8");
  const enactmentDate = xmlText.match(/<ukm:EnactmentDate\s+Date="([0-9-]+)"/)?.[1] || `${source.year}-01-01`;
  const documentStatus = xmlText.match(/<ukm:DocumentStatus\s+Value="([^"]+)"/)?.[1] || "unknown";
  const snapshotValidFrom = xmlText.match(/<dct:valid>([0-9-]+)<\/dct:valid>/)?.[1] || null;
  const unappliedEffects = (xmlText.match(/<ukm:UnappliedEffect\b/g) || []).length;
  const metadata = {
    id:`official-${source.id}`,title:source.title,authority:"The National Archives / legislation.gov.uk",jurisdiction:source.jurisdiction || "United Kingdom",
    canonical_location:base,original_source_url:original.url,original_pdf_url:original.format === "pdf" ? pdfUrl : null,current_xml_url:xmlUrl,version,retrieved_at:retrievedAt,
    publication_date:enactmentDate,effective_date:retrievedAt.slice(0, 10),expiry_date:null,
    licence:"Open Government Licence v3.0",reviewer:"official-source-import",approval_status:"approved",
    source_type:"legislation",authority_rank:1,oscola_citation:source.title,document_type:"law",
    document_status:documentStatus,snapshot_valid_from:snapshotValidFrom,unapplied_effects:unappliedEffects,
    status_note:"Latest available legislation.gov.uk consolidated snapshot. The effective_date records the retrieval/current-check date, not a blanket commencement date. Provision-level commencement and outstanding amendments must still be checked.",
    files:{ original,xml:{ path:xmlPath,bytes:xml.bytes,sha256:xml.sha256 },text:{ path:textPath,bytes:text.length,sha256:createHash("sha256").update(text).digest("hex") } }
  };
  await writeFile(resolve(index, `${source.id}-metadata.json`), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`${Math.round(original.bytes / 1024)} KB ${original.format.toUpperCase()} original, ${Math.round(text.length / 1024)} KB text`);
}

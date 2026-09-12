import { createHash } from "node:crypto";
import { mkdir,readFile,rename,writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve("approved-materials");
const originals = resolve(root,"originals","case-law");
const index = resolve(root,"index","case-law");
await Promise.all([mkdir(originals,{ recursive:true }),mkdir(index,{ recursive:true })]);
const allSources = JSON.parse(await readFile(resolve(root,"case-law-sources.json"),"utf8"));
const requestedIds = new Set(String(process.env.MATERIAL_IDS || "").split(",").map((id)=>id.trim()).filter(Boolean));
const sources = requestedIds.size ? allSources.filter((source)=>requestedIds.has(source.id)) : allSources;
if (requestedIds.size && sources.length !== requestedIds.size) throw new Error("One or more MATERIAL_IDS did not match case-law-sources.json");
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

function decodeXml(value="") {
  return value.replace(/&#(\d+);/g,(_,number)=>String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi,(_,number)=>String.fromCodePoint(Number.parseInt(number,16)))
    .replaceAll("&amp;","&").replaceAll("&quot;",'"').replaceAll("&apos;", "'").replaceAll("&lt;","<").replaceAll("&gt;",">");
}

for (const source of sources) {
  const base = `https://caselaw.nationalarchives.gov.uk/${source.path}`;
  const pdfUrl = `${base}/data.pdf`;
  const xmlUrl = `${base}/data.xml`;
  const pdfPath = resolve(originals,`${source.id}.pdf`);
  const xmlPath = resolve(index,`${source.id}.xml`);
  const textPath = resolve(index,`${source.id}.txt`);
  process.stdout.write(`Downloading ${source.path}... `);
  const [pdf,xml] = await Promise.all([download(pdfUrl,pdfPath),download(xmlUrl,xmlPath)]);
  const python = process.env.WORKSPACE_PYTHON || "python3";
  const normalized = spawnSync(python,[resolve("scripts","normalizeCaseLaw.py"),xmlPath,textPath],{ encoding:"utf8" });
  if (normalized.status !== 0) throw new Error(`Could not normalize ${source.path}: ${normalized.stderr}`);
  const xmlText = await readFile(xmlPath,"utf8");
  const text = await readFile(textPath);
  const name = decodeXml(xmlText.match(/<FRBRname\s+value="([^"]+)"/)?.[1] || source.id);
  const cite = decodeXml(xmlText.match(/<uk:cite>([^<]+)<\/uk:cite>/)?.[1] || "");
  const court = decodeXml(xmlText.match(/<uk:court>([^<]+)<\/uk:court>/)?.[1] || "Court");
  const judgmentDate = xmlText.match(/<FRBRdate\s+date="([0-9-]+)"\s+name="judgment"/)?.[1] || null;
  const title = `${name}${cite ? ` ${cite}` : ""}`;
  const jurisdiction = /^(EWCA|EWHC)/.test(court) ? "England and Wales" : "United Kingdom";
  const metadata = {
    id:`official-${source.id}`,title,authority:`${court} / The National Archives`,jurisdiction,
    canonical_location:base,original_pdf_url:pdfUrl,current_xml_url:xmlUrl,version,retrieved_at:retrievedAt,
    publication_date:judgmentDate,effective_date:judgmentDate,expiry_date:null,
    licence:"Open Justice Licence v1.0",licence_url:"https://caselaw.nationalarchives.gov.uk/open-justice-licence",
    reviewer:"official-source-import",approval_status:"approved",source_type:"case_law",authority_rank:0.9,
    oscola_citation:title,document_type:"case_law",court,neutral_citation:cite,seminars:source.seminars,topics:source.topics,
    status_note:"Official judgment supplied by The National Archives Find Case Law. Apply the ratio only to propositions supported by the cited paragraphs; check appeal history and later treatment.",
    files:{ pdf:{ path:pdfPath,bytes:pdf.bytes,sha256:pdf.sha256 },xml:{ path:xmlPath,bytes:xml.bytes,sha256:xml.sha256 },text:{ path:textPath,bytes:text.length,sha256:createHash("sha256").update(text).digest("hex") } }
  };
  await writeFile(resolve(index,`${source.id}-metadata.json`),`${JSON.stringify(metadata,null,2)}\n`);
  console.log(`${title}: ${Math.round(text.length/1024)} KB text`);
}

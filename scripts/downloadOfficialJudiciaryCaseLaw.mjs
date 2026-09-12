import { createHash } from "node:crypto";
import { mkdir,readFile,rename,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pdfParse from "pdf-parse";

const root = resolve("approved-materials");
const originals = resolve(root,"originals","judiciary-case-law");
const index = resolve(root,"index","judiciary-case-law");
await Promise.all([mkdir(originals,{ recursive:true }),mkdir(index,{ recursive:true })]);
const sources = JSON.parse(await readFile(resolve(root,"judiciary-case-law-sources.json"),"utf8"));
const retrievedAt = new Date().toISOString();
const version = Number(retrievedAt.slice(0,10).replaceAll("-",""));

async function download(url,destination) {
  const response = await fetch(url,{ headers:{ "User-Agent":"PensionAssistantMaterialImporter/1.0" },redirect:"follow" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!String(response.headers.get("content-type") || "").includes("pdf") && buffer.subarray(0,4).toString() !== "%PDF") {
    throw new Error(`${url} did not return a PDF`);
  }
  const partial = `${destination}.partial`;
  await writeFile(partial,buffer);
  await rename(partial,destination);
  return { buffer,bytes:buffer.length,sha256:createHash("sha256").update(buffer).digest("hex") };
}

async function acquire(source,destination) {
  try {
    return { ...(await download(source.document_url,destination)),acquisition:"official-download" };
  } catch (error) {
    if (!source.fallback_local_path || !source.fallback_sha256) throw error;
    const buffer = await readFile(source.fallback_local_path);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (sha256 !== source.fallback_sha256) throw new Error(`Fallback checksum mismatch for ${source.citation}`);
    if (buffer.subarray(0,4).toString() !== "%PDF") throw new Error(`Fallback for ${source.citation} is not a PDF`);
    await writeFile(destination,buffer);
    return { buffer,bytes:buffer.length,sha256,acquisition:"verified-local-copy-of-official-judgment",download_error:error.message };
  }
}

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g,"\n").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}

for (const source of sources) {
  const pdfPath = resolve(originals,`${source.id}.pdf`);
  const textPath = resolve(index,`${source.id}.txt`);
  process.stdout.write(`Downloading ${source.citation}... `);
  const pdf = await acquire(source,pdfPath);
  const parsed = await pdfParse(pdf.buffer);
  const text = normalizeText(parsed.text);
  if (text.length < 1000) throw new Error(`${source.citation} produced too little normalized text`);
  await writeFile(textPath,`${text}\n`);
  const textBuffer = await readFile(textPath);
  const metadata = {
    id:`official-${source.id}`,title:source.title,authority:`${source.court} / Courts and Tribunals Judiciary`,
    jurisdiction:"England and Wales",canonical_location:source.page_url,original_pdf_url:source.document_url,
    version,retrieved_at:retrievedAt,publication_date:source.judgment_date,effective_date:source.judgment_date,expiry_date:null,
    licence:"Open Government Licence v3.0 (Judiciary Crown copyright material)",
    licence_url:"https://www.judiciary.uk/copyright/",reviewer:"official-source-import",approval_status:"approved",
    source_type:"case_law",authority_rank:0.9,oscola_citation:source.title,document_type:"case_law",
    court:source.court,neutral_citation:source.citation,seminars:source.seminars,topics:source.topics,
    status_note:"Official judgment published by Courts and Tribunals Judiciary. Apply the ratio only to propositions supported by the cited paragraphs; check appeal history and later treatment.",
    acquisition:pdf.acquisition,download_error:pdf.download_error || null,
    files:{ pdf:{ path:pdfPath,bytes:pdf.bytes,sha256:pdf.sha256 },text:{ path:textPath,bytes:textBuffer.length,sha256:createHash("sha256").update(textBuffer).digest("hex") } }
  };
  await writeFile(resolve(index,`${source.id}-metadata.json`),`${JSON.stringify(metadata,null,2)}\n`);
  console.log(`${Math.round(textBuffer.length/1024)} KB text`);
}

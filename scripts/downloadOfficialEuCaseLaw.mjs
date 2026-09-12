import { createHash } from "node:crypto";
import { mkdir,readFile,rename,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pdfParse from "pdf-parse";

const root = resolve("approved-materials");
const originals = resolve(root,"originals","eu-case-law");
const index = resolve(root,"index","eu-case-law");
await Promise.all([mkdir(originals,{ recursive:true }),mkdir(index,{ recursive:true })]);
const sources = JSON.parse(await readFile(resolve(root,"eu-case-law-sources.json"),"utf8"));
const retrievedAt = new Date().toISOString();
const version = Number(retrievedAt.slice(0,10).replaceAll("-",""));

async function fetchBuffer(url) {
  const response = await fetch(url,{ headers:{ "User-Agent":"PensionAssistantMaterialImporter/1.0" },redirect:"follow" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 100) throw new Error(`${url} returned an unexpectedly small file`);
  return buffer;
}

async function expressionManifestations(celex) {
  const expression = `https://publications.europa.eu/resource/celex/${celex}.ENG`;
  const rdf = (await fetchBuffer(expression)).toString("utf8");
  return [...rdf.matchAll(/expression_manifested_by_manifestation\s+rdf:resource="([^"]+)"/g)].map((match)=>match[1]);
}

async function manifestationItem(alias) {
  const rdf = (await fetchBuffer(alias)).toString("utf8");
  const item = [...rdf.matchAll(/<rdf:Description\s+rdf:about="([^"]+\/DOC_\d+)"/g)]
    .map((match)=>match[1]).find((url)=>new RegExp(`/cellar/.+\\.\\d+\\.\\d+/DOC_\\d+$`).test(url));
  if (!item) throw new Error(`Could not resolve manifestation ${alias}`);
  return { alias,item };
}

async function writeAtomic(path,buffer) {
  const partial = `${path}.partial`;
  await writeFile(partial,buffer);
  await rename(partial,path);
  return { bytes:buffer.length,sha256:createHash("sha256").update(buffer).digest("hex") };
}

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g,"\n").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}

for (const source of sources) {
  process.stdout.write(`Downloading ${source.celex}... `);
  const manifestations = await expressionManifestations(source.celex);
  const htmlAlias = manifestations.find((url)=>url.endsWith(".xhtml")) || manifestations.find((url)=>url.endsWith(".html"));
  const pdfAlias = manifestations.find((url)=>url.endsWith(".pdfa1a")) || manifestations.find((url)=>url.endsWith(".pdf"));
  if (!htmlAlias || !pdfAlias) throw new Error(`No English HTML/PDF manifestations were found for ${source.celex}`);
  const [htmlItem,pdfItem] = await Promise.all([manifestationItem(htmlAlias),manifestationItem(pdfAlias)]);
  const [htmlBuffer,pdfBuffer] = await Promise.all([fetchBuffer(htmlItem.item),fetchBuffer(pdfItem.item)]);
  const htmlPath = resolve(index,`${source.id}.xhtml`);
  const pdfPath = resolve(originals,`${source.id}.pdf`);
  const textPath = resolve(index,`${source.id}.txt`);
  const [html,pdf] = await Promise.all([writeAtomic(htmlPath,htmlBuffer),writeAtomic(pdfPath,pdfBuffer)]);
  const parsed = await pdfParse(pdfBuffer);
  const normalized = normalizeText(parsed.text);
  if (normalized.length < 1000) throw new Error(`Could not extract sufficient PDF text for ${source.celex}`);
  await writeFile(textPath,`${normalized}\n`);
  const text = await readFile(textPath);
  const canonical = `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${source.celex}`;
  const title = `${source.title} (${source.case_number})`;
  const metadata = {
    id:`official-eu-${source.id}`,title,authority:"Court of Justice of the European Union / Publications Office of the European Union",
    jurisdiction:"European Union; UK effect depends on retained-EU-law rules and event date",canonical_location:canonical,
    celex:source.celex,official_xhtml_url:htmlItem.item,official_pdf_url:pdfItem.item,version,retrieved_at:retrievedAt,
    publication_date:source.judgment_date,effective_date:source.judgment_date,expiry_date:null,
    licence:"European Commission reuse policy",licence_url:"https://commission.europa.eu/legal-notice_en#copyright-notice",
    reviewer:"official-source-import",approval_status:"approved",source_type:source.source_type || "case_law",
    authority_rank:Number(source.authority_rank || 0.85),oscola_citation:title,document_type:"case_law",
    case_number:source.case_number,seminars:source.seminars,topics:source.topics,
    status_note:"Official EU judgment or opinion. For UK questions, verify the event date and the current effect of assimilated/retained EU law before relying on the proposition.",
    files:{ pdf:{ path:pdfPath,bytes:pdf.bytes,sha256:pdf.sha256 },xhtml:{ path:htmlPath,bytes:html.bytes,sha256:html.sha256 },text:{ path:textPath,bytes:text.length,sha256:createHash("sha256").update(text).digest("hex") } }
  };
  await writeFile(resolve(index,`${source.id}-metadata.json`),`${JSON.stringify(metadata,null,2)}\n`);
  console.log(`${title}: ${Math.round(text.length/1024)} KB text`);
}

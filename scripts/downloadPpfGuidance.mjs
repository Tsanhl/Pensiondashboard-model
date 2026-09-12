import { createHash } from "node:crypto";
import { mkdir,readFile,rename,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pdf from "pdf-parse";

const root = resolve("approved-materials");
const originals = resolve(root,"originals","ppf-guidance");
const index = resolve(root,"index","ppf-guidance");
await Promise.all([mkdir(originals,{ recursive:true }),mkdir(index,{ recursive:true })]);
const sources = JSON.parse(await readFile(resolve(root,"ppf-guidance-sources.json"),"utf8"));
const retrievedAt = new Date().toISOString();
const version = Number(retrievedAt.slice(0,10).replaceAll("-",""));
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function decodeHtml(value) {
  const named = { amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" ",ndash:"–",mdash:"—",pound:"£",rsquo:"’" };
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi,(match,key) => {
    if (key[0] === "#") { const hex=key[1]?.toLowerCase()==="x"; const code=Number.parseInt(key.slice(hex?2:1),hex?16:10); return Number.isFinite(code)?String.fromCodePoint(code):match; }
    return named[key.toLowerCase()] ?? match;
  });
}
function htmlToText(html) {
  return decodeHtml(String(html || "").replace(/<h1\b[^>]*>/gi,"\n# ").replace(/<h2\b[^>]*>/gi,"\n## ")
    .replace(/<h3\b[^>]*>/gi,"\n### ").replace(/<h[4-6]\b[^>]*>/gi,"\n#### ").replace(/<li\b[^>]*>/gi,"\n- ")
    .replace(/<br\s*\/?\s*>/gi,"\n").replace(/<\/(p|div|table|tr|ul|ol|h[1-6])>/gi,"\n")
    .replace(/<t[dh]\b[^>]*>/gi," | ").replace(/<[^>]+>/g," "))
    .replace(/[ \t]+/g," ").replace(/ *\n */g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}
async function download(source,path) {
  const response = await fetch(source.url,{ headers:{ "User-Agent":"PensionAssistantMaterialImporter/1.0" },redirect:"follow" });
  if (!response.ok) throw new Error(`${source.url} returned ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const partial = `${path}.partial`; await writeFile(partial,buffer); await rename(partial,path); return buffer;
}
for (const source of sources) {
  const originalPath = resolve(originals,`${source.id}.${source.kind === "pdf" ? "pdf" : "html"}`);
  const buffer = await download(source,originalPath);
  const raw = buffer.toString("utf8");
  const main = source.kind === "html" ? raw.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || raw : null;
  const text = source.kind === "pdf" ? (await pdf(buffer)).text : htmlToText(main);
  if (text.trim().length < 300) throw new Error(`No usable PPF guidance text for ${source.title}`);
  const textPath = resolve(index,`${source.id}-current.txt`);
  await writeFile(textPath,`${text.trim()}\n`);
  const textBuffer = await readFile(textPath);
  const metadata = {
    id:`official-${source.id}`,title:source.title,authority:"Pension Protection Fund",jurisdiction:"United Kingdom",
    canonical_location:source.url,version,retrieved_at:retrievedAt,publication_date:source.publishedAt,
    effective_date:source.publishedAt,expiry_date:null,licence:"Pension Protection Fund copyright; internal search snapshot with source attribution",
    reviewer:"official-source-import",approval_status:"approved",source_type:"ppf_operational_guidance",authority_rank:0.8,
    oscola_citation:`Pension Protection Fund, '${source.title}' (accessed ${retrievedAt.slice(0,10)})`,
    document_type:"official_guidance",update_cycle_days:30,topics:source.topics,
    status_note:"Operational PPF guidance. Legislation and binding case law take priority. Time-sensitive compensation and valuation parameters must be checked against the live PPF source.",
    files:{ original:{ path:originalPath,url:source.url,format:source.kind,bytes:buffer.length,sha256:sha256(buffer) },
      text:{ path:textPath,bytes:textBuffer.length,sha256:sha256(textBuffer) } }
  };
  await writeFile(resolve(index,`${source.id}-metadata.json`),`${JSON.stringify(metadata,null,2)}\n`);
  console.log(`${source.title}: ${Math.round(buffer.length/1024)} KB ${source.kind.toUpperCase()}`);
}

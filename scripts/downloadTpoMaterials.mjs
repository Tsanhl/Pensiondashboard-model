import { createHash } from "node:crypto";
import { mkdir,readFile,rename,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pdf from "pdf-parse";

const base = "https://www.pensions-ombudsman.org.uk";
const root = resolve("approved-materials");
const originals = resolve(root,"originals","pensions-ombudsman");
const index = resolve(root,"index","pensions-ombudsman");
await Promise.all([mkdir(originals,{ recursive:true }),mkdir(index,{ recursive:true })]);
const retrievedAt = new Date().toISOString();
const version = Number(retrievedAt.slice(0,10).replaceAll("-",""));

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function decodeHtml(value) {
  const named = { amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" ",ndash:"–",mdash:"—",pound:"£",rsquo:"’",lsquo:"‘",ldquo:"“",rdquo:"”" };
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi,(match,key) => {
    if (key[0] === "#") {
      const hex = key[1]?.toLowerCase() === "x";
      const code = Number.parseInt(key.slice(hex ? 2 : 1),hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[key.toLowerCase()] ?? match;
  });
}
function htmlToText(html) {
  return decodeHtml(String(html || "")
    .replace(/<h1\b[^>]*>/gi,"\n# ").replace(/<h2\b[^>]*>/gi,"\n## ").replace(/<h3\b[^>]*>/gi,"\n### ")
    .replace(/<h[4-6]\b[^>]*>/gi,"\n#### ").replace(/<li\b[^>]*>/gi,"\n- ")
    .replace(/<br\s*\/?\s*>/gi,"\n").replace(/<\/(p|div|table|tr|ul|ol|h[1-6])>/gi,"\n")
    .replace(/<t[dh]\b[^>]*>/gi," | ").replace(/<[^>]+>/g," "))
    .replace(/[ \t]+/g," ").replace(/ *\n */g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}
function mainHtml(html) { return html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || html; }
async function fetchBuffer(url) {
  const response = await fetch(url,{ headers:{ "User-Agent":"PensionAssistantMaterialImporter/1.0" },redirect:"follow" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
async function saveBuffer(url,path) {
  const buffer = await fetchBuffer(url);
  const partial = `${path}.partial`;
  await writeFile(partial,buffer);
  await rename(partial,path);
  return buffer;
}
async function writeMetadata(id,metadata,text) {
  const textPath = resolve(index,`${id}-current.txt`);
  await writeFile(textPath,`${text.trim()}\n`);
  const textBuffer = await readFile(textPath);
  const complete = { ...metadata,id:`official-tpo-${id}`,version,retrieved_at:retrievedAt,
    authority:"The Pensions Ombudsman",jurisdiction:"United Kingdom",licence:"The Pensions Ombudsman website re-use terms: latest-version, attribution, non-endorsement and no-fee conditions",
    reviewer:"official-source-import",approval_status:"approved",authority_rank:0.78,
    files:{ ...metadata.files,text:{ path:textPath,bytes:textBuffer.length,sha256:sha256(textBuffer) } } };
  await writeFile(resolve(index,`${id}-metadata.json`),`${JSON.stringify(complete,null,2)}\n`);
}

const decisionLinks = [];
for (const page of [0,1]) {
  const listingUrl = `${base}/decisions?page=${page}`;
  const listing = (await fetchBuffer(listingUrl)).toString("utf8");
  for (const match of listing.matchAll(/href="(\/decision\/2026\/[^"#?]+)"/g)) {
    if (!decisionLinks.includes(match[1])) decisionLinks.push(match[1]);
  }
}

// Gold-evaluation determinations are pinned explicitly so a change in the
// website's latest-decisions pagination cannot silently remove them.
for (const relativeUrl of [
  "/decision/2026/cas-100107-z2t4/tt-group-1993-pension-scheme-cas-100107-z2t4",
  "/decision/2026/cas-81099-b2p1/tyne-and-wear-pension-fund-local-government-pension-scheme-lgps"
]) {
  if (!decisionLinks.includes(relativeUrl)) decisionLinks.unshift(relativeUrl);
}

for (const relativeUrl of decisionLinks.slice(0,24)) {
  const canonical = `${base}${relativeUrl}`;
  const html = (await fetchBuffer(canonical)).toString("utf8");
  const main = mainHtml(html);
  const title = htmlToText(main.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || relativeUrl.split("/").at(-1));
  const reference = relativeUrl.match(/cas-[a-z0-9-]+/i)?.[0].toUpperCase();
  const publishedAt = html.match(/<time\s+datetime="([^"]+)"/i)?.[1] || `${relativeUrl.split("/")[2]}-01-01`;
  const pdfPathRelative = html.match(/href="([^"]+\.pdf)"/i)?.[1];
  if (!reference || !pdfPathRelative) throw new Error(`Missing decision metadata for ${canonical}`);
  const pdfUrl = new URL(pdfPathRelative,base).href;
  const originalPath = resolve(originals,`${reference.toLowerCase()}.pdf`);
  const pdfBuffer = await saveBuffer(pdfUrl,originalPath);
  const extracted = await pdf(pdfBuffer);
  if (extracted.text.trim().length < 300) throw new Error(`No usable determination text for ${reference}`);
  const mainText = htmlToText(main);
  const outcome = mainText.match(/Outcome:\s*([^\n]+)/i)?.[1]?.trim() || null;
  const complaintTopic = mainText.match(/Complaint Topic:\s*([^\n]+)/i)?.[1]?.trim() || null;
  const id = reference.toLowerCase();
  await writeMetadata(id,{
    title,canonical_location:canonical,publication_date:publishedAt,effective_date:publishedAt.slice(0,10),expiry_date:null,
    source_type:"ombudsman_determination",document_type:"determination",update_cycle_days:7,
    oscola_citation:`The Pensions Ombudsman, ${title} (${reference}, ${publishedAt.slice(0,10)})`,
    decision_reference:reference,outcome,complaint_topic:complaintTopic,
    status_note:"Fact-specific Ombudsman determination. It is not a substitute for legislation or binding appellate case law and must not be generalised beyond its reasons and facts.",
    files:{ original:{ path:originalPath,url:pdfUrl,format:"pdf",bytes:pdfBuffer.length,sha256:sha256(pdfBuffer) } }
  },extracted.text);
  console.log(`${reference}: ${title}`);
}

const procedureSources = [
  { id:"how-we-investigate-complaints-2024",title:"How we investigate complaints",kind:"pdf",url:`${base}/sites/default/files/publication/files/How%20we%20investigate%20complaints_2.pdf`,publishedAt:"2024-10-16" },
  { id:"how-we-handle-complaints",title:"How we handle complaints",kind:"html",url:`${base}/how-we-handle-complaints`,publishedAt:retrievedAt.slice(0,10) },
  { id:"how-to-complain-about-a-pension-problem",title:"How to complain about a pension problem",kind:"html",url:`${base}/how-complain-about-pension-problem`,publishedAt:retrievedAt.slice(0,10) },
  { id:"how-to-appeal",title:"How to appeal",kind:"html",url:`${base}/how-appeal`,publishedAt:retrievedAt.slice(0,10) }
];
for (const source of procedureSources) {
  const originalPath = resolve(originals,`${source.id}.${source.kind === "pdf" ? "pdf" : "html"}`);
  const buffer = await saveBuffer(source.url,originalPath);
  const text = source.kind === "pdf" ? (await pdf(buffer)).text : htmlToText(mainHtml(buffer.toString("utf8")));
  if (text.trim().length < 300) throw new Error(`No usable procedure text for ${source.title}`);
  await writeMetadata(source.id,{
    title:source.title,canonical_location:source.url,publication_date:source.publishedAt,effective_date:source.publishedAt,expiry_date:null,
    source_type:"ombudsman_procedure",document_type:"official_guidance",update_cycle_days:30,
    oscola_citation:`The Pensions Ombudsman, '${source.title}' (accessed ${retrievedAt.slice(0,10)})`,
    status_note:"Official procedural information. Check the current legislation and the live TPO page before stating a deadline or jurisdiction conclusion.",
    files:{ original:{ path:originalPath,url:source.url,format:source.kind,bytes:buffer.length,sha256:sha256(buffer) } }
  },text);
}
console.log(`Prepared ${Math.min(24,decisionLinks.length)} latest determinations and ${procedureSources.length} procedure sources.`);

import { createHash } from "node:crypto";
import { mkdir,readFile,rename,writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("approved-materials");
const originals = resolve(root,"originals","official-web-guidance");
const index = resolve(root,"index","official-web-guidance");
await Promise.all([mkdir(originals,{recursive:true}),mkdir(index,{recursive:true})]);
const allSources = JSON.parse(await readFile(resolve(root,"official-web-guidance-sources.json"),"utf8"));
const requestedIds = new Set(String(process.env.MATERIAL_IDS || "").split(",").map((value) => value.trim()).filter(Boolean));
const sources = requestedIds.size ? allSources.filter((source) => requestedIds.has(source.id)) : allSources;
if (requestedIds.size && sources.length !== requestedIds.size) throw new Error("One or more MATERIAL_IDS did not match official-web-guidance-sources.json");
const retrievedAt = new Date().toISOString();
const version = Number(retrievedAt.slice(0,10).replaceAll("-",""));

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function decodeHtml(value) {
  const named = {amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" ",ndash:"–",mdash:"—",pound:"£",rsquo:"’",lsquo:"‘",ldquo:"“",rdquo:"”"};
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi,(match,key) => {
    if (key[0] === "#") {
      const hexadecimal = key[1]?.toLowerCase() === "x";
      const code = Number.parseInt(key.slice(hexadecimal ? 2 : 1),hexadecimal ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[key.toLowerCase()] ?? match;
  });
}
function htmlToText(html) {
  const main = String(html || "").match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || html;
  return decodeHtml(String(main)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"")
    .replace(/<h1\b[^>]*>/gi,"\n# ").replace(/<h2\b[^>]*>/gi,"\n## ").replace(/<h3\b[^>]*>/gi,"\n### ")
    .replace(/<h[4-6]\b[^>]*>/gi,"\n#### ").replace(/<li\b[^>]*>/gi,"\n- ")
    .replace(/<br\s*\/?\s*>/gi,"\n").replace(/<\/(p|div|table|tr|ul|ol|h[1-6])>/gi,"\n")
    .replace(/<t[dh]\b[^>]*>/gi," | ").replace(/<[^>]+>/g," "))
    .replace(/[ \t]+/g," ").replace(/ *\n */g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}

for (const source of sources) {
  const response = await fetch(source.url,{headers:{"User-Agent":"PensionAssistantMaterialImporter/1.0"},redirect:"follow"});
  if (!response.ok) throw new Error(`${source.url} returned ${response.status}`);
  const html = Buffer.from(await response.arrayBuffer());
  const text = htmlToText(html.toString("utf8"));
  if (text.length < 500) throw new Error(`Could not extract sufficient text from ${source.title}`);
  const htmlPath = resolve(originals,`${source.id}.html`);
  const textPath = resolve(index,`${source.id}.txt`);
  const partial = `${htmlPath}.partial`;
  await writeFile(partial,html);
  await rename(partial,htmlPath);
  await writeFile(textPath,`${text}\n`);
  const textBuffer = await readFile(textPath);
  const metadata = {
    id:`official-${source.id}`,title:source.title,authority:source.authority,jurisdiction:source.jurisdiction,
    canonical_location:source.url,version,retrieved_at:retrievedAt,current_checked_at:retrievedAt,published_at:source.published_at,
    source_updated_at:source.source_updated_at,source_type:source.source_type,authority_rank:source.authority_rank,
    licence:source.licence,licence_url:source.licence_url,oscola_citation:source.oscola_citation,
    reviewer:"official-source-import",approval_status:"approved",topics:source.topics,
    files:{original:{path:htmlPath,bytes:html.length,sha256:sha256(html)},text:{path:textPath,bytes:textBuffer.length,sha256:sha256(textBuffer)}}
  };
  await writeFile(resolve(index,`${source.id}-metadata.json`),`${JSON.stringify(metadata,null,2)}\n`);
  console.log(`${source.title}: ${Math.round(textBuffer.length/1024)} KB text`);
}

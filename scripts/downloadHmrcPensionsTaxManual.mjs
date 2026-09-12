import { createHash } from "node:crypto";
import { mkdir,readFile,rename,writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve("approved-materials");
const originals = resolve(root,"originals","hmrc-pensions-tax-manual");
const index = resolve(root,"index","hmrc-pensions-tax-manual");
await Promise.all([mkdir(originals,{ recursive:true }),mkdir(index,{ recursive:true })]);

const rootPath = "/hmrc-internal-manuals/pensions-tax-manual";
const apiBase = "https://www.gov.uk/api/content";
const pageBase = "https://www.gov.uk";
const retrievedAt = new Date().toISOString();
const version = Number(retrievedAt.slice(0,10).replaceAll("-",""));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fetchJson(basePath) {
  const response = await fetch(`${apiBase}${basePath}`,{
    headers:{ "User-Agent":"PensionAssistantMaterialImporter/1.0","Accept":"application/json" },redirect:"follow"
  });
  if (!response.ok) throw new Error(`${basePath} returned ${response.status}`);
  return response.json();
}

function decodeHtml(value) {
  const named = { amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" ",ndash:"–",mdash:"—",pound:"£",hellip:"…" };
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

function childSections(page) {
  return (page.details?.child_section_groups || []).flatMap((group) => group.child_sections || []);
}

let previous = { pages:{} };
try {
  previous = JSON.parse(await readFile(resolve(index,"freshness-report.json"),"utf8"));
} catch {}

const manual = await fetchJson(rootPath);
const roots = childSections(manual);
const queue = roots.map((item) => ({ basePath:item.base_path,chapterId:item.section_id,chapterTitle:item.title }));
const queued = new Set(queue.map((item) => item.basePath));
const pages = new Map();

while (queue.length) {
  const batch = queue.splice(0,8);
  const results = await Promise.all(batch.map(async (item) => ({ item,page:await fetchJson(item.basePath) })));
  for (const { item,page } of results) {
    pages.set(item.basePath,{ ...item,page });
    for (const child of childSections(page)) {
      if (!child.base_path?.startsWith(`${rootPath}/`) || queued.has(child.base_path)) continue;
      queued.add(child.base_path);
      queue.push({ basePath:child.base_path,chapterId:item.chapterId,chapterTitle:item.chapterTitle });
    }
  }
  process.stdout.write(`\rFetched ${pages.size} HMRC PTM pages...`);
}
process.stdout.write("\n");

const byChapter = new Map();
const pageHashes = {};
for (const item of [...pages.values()].sort((left,right) => left.basePath.localeCompare(right.basePath))) {
  const code = item.page.details?.section_id || item.basePath.split("/").at(-1).toUpperCase();
  const body = htmlToText(item.page.details?.body || "");
  const snapshot = `${JSON.stringify(item.page,null,2)}\n`;
  const snapshotPath = resolve(originals,`${code.toLowerCase()}.json`);
  const partialPath = `${snapshotPath}.partial`;
  await writeFile(partialPath,snapshot);
  await rename(partialPath,snapshotPath);
  pageHashes[item.basePath] = {
    sha256:sha256(snapshot),title:item.page.title,sectionId:code,updatedAt:item.page.public_updated_at || item.page.updated_at,
    canonicalLocation:`${pageBase}${item.basePath}`
  };
  const chapter = byChapter.get(item.chapterId) || { id:item.chapterId,title:item.chapterTitle,pages:[] };
  chapter.pages.push({ code,title:item.page.title,basePath:item.basePath,body,updatedAt:item.page.public_updated_at || item.page.updated_at });
  byChapter.set(item.chapterId,chapter);
}

for (const chapter of [...byChapter.values()].sort((a,b) => a.id.localeCompare(b.id))) {
  const text = chapter.pages.map((page) => [
    `# ${page.code} — ${page.title}`,
    `Canonical source: ${pageBase}${page.basePath}`,
    `Source updated: ${page.updatedAt}`,
    page.body || "[Contents page with no separate body text]"
  ].join("\n\n")).join("\n\n---\n\n");
  const textPath = resolve(index,`${chapter.id.toLowerCase()}-current.txt`);
  await writeFile(textPath,`${text}\n`);
  const newestUpdate = chapter.pages.map((page) => page.updatedAt).filter(Boolean).sort().at(-1) || manual.public_updated_at || manual.updated_at;
  const metadata = {
    id:`official-hmrc-ptm-${chapter.id.toLowerCase()}`,title:`HMRC Pensions Tax Manual — ${chapter.title}`,
    authority:"HM Revenue & Customs",jurisdiction:"United Kingdom",canonical_location:`${pageBase}${rootPath}/${chapter.id.toLowerCase()}`,
    version,retrieved_at:retrievedAt,source_updated_at:newestUpdate,publication_date:manual.first_published_at,
    effective_date:retrievedAt.slice(0,10),expiry_date:null,licence:"Open Government Licence v3.0",
    reviewer:"official-source-import",approval_status:"approved",source_type:"official_tax_guidance",authority_rank:0.85,
    oscola_citation:`HM Revenue & Customs, '${chapter.title}' (Pensions Tax Manual, ${chapter.id}, updated ${newestUpdate.slice(0,10)})`,
    document_type:"guidance",update_cycle_days:7,page_count:chapter.pages.length,
    page_paths:chapter.pages.map((page) => page.basePath),topics:["pensions tax",chapter.title],
    status_note:"Operational HMRC guidance, not legislation. Monetary thresholds must be read from dated structured facts for the relevant tax year and checked against the current official page.",
    files:{ text:{ path:textPath,bytes:Buffer.byteLength(text),sha256:sha256(text) } }
  };
  await writeFile(resolve(index,`${chapter.id.toLowerCase()}-metadata.json`),`${JSON.stringify(metadata,null,2)}\n`);
}

const oldPaths = new Set(Object.keys(previous.pages || {}));
const newPaths = new Set(Object.keys(pageHashes));
const freshness = {
  generatedAt:retrievedAt,manualUpdatedAt:manual.public_updated_at || manual.updated_at,pageCount:pages.size,chapterCount:byChapter.size,
  added:[...newPaths].filter((path) => !oldPaths.has(path)),
  changed:[...newPaths].filter((path) => oldPaths.has(path) && previous.pages[path]?.sha256 !== pageHashes[path].sha256),
  unchanged:[...newPaths].filter((path) => oldPaths.has(path) && previous.pages[path]?.sha256 === pageHashes[path].sha256),
  removed:[...oldPaths].filter((path) => !newPaths.has(path)),pages:pageHashes
};
await writeFile(resolve(index,"freshness-report.json"),`${JSON.stringify(freshness,null,2)}\n`);
console.log(`Prepared ${pages.size} pages in ${byChapter.size} freshness-managed chapter documents.`);

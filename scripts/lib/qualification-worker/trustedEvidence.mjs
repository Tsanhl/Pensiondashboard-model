import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadApprovedCorpusManifest } from "../../../server/services/approvedCorpusService.js";
import { structuralChunk } from "../../../server/services/chunkingService.js";
import { safeHostEnvironment } from "./processEnvironment.mjs";

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

function publicFactContent(fact) {
  return JSON.stringify({
    label:fact.label,value:fact.value,unit:fact.unit,operator:fact.operator || null,
    condition:fact.condition || null,validFrom:fact.validFrom,validTo:fact.validTo,
  });
}

function record(sourceId, content, metadata = {}) {
  return { source_id:String(sourceId),content:String(content),content_sha256:sha256(String(content)),...metadata };
}

function recordIdentity(item) {
  return {
    content_sha256:item.content_sha256,
    scope:item.scope || null,
    title:item.title || null,
    provenance:item.provenance || null,
  };
}

function catalogManifest(catalog) {
  return [...catalog.values()].map((item) => ({ source_id:item.source_id,...recordIdentity(item) }))
    .sort((left,right) => left.source_id.localeCompare(right.source_id));
}

export async function buildTrustedEvidenceCatalog({ manifestPath,manifestSha256,projectRoot,databasePath,expectedCanonicalFactsSha256,timeoutMs = 30_000,userId = "alex-morgan" }) {
  const loaded = await loadApprovedCorpusManifest({ environment:{
    APPROVED_CORPUS_MANIFEST_PATH:manifestPath,
    APPROVED_CORPUS_MANIFEST_SHA256:manifestSha256,
    APPROVED_CORPUS_MIN_DOCUMENTS:"1",
  } });
  const records = [];
  for (const document of loaded.documents) {
    for (const [index, chunk] of structuralChunk(document.text,{ documentType:document.document_type || document.source_type }).entries()) {
      records.push(record(`${document.id}_chunk_${index + 1}`,chunk.content,{
        scope:"CURATED_PUBLIC",title:document.title,document_id:document.id,provenance:"PINNED_RUNTIME_EVIDENCE",
      }));
    }
  }
  for (const collection of loaded.structuredFactCollections) {
    for (const fact of collection.facts) records.push(record(`structured_public_${fact.id}`,publicFactContent(fact),{
      scope:"CURATED_PUBLIC",title:`HMRC dated fact: ${fact.label}`,fact_id:fact.id,
      provenance:"PINNED_RUNTIME_EVIDENCE",
    }));
  }
  if (!projectRoot || !databasePath || !/^[0-9a-f]{64}$/.test(String(expectedCanonicalFactsSha256 || ""))) throw new Error("Pinned personal-evidence inputs are incomplete.");
  const personalProbe = spawnSync(process.execPath,[
    resolve(projectRoot,"scripts/qualificationPersonalEvidence.mjs"),
    "--project-root",resolve(projectRoot),"--database",resolve(databasePath),
    "--canonical-facts-sha256",expectedCanonicalFactsSha256,"--user",userId,
  ],{
    cwd:resolve(projectRoot),encoding:"utf8",timeout:timeoutMs,maxBuffer:16 * 1024 * 1024,
    env:{ ...safeHostEnvironment(),DISABLE_DOTENV_LOAD:"true" },
  });
  if (personalProbe.status !== 0 || personalProbe.signal || personalProbe.error) {
    throw new Error(`Pinned personal-evidence probe failed: ${String(personalProbe.error?.message || personalProbe.stderr || personalProbe.signal || personalProbe.status).slice(0,500)}`);
  }
  let personal;
  try { personal = JSON.parse(personalProbe.stdout); }
  catch { throw new Error("Pinned personal-evidence probe returned invalid JSON."); }
  if (personal.version !== "qualification-personal-evidence-v1" || personal.user_id !== userId ||
      personal.canonical_facts_sha256 !== expectedCanonicalFactsSha256 || !Array.isArray(personal.sources) || personal.sources.length === 0) {
    throw new Error("Pinned personal-evidence probe identity is invalid.");
  }
  for (const source of personal.sources) records.push(record(source.source_id,source.content,{ scope:source.scope,title:source.title,provenance:"PINNED_RUNTIME_EVIDENCE" }));
  const unique = new Map();
  for (const item of records) {
    const prior = unique.get(item.source_id);
    if (prior && JSON.stringify(recordIdentity(prior)) !== JSON.stringify(recordIdentity(item))) {
      throw new Error(`Trusted evidence source ID is ambiguous: ${item.source_id}`);
    }
    unique.set(item.source_id,item);
  }
  const manifest = catalogManifest(unique);
  return { catalog:unique,catalog_sha256:sha256(JSON.stringify(manifest)),manifest,canonical_facts_sha256:personal.canonical_facts_sha256,database_path:personal.database_path };
}

export function mergeCaseEvidenceCatalog(cases, baseCatalog) {
  const catalog = new Map(baseCatalog || []);
  for (const item of cases || []) {
    for (const source of item.case_trusted_sources || []) {
      const sourceId = String(source.source_id || "");
      if (!sourceId || typeof source.content !== "string" || !source.content.trim()) {
        throw new Error(`Qualification fixture evidence is incomplete for case ${item.case_id || item.id || "<unknown>"}.`);
      }
      const candidate = record(sourceId,source.content,{
        ...source,
        source_id:sourceId,
        provenance:"HASH_BOUND_QUALIFICATION_FIXTURE",
      });
      const prior = catalog.get(sourceId);
      if (prior && JSON.stringify(recordIdentity(prior)) !== JSON.stringify(recordIdentity(candidate))) {
        throw new Error(`Trusted evidence source ID collision across provenance or content: ${sourceId}`);
      }
      catalog.set(sourceId,candidate);
    }
  }
  const manifest = catalogManifest(catalog);
  return { catalog,manifest,catalog_sha256:sha256(JSON.stringify(manifest)) };
}

function sourceText(source) {
  return String(source.evidence_excerpt || source.snippet || source.excerpt || source.text || "").trim();
}

export function bindCaseEvidence(cases, catalog) {
  return (cases || []).map((item) => {
    const trusted = [];
    const untrusted = [];
    for (const source of item.sources || []) {
      const sourceId = String(source.source_id || source.sourceId || source.id || "");
      const excerpt = sourceText(source);
      const expected = catalog.get(sourceId);
      if (!sourceId || !excerpt || !expected || !expected.content.includes(excerpt)) {
        untrusted.push(sourceId || "<missing-source-id>");
        continue;
      }
      const policyOnly = String(expected.scope || source.scope || "") === "POLICY_ONLY";
      trusted.push({
        evidence_id:`${policyOnly ? "POLICY" : "SRC"}:${sourceId}`,source_id:sourceId,title:String(expected.title || source.title || ""),
        content:expected.content,content_sha256:expected.content_sha256,scope:String(expected.scope || source.scope || ""),
        evidence_binding:expected.provenance,
      });
    }
    return { ...item,trusted_evidence_records:trusted,untrusted_source_ids:[...new Set(untrusted)] };
  });
}

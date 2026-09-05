#!/usr/bin/env node
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const projectRoot = realpathSync.native(resolve(option("--project-root") || "."));
const databaseArgument = option("--database");
const expectedCanonicalFactsSha256 = String(option("--canonical-facts-sha256") || "");
const userId = String(option("--user") || "");
if (!databaseArgument || !isAbsolute(databaseArgument) || !existsSync(databaseArgument) || lstatSync(databaseArgument).isSymbolicLink()) throw new Error("A real absolute pinned SQLite database is required.");
const databasePath = realpathSync.native(databaseArgument);
const relativeDatabase = databasePath.slice(projectRoot.length + 1);
if (!relativeDatabase || relativeDatabase.startsWith("..") || resolve(projectRoot,relativeDatabase) !== databasePath) throw new Error("Pinned personal-evidence database leaves the project root.");
if (!/^[0-9a-f]{64}$/.test(expectedCanonicalFactsSha256) || userId !== "alex-morgan") throw new Error("Canonical personal-evidence identity is incomplete.");

delete process.env.DATABASE_URL;
process.env.PENSIONS_STORAGE = "sqlite";
process.env.PENSIONS_DB_PATH = databasePath;
process.env.QUALIFICATION_CANONICAL_USER_ID = userId;
process.env.DISABLE_DOTENV_LOAD = "true";

const [{ canonicalQualificationFactsReadiness },{ lookupStructuredData }] = await Promise.all([
  import("../server/services/readinessService.js"),
  import("../server/services/structuredDataService.js"),
]);
const readiness = canonicalQualificationFactsReadiness(process.env);
if (readiness.ready !== true || readiness.canonicalUserId !== userId ||
    readiness.canonicalFactsSha256 !== expectedCanonicalFactsSha256 || readiness.actualCanonicalFactsSha256 !== expectedCanonicalFactsSha256) {
  throw new Error("Pinned SQLite personal facts do not match the verified runtime canonical-facts digest.");
}

const plans = [
  { structured_lookups:["account"],entities:{} },
  { structured_lookups:["document_status"],entities:{} },
  { structured_lookups:["projection"],entities:{} },
  { structured_lookups:["investment_profile"],entities:{} },
];
const allAccounts = lookupStructuredData(userId,plans[0]).sources;
const providers = [...new Set(allAccounts.flatMap((source) => [...String(source.snippet || "").matchAll(/^([^;(\n]+)\s*\(([^)]+)\)/gm)].map((match) => match[2])))];
for (const provider of providers) plans.push({ structured_lookups:["account"],entities:{ provider } });

const sources = [];
const byId = new Map();
for (const plan of plans) {
  for (const source of lookupStructuredData(userId,plan).sources) {
    const row = { source_id:String(source.sourceId),content:String(source.snippet || ""),scope:String(source.scope || ""),title:String(source.title || "") };
    const prior = byId.get(row.source_id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error(`Pinned personal evidence source ID is ambiguous: ${row.source_id}`);
    if (!prior) { byId.set(row.source_id,row); sources.push(row); }
  }
}
process.stdout.write(`${JSON.stringify({
  version:"qualification-personal-evidence-v1",database_path:databasePath,user_id:userId,
  canonical_facts_sha256:expectedCanonicalFactsSha256,sources,
})}\n`);

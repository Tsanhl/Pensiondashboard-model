import "../server/loadEnv.js";
import { readFileSync } from "node:fs";
import { initialiseCache } from "../server/services/cacheService.js";
import { retrieveKnowledge } from "../server/services/knowledgeService.js";
import { initialiseDataStore } from "../server/store/userDataStore.js";

const path = process.argv[2];
if (!path) throw new Error("Usage: npm run eval:retrieval -- private-eval.jsonl");
const rows = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
await initialiseDataStore();
await initialiseCache();
let hits = 0;
let expected = 0;
for (const row of rows) {
  const result = await retrieveKnowledge(row.user_id || "__public__", row.query, { limit:8,scopes:row.scopes || [] });
  const returned = new Set(result.sources.map((source) => source.sourceId));
  const ids = row.expected_source_ids || [];
  hits += ids.filter((id) => returned.has(id)).length;
  expected += ids.length;
}
const recallAt8 = expected ? hits / expected : 0;
console.log(JSON.stringify({ examples:rows.length,hits,expected,recall_at_8:recallAt8,gate:0.85,passed:recallAt8 >= 0.85 }, null, 2));
if (recallAt8 < 0.85) process.exitCode = 1;

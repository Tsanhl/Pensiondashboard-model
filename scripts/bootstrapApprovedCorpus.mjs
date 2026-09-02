import "../server/loadEnv.js";
import { bootstrapApprovedCorpus, approvedCorpusReadiness } from "../server/services/approvedCorpusService.js";
import { initialiseCache } from "../server/services/cacheService.js";
import { initialiseDataStore } from "../server/store/userDataStore.js";

await initialiseDataStore();
await initialiseCache();

const result = await bootstrapApprovedCorpus();
const readiness = await approvedCorpusReadiness();
if (!readiness.ready) throw Object.assign(new Error(`Approved corpus is not ready after bootstrap (${readiness.code}).`), { code:readiness.code });

console.log(JSON.stringify({ ...result,readiness }, null, 2));

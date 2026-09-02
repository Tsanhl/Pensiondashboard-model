import "../server/loadEnv.js";
import { initialiseDataStore, flushDataStore } from "../server/store/userDataStore.js";
import { runScheduledAgent } from "../server/services/schedulerService.js";

await initialiseDataStore();
const result = await runScheduledAgent({ reason: "external_cron" });
await flushDataStore();
console.log(JSON.stringify(result, null, 2));

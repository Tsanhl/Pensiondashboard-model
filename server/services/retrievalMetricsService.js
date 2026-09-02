import { cacheGet, cacheIncrement } from "./cacheService.js";

function day() { return new Date().toISOString().slice(0, 10); }

export async function recordRetrievalOutcome(noResult) {
  if (String(process.env.DISABLE_RETRIEVAL_METRICS || "false").toLowerCase() === "true") return;
  await cacheIncrement(`metrics:retrieval:${day()}:total`, 172800);
  if (noResult) await cacheIncrement(`metrics:retrieval:${day()}:no_result`, 172800);
}

export async function retrievalMetrics() {
  const total = Number(await cacheGet(`metrics:retrieval:${day()}:total`)) || 0;
  const noResult = Number(await cacheGet(`metrics:retrieval:${day()}:no_result`)) || 0;
  return { date:day(),total,noResult,noResultRate:total ? Number((noResult / total).toFixed(4)) : 0 };
}

import { createHash } from "node:crypto";

export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "BAAI/bge-small-en-v1.5";

function normalize(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function degradedEmbedding(text) {
  const vector = Array(EMBEDDING_DIMENSIONS).fill(0);
  const tokens = String(text || "").toLowerCase().match(/[a-z0-9£%]+/g) || [];
  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    for (let offset = 0; offset < digest.length; offset += 4) {
      const index = digest.readUInt16BE(offset) % EMBEDDING_DIMENSIONS;
      vector[index] += digest[offset + 2] % 2 ? 1 : -1;
    }
  }
  return normalize(vector);
}

export async function embedTexts(texts = []) {
  const values = texts.map((value) => String(value || ""));
  const serviceUrl = String(process.env.EMBEDDING_SERVICE_URL || "").replace(/\/$/, "");
  const degradedFallbackAllowed = String(process.env.ALLOW_DEGRADED_EMBEDDINGS || "true").toLowerCase() === "true";
  if (!serviceUrl && !degradedFallbackAllowed) {
    throw Object.assign(
      new Error("EMBEDDING_SERVICE_URL is required when degraded embeddings are disabled."),
      { code: "EMBEDDING_CONFIG_ERROR" },
    );
  }
  if (serviceUrl) {
    try {
      const embeddings = [];
      const batchSize = Math.max(1,Math.min(128,Number(process.env.EMBEDDING_BATCH_SIZE || 128)));
      for (let start = 0; start < values.length; start += batchSize) {
        const response = await fetch(`${serviceUrl}/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: EMBEDDING_MODEL, texts: values.slice(start,start + batchSize), normalize: true }),
          signal: AbortSignal.timeout(Number(process.env.EMBEDDING_TIMEOUT_MS || 15_000))
        });
        if (!response.ok) throw new Error(`embedding service returned ${response.status}`);
        const payload = await response.json();
        const batch = payload.embeddings;
        if (!Array.isArray(batch) || batch.some((item) => !Array.isArray(item) || item.length !== EMBEDDING_DIMENSIONS)) {
          throw new Error(`embedding service must return ${EMBEDDING_DIMENSIONS}-dimension vectors`);
        }
        embeddings.push(...batch);
      }
      return { embeddings: embeddings.map(normalize), model: EMBEDDING_MODEL, degraded: false };
    } catch (error) {
      if (!degradedFallbackAllowed) throw error;
    }
  }
  return { embeddings: values.map(degradedEmbedding), model: `${EMBEDDING_MODEL}:deterministic-test-fallback`, degraded: true };
}

export function cosineSimilarity(left = [], right = []) {
  if (left.length !== EMBEDDING_DIMENSIONS || right.length !== EMBEDDING_DIMENSIONS) return 0;
  let score = 0;
  for (let index = 0; index < EMBEDDING_DIMENSIONS; index += 1) score += left[index] * right[index];
  return score;
}

export function embeddingStatus() {
  return {
    model:EMBEDDING_MODEL,
    dimensions:EMBEDDING_DIMENSIONS,
    serviceConfigured:Boolean(process.env.EMBEDDING_SERVICE_URL),
    degradedFallbackAllowed:String(process.env.ALLOW_DEGRADED_EMBEDDINGS || "true").toLowerCase() === "true"
  };
}

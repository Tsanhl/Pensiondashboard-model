const localCache = new Map();
let redisClient = null;
let redisState = "local";

function localGet(key) {
  const item = localCache.get(key);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    localCache.delete(key);
    return null;
  }
  return structuredClone(item.value);
}

export async function initialiseCache() {
  if (!process.env.REDIS_URL) return cacheStatus();
  try {
    const { createClient } = await import("redis");
    redisClient = createClient({
      url: process.env.REDIS_URL,
      socket: { connectTimeout: 900, reconnectStrategy: false }
    });
    redisClient.on("error", () => {});
    await redisClient.connect();
    redisState = "redis";
  } catch (error) {
    redisClient = null;
    redisState = "local-degraded";
    console.warn(`Redis unavailable; using process-local cache: ${error.message}`);
  }
  return cacheStatus();
}

export async function cacheGet(key) {
  if (redisClient?.isReady) {
    const raw = await redisClient.get(key);
    return raw ? JSON.parse(raw) : null;
  }
  return localGet(key);
}

export async function cacheSet(key, value, ttlSeconds) {
  const ttl = Math.max(1, Number(ttlSeconds) || 60);
  if (redisClient?.isReady) {
    await redisClient.set(key, JSON.stringify(value), { EX: ttl });
    return;
  }
  localCache.set(key, { value: structuredClone(value), expiresAt: Date.now() + ttl * 1000 });
}

export async function cacheDeletePrefix(prefix) {
  if (redisClient?.isReady) {
    let cursor = "0";
    do {
      const result = await redisClient.scan(cursor, { MATCH: `${prefix}*`, COUNT: 100 });
      cursor = String(result.cursor);
      if (result.keys.length) await redisClient.del(result.keys);
    } while (cursor !== "0");
    return;
  }
  for (const key of localCache.keys()) if (key.startsWith(prefix)) localCache.delete(key);
}

export async function cacheIncrement(key, ttlSeconds) {
  const ttl = Math.max(1, Number(ttlSeconds) || 60);
  if (redisClient?.isReady) {
    const value = await redisClient.incr(key);
    if (value === 1) await redisClient.expire(key, ttl);
    return value;
  }
  const current = localGet(key) || 0;
  const next = Number(current) + 1;
  localCache.set(key, { value:next,expiresAt:Date.now() + ttl * 1000 });
  return next;
}

export function cacheStatus() {
  return {
    mode: redisState,
    connected: Boolean(redisClient?.isReady),
    sourceOfTruth: false
  };
}

export async function cacheReadiness({ requireRedis = false } = {}) {
  if (requireRedis && !redisClient?.isReady) {
    return { ready:false,code:"CACHE_REDIS_UNAVAILABLE",mode:redisState };
  }
  try {
    if (redisClient?.isReady) {
      const pong = await redisClient.ping();
      return pong === "PONG"
        ? { ready:true,code:"CACHE_READY",mode:"redis" }
        : { ready:false,code:"CACHE_PING_FAILED",mode:"redis" };
    }
    const key = `readiness:${process.pid}:${Date.now()}`;
    await cacheSet(key, { ok:true }, 5);
    const value = await cacheGet(key);
    await cacheDeletePrefix(key);
    return value?.ok === true
      ? { ready:true,code:"CACHE_READY",mode:redisState }
      : { ready:false,code:"CACHE_ROUND_TRIP_FAILED",mode:redisState };
  } catch {
    return { ready:false,code:"CACHE_UNAVAILABLE",mode:redisState };
  }
}

export async function closeCache() {
  if (redisClient?.isReady) await redisClient.quit();
}

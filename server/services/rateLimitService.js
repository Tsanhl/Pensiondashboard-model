const buckets = new Map();

function now() {
  return Date.now();
}

function keyFor(key = "global", windowMs) {
  return `${key}:${Math.floor(now() / windowMs)}`;
}

export function checkRateLimit({ key = "global", limit = 20, windowMs = 60_000 } = {}) {
  const bucketKey = keyFor(key, windowMs);
  const current = buckets.get(bucketKey) || { count: 0, resetAt: now() + windowMs };
  current.count += 1;
  buckets.set(bucketKey, current);

  for (const [itemKey, item] of buckets) {
    if (item.resetAt < now()) buckets.delete(itemKey);
  }

  if (current.count > limit) {
    const error = new Error("Too many requests. Try again shortly.");
    error.status = 429;
    error.retryAfter = Math.max(1, Math.ceil((current.resetAt - now()) / 1000));
    throw error;
  }
  return {
    remaining: Math.max(0, limit - current.count),
    resetAt: new Date(current.resetAt).toISOString()
  };
}

export async function checkRateLimitAsync({ key = "global",limit = 20,windowMs = 60_000 } = {}) {
  const resetAt = (Math.floor(Date.now() / windowMs) + 1) * windowMs;
  const bucketKey = `rate:${key}:${Math.floor(Date.now() / windowMs)}`;
  const count = await cacheIncrement(bucketKey, Math.ceil(windowMs / 1000) + 1);
  if (count > limit) {
    const error = new Error("Too many requests. Try again shortly.");
    error.status = 429;
    error.retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    throw error;
  }
  return { remaining:Math.max(0,limit-count),resetAt:new Date(resetAt).toISOString() };
}
import { cacheIncrement } from "./cacheService.js";

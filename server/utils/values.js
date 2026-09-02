export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function slugify(value = "item") {
  return String(value || "item")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

export function moneyToNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value ?? "").replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function percentToNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value ?? "").replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normaliseStyle(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (["aggressive", "growth", "high risk", "high-risk"].includes(raw)) return "growth";
  if (["conservative", "cautious", "low risk", "low-risk", "safe"].includes(raw)) return "conservative";
  if (["balanced", "moderate", "medium risk", "medium-risk"].includes(raw)) return "balanced";
  return "";
}

export function displayStyle(value = "") {
  const style = normaliseStyle(value);
  if (style === "growth") return "Growth";
  if (style === "conservative") return "Conservative";
  if (style === "balanced") return "Balanced";
  return "";
}

export function parseReadableDate(value, fallback = null) {
  if (!value) return fallback;
  const text = String(value).trim();
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return new Date(parsed);
  const withUtc = Date.parse(`${text} UTC`);
  return Number.isFinite(withUtc) ? new Date(withUtc) : fallback;
}

export function daysSince(value, now = new Date()) {
  const date = parseReadableDate(value);
  if (!date) return null;
  const diff = now.getTime() - date.getTime();
  return Math.max(0, Math.floor(diff / 86_400_000));
}

export function isoNow() {
  return new Date().toISOString();
}

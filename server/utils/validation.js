export function requireString(value, field, { max = 240, optional = false } = {}) {
  const text = String(value ?? "").trim();
  if (!text && !optional) throw validationError(`${field} is required`);
  if (text.length > max) throw validationError(`${field} is too long`);
  return text;
}

export function requireNumber(value, field, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if ((value == null || value === "") && optional) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw validationError(`${field} must be a number`);
  if (number < min || number > max) throw validationError(`${field} is outside the allowed range`);
  return number;
}

export function requireEnum(value, field, allowed, { optional = false } = {}) {
  const text = String(value ?? "").trim();
  if (!text && optional) return "";
  if (!allowed.includes(text)) throw validationError(`${field} must be one of: ${allowed.join(", ")}`);
  return text;
}

export function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function validateActionInput(input = {}) {
  return {
    title: requireString(input.title, "title"),
    detail: requireString(input.detail || "", "detail", { max: 1000, optional: true }),
    priority: requireEnum(input.priority || "medium", "priority", ["high", "medium", "low"]),
    category: requireString(input.category || "manual", "category", { max: 80, optional: true }),
    linkedView: requireString(input.linkedView || "overview", "linkedView", { max: 80, optional: true }),
    dueAt: requireString(input.dueAt || "", "dueAt", { max: 80, optional: true })
  };
}

export function validateRiskProfileInput(input = {}) {
  return {
    preferredStyle: requireEnum(input.preferredStyle || "", "preferredStyle", ["", "conservative", "balanced", "growth"], { optional: true }),
    timeHorizonYears: requireNumber(input.timeHorizonYears, "timeHorizonYears", { min: 0, max: 60, optional: true }),
    lossTolerancePct: requireNumber(input.lossTolerancePct, "lossTolerancePct", { min: 0, max: 80, optional: true }),
    mainGoal: requireString(input.mainGoal || "", "mainGoal", { max: 160, optional: true }),
    mustCheckItems: Array.isArray(input.mustCheckItems) ? input.mustCheckItems.slice(0, 12).map((item) => requireString(item, "mustCheckItems", { max: 80, optional: true })).filter(Boolean) : requireString(input.mustCheckItems || "", "mustCheckItems", { max: 500, optional: true })
  };
}

export function validateNotificationPreferences(input = {}) {
  const cadence = ["immediate", "daily", "weekly", "off"];
  const next = {};
  for (const key of ["actionNeeded", "documentReview", "projectionUpdates", "investmentReview", "annualReview", "emailSummary", "phonePush"]) {
    if (input[key] != null) next[key] = requireEnum(input[key], key, cadence);
  }
  if (input.inApp != null) next.inApp = Boolean(input.inApp);
  return next;
}

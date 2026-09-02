import { daysSince, isoNow } from "../utils/values.js";
import { newId, readActions, writeActions } from "../store/userDataStore.js";
import { notifyUrgentAction } from "./notificationService.js";

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const LOW_TO_MEDIUM_DAYS = 90;
const MEDIUM_TO_HIGH_DAYS = 30;

function normalisePriority(priority = "medium") {
  return ["high", "medium", "low"].includes(priority) ? priority : "medium";
}

function actionFromCandidate(candidate) {
  return {
    id: newId("action"),
    source: "agent",
    sourceKey: candidate.sourceKey,
    category: candidate.category || "general",
    priority: normalisePriority(candidate.priority),
    basePriority: normalisePriority(candidate.priority),
    escalation: null,
    title: candidate.title,
    detail: candidate.detail || "",
    linkedView: candidate.linkedView || "overview",
    status: "open",
    createdAt: isoNow(),
    updatedAt: isoNow(),
    dueAt: candidate.dueAt || null,
    completedAt: null
  };
}

function priorityWithAgeEscalation(action = {}, basePriority = "medium", now = new Date()) {
  const priority = normalisePriority(basePriority);
  if (priority === "high" || action.priority === "high") {
    return { priority: "high", escalation: action.escalation || null };
  }
  const age = daysSince(action.createdAt, now) ?? 0;
  if (priority === "medium" && age >= MEDIUM_TO_HIGH_DAYS) {
    return {
      priority: "high",
      escalation: {
        reason: "open_too_long",
        from: "medium",
        to: "high",
        thresholdDays: MEDIUM_TO_HIGH_DAYS,
        ageDays: age,
        escalatedAt: action.escalation?.escalatedAt || isoNow()
      }
    };
  }
  if (priority === "low" && age >= LOW_TO_MEDIUM_DAYS + MEDIUM_TO_HIGH_DAYS) {
    return {
      priority: "high",
      escalation: {
        reason: "open_too_long",
        from: "low",
        to: "high",
        thresholdDays: LOW_TO_MEDIUM_DAYS + MEDIUM_TO_HIGH_DAYS,
        ageDays: age,
        escalatedAt: action.escalation?.escalatedAt || isoNow()
      }
    };
  }
  if (priority === "low" && age >= LOW_TO_MEDIUM_DAYS) {
    return {
      priority: "medium",
      escalation: {
        reason: "open_too_long",
        from: "low",
        to: "medium",
        thresholdDays: LOW_TO_MEDIUM_DAYS,
        ageDays: age,
        escalatedAt: action.escalation?.escalatedAt || isoNow()
      }
    };
  }
  return { priority, escalation: action.escalation || null };
}

function applyAgeEscalation(action, basePriority = action.basePriority || action.priority, now = new Date()) {
  const next = priorityWithAgeEscalation(action, basePriority, now);
  const changed = action.priority !== next.priority || JSON.stringify(action.escalation || null) !== JSON.stringify(next.escalation || null);
  action.basePriority = normalisePriority(basePriority);
  action.priority = next.priority;
  action.escalation = next.escalation;
  if (changed) action.updatedAt = isoNow();
  return changed;
}

function questionRelevantToAction(question = "", action = {}) {
  const text = String(question || "").toLowerCase();
  const category = String(action.category || "").toLowerCase();
  const sourceKey = String(action.sourceKey || "").toLowerCase();
  const combined = `${category} ${sourceKey} ${action.title || ""} ${action.detail || ""}`.toLowerCase();
  if (/\b(charge|fee|cost|transfer|consolidat|provider|fund|investment|move|switch)\b/.test(text) && /\b(charge|account|provider|investment)\b/.test(combined)) return true;
  if (/\b(project|projection|gap|target|income|contribution|retirement age|assumption)\b/.test(text) && /\b(projection|target|gap|contribution)\b/.test(combined)) return true;
  if (/\b(document|statement|policy|guarantee|legal|law|employer|scheme|transfer|rely|verify)\b/.test(text) && /\b(document|data_quality|manual|stale|provider)\b/.test(combined)) return true;
  if (/\b(advice|suggest|recommend|should i|what should|change|switch|move)\b/.test(text) && /\b(data_quality|manual|stale|document|charge|projection)\b/.test(combined)) return true;
  return false;
}

function actionRequiresUserData(action = {}) {
  const combined = `${action.category || ""} ${action.sourceKey || ""} ${action.title || ""} ${action.detail || ""}`.toLowerCase();
  return /\b(documents?|data_quality|manual|statement|upload|confirm|missing|stale|provider)\b/.test(combined);
}

export function questionDependencyActions(userId, question = "") {
  return sortActions(readActions(userId).filter((action) => (
    action.status === "open" &&
    actionRequiresUserData(action) &&
    questionRelevantToAction(question, action)
  )));
}

export function questionDependencyWarning(userId, question = "") {
  const actions = questionDependencyActions(userId, question);
  if (!actions.length) return "";
  const titles = actions
    .slice(0, 2)
    .map((action) => String(action.title || "the open data task").replace(/[.]+$/g, "").toLowerCase());
  const taskText = titles.length === 1 ? titles[0] : `${titles[0]} and ${titles[1]}`;
  return `Before relying on this answer, complete this data task first: ${taskText}.`;
}

export function sortActions(actions = []) {
  return [...actions].sort((a, b) => {
    const priority = (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
    if (priority) return priority;
    return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
  });
}

export function syncActionsFromAgent(userId, summary) {
  const candidates = Array.isArray(summary?.actionCandidates) ? summary.actionCandidates : [];
  const candidateKeys = new Set(candidates.map((candidate) => candidate?.sourceKey).filter(Boolean));
  const actions = readActions(userId);
  let changed = false;

  for (const candidate of candidates) {
    if (!candidate?.sourceKey || !candidate.title) continue;
    const dismissed = actions.find((action) => action.sourceKey === candidate.sourceKey && action.status === "dismissed");
    if (dismissed) continue;
    const existing = actions.find((action) => action.sourceKey === candidate.sourceKey && action.status !== "dismissed");
    if (existing) {
      const basePriority = normalisePriority(candidate.priority);
      const nextPriority = priorityWithAgeEscalation(existing, basePriority);
      const previousPriority = existing.priority;
      if (
        existing.title !== candidate.title ||
        existing.detail !== candidate.detail ||
        existing.priority !== nextPriority.priority ||
        existing.basePriority !== basePriority ||
        existing.linkedView !== candidate.linkedView
      ) {
        existing.title = candidate.title;
        existing.detail = candidate.detail || "";
        existing.basePriority = basePriority;
        existing.priority = nextPriority.priority;
        existing.escalation = nextPriority.escalation;
        existing.linkedView = candidate.linkedView || existing.linkedView || "overview";
        existing.updatedAt = isoNow();
        if (previousPriority !== "high" && existing.priority === "high") notifyUrgentAction(userId, existing);
        changed = true;
      }
      continue;
    }
    const action = actionFromCandidate(candidate);
    applyAgeEscalation(action);
    actions.push(action);
    changed = true;
  }

  for (const action of actions) {
    if (action.source === "agent" && action.status === "open" && action.sourceKey && !candidateKeys.has(action.sourceKey)) {
      action.status = "dismissed";
      action.updatedAt = isoNow();
      action.completedAt = action.completedAt || null;
      changed = true;
      continue;
    }
    if (action.status === "open") {
      const previousPriority = action.priority;
      if (applyAgeEscalation(action)) {
        if (previousPriority !== "high" && action.priority === "high") notifyUrgentAction(userId, action);
        changed = true;
      }
    }
  }

  return changed ? writeActions(userId, actions) : actions;
}

export function escalateActionsForAssistantQuestion(userId, question = "") {
  const actions = readActions(userId);
  const escalated = [];
  for (const action of actions) {
    if (action.status !== "open" || !questionRelevantToAction(question, action)) continue;
    const current = normalisePriority(action.priority);
    if (current === "high") continue;
    action.basePriority = action.basePriority || current;
    action.priority = current === "medium" ? "high" : "medium";
    action.escalation = {
      reason: "assistant_question_depends_on_open_item",
      from: current,
      to: action.priority,
      questionPreview: String(question).slice(0, 160),
      escalatedAt: isoNow()
    };
    action.updatedAt = isoNow();
    if (action.priority === "high") notifyUrgentAction(userId, action);
    escalated.push(action);
  }
  if (escalated.length) writeActions(userId, actions);
  return escalated;
}

export function listActions(userId, { status = "open" } = {}) {
  const actions = readActions(userId);
  const filtered = status === "all" ? actions : actions.filter((action) => action.status === status);
  return sortActions(filtered);
}

export function createManualAction(userId, input = {}) {
  const actions = readActions(userId);
  const action = {
    id: newId("action"),
    source: "manual",
    sourceKey: input.sourceKey || null,
    category: input.category || "manual",
    priority: normalisePriority(input.priority || "medium"),
    title: String(input.title || "").trim(),
    detail: String(input.detail || "").trim(),
    linkedView: input.linkedView || "overview",
    status: "open",
    createdAt: isoNow(),
    updatedAt: isoNow(),
    dueAt: input.dueAt || null,
    completedAt: null
  };
  if (!action.title) throw new Error("Action title is required");
  actions.push(action);
  writeActions(userId, actions);
  return action;
}

export function updateAction(userId, actionId, patch = {}) {
  const actions = readActions(userId);
  const action = actions.find((item) => item.id === actionId);
  if (!action) {
    const error = new Error("Action not found");
    error.status = 404;
    throw error;
  }
  if (patch.title != null) action.title = String(patch.title).trim() || action.title;
  if (patch.detail != null) action.detail = String(patch.detail).trim();
  if (patch.priority != null) action.priority = normalisePriority(patch.priority);
  if (patch.linkedView != null) action.linkedView = String(patch.linkedView || "overview");
  if (patch.dueAt !== undefined) action.dueAt = patch.dueAt || null;
  if (patch.status != null) {
    const nextStatus = String(patch.status);
    if (!["open", "done", "dismissed"].includes(nextStatus)) throw new Error("Unsupported action status");
    action.status = nextStatus;
    action.completedAt = nextStatus === "done" ? isoNow() : null;
  }
  action.updatedAt = isoNow();
  writeActions(userId, actions);
  return action;
}

import { isoNow } from "../utils/values.js";
import {
  newId,
  readNotificationPreferences,
  readNotifications,
  writeNotificationPreferences,
  writeNotifications
} from "../store/userDataStore.js";
import { queueNotificationDelivery } from "./notificationDeliveryService.js";

function isUrgentTaskNotification(notification = {}) {
  if ((notification.priority || "medium") !== "high") return false;
  const combined = [
    notification.category,
    notification.preferenceKey,
    notification.source,
    notification.sourceKey,
    notification.title,
    notification.body,
    notification.detail
  ].join(" ").toLowerCase();
  return /\b(data_quality|documents?|manual|statement|upload|confirm|missing|stale|provider)\b/.test(combined);
}

function channelsFor(preferences, notification = {}) {
  const channels = ["in_app"];
  const urgentTask = isUrgentTaskNotification(notification);
  if (urgentTask && preferences.emailSummary && preferences.emailSummary !== "off") channels.push("email_summary");
  if (urgentTask && preferences.phonePush && preferences.phonePush !== "off") channels.push("phone_push");
  return channels;
}

function preferenceAllows(preferences, candidate) {
  const key = candidate.preferenceKey || "actionNeeded";
  if (preferences.inApp === false) return false;
  return preferences[key] !== "off";
}

export function syncNotificationsFromAgent(userId, summary) {
  const preferences = readNotificationPreferences(userId);
  const candidates = Array.isArray(summary?.notificationCandidates) ? summary.notificationCandidates : [];
  const candidateKeys = new Set(candidates.map((candidate) => candidate?.sourceKey).filter(Boolean));
  const notifications = readNotifications(userId);
  let changed = false;

  for (const candidate of candidates) {
    if (!candidate?.sourceKey || !candidate.title || !preferenceAllows(preferences, candidate)) continue;
    const dismissed = notifications.find((notification) => notification.sourceKey === candidate.sourceKey && notification.status === "dismissed");
    if (dismissed) continue;
    const existing = notifications.find((notification) => notification.sourceKey === candidate.sourceKey);
    if (existing) {
      const nextChannels = channelsFor(preferences, candidate);
      if (
        existing.title !== candidate.title ||
        existing.body !== candidate.body ||
        existing.priority !== candidate.priority ||
        JSON.stringify(existing.channels || []) !== JSON.stringify(nextChannels)
      ) {
        existing.title = candidate.title;
        existing.body = candidate.body || "";
        existing.priority = candidate.priority || "medium";
        existing.channels = nextChannels;
        existing.updatedAt = isoNow();
        changed = true;
      }
      continue;
    }
    const notification = {
      id: newId("notification"),
      source: "agent",
      sourceKey: candidate.sourceKey,
      category: candidate.category || "action",
      preferenceKey: candidate.preferenceKey || "actionNeeded",
      priority: candidate.priority || "medium",
      title: candidate.title,
      body: candidate.body || "",
      linkedView: candidate.linkedView || "overview",
      status: "unread",
      channels: channelsFor(preferences, candidate),
      createdAt: isoNow(),
      updatedAt: isoNow(),
      readAt: null
    };
    notifications.unshift(notification);
    queueNotificationDelivery(userId, notification);
    changed = true;
  }

  for (const notification of notifications) {
    if (notification.source === "agent" && notification.status !== "dismissed" && notification.sourceKey && !candidateKeys.has(notification.sourceKey)) {
      notification.status = "dismissed";
      notification.updatedAt = isoNow();
      changed = true;
    }
  }

  return changed ? writeNotifications(userId, notifications) : notifications;
}

export function createNotification(userId, input = {}) {
  const preferences = readNotificationPreferences(userId);
  const notifications = readNotifications(userId);
  const notification = {
    id: newId("notification"),
    source: input.source || "system",
    sourceKey: input.sourceKey || `system_${Date.now()}`,
    category: input.category || "update",
    preferenceKey: input.preferenceKey || "actionNeeded",
    priority: input.priority || "medium",
    title: String(input.title || "Dashboard updated").trim(),
    body: String(input.body || "Open the dashboard to review the latest update.").trim(),
    linkedView: input.linkedView || "overview",
    status: "unread",
    channels: channelsFor(preferences, input),
    createdAt: isoNow(),
    updatedAt: isoNow(),
    readAt: null
  };
  notifications.unshift(notification);
  writeNotifications(userId, notifications);
  queueNotificationDelivery(userId, notification);
  return notification;
}

export function notifyUrgentAction(userId, action = {}) {
  if (!action?.id && !action?.sourceKey) return null;
  const preferences = readNotificationPreferences(userId);
  const notifications = readNotifications(userId);
  const sourceKey = `urgent_action_${action.id || action.sourceKey}`;
  const body = action.detail || "This action has become urgent and should be reviewed before relying on the dashboard.";
  const existing = notifications.find((notification) => notification.sourceKey === sourceKey && notification.status !== "dismissed");
  if (existing) {
    let changed = false;
    const nextChannels = channelsFor(preferences, { ...existing, priority: "high", category: action.category || existing.category });
    if (existing.title !== action.title) {
      existing.title = action.title;
      changed = true;
    }
    if (existing.body !== body) {
      existing.body = body;
      changed = true;
    }
    if (existing.priority !== "high") {
      existing.priority = "high";
      changed = true;
    }
    if (JSON.stringify(existing.channels || []) !== JSON.stringify(nextChannels)) {
      existing.channels = nextChannels;
      changed = true;
    }
    if (changed) {
      existing.updatedAt = isoNow();
      writeNotifications(userId, notifications);
      queueNotificationDelivery(userId, existing);
    }
    return existing;
  }
  const notification = {
    id: newId("notification"),
    source: "action_escalation",
    sourceKey,
    category: action.category || "action",
    preferenceKey: "actionNeeded",
    priority: "high",
    title: action.title || "Action needs urgent review",
    body,
    linkedView: action.linkedView || "overview",
    status: "unread",
    channels: channelsFor(preferences, { priority: "high", category: action.category || "action" }),
    createdAt: isoNow(),
    updatedAt: isoNow(),
    readAt: null
  };
  notifications.unshift(notification);
  writeNotifications(userId, notifications);
  queueNotificationDelivery(userId, notification);
  return notification;
}

export function listNotifications(userId, { status = "active" } = {}) {
  const notifications = readNotifications(userId);
  if (status === "all") return notifications;
  if (status === "unread") return notifications.filter((notification) => notification.status === "unread");
  return notifications.filter((notification) => notification.status !== "dismissed");
}

export function markNotificationRead(userId, notificationId) {
  const notifications = readNotifications(userId);
  const notification = notifications.find((item) => item.id === notificationId);
  if (!notification) {
    const error = new Error("Notification not found");
    error.status = 404;
    throw error;
  }
  notification.status = "read";
  notification.readAt = isoNow();
  notification.updatedAt = isoNow();
  writeNotifications(userId, notifications);
  return notification;
}

export function dismissNotification(userId, notificationId) {
  const notifications = readNotifications(userId);
  const notification = notifications.find((item) => item.id === notificationId);
  if (!notification) {
    const error = new Error("Notification not found");
    error.status = 404;
    throw error;
  }
  notification.status = "dismissed";
  notification.updatedAt = isoNow();
  writeNotifications(userId, notifications);
  return notification;
}

export function getNotificationPreferences(userId) {
  return readNotificationPreferences(userId);
}

export function updateNotificationPreferences(userId, preferences = {}) {
  return writeNotificationPreferences(userId, preferences);
}

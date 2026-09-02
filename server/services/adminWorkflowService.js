import { isoNow } from "../utils/values.js";
import {
  appendAuditEvent,
  listKnownUsers,
  newId,
  readDeletionRequests,
  writeDeletionRequests
} from "../store/userDataStore.js";

const ALLOWED_STATUSES = new Set(["pending", "approved", "rejected", "completed"]);

export function requestDataDeletion(userId, { reason = "", requestedBy = "user" } = {}) {
  const requests = readDeletionRequests(userId);
  const open = requests.find((request) => ["pending", "approved"].includes(request.status));
  if (open) return open;
  const request = {
    id: newId("delete_req"),
    userId,
    status: "pending",
    reason: String(reason || "").trim(),
    requestedBy,
    createdAt: isoNow(),
    updatedAt: isoNow(),
    reviewedAt: null,
    reviewedBy: null,
    adminNote: ""
  };
  requests.unshift(request);
  writeDeletionRequests(userId, requests);
  appendAuditEvent(userId, { type: "data_deletion_requested", requestId: request.id });
  return request;
}

export function listDeletionRequests({ status = "all" } = {}) {
  const requests = [];
  for (const userId of listKnownUsers()) {
    for (const request of readDeletionRequests(userId)) requests.push({ ...request, userId });
  }
  const filtered = status === "all" ? requests : requests.filter((request) => request.status === status);
  return filtered.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

export function updateDeletionRequest(requestId, { status, adminNote = "", reviewedBy = "admin" } = {}) {
  const nextStatus = String(status || "").trim();
  if (!ALLOWED_STATUSES.has(nextStatus)) throw new Error("Unsupported deletion request status");
  for (const userId of listKnownUsers()) {
    const requests = readDeletionRequests(userId);
    const request = requests.find((item) => item.id === requestId);
    if (!request) continue;
    request.status = nextStatus;
    request.adminNote = String(adminNote || request.adminNote || "").trim();
    request.reviewedBy = reviewedBy;
    request.reviewedAt = isoNow();
    request.updatedAt = isoNow();
    writeDeletionRequests(userId, requests);
    appendAuditEvent(userId, { type: "data_deletion_reviewed", requestId, status: nextStatus, reviewedBy });
    return request;
  }
  const error = new Error("Deletion request not found");
  error.status = 404;
  throw error;
}

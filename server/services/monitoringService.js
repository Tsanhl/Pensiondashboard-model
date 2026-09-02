import { listKnownUsers, readAuditLog, readSystemEvents, storageStatus } from "../store/userDataStore.js";
import { listComplianceCases } from "./complianceService.js";
import { queueStatus } from "./jobQueueService.js";
import { listNotificationDeliveries } from "./notificationDeliveryService.js";
import { schedulerStatus } from "./schedulerService.js";

export function monitoringStatus({ userId = "" } = {}) {
  const users = userId ? [userId] : listKnownUsers();
  const deliveries = users.flatMap((id) => listNotificationDeliveries(id, { status: "all" }).map((delivery) => ({ userId: id, ...delivery })));
  const audits = users.flatMap((id) => readAuditLog(id).slice(0, 20).map((event) => ({ userId: id, ...event })));
  return {
    generatedAt: new Date().toISOString(),
    storage: storageStatus(),
    scheduler: schedulerStatus(),
    jobs: queueStatus(),
    notifications: {
      totalDeliveries: deliveries.length,
      queued: deliveries.filter((item) => item.status === "queued").length,
      retry: deliveries.filter((item) => item.status === "retry").length,
      failed: deliveries.filter((item) => item.status === "failed").length,
      delivered: deliveries.filter((item) => item.status === "delivered").length,
      recentFailures: deliveries
        .filter((item) => item.status === "failed" || item.status === "retry")
        .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
        .slice(0, 10)
    },
    compliance: {
      openCases: listComplianceCases({ status: "open" }).length,
      recentCases: listComplianceCases({ status: "all" }).slice(0, 10)
    },
    audit: {
      recentEvents: audits
        .sort((a, b) => String(b.occurredAt || "").localeCompare(String(a.occurredAt || "")))
        .slice(0, 20)
    },
    systemEvents: readSystemEvents().slice(0, 20)
  };
}

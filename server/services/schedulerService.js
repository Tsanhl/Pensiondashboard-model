import { isoNow } from "../utils/values.js";
import { appendSystemEvent, flushDataStore, listKnownUsers, readSchedulerRuns, storageStatus, writeSchedulerRuns } from "../store/userDataStore.js";
import { runAgentForUser } from "./agentService.js";
import { flushNotificationDeliveries } from "./notificationDeliveryService.js";

const schedules = [
  { id: "daily_agent_check", cadence: "daily", enabled: true, purpose: "Check new uploads, scan status and urgent actions." },
  { id: "weekly_dashboard_review", cadence: "weekly", enabled: true, purpose: "Check target gap, contribution changes, stale data and missing fields." },
  { id: "monthly_progress_summary", cadence: "monthly", enabled: true, purpose: "Summarise pension progress and investment review status." },
  { id: "annual_pension_review", cadence: "annual", enabled: true, purpose: "Prompt a full pension review." }
];

let schedulerTimer = null;
let schedulerStartedAt = null;
let schedulerLastTick = null;

function schedulerEnabled() {
  return String(process.env.AGENT_SCHEDULER_ENABLED || "true").toLowerCase() !== "false";
}

function schedulerIntervalMs() {
  return Math.max(60_000, Number(process.env.AGENT_SCHEDULER_INTERVAL_MS || 5 * 60_000));
}

function appendSchedulerRun(userId, run) {
  const runs = readSchedulerRuns(userId);
  runs.unshift(run);
  writeSchedulerRuns(userId, runs.slice(0, 100));
}

export async function runScheduledAgent({ userId = "", reason = "scheduled_agent_run" } = {}) {
  const users = userId ? [userId] : listKnownUsers();
  const results = [];
  for (const id of users) {
    const summary = runAgentForUser({ userId: id, persist: true, reason });
    const deliveries = await flushNotificationDeliveries(id);
    const run = {
      id: `scheduler_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      reason,
      status: summary.status,
      openActions: summary.actions.filter((action) => action.status === "open").length,
      notificationsProcessed: deliveries.processed,
      ranAt: isoNow()
    };
    appendSchedulerRun(id, run);
    results.push({ userId: id, ...run });
  }
  await flushDataStore();
  schedulerLastTick = isoNow();
  return { ranAt: schedulerLastTick, users: results };
}

export function startAgentScheduler() {
  if (!schedulerEnabled() || schedulerTimer) return schedulerStatus();
  schedulerStartedAt = isoNow();
  schedulerTimer = setInterval(() => {
    runScheduledAgent({ reason: "background_interval" }).catch((error) => {
      console.error("Scheduled agent run failed:", error.message);
      appendSystemEvent({ type: "scheduler_error", message: error.message || "Scheduled agent run failed" });
    });
  }, schedulerIntervalMs());
  schedulerTimer.unref?.();
  return schedulerStatus();
}

export function schedulerStatus() {
  const users = listKnownUsers();
  return {
    generatedAt: isoNow(),
    mode: "background_agent_scheduler",
    enabled: schedulerEnabled(),
    running: Boolean(schedulerTimer),
    startedAt: schedulerStartedAt,
    lastTick: schedulerLastTick,
    intervalMs: schedulerIntervalMs(),
    storage: storageStatus(),
    schedules,
    users: users.map((userId) => ({ userId, recentRuns: readSchedulerRuns(userId).slice(0, 3) })),
    productionNeeded: ["external_cron_or_worker", "timezone_per_user", "missed_run_recovery", "observability_alerts"]
  };
}

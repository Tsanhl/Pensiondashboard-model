export function hasStickyWorkerInterruption(state = {}, reportNames = []) {
  const stateRecordsInterruption = ["REQUESTED","COMPLETED"].includes(String(state.interruption?.status || "")) ||
    state.status === "INTERRUPTING" || /received\s+SIG(?:INT|TERM)\b|persisted worker interruption/i.test(String(state.blocker || ""));
  const reportRecordsInterruption = (reportNames || []).some((name) => /^WORKER_INTERRUPTION(?:-INTENT)?-\d+\.json$/.test(String(name)));
  return stateRecordsInterruption || reportRecordsInterruption;
}

import { now, sleep } from "./utils.mjs";

export function processGroupAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  if (process.platform === "win32") {
    try { process.kill(Number(pid),0); return true; } catch { return false; }
  }
  try { process.kill(-Number(pid),0); return true; } catch { return false; }
}

export function signalProcessGroup(pid,signal) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  if (process.platform !== "win32") {
    try { process.kill(-Number(pid),signal); return true; } catch {}
  }
  try { process.kill(Number(pid),signal); return true; } catch { return false; }
}

async function waitForGroupExit(pid,timeoutMs,pollMs) {
  const deadline = Date.now() + Math.max(0,Number(timeoutMs));
  while (processGroupAlive(pid) && Date.now() < deadline) await sleep(Math.max(10,Number(pollMs) || 50));
  return !processGroupAlive(pid);
}

export async function terminateProcessGroup(pid,{ reason,terminationGraceMs,killSettleMs,pollMs = 50 }) {
  const result = {
    reason,pid:Number(pid),started_at:now(),term_sent:false,term_sent_at:null,
    kill_sent:false,kill_sent_at:null,stopped:false,completed_at:null,
  };
  if (!processGroupAlive(pid)) return { ...result,stopped:true,completed_at:now(),detail:"process_group_already_absent" };
  result.term_sent = signalProcessGroup(pid,"SIGTERM");
  result.term_sent_at = now();
  if (await waitForGroupExit(pid,terminationGraceMs,pollMs)) return { ...result,stopped:true,completed_at:now(),detail:"stopped_after_sigterm" };
  result.kill_sent = signalProcessGroup(pid,"SIGKILL");
  result.kill_sent_at = now();
  result.stopped = await waitForGroupExit(pid,killSettleMs,pollMs);
  result.completed_at = now();
  result.detail = result.stopped ? "stopped_after_sigkill" : "process_group_remains_after_sigkill";
  return result;
}

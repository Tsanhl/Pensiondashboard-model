import { join } from "node:path";
import { atomicWrite, now } from "./utils.mjs";

export function statusMarkdown(state) {
  const completed = state.completed_stages || [];
  const currentGate = state.stage_results?.[state.state] || null;
  const lines = [
    "# Post-T4 qualification worker",
    "",
    `Updated: ${state.updated_at || now()}`,
    "",
    `- Current state: **${state.state}**`,
    `- Candidate: **${state.candidate_id || "pending runtime verification"}**`,
    `- Selected checkpoint: **iteration ${state.selected_iteration || 104}**`,
    `- Review route for this run: **${state.review_selection?.selected_route || "not recorded in this historical run"}**`,
    `- Review claim scope: **${state.review_selection?.claim_scope || "no additional claim recorded"}**`,
    `- Configured review workers: **${state.review_workers?.map((worker) => `${worker.role}: ${worker.worker_id}`).join("; ") || "not recorded in this historical run"}**`,
    `- Active endpoint: **${state.active_endpoint || "not started"}**`,
    `- Configured endpoint: **${state.configured_endpoint || state.active_endpoint || "pending"}**`,
    `- Last completed gate: **${completed.at(-1) || "none"}**`,
    `- Completed gates: **${completed.length}**`,
    `- Current gate counts: **${currentGate?.counts ? JSON.stringify(currentGate.counts) : "pending"}**`,
    `- Infrastructure retries used: **${state.retries_used || 0}**`,
    `- Product repair cycles used: **${state.repairs_used || 0}**`,
    `- Next authorised action: **${state.next_authorised_action || state.state}**`,
    `- Blocker: **${state.blocker || "none"}**`,
    `- Sealed unseen: **CLOSED — no key, data access, run, or score authorised**`,
    `- Factual status: **${state.factual_status || "PENDING — no absolute truth claim"}**`,
    "",
    "The 70-point score is a minimum quality floor. Every mandatory factual, citation, jurisdiction, safety, outcome, and personal-fact gate must also pass.",
    "",
  ];
  return lines.join("\n");
}

export function writeStatus(logRoot, state) {
  atomicWrite(join(logRoot, "STATUS.md"), statusMarkdown(state));
}

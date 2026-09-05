import { existsSync } from "node:fs";
import { canonicalHash,readJson,sha256File } from "./utils.mjs";
import { validateArtifactRecords } from "./artifactManifest.mjs";

function integrityError(message) {
  return Object.assign(new Error(message),{ code:"WORKER_STAGE_TRANSITION_INTEGRITY_ERROR" });
}

export function stageGateCommitment({ projectRoot,runId,stage,gatePath }) {
  if (!existsSync(gatePath)) throw integrityError(`Passing gate is missing for ${stage}.`);
  const gate = readJson(gatePath);
  if (gate.version !== "qualification-stage-gate-v1" || gate.stage !== stage || gate.passed !== true || gate.sealed_unseen_accessed !== false) {
    throw integrityError(`Passing gate identity is invalid for ${stage}.`);
  }
  if (!Array.isArray(gate.artifacts) || gate.artifacts.length === 0 || gate.artifacts_sha256 !== canonicalHash(gate.artifacts)) {
    throw integrityError(`Passing gate artifact manifest is invalid for ${stage}.`);
  }
  const artifactFailures = validateArtifactRecords(projectRoot,gate.artifacts);
  if (artifactFailures.length) throw integrityError(`Passing evidence changed for ${stage}: ${artifactFailures[0].path}`);
  return {
    run_id:runId,
    stage,
    gate:gatePath,
    gate_sha256:sha256File(gatePath),
    artifacts_sha256:gate.artifacts_sha256,
    artifacts_count:gate.artifacts.length,
    predecessor_sha256:gate.inputs?.predecessor?.sha256 || null,
  };
}

export function verifyCommittedStageTransitions({ projectRoot,runId,completedStages,stagePath,eventAudit }) {
  const events = Array.isArray(eventAudit?.events) ? eventAudit.events : [];
  let priorSequence = 0;
  for (const stage of completedStages || []) {
    const matches = events.filter((event) => event.type === "stage_passed" && event.data?.run_id === runId && event.data?.stage === stage);
    if (matches.length !== 1) throw integrityError(`${stage} must have exactly one signed stage-passed transition; found ${matches.length}.`);
    const event = matches[0];
    if (!Number.isInteger(event.sequence) || event.sequence <= priorSequence) throw integrityError(`Signed stage-passed transitions are out of order at ${stage}.`);
    const expected = stageGateCommitment({ projectRoot,runId,stage,gatePath:stagePath(stage) });
    for (const key of ["run_id","stage","gate","gate_sha256","artifacts_sha256","artifacts_count","predecessor_sha256"]) {
      if (canonicalHash(event.data?.[key]) !== canonicalHash(expected[key])) throw integrityError(`Signed stage-passed commitment mismatch for ${stage}: ${key}.`);
    }
    priorSequence = event.sequence;
  }
  return { passed:true,stage_count:(completedStages || []).length,last_sequence:priorSequence };
}

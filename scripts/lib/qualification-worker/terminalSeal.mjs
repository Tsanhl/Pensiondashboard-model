import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalHash,createExclusive,now,readJson,sha256File } from "./utils.mjs";

export function ensureQualificationTerminalSeal({ runRoot,runId,stages,stagePath,eventAudit,allowCreate = true,integritySigner,integrityVerifier }) {
  const path = join(runRoot,"candidate-freeze","TERMINAL-SEAL.json");
  const gateChain = stages.map((stage) => {
    const gatePath = stagePath(stage);
    if (!existsSync(gatePath)) throw new Error(`Terminal seal cannot bind missing gate ${stage}.`);
    return { stage,path:gatePath,sha256:sha256File(gatePath) };
  });
  const finalGatePath = stagePath("CANDIDATE_FREEZE");
  const freezeManifestPath = join(runRoot,"candidate-freeze","SHA256-MANIFEST.json");
  const candidateManifestPath = join(runRoot,"candidate-freeze","candidate-manifest.json");
  if (!existsSync(freezeManifestPath) || !existsSync(candidateManifestPath)) throw new Error("Terminal seal cannot bind missing frozen-candidate manifests.");
  const staticExpected = {
    version:"qualification-terminal-seal-v1",run_id:runId,
    final_gate_path:finalGatePath,final_gate_sha256:sha256File(finalGatePath),
    gate_chain_sha256:canonicalHash(gateChain),gate_chain:gateChain,
    frozen_manifest_path:freezeManifestPath,frozen_manifest_sha256:sha256File(freezeManifestPath),
    candidate_manifest_path:candidateManifestPath,candidate_manifest_sha256:sha256File(candidateManifestPath),
    sealed_unseen_accessed:false,
  };
  if (!existsSync(path)) {
    if (!allowCreate) throw new Error("Qualification terminal seal is missing.");
    if (typeof integritySigner !== "function") throw new Error("Qualification terminal seal requires a controller integrity signer.");
    const payload = { ...staticExpected,event_chain_count:eventAudit.event_count,event_chain_root:eventAudit.head_hash,event_chain_anchor_sha256:eventAudit.anchor_sha256,sealed_at:now() };
    createExclusive(path,{ ...payload,...integritySigner(payload) });
  }
  const seal = readJson(path);
  const { integrity_public_key_sha256,integrity_signature,...signedPayload } = seal || {};
  if (typeof integrityVerifier !== "function" || !integrityVerifier(signedPayload,{ integrity_public_key_sha256,integrity_signature })) throw new Error("Qualification terminal seal signature is invalid.");
  for (const [key,value] of Object.entries(staticExpected)) {
    if (canonicalHash(seal[key]) !== canonicalHash(value)) throw new Error(`Terminal seal binding mismatch: ${key}.`);
  }
  if (!Number.isInteger(Number(seal.event_chain_count)) || Number(seal.event_chain_count) < 1 || Number(seal.event_chain_count) > eventAudit.event_count ||
      eventAudit.hashes[Number(seal.event_chain_count) - 1] !== seal.event_chain_root) throw new Error("Terminal seal event-chain root is not present at its declared sequence.");
  return { path,seal };
}

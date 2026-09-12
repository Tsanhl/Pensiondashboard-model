import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const RUN_ROOT = resolve("training/evaluation-cycle-v2/02-wave-2-execution/training/cumulative-lora-v1");
const SOURCE = resolve("adapters/pension-assistant-v2-wave2-cumulative");
const SELECTED = resolve("adapters/pension-assistant-v2-wave2-cumulative-selected");
const RESUMED_WAVE_1 = resolve("adapters/pension-assistant-v1-targeted-behaviour-selected/adapters.safetensors");
const LOG = JSON.parse(readFileSync(resolve(RUN_ROOT, "training-log.json"), "utf8"));
const MANIFEST = JSON.parse(readFileSync(resolve(RUN_ROOT, "training-run-manifest.json"), "utf8"));
if (MANIFEST.status !== "completed_checkpoint_selection_pending") throw new Error("Wave 2 cumulative training has not completed successfully.");
if (existsSync(SELECTED) && readdirSync(SELECTED).length) throw new Error(`Selected Wave 2 adapter path is not empty: ${SELECTED}`);

const persistedIterations = [9, 18, 27];
const initialValidation = LOG.validation_loss.find((entry) => entry.iteration === 1);
const resumedCandidate = initialValidation && existsSync(RESUMED_WAVE_1)
  ? [{ iteration: 0, validation_loss: initialValidation.loss, checkpoint: RESUMED_WAVE_1, source_kind: "resumed_wave_1_adapter_before_wave_2_updates" }]
  : [];
const candidates = [...resumedCandidate, ...LOG.validation_loss.filter((entry) => persistedIterations.includes(entry.iteration)).map((entry) => {
  const checkpoint = entry.iteration === MANIFEST.hyperparameters.iterations ? resolve(SOURCE, "adapters.safetensors") : resolve(SOURCE, `${String(entry.iteration).padStart(7, "0")}_adapters.safetensors`);
  if (!existsSync(checkpoint)) return null;
  return { iteration: entry.iteration, validation_loss: entry.loss, checkpoint, source_kind: "wave_2_cumulative_checkpoint" };
}).filter(Boolean)].sort((left, right) => left.validation_loss - right.validation_loss || left.iteration - right.iteration);
if (!candidates.length) throw new Error("No persisted Wave 2 validation checkpoint can be selected.");
const selected = candidates[0];
mkdirSync(SELECTED, { recursive: true });
copyFileSync(selected.checkpoint, resolve(SELECTED, "adapters.safetensors"));
copyFileSync(resolve(SOURCE, "adapter_config.json"), resolve(SELECTED, "adapter_config.json"));
const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const selection = {
  version: "evaluation-cycle-v2-wave-2-checkpoint-selection-v1",
  selected_at: new Date().toISOString(),
  policy: "lowest validation loss among persisted checkpoints; ties prefer the earlier iteration",
  model_version: "pension-assistant-v2-wave2-cumulative",
  selected_iteration: selected.iteration,
  selected_source_kind: selected.source_kind,
  selected_validation_loss: selected.validation_loss,
  source_checkpoint: selected.checkpoint,
  selected_adapter_path: SELECTED,
  adapter_sha256: hashFile(resolve(SELECTED, "adapters.safetensors")),
  adapter_config_sha256: hashFile(resolve(SELECTED, "adapter_config.json")),
  candidates: candidates.map((candidate) => ({ iteration: candidate.iteration, validation_loss: candidate.validation_loss, source_kind: candidate.source_kind, sha256: hashFile(candidate.checkpoint) })),
};
writeFileSync(resolve(RUN_ROOT, "checkpoint-selection.json"), `${JSON.stringify(selection, null, 2)}\n`);
console.log(JSON.stringify(selection, null, 2));

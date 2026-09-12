import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const RUN_ROOT = resolve("training/evaluation-cycle-v2/02-wave-3-execution/training/cumulative-lora-v1");
const SOURCE = resolve("adapters/pension-assistant-v3-wave3-cumulative");
const SELECTED = resolve("adapters/pension-assistant-v3-wave3-cumulative-selected");
const RESUMED = resolve("adapters/pension-assistant-v2-wave2-cumulative-selected/adapters.safetensors");
const LOG = JSON.parse(readFileSync(resolve(RUN_ROOT, "training-log.json"), "utf8")); const MANIFEST = JSON.parse(readFileSync(resolve(RUN_ROOT, "training-run-manifest.json"), "utf8"));
if (MANIFEST.status !== "completed_checkpoint_selection_pending") throw new Error("Wave 3 cumulative training has not completed successfully.");
if (existsSync(SELECTED) && readdirSync(SELECTED).length) throw new Error(`Selected Wave 3 adapter path is not empty: ${SELECTED}`);
const initial = LOG.validation_loss.find((entry) => entry.iteration === 1); const candidates = initial && existsSync(RESUMED) ? [{ iteration: 0, validation_loss: initial.loss, checkpoint: RESUMED, source_kind: "resumed_wave_2_adapter" }] : [];
for (const entry of LOG.validation_loss.filter((value) => [5, 10, 15].includes(value.iteration))) { const checkpoint = entry.iteration === 15 ? resolve(SOURCE, "adapters.safetensors") : resolve(SOURCE, `${String(entry.iteration).padStart(7, "0")}_adapters.safetensors`); if (existsSync(checkpoint)) candidates.push({ iteration: entry.iteration, validation_loss: entry.loss, checkpoint, source_kind: "wave_3_cumulative_checkpoint" }); }
candidates.sort((a, b) => a.validation_loss - b.validation_loss || a.iteration - b.iteration); if (!candidates.length) throw new Error("No Wave 3 checkpoint can be selected."); const selected = candidates[0];
mkdirSync(SELECTED, { recursive: true }); copyFileSync(selected.checkpoint, resolve(SELECTED, "adapters.safetensors")); copyFileSync(resolve(SOURCE, "adapter_config.json"), resolve(SELECTED, "adapter_config.json"));
const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex"); const selection = { version: "evaluation-cycle-v2-wave-3-checkpoint-selection-v1", selected_at: new Date().toISOString(), policy: "lowest validation loss among the resumed adapter and persisted checkpoints; ties prefer earlier iteration", model_version: "pension-assistant-v3-wave3-cumulative", selected_iteration: selected.iteration, selected_source_kind: selected.source_kind, selected_validation_loss: selected.validation_loss, source_checkpoint: selected.checkpoint, selected_adapter_path: SELECTED, adapter_sha256: hashFile(resolve(SELECTED, "adapters.safetensors")), adapter_config_sha256: hashFile(resolve(SELECTED, "adapter_config.json")), candidates: candidates.map((item) => ({ iteration: item.iteration, validation_loss: item.validation_loss, source_kind: item.source_kind, sha256: hashFile(item.checkpoint) })) };
writeFileSync(resolve(RUN_ROOT, "checkpoint-selection.json"), `${JSON.stringify(selection, null, 2)}\n`); console.log(JSON.stringify(selection, null, 2));

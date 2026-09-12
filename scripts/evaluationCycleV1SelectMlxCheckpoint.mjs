import { copyFileSync,existsSync,mkdirSync,readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  CYCLE_ROOT,PROJECT_ROOT,hashFile,isoNow,readJson,writeJsonAtomic,writeTextAtomic
} from "./evaluationCycleV1Common.mjs";

const version = "pension-assistant-v1-targeted-behaviour";
const runRoot = resolve(CYCLE_ROOT,"05-training-runs",version);
const sourceRoot = resolve(PROJECT_ROOT,"adapters",version);
const selectedRoot = resolve(PROJECT_ROOT,"adapters",`${version}-selected`);
const logPath = resolve(runRoot,"training-log.json");
const manifestPath = resolve(runRoot,"training-run-manifest.json");

const log = readJson(logPath);
const manifest = readJson(manifestPath);
if (log.status !== "completed" || manifest.status !== "completed") throw new Error("Training must complete before checkpoint selection.");
if (existsSync(selectedRoot) && readdirSync(selectedRoot).length) throw new Error(`Selected adapter directory is not empty: ${selectedRoot}`);

const candidates = log.validation_loss
  .map((row) => ({
    ...row,
    path:resolve(sourceRoot,`${String(row.iteration).padStart(7,"0")}_adapters.safetensors`)
  }))
  .filter((row) => existsSync(row.path));
if (!candidates.length) throw new Error("No validation checkpoint with saved adapter weights was found.");
candidates.sort((a,b) => a.loss - b.loss || a.iteration - b.iteration);
const selected = candidates[0];

mkdirSync(selectedRoot,{ recursive:true });
copyFileSync(resolve(sourceRoot,"adapter_config.json"),resolve(selectedRoot,"adapter_config.json"));
copyFileSync(selected.path,resolve(selectedRoot,"adapters.safetensors"));

const selection = {
  version:"phase-6-checkpoint-selection-v1",
  selected_at:isoNow(),
  policy:"lowest validation loss among persisted checkpoints; ties prefer earlier iteration",
  model_version:version,
  selected_iteration:selected.iteration,
  selected_validation_loss:selected.loss,
  source_checkpoint:selected.path,
  selected_adapter_path:selectedRoot,
  adapter_config_sha256:hashFile(resolve(selectedRoot,"adapter_config.json")),
  adapter_sha256:hashFile(resolve(selectedRoot,"adapters.safetensors")),
  candidates:candidates.map((row) => ({ iteration:row.iteration,validation_loss:row.loss,sha256:hashFile(row.path) }))
};
writeJsonAtomic(resolve(runRoot,"checkpoint-selection.json"),selection);
manifest.adapter_selection = selection;
writeJsonAtomic(manifestPath,manifest);
writeTextAtomic(resolve(runRoot,"checkpoint-selection.md"),`# Checkpoint Selection\n\nSelected iteration **${selected.iteration}** with validation loss **${selected.loss}**.\n\nPolicy: ${selection.policy}. The final training weights remain preserved; regression uses the immutable selected adapter directory.\n`);
console.log(JSON.stringify(selection,null,2));

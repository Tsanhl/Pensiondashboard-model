import { createWriteStream,existsSync,mkdirSync,readdirSync } from "node:fs";
import { spawn,execFileSync } from "node:child_process";
import os from "node:os";
import { resolve } from "node:path";
import { CYCLE_ROOT,PROJECT_ROOT,hashFile,isoNow,readJson,sha256,writeJsonAtomic,writeTextAtomic } from "./evaluationCycleV1Common.mjs";

const version = "pension-assistant-v1-targeted-behaviour";
const draftRoot = resolve(CYCLE_ROOT,"03-training-drafts");
const runRoot = resolve(CYCLE_ROOT,"05-training-runs",version);
const adapterPath = resolve(PROJECT_ROOT,"adapters",version);
const modelPath = resolve(PROJECT_ROOT,"models/mlx/Qwen3-8B-4bit");
const datasetPath = resolve(PROJECT_ROOT,"training-data/private/evaluation-cycle-v1-lora");
const pythonPath = resolve(PROJECT_ROOT,".training-venv/bin/python");
const approvedManifestPath = resolve(draftRoot,"approved-training-manifest.json");
const datasetManifestPath = resolve(datasetPath,"dataset-manifest.json");
const configPath = resolve(PROJECT_ROOT,"training/phase6_mlx_config.yaml");
const stagePath = resolve(CYCLE_ROOT,"stage-status.json");

const approved = readJson(approvedManifestPath);
const dataset = readJson(datasetManifestPath);
if (!approved.phase_6_authorised || !approved.training_run_authorised || approved.approved_items.length !== 42) throw new Error("The approved Phase 6 manifest is incomplete.");
if (dataset.source_manifest.sha256 !== hashFile(approvedManifestPath) || dataset.train.count !== 34 || dataset.validation.count !== 8) throw new Error("The training dataset no longer matches the approved manifest.");
if (!existsSync(modelPath) || !existsSync(resolve(modelPath,"model.safetensors")) || !existsSync(pythonPath)) throw new Error("Pinned MLX model or isolated training runtime is missing.");
if (existsSync(adapterPath) && readdirSync(adapterPath).length) throw new Error(`Adapter path already contains data: ${adapterPath}`);
mkdirSync(runRoot,{ recursive:true });
mkdirSync(adapterPath,{ recursive:true });

const startedAt = isoNow();
const git = (args) => { try { return execFileSync("git",args,{ cwd:PROJECT_ROOT,encoding:"utf8",stdio:["ignore","pipe","ignore"] }).trim(); } catch { return null; } };
const freeze = execFileSync(pythonPath,["-m","pip","freeze"],{ cwd:PROJECT_ROOT,encoding:"utf8" });
writeTextAtomic(resolve(runRoot,"environment-freeze.txt"),freeze);
const manifest = {
  version:"phase-6-mlx-training-run-v1",model_version:version,status:"running",started_at:startedAt,completed_at:null,
  base_model:{ repository:"mlx-community/Qwen3-8B-4bit",revision:"545dc4251c05440727734bcd94334791f6ab0192",source_model:"Qwen/Qwen3-8B",quantisation:"4-bit",model_file_sha256:hashFile(resolve(modelPath,"model.safetensors")),config_sha256:hashFile(resolve(modelPath,"config.json")) },
  adapter:{ path:adapterPath,format:"MLX LoRA safetensors",sha256:null },
  approved_training_manifest:{ path:approvedManifestPath,sha256:hashFile(approvedManifestPath),items:42 },
  dataset:{ path:datasetPath,manifest_sha256:hashFile(datasetManifestPath),train_count:34,validation_count:8,train_sha256:dataset.train.sha256,validation_sha256:dataset.validation.sha256,protected_assets_excluded:true,sealed_unseen_accessed:false },
  hyperparameters:{ framework:"mlx-lm",framework_version:"0.31.3",fine_tune_type:"QLoRA",iterations:102,estimated_train_set_passes:3,num_layers:16,batch_size:1,gradient_accumulation_steps:1,learning_rate:0.00001,rank:8,mlx_scale:20,alpha_equivalent:160,dropout:0.05,seed:42,max_sequence_length:768,mask_prompt:true,optimizer:"adam",gradient_checkpointing:true },
  hardware:{ platform:os.platform(),architecture:os.arch(),chip:"Apple M2",memory_bytes:os.totalmem(),cpu_count:os.cpus().length },
  software:{ python:execFileSync(pythonPath,["--version"],{ encoding:"utf8" }).trim(),environment_freeze_sha256:hashFile(resolve(runRoot,"environment-freeze.txt")) },
  code:{ commit:git(["rev-parse","HEAD"]),branch:git(["rev-parse","--abbrev-ref","HEAD"]),worktree_dirty:Boolean(git(["status","--porcelain"])),runner_sha256:hashFile(resolve(PROJECT_ROOT,"scripts/evaluationCycleV1TrainMlx.mjs")),config_sha256:hashFile(configPath) },
  evaluation_access:{ development_regression_used_for_training:false,sealed_unseen_used_for_training:false,sealed_gold_opened:false },training_log:"training-output.log"
};
writeJsonAtomic(resolve(runRoot,"training-run-manifest.json"),manifest);

const logPath = resolve(runRoot,"training-output.log");
const log = createWriteStream(logPath,{ flags:"wx" });
const child = spawn("bash",["training/train_mlx.sh",datasetPath],{
  cwd:PROJECT_ROOT,env:{ ...process.env,PENSION_TRAINING_PYTHON:pythonPath,PENSION_MLX_MODEL_PATH:modelPath,PENSION_ADAPTER_PATH:adapterPath,PENSION_TRAINING_ITERS:"102",PENSION_TRAINING_SEED:"42" },stdio:["ignore","pipe","pipe"]
});
let output = "";
for (const stream of [child.stdout,child.stderr]) stream.on("data",(chunk) => { const value=chunk.toString(); output += value; log.write(value); process.stdout.write(value); });
const exitCode = await new Promise((resolveExit,reject) => { child.on("error",reject); child.on("exit",(code) => resolveExit(code ?? 1)); });
await new Promise((resolveLog) => log.end(resolveLog));
const completedAt = isoNow();
const trainRows = [...output.matchAll(/Iter\s+(\d+): Train loss\s+([0-9.]+)/g)].map((match) => ({ iteration:Number(match[1]),loss:Number(match[2]) }));
const validRows = [...output.matchAll(/Iter\s+(\d+): Val loss\s+([0-9.]+)/g)].map((match) => ({ iteration:Number(match[1]),loss:Number(match[2]) }));
const peakMemory = [...output.matchAll(/Peak mem\s+([0-9.]+)\s+GB/g)].map((match) => Number(match[1]));
const adapterFile = resolve(adapterPath,"adapters.safetensors");
const completed = exitCode === 0 && existsSync(adapterFile) && trainRows.at(-1)?.iteration === 102;
writeJsonAtomic(resolve(runRoot,"training-log.json"),{
  version:"phase-6-training-log-v1",started_at:startedAt,completed_at:completedAt,exit_code:exitCode,status:completed ? "completed" : "failed",
  train_loss:trainRows,validation_loss:validRows,final_train_loss:trainRows.at(-1)?.loss ?? null,final_validation_loss:validRows.at(-1)?.loss ?? null,
  peak_memory_gb:peakMemory.length ? Math.max(...peakMemory) : null,output_sha256:hashFile(logPath)
});
manifest.status = completed ? "completed" : "failed";
manifest.completed_at = completedAt;
manifest.metrics = { final_train_loss:trainRows.at(-1)?.loss ?? null,final_validation_loss:validRows.at(-1)?.loss ?? null,peak_memory_gb:peakMemory.length ? Math.max(...peakMemory) : null,train_reports:trainRows.length,validation_reports:validRows.length };
manifest.adapter.sha256 = existsSync(adapterFile) ? hashFile(adapterFile) : null;
manifest.adapter.size_bytes = existsSync(adapterFile) ? Number(execFileSync("stat",["-f","%z",adapterFile],{ encoding:"utf8" }).trim()) : null;
manifest.training_output_sha256 = hashFile(logPath);
writeJsonAtomic(resolve(runRoot,"training-run-manifest.json"),manifest);
writeTextAtomic(resolve(runRoot,"model-card.md"),`# ${version}\n\n- Base: mlx-community/Qwen3-8B-4bit at \`545dc4251c05440727734bcd94334791f6ab0192\` (derived from Qwen/Qwen3-8B)\n- Method: MLX QLoRA, 16 layers, rank 8, dropout 0.05, scale 20\n- Approved examples: 42; split 34 train / 8 source-ID-disjoint validation\n- Completion loss: assistant \`ideal_answer\` only\n- Final train loss: ${manifest.metrics.final_train_loss ?? "unavailable"}\n- Final validation loss: ${manifest.metrics.final_validation_loss ?? "unavailable"}\n- Peak memory: ${manifest.metrics.peak_memory_gb ?? "unavailable"} GB\n- Evaluation, gold and sealed unseen assets: excluded from training\n- Status: ${manifest.status}\n\nThis adapter teaches evidence discipline, citation-token use, scam handling and human handoff. Current law, figures and provider facts remain in RAG or dated structured data. It is not deployment-approved until critical, full regression and sealed unseen evaluation pass.\n`);
writeTextAtomic(resolve(runRoot,"adapter-comparison.md"),`# Adapter Comparison — Pre-evaluation\n\nThe adapter completed training but has not yet been selected. Pre-training narrow regression was 13 pass / 1 critical fail; \`gold-063\` remained the critical scam/handoff case. Post-training critical and full regression results must be added before model selection.\n`);

const stage = readJson(stagePath);
stage.updated_at = completedAt;
stage.overall_status = completed ? "phase_6_training_completed_evaluation_pending" : "phase_6_training_failed";
stage.phases.phase_6 = { ...stage.phases.phase_6,status:completed ? "completed_training_evaluation_pending" : "failed",authorised:true,training_run_authorised:true,training_started:true,training_completed:completed,model_version_produced:completed ? version : null,adapter_path:adapterPath,training_manifest:"05-training-runs/pension-assistant-v1-targeted-behaviour/training-run-manifest.json" };
stage.phases.phase_7 = { status:"not_started",authorised:completed,sequence:["critical_safety_regression","full_69_regression","sealed_unseen_after_independent_review"] };
stage.next_phase_authorised = completed;
stage.next_phase_ready = completed ? "phase_7_critical_safety_regression" : null;
stage.deployment_gate = completed ? "BLOCKED_PENDING_SAFETY_FIX" : "BLOCKED_DUE_TO_CRITICAL_FAILURE";
writeJsonAtomic(stagePath,stage);
console.log(JSON.stringify({ status:manifest.status,model_version:version,adapter:adapterPath,final_train_loss:manifest.metrics.final_train_loss,final_validation_loss:manifest.metrics.final_validation_loss,peak_memory_gb:manifest.metrics.peak_memory_gb,phase_7_authorised:completed },null,2));
if (!completed) process.exitCode = 1;

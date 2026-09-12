import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Frozen diagnostic selection only. No unseen files, gold keys or training.
const label = process.env.WAVE4_REPAIR_LABEL || "wave4-runtime-repair-20260831-v2";
if (!/^[a-zA-Z0-9._-]+$/.test(label)) throw new Error("Invalid run label");
const checkpointPath = resolve("training/evaluation-cycle-v2/02-wave-3-execution/training/cumulative-lora-v1/checkpoint-selection.json");
const checkpoint = JSON.parse(readFileSync(checkpointPath));
const training = JSON.parse(readFileSync(resolve(checkpointPath, "../training-run-manifest.json")));
const selection = JSON.parse(readFileSync("training/evaluation-cycle-v2/03-wave-4-release-gate/selection.json"));
const env = { ...process.env,
  CYCLE_V2_PARTITION: "diagnostic", CYCLE_V2_RUN_LABEL: label, POST_FIX_RUN_LABEL: label,
  CYCLE_V2_CHECKPOINT_PATH: checkpointPath,
  LOCAL_LLM_BASE_URL: "http://127.0.0.1:8080", LOCAL_LLM_TRANSPORT: "openai",
  LOCAL_LLM_MODEL: `${checkpoint.model_version}-step${checkpoint.selected_iteration}`,
  LOCAL_LLM_EXPECTED_ADAPTER_SHA256: checkpoint.adapter_sha256,
  LOCAL_LLM_EXPECTED_BASE_SHA256: training.base_model.model_sha256,
  LOCAL_LLM_TIMEOUT_MS: "120000", LOCAL_LLM_MAX_TOKENS: "400",
  LLM_CONTEXT_SOURCE_LIMIT: "3", LLM_SOURCE_SNIPPET_CHARS: "800",
  EMBEDDING_SERVICE_URL: "http://127.0.0.1:8090",
  EVALUATION_MODEL_VERSION: `${checkpoint.model_version}-step${checkpoint.selected_iteration}`,
  EVALUATION_MODEL_REPOSITORY: "mlx-community/Qwen3-8B-4bit",
  EVALUATION_MODEL_QUANTISATION: "MLX-4bit",
  EVALUATION_LORA_ADAPTER: checkpoint.selected_adapter_path,
};
for (const wave of selection.waves) {
  if (existsSync(`training/evaluation-cycle-v2/02-${wave.wave}-execution/diagnostic/${label}`)) throw new Error("Run label already used; preserve existing attempt");
}
if (existsSync(`training/evaluation-cycle-v1/06-regression/${label}`)) throw new Error("Critical run label already used");
async function run(script, extra = {}) {
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...env, ...extra }, stdio: "inherit" });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    child.once("error", reject);
    child.once("close", (code) => {
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
      code === 0 ? accept() : reject(new Error(`${script} exited ${code}`));
    });
  });
}
// Begin with the three cases that previously timed out; keep all attempts.
for (const wave of [...selection.waves].reverse()) {
  const extra = { CYCLE_V2_WAVE: wave.wave, CYCLE_V2_QUESTION_IDS: wave.question_ids.join(",") };
  await run("scripts/evaluationCycleV2Wave1Run.mjs", extra);
  await run("scripts/evaluationCycleV2Wave1Score.mjs", extra);
}
await run("scripts/evaluationCycleV1PostFixRegression.mjs", { EVALUATION_QUESTION_IDS: "gold-011,gold-041,gold-047,gold-063" });
await run("scripts/evaluationCycleV1PostFixScore.mjs");
